/**
 * 统一的 handle 持久化与 supervisor 启动（R1，specs/cloud-agent/15 §3；01 §5.1 第 3 条、
 * §5.3 启动对账、08 §8.1 停止屏障）。
 *
 * 单一实现，三处共用：create 正常路径/对账恢复、startup 启动对账、readiness 看门狗。
 * 之前 startup/readiness 各自 `recordProviderHandle`，漏了 workspacePath 且从不启动
 * supervisor——provider 里活着的沙箱没人连，run 只能等超时收口。顺序冻结为：
 *
 *   workspacePath（唯一计算点）→ recordProviderHandle（含 workspacePath）
 *   → 停止意图/迟到 handle 只清理 → clone grant → startSupervisor → 结算操作
 *
 * 恢复路径没有内存中的 create 票据（只持久 hash）：按同一秘密注入通道重新铸造，
 * `credentials.saveInitial` 只在初始票据未被消费时更新 hash；若 supervisor 已连接过，
 * 票据无法再轮换，此时重复 startSupervisor 依赖沙箱内 flock 单例幂等（01 §6.2）。
 */
import { type CloudErrorCode, type CloudRunRecord } from "@zcode/shared";
import { createOperationKey } from "../../domain/idempotency.js";
import { buildCloudTaskWorkspacePath } from "../../domain/workspacePath.js";
import type { CloudCoreDeps } from "../deps.js";
import type { LeasedOperation } from "../ports/operationOutboxPort.js";
import type {
  ProviderSandboxHandle,
  SandboxCreateInput,
  SandboxDriverPort,
} from "../ports/sandboxDriverPort.js";
import type { StoragePort } from "../ports/storagePort.js";
import { cloudCoreLogger } from "../logger.js";
import type { RunCompensation } from "./compensation.js";
import { isRecoverableGitGrantFailure, type CloudGitGrantService } from "../gitGrants.js";
import { SandboxBootstrapError, bootstrapSandboxWithCompensation } from "./bootstrapSandbox.js";
import { classifyCreateFailure, describeCreateError } from "./createFailure.js";

/** workspacePath 解析结论：不安全/缺失时明确失败，不落临时目录、不回退别的路径。 */
export type WorkspacePathResolution =
  | { ok: true; path: string }
  | { ok: false; reason: "project-repository-missing" | "repo-name-unresolved" };

/**
 * 解析 run 的 checkout 路径。
 *
 * - `provided`（create 路径在 create 前算好的同一份值）直接复用，保证下发值/落库值同源；
 * - 已持久化的 `run.workspacePath` 是创建期唯一计算点的事实，恢复时优先复用（repoName
 *   若在创建后被改写，也不能把已有沙箱的路径改到别处）；
 * - 两者都没有时按 project.repoName 用唯一计算点重新计算（startup/readiness 漏持久
 *   路径的旧 run）。
 */
export async function resolveRunWorkspacePath(
  storage: StoragePort,
  run: CloudRunRecord,
  provided?: string,
): Promise<WorkspacePathResolution> {
  if (provided) return { ok: true, path: provided };
  if (run.workspacePath) return { ok: true, path: run.workspacePath };
  const task = await storage.tasks.get(run.taskId);
  const project = task ? await storage.projects.get(task.projectId) : null;
  if (!project?.repoName) return { ok: false, reason: "project-repository-missing" };
  const computed = buildCloudTaskWorkspacePath(project.repoName);
  return computed.ok
    ? { ok: true, path: computed.path }
    : { ok: false, reason: "repo-name-unresolved" };
}

/**
 * 铸造自举票据并持久 hash（01 §6.2、02 §5.1）：库内只有 hash，明文只经秘密注入通道
 * 交给 supervisor。恢复路径复用同一入口，不新造第二套凭据。
 */
