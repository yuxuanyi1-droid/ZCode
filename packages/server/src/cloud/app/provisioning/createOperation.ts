/**
 * create 操作执行与恢复（01 §5.1 接受与创建、§5.3 启动对账、03 §5 外部操作不是事务、
 * 08 §6/§8.1 停止屏障对创建的影响）。
 *
 * 关键规则：
 * - 领取操作前检查当前代际与 stopRequested（01 §5.1 第 2 条、08 §8.1）：停止意图优先，
 *   迟到 handle 只能进入清理，回调不能发布 ready 或启动 Agent。
 * - 使用 Run recipe 中冻结的 provider/模板/资源与配置，不读取新部署默认值（01 §5.1 第 2 条）。
 * - create 结果未知进对账（按 operationKey），不自动第二次 create（03 §5、01 §4.1）。
 * - create 成功立即持久 handle/deadline，再等 bridge（01 §5.1 第 3 条）。
 * - DB 失败/本地校验失败不建资源（01 §5.1 尾段）。
 */
import { type CloudErrorCode, type CloudRunRecord } from "@zcode/shared";
import { createOperationKey } from "../../domain/idempotency.js";
import { buildCloudTaskWorkspacePath } from "../../domain/workspacePath.js";
import { resolveHardDeadline } from "../../domain/savePolicy.js";
import type { CloudCoreDeps } from "../deps.js";
import { cloudCoreLogger } from "../logger.js";
import { startOperationLeaseKeepalive } from "./leaseKeepalive.js";
import type { LeasedOperation } from "../ports/operationOutboxPort.js";
import type { CreateReconciliation, ProviderSandboxHandle } from "../ports/sandboxDriverPort.js";
import type { RunCompensation } from "./compensation.js";
import type { RunOrchestrator } from "../runOrchestrator.js";
import { classifyCreateFailure, describeCreateError } from "./createFailure.js";
import { persistRunHandle, type CreateAttemptOutcome } from "./handlePersistence.js";
import type { CloudGitGrantService } from "../gitGrants.js";

export type { CreateAttemptOutcome } from "./handlePersistence.js";

export interface CreateOperationRunner {
  /** 领取一个 create 操作并执行；无待处理操作返回 null。 */
  runCreateOnce(input?: {
    workerId?: string;
    leaseMs?: number;
    signal?: AbortSignal;
  }): Promise<CreateAttemptOutcome | null>;
}