export async function mintRunBootstrapTicket(
  deps: CloudCoreDeps,
  run: CloudRunRecord,
  operationId?: string,
): Promise<string> {
  const ticket = deps.ids.newSecret();
  await deps.storage.credentials.saveInitial({
    runId: run.runId,
    runGeneration: run.runGeneration,
    credentialHash: await deps.hash.sha256Hex(ticket),
    // 与 createOperation 同一口径：凭据行覆盖 run 终身（旋转只换 hash 不换行），
    // 硬期限未规划时按 run 时长默认值兜底，首个 hello 会再对齐。
    expiresAt: run.hardDeadlineAt ?? deps.clock.now() + deps.config.hardRunDurationMs,
    bootstrapOperationId: operationId ?? createOperationKey(run.runId),
  });
  return ticket;
}

/**
 * 已持久 handle 的端口形状（R1 恢复入口）：deadline 事实取自已落库值。
 * 调用方已确认 `run.providerHandle` 非空，故直接返回非空 handle。
 */
export function persistedProviderHandle(
  run: CloudRunRecord,
  sandboxId: string,
): ProviderSandboxHandle {
  return {
    provider: run.provider ?? "",
    sandboxId,
    ...(run.expiresAt !== undefined ? { providerDeadline: run.expiresAt } : {}),
    ...(run.deadlineEstimate !== undefined ? { deadlineEstimate: run.deadlineEstimate } : {}),
  };
}

export type CreateRetryReconciliation =
  | { status: "created"; handle: ProviderSandboxHandle }
  | { status: "notFound" }
  | { status: "unknown"; detail?: string };

/**
 * create 重试前置对账（R1）：结果未知的 create 在重试前必须按 operationKey 查询
 * provider（锚点 = operation.createdAt）。created → 恢复，notFound → 才允许 create，
 * unknown（含对账本身失败）→ 保持 ambiguous，绝不 create。
 */
export async function reconcileCreateBeforeRetry(input: {
  driver: SandboxDriverPort;
  runId: string;
  operationAttemptedAtMs: number;
}): Promise<CreateRetryReconciliation> {
  try {
    const reconciliation = await input.driver.findCreateResult(createOperationKey(input.runId), {
      operationAttemptedAtMs: input.operationAttemptedAtMs,
    });
    if (reconciliation.status === "created") {
      return { status: "created", handle: reconciliation.handle };
    }
    return reconciliation.status === "notFound" ? { status: "notFound" } : { status: "unknown" };
  } catch (error) {
    return { status: "unknown", detail: describeCreateError(error) };
  }
}

export type SandboxCreateAttempt =
  | { status: "created"; handle: ProviderSandboxHandle }
  /** create 抛错但按 operationKey 查回了 provider 已建资源（只恢复，不重建）。 */
  | { status: "reconciled"; handle: ProviderSandboxHandle }
  | { status: "notFound"; detail: string }
  | { status: "unknown"; detail: string }
  | { status: "failed"; code: CloudErrorCode; reason: string; detail: string };

/**
 * 发起一次 create 并按 01 §9 三分类收口结果（R1）：确定失败 → failed；结果未知 →
 * 立即按 operationKey 对账，created → 复用该 handle（绝不第二次 create），
 * notFound/unknown 交给调用方结算。`operationAttemptedAtMs` 是持久锚点。
 */
export async function createSandboxOrReconcile(input: {
  driver: SandboxDriverPort;
  createInput: SandboxCreateInput;
  runId: string;
  operationAttemptedAtMs: number;
}): Promise<SandboxCreateAttempt> {
  try {
    return { status: "created", handle: await input.driver.create(input.createInput) };
  } catch (error) {
    const detail = describeCreateError(error);
    const failure = classifyCreateFailure(error);
    if (failure.definite) {
      return { status: "failed", code: failure.code, reason: failure.reason, detail };
    }
    try {
      const reconciliation = await input.driver.findCreateResult(createOperationKey(input.runId), {
        operationAttemptedAtMs: input.operationAttemptedAtMs,
      });
      if (reconciliation.status === "created") {
        return { status: "reconciled", handle: reconciliation.handle };
      }
      return reconciliation.status === "notFound"
        ? { status: "notFound", detail }
        : { status: "unknown", detail };
    } catch (reconcileError) {
      // 对账本身失败（网络/权限）：保留 unknown，等下一次租约重试，不猜也不丢文本。
      return { status: "unknown", detail: `${detail}; ${describeCreateError(reconcileError)}` };
    }
  }
}

export interface EstablishRunHandleInput {
  driver: SandboxDriverPort;
  run: CloudRunRecord;
  handle: ProviderSandboxHandle;
  deadlineSource: "provider" | "estimated";
  /** create 路径在 create 前算好的同一份路径；恢复路径省略时按持久事实/项目重算。 */
  workspacePath?: string;
  /** create 路径已铸造的票据；恢复路径省略时重新铸造。 */
  bootstrapTicket?: string;
  /** create worker 持有的租约操作（有则结算；startup/readiness 无租约时省略）。 */
  leasedOperation?: LeasedOperation;
  /** 带租约的操作结算（由 create worker 提供）；无租约时省略。 */
  settleOperation?: (
    outcome: "settled" | "ambiguous" | "failed",
    errorCode?: CloudErrorCode,
  ) => Promise<void>;
}

export type EstablishRunHandleResult =
  | {
      status: "established";
      run: CloudRunRecord;
      /** 本次是否拉起了 supervisor（非 provisioning run 只恢复持久事实，不再拉起）。 */
      supervisorStarted: boolean;
    }
  | { status: "skipped"; reason: "late-handle" | "stop-requested" }
  | { status: "failed"; code: CloudErrorCode; reason: string };

export interface RunHandleEstablisher {
  establish(input: EstablishRunHandleInput): Promise<EstablishRunHandleResult>;
}