export function createCreateOperationRunner(
  deps: CloudCoreDeps,
  orchestrator: RunOrchestrator,
  compensation: RunCompensation,
  gitGrants: CloudGitGrantService,
): CreateOperationRunner {
  const { storage, operations, drivers, clock, ids, hash, config } = deps;

  async function settle(
    leased: LeasedOperation,
    outcome: "settled" | "ambiguous" | "failed",
    errorCode?: CloudErrorCode,
  ): Promise<void> {
    await operations.settle({
      operationId: leased.operation.operationId,
      leaseToken: leased.leaseToken,
      outcome,
      ...(errorCode ? { errorCode } : {}),
      now: clock.now(),
    });
  }

  /** bootstrap ticket 只经秘密注入通道下发（01 §6.2）；库内只持久 hash（02 §5.1）。 */
  async function mintBootstrapTicket(run: CloudRunRecord, operationId: string): Promise<string> {
    const ticket = ids.newSecret();
    await storage.credentials.saveInitial({
      runId: run.runId,
      runGeneration: run.runGeneration,
      credentialHash: await hash.sha256Hex(ticket),
      // 凭据行的有效期 = run 硬期限（修复依据 2026-10-07 真实链路：这行凭据不只是
      // "自举票据"，而是 run 终身的 bridge 身份——旋转只换 hash 不换行；原来按 10 分钟
      // TTL 落库后，bridge 连接存活超过 10 分钟的 run 一旦断线就永远 credential-rejected
      // （expires_at > now 恒假），恢复阶梯走完 exhausted，run 只能等 1h 硬期限收口）。
      // 旋转时 consumeForHello 会把 expires_at 跟随 runs.hard_deadline_at（run 延期不受影响）。
      // 硬期限尚未规划（类型可空）时按 run 时长默认值兜底；首个 hello 就会对齐到真实值。
      expiresAt: run.hardDeadlineAt ?? clock.now() + config.hardRunDurationMs,
      bootstrapOperationId: operationId,
    });
    return ticket;
  }

  async function executeCreate(
    leased: LeasedOperation,
    run: CloudRunRecord,
    signal?: AbortSignal,
  ): Promise<CreateAttemptOutcome> {
    const recipe = run.executionRecipe;
    const providerName = recipe?.provider ?? run.provider;
    const driver = providerName ? await drivers.resolve(providerName) : null;
    if (!driver) {
      // 冻结 recipe 的 provider 不可用：明确失败，不在 worker 中替换 provider（01 §7.3）。
      await settle(leased, "failed", "validation_failed");
      await orchestrator.failProvisioning({
        runId: run.runId,
        runGeneration: run.runGeneration,
        reason: "provider-not-available",
        instanceDispositioned: true,
        termination: "terminated",
      });
      return {
        operationId: leased.operation.operationId,
        outcome: "failed",
        reason: "provider-not-available",
      };
    }

    if (run.stopRequested) {
      // 停止意图优先：create 未发出（attempt=0）时取消意图并确认无资源（08 §8.1）。
      await settle(leased, "failed", "recovery_required");
      await orchestrator.failProvisioning({
        runId: run.runId,
        runGeneration: run.runGeneration,
        reason: "stop-before-create",
        instanceDispositioned: true,
        termination: "terminated",
      });
      return {
        operationId: leased.operation.operationId,
        outcome: "skipped",
        reason: "stop-requested",
      };
    }

    const capabilities = await driver.describeCapabilities();
    if (!capabilities.supportsOutboundWss) {
      await settle(leased, "failed", "resource_unsupported");
      await orchestrator.failProvisioning({
        runId: run.runId,
        runGeneration: run.runGeneration,
        reason: "provider-no-outbound-wss",
        instanceDispositioned: true,
        termination: "terminated",
      });
      return {
        operationId: leased.operation.operationId,
        outcome: "failed",
        reason: "no-outbound-wss",
      };
    }

    // 版本/digest 固定的镜像引用，禁止 latest（01 §5.1 第 2 条）。
    // 模板在接纳期由 `SandboxTemplateResolverPort` 冻结进 recipe，create 只消费冻结事实；
    // 这里的兜底用于老 recipe（无 digest/ref）：仍 fail-closed，不猜默认镜像。
    const imageRef = recipe?.imageDigest ?? recipe?.templateRef;
    if (!imageRef) {
      await settle(leased, "failed", "unsupported_template");
      await orchestrator.failProvisioning({
        runId: run.runId,
        runGeneration: run.runGeneration,
        reason: "template-reference-unfrozen",
        instanceDispositioned: true,
        termination: "terminated",
      });
      return {
        operationId: leased.operation.operationId,
        outcome: "failed",
        reason: "template-unfrozen",
      };
    }

    // checkout 路径唯一计算点（01 §6.2 步骤 2）：创建期下发、持久化、校验 hello。
    const task = await storage.tasks.get(run.taskId);
    const project = task ? await storage.projects.get(task.projectId) : null;
    const workspacePath = project?.repoName ? buildCloudTaskWorkspacePath(project.repoName) : null;
    if (!workspacePath?.ok) {
      // 仓库名不安全/缺失：明确失败，不落临时目录、不回退别的路径（01 §6.2 步骤 2）。
      await settle(leased, "failed", "validation_failed");
      await orchestrator.failProvisioning({
        runId: run.runId,
        runGeneration: run.runGeneration,
        reason: workspacePath ? workspacePath.reason : "project-repository-missing",
        instanceDispositioned: true,
        termination: "terminated",
      });
      return {
        operationId: leased.operation.operationId,
        outcome: "failed",
        reason: "workspace-path-unresolved",
      };
    }

    const ticket = await mintBootstrapTicket(run, leased.operation.operationId);
    // 请求寿命只在接纳期算一次（01 §4.3）：读持久化的 hardDeadlineAt，不重算；
    // 老 run 无该字段时按旧规则兜底一次。
    const requestedDeadline =
      run.hardDeadlineAt ??
      resolveHardDeadline({
        runStartedAt: run.createdAt,
        deploymentBudgetMs: config.hardRunDurationMs,
        providerMaxLifetimeSeconds: capabilities.maxLifetimeSeconds,
      });

    let handle: ProviderSandboxHandle;
    try {
      handle = await driver.create({
        operationKey: createOperationKey(run.runId),
        runId: run.runId,
        runGeneration: run.runGeneration,
        // 非秘密自举要素（01 §6.2 步骤 1/2）：supervisor 在连接前用它拼 bridge.hello；
        // 不走 provider labels（那是 provider 侧对账键），凭据仍只走 bootstrap.config。
        bootstrapAddress: { taskId: run.taskId, workspacePath: workspacePath.path },
        imageRef,
        resources: recipe?.resources ?? { cpu: 2, memoryMiB: 4096, diskGiB: 10 },
        requestedDeadline,
        publicControlPlaneUrl: config.publicControlPlaneUrl,
        bootstrapTicket: ticket,
        // labels 只放额外业务标签：operationKey/runId/runGeneration 是 driver 保留键（由它从
        // 顶层字段自动写入，调用方传会被本地拒绝）。当前没有额外标签 → 空对象。
        labels: {},
        signal: signal ?? new AbortController().signal,
      });
    } catch (error) {
      // 01 §9 / 03 §5 三分类：确定失败立即收口；只有"结果未知"才留 ambiguous 对账。
      const failure = classifyCreateFailure(error);
      const detail = describeCreateError(error);
      if (failure.definite) {
        await settle(leased, "failed", failure.code);
        await orchestrator.failProvisioning({
          runId: run.runId,
          runGeneration: run.runGeneration,
          reason: failure.reason,
          instanceDispositioned: true,
          termination: "terminated",
          lastError: detail,
        });
        cloudCoreLogger.warn(undefined, "cloud create rejected definitively", {
          runId: run.runId,
          operationId: leased.operation.operationId,
          code: failure.code,
          detail,
        });
        return {
          operationId: leased.operation.operationId,
          outcome: "failed",
          reason: failure.reason,
        };
      }

      // 抛错不等于失败：网络超时/结果未知必须走 provider 对账，不自动第二次 create（03 §5）。
      let reconciliation: CreateReconciliation;
      try {
        reconciliation = await driver.findCreateResult(createOperationKey(run.runId), {
          // C-3（定稿附录 6）：对账必须带持久锚点——operation 行的 createdAt 是跨重启
          // 可用的 create 尝试时间；没有它，「查不到」无法安全判 notFound（01 §4.1）。
          operationAttemptedAtMs: leased.operation.createdAt,
        });
      } catch (reconcileError) {
        // 对账本身失败（网络/权限）：保留 unknown 语义等下一次租约重试，不猜也不丢文本。
        const reconcileDetail = describeCreateError(reconcileError);
        await settle(leased, "ambiguous", "provider_create_unknown");
        cloudCoreLogger.warn(undefined, "cloud create reconciliation failed", {
          runId: run.runId,
          operationId: leased.operation.operationId,
          detail: reconcileDetail,
        });
        return {
          operationId: leased.operation.operationId,
          outcome: "unknown",
          reason: "create-unknown",
        };
      }
      if (reconciliation.status === "created") {
        return await persistRunHandle({
          driver,
          leased,
          run,
          handle: reconciliation.handle,
          deadlineSource: capabilities.deadlineSource,
          workspacePath: workspacePath.path,
          bootstrapTicket: ticket,
          storage,
          clock,
          config,
          compensation,
          gitGrants,
          settle: (outcome, errorCode) => settle(leased, outcome, errorCode),
        });
      }
      if (reconciliation.status === "notFound") {
        await settle(leased, "failed", "bootstrap_failed");
        await orchestrator.failProvisioning({
          runId: run.runId,
          runGeneration: run.runGeneration,
          reason: "create-failed",
          instanceDispositioned: true,
          termination: "terminated",
          lastError: detail,
        });
        return {
          operationId: leased.operation.operationId,
          outcome: "failed",
          reason: "create-failed",
        };
      }
      await settle(leased, "ambiguous", "provider_create_unknown");
      cloudCoreLogger.warn(undefined, "cloud create result unknown", {
        runId: run.runId,
        operationId: leased.operation.operationId,
        detail,
      });
      return {
        operationId: leased.operation.operationId,
        outcome: "unknown",
        reason: "create-unknown",
      };
    }
    return await persistRunHandle({
      driver,
      leased,
      run,
      handle,
      deadlineSource: capabilities.deadlineSource,
      workspacePath: workspacePath.path,
      bootstrapTicket: ticket,
      storage,
      clock,
      config,
      compensation,
      gitGrants,
      settle: (outcome, errorCode) => settle(leased, outcome, errorCode),
    });
  }

  return {
    async runCreateOnce(input = {}) {
      // 迁移未就绪/不可写时不得开始 provider 操作（03 §8 启动顺序、§4「不返回已接受」）。
      const readiness = await storage.readiness();
      if (!readiness.writable || readiness.lastAppliedMigrationId === null) {
        cloudCoreLogger.warn(undefined, "cloud provisioning paused: storage not ready", {
          writable: readiness.writable,
          migration: readiness.lastAppliedMigrationId,
        });
        return null;
      }
      const leaseMs = input.leaseMs ?? 60_000;
      const leased = await operations.leaseNext({
        kinds: ["create"],
        workerId: input.workerId ?? "cloud-provisioning",
        leaseMs,
        now: clock.now(),
      });
      if (!leased) return null;
      const run = leased.operation.runId ? await storage.runs.get(leased.operation.runId) : null;
      // C-3：create 全程持有租约（provider create 可能 60s+）。执行期间周期续租，
      // 租约不再到期 → 第二个 worker 无法领取同一 create（迟到分配的根源被闭合，
      // lifecycleLoops 的双 scope 并发因此无害）。结算后/令牌丢失时续租自然失败退出。
      const keepalive = startOperationLeaseKeepalive({
        operations,
        clock,
        operationId: leased.operation.operationId,
        leaseToken: leased.leaseToken,
        leaseMs,
        onLost: () => {
          cloudCoreLogger.warn(undefined, "cloud create lease lost during execution", {
            runId: run?.runId,
            operationId: leased.operation.operationId,
          });
        },
      });
      try {
        if (!run) {
          await settle(leased, "failed", "validation_failed");
          return {
            operationId: leased.operation.operationId,
            outcome: "failed",
            reason: "run-missing",
          };
        }
        if (run.runGeneration !== leased.operation.runGeneration) {
          await settle(leased, "failed", "stale");
          return {
            operationId: leased.operation.operationId,
            outcome: "skipped",
            reason: "stale-generation",
          };
        }
        if (run.status !== "provisioning") {
          // 已是终态/已 ready：迟到 create 不复活 run（08 §3.2）。
          await settle(leased, "failed", "stale");
          return {
            operationId: leased.operation.operationId,
            outcome: "skipped",
            reason: "run-not-provisioning",
          };
        }
        return await executeCreate(leased, run, input.signal);
      } finally {
        await keepalive.stop();
      }
    },
  };
}