export function createRunHandleEstablisher(
  deps: CloudCoreDeps,
  compensation: RunCompensation,
  gitGrants: CloudGitGrantService,
): RunHandleEstablisher {
  const { storage, clock, config } = deps;
  /**
   * 恢复路径铸造的自举票据缓存（run+generation）：startup/readiness/create worker 在同一
   * 进程内反复进入恢复时复用同一明文。否则每次 saveInitial 都会把「尚未被 hello 消费」的
   * 初始 hash 轮换掉，而上一拍已启动的 supervisor 手里的票据随即失效。
   */
  const recoveryTickets = new Map<string, string>();

  async function ticketForRecovery(run: CloudRunRecord, operationId?: string): Promise<string> {
    const key = `${run.runId}:${run.runGeneration}`;
    const cached = recoveryTickets.get(key);
    if (cached) return cached;
    const ticket = await mintRunBootstrapTicket(deps, run, operationId);
    recoveryTickets.set(key, ticket);
    return ticket;
  }

  /**
   * 无法继续 bootstrap 的 fail-closed 出口：复用补偿终止（provider 确认后收口并释放
   * 配额），不让 run 停在「有 handle 却永远没人连」的 provisioning。
   */
  async function failClosed(
    input: EstablishRunHandleInput,
    code: CloudErrorCode,
    reason: string,
    detail: string,
  ): Promise<EstablishRunHandleResult> {
    const attempt = await bootstrapSandboxWithCompensation({
      run: input.run,
      compensation,
      settleFailed: async (failureCode) => {
        await input.settleOperation?.("failed", failureCode);
      },
      bootstrap: async () => {
        throw new SandboxBootstrapError(code, reason, detail);
      },
    });
    return { status: "failed", code: attempt.ok ? code : attempt.code, reason };
  }

  return {
    async establish(input) {
      const { driver, run, handle, deadlineSource } = input;
      const workspace = await resolveRunWorkspacePath(storage, run, input.workspacePath);
      if (!workspace.ok) {
        // workspace 无法确定时不能启动 supervisor；fail-closed 走补偿终止（01 §6.2）。
        return failClosed(
          input,
          "validation_failed",
          "workspace-path-unresolved",
          workspace.reason,
        );
      }

      // create 成功立即持久 handle/deadline（必须匹配 runGeneration；01 §5.1 第 3 条）。
      const persisted = await storage.runs.recordProviderHandle({
        runId: run.runId,
        runGeneration: run.runGeneration,
        provider: handle.provider,
        providerHandle: handle.sandboxId,
        workspacePath: workspace.path,
        providerDeadline: handle.providerDeadline,
        deadlineEstimate: handle.deadlineEstimate,
        now: clock.now(),
      });
      if (!persisted) {
        // 写 handle 前 run 已被新代际接管/已终态：迟到 handle 只能进入清理（08 §8.1）。
        await compensation.requestTermination({
          runId: run.runId,
          runGeneration: run.runGeneration,
          reason: "late-handle",
        });
        await input.settleOperation?.("settled");
        return { status: "skipped", reason: "late-handle" };
      }
      if (deadlineSource === "estimated") {
        cloudCoreLogger.info(undefined, "cloud sandbox created with estimated deadline", {
          runId: run.runId,
        });
      }

      const latest = (await storage.runs.get(run.runId)) ?? run;
      if (latest.stopRequested && latest.status === "provisioning") {
        // 创建/恢复与停止并发：不启动 supervisor（08 §8.1「迟到 handle 只能进入清理，
        // 不能启动 Agent」）。startup 发现的 provisioning run 同样适用。
        // 非 provisioning（ready/paused/...）的停止由既有停止推进通路负责，不在此重复终止。
        await compensation.requestTermination({
          runId: run.runId,
          runGeneration: run.runGeneration,
          reason: "stop-after-create",
        });
        await input.settleOperation?.("settled");
        return { status: "skipped", reason: "stop-requested" };
      }

      // 非 provisioning（ready/paused/disconnected/draining）：handle 只用于补齐持久事实，
      // 不重复拉起 supervisor（已有连接或生命周期通路正在收敛）。
      if (latest.status !== "provisioning") {
        await input.settleOperation?.("settled");
        return { status: "established", run: latest, supervisorStarted: false };
      }

      const ticket =
        input.bootstrapTicket ??
        (await ticketForRecovery(latest, input.leasedOperation?.operation.operationId));

      // 01 §5.1 第 3 条 + §7.2：clone grant 必须在 supervisor 启动**之前**签发
      // （TTL 60s；启动 → hello → bootstrap.config → 兑换实测约 2s）。
      const started = await bootstrapSandboxWithCompensation({
        run: latest,
        compensation,
        settleFailed: async (code) => {
          await input.settleOperation?.("failed", code);
        },
        bootstrap: async () => {
          const cloneGrant = await gitGrants.issueForRun({ runId: latest.runId, purpose: "clone" });
          if (!cloneGrant.ok) {
            if (isRecoverableGitGrantFailure(cloneGrant.code)) {
              cloudCoreLogger.warn(undefined, "cloud clone grant issuance deferred", {
                runId: latest.runId,
                code: cloneGrant.code,
                reason: cloneGrant.reason,
              });
            } else {
              throw new SandboxBootstrapError(
                cloneGrant.code,
                "git-grant-issuance-failed",
                `clone grant issuance failed: ${cloneGrant.reason}`,
              );
            }
          }
          await driver.startSupervisor(handle, {
            operationKey: createOperationKey(latest.runId),
            runId: latest.runId,
            runGeneration: latest.runGeneration,
            publicControlPlaneUrl: config.publicControlPlaneUrl,
            bootstrapTicket: ticket,
            taskId: latest.taskId,
            workspacePath: workspace.path,
          });
        },
      });
      if (!started.ok) {
        return {
          status: "failed",
          code: started.code,
          reason:
            started.code === "bootstrap_failed" ? "bootstrap-failed" : "bootstrap-step-failed",
        };
      }

      await input.settleOperation?.("settled");
      return { status: "established", run: latest, supervisorStarted: true };
    },
  };
}
