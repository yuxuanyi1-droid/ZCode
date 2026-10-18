/**
 * create 操作执行与恢复（01 §5.1 接受与创建、§5.3 启动对账、03 §5 外部操作不是事务、
 * 08 §6/§8.1 停止屏障对创建的影响）。
 *
 * 关键规则：
 * - 领取操作前检查当前代际与 stopRequested（01 §5.1 第 2 条、08 §8.1）：停止意图优先，
 *   迟到 handle 只能进入清理，回调不能发布 ready 或启动 Agent。
 * - 使用 Run recipe 中冻结的 provider/模板/资源与配置，不读取新部署默认值（01 §5.1 第 2 条）。
 * - **同 run 的 driver.create 最多一次**（R1）：run 已有 providerHandle 时禁止再 create，
 *   直接进入统一恢复/启动；create 重试（attempt > 1）或上次 ambiguous 时必须先按
 *   operationKey `findCreateResult`（锚点 = operation.createdAt），created → 恢复，
 *   unknown → 保持 ambiguous，只有 notFound 才允许 create（01 §4.1、03 §5）。
 * - create 结果未知进对账（按 operationKey），不自动第二次 create（03 §5、01 §4.1）。
 * - create 成功立即持久 handle/deadline，再等 bridge（01 §5.1 第 3 条）。
 * - DB 失败/本地校验失败不建资源（01 §5.1 尾段）。
 */
import { type CloudErrorCode, type CloudRunRecord } from "@zcode/shared";
import { createOperationKey } from "../../domain/idempotency.js";
import { resolveHardDeadline } from "../../domain/savePolicy.js";
import type { CloudCoreDeps } from "../deps.js";
import { cloudCoreLogger } from "../logger.js";
import { startOperationLeaseKeepalive } from "./leaseKeepalive.js";
import type { LeasedOperation } from "../ports/operationOutboxPort.js";
import type { RunCompensation } from "./compensation.js";
import type { RunOrchestrator } from "../runOrchestrator.js";
import { persistRunHandle, type CreateAttemptOutcome } from "./handlePersistence.js";
import {
  createRunHandleEstablisher,
  createSandboxOrReconcile,
  mintRunBootstrapTicket,
  persistedProviderHandle,
  reconcileCreateBeforeRetry,
  resolveRunWorkspacePath,
} from "./recoverHandle.js";
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
  const { storage, operations, drivers, clock, config } = deps;
  // create 正常路径、对账恢复、startup/readiness 共用同一 handle 恢复/启动实现（R1）。
  const establish = createRunHandleEstablisher(deps, compensation, gitGrants);

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

  /** 确定失败的统一收口：结算 operation + run 收口（instance 已确认处置）。 */
  async function failAttempt(input: {
    leased: LeasedOperation;
    run: CloudRunRecord;
    code: CloudErrorCode;
    reason: string;
    outcomeReason?: string;
    detail?: string;
    skipped?: boolean;
  }): Promise<CreateAttemptOutcome> {
    await settle(input.leased, "failed", input.code);
    await orchestrator.failProvisioning({
      runId: input.run.runId,
      runGeneration: input.run.runGeneration,
      reason: input.reason,
      instanceDispositioned: true,
      termination: "terminated",
      ...(input.detail ? { lastError: input.detail } : {}),
    });
    return {
      operationId: input.leased.operation.operationId,
      outcome: input.skipped ? "skipped" : "failed",
      reason: input.outcomeReason ?? input.reason,
    };
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
      return await failAttempt({
        leased,
        run,
        code: "validation_failed",
        reason: "provider-not-available",
      });
    }

    if (run.stopRequested) {
      // 停止意图优先：create 未发出（attempt=0）时取消意图并确认无资源（08 §8.1）。
      return await failAttempt({
        leased,
        run,
        code: "recovery_required",
        reason: "stop-before-create",
        outcomeReason: "stop-requested",
        skipped: true,
      });
    }

    // checkout 路径唯一计算点（01 §6.2 步骤 2）：创建期下发、持久化、校验 hello。
    // 恢复场景优先复用已持久事实；缺失时按 project.repoName 重算（与创建期同一计算点）。
    const workspacePath = await resolveRunWorkspacePath(storage, run);
    if (!workspacePath.ok) {
      // 仓库名不安全/缺失：明确失败，不落临时目录、不回退别的路径（01 §6.2 步骤 2）。
      return await failAttempt({
        leased,
        run,
        code: "validation_failed",
        reason:
          workspacePath.reason === "project-repository-missing"
            ? "project-repository-missing"
            : "repo-name-unresolved",
        outcomeReason: "workspace-path-unresolved",
      });
    }

    // 幂等优先（R1）：run 已有 providerHandle 说明上一次 create 已成功，只是 handle 落库后
    // supervisor/结算未完成。禁止再次 create，直接进入统一恢复/启动路径。
    if (run.providerHandle) {
      const capabilities = await driver.describeCapabilities();
      return await persistRunHandle({
        establish,
        driver,
        leased,
        run,
        handle: persistedProviderHandle(run, run.providerHandle),
        deadlineSource: capabilities.deadlineSource,
        workspacePath: workspacePath.path,
        settle: (outcome, errorCode) => settle(leased, outcome, errorCode),
      });
    }

    const capabilities = await driver.describeCapabilities();
    if (!capabilities.supportsOutboundWss) {
      return await failAttempt({
        leased,
        run,
        code: "resource_unsupported",
        reason: "provider-no-outbound-wss",
        outcomeReason: "no-outbound-wss",
      });
    }

    // 版本/digest 固定的镜像引用，禁止 latest（01 §5.1 第 2 条）。
    // 模板在接纳期由 `SandboxTemplateResolverPort` 冻结进 recipe，create 只消费冻结事实；
    // 这里的兜底用于老 recipe（无 digest/ref）：仍 fail-closed，不猜默认镜像。
    const imageRef = recipe?.imageDigest ?? recipe?.templateRef;
    if (!imageRef) {
      return await failAttempt({
        leased,
        run,
        code: "unsupported_template",
        reason: "template-reference-unfrozen",
        outcomeReason: "template-unfrozen",
      });
    }

    // create 重试/上次 ambiguous（R1）：provider 可能已经建好资源，只是 handle 没落库。
    // 先按 operationKey 对账（锚点取 operation.createdAt），只有 notFound 才允许 create。
    const needsReconciliation =
      leased.operation.attempt > 1 ||
      leased.operation.state === "ambiguous" ||
      leased.operation.errorCode === "provider_create_unknown";
    if (needsReconciliation) {
      const reconciliation = await reconcileCreateBeforeRetry({
        driver,
        runId: run.runId,
        operationAttemptedAtMs: leased.operation.createdAt,
      });
      if (reconciliation.status === "created") {
        // provider 已有该 operationKey 的资源：走统一恢复/启动，绝不再次 create。
        return await persistRunHandle({
          establish,
          driver,
          leased,
          run,
          handle: reconciliation.handle,
          deadlineSource: capabilities.deadlineSource,
          workspacePath: workspacePath.path,
          settle: (outcome, errorCode) => settle(leased, outcome, errorCode),
        });
      }
      if (reconciliation.status === "unknown") {
        await settle(leased, "ambiguous", "provider_create_unknown");
        cloudCoreLogger.warn(undefined, "cloud create result unknown before retry", {
          runId: run.runId,
          operationId: leased.operation.operationId,
          detail: reconciliation.detail,
        });
        return {
          operationId: leased.operation.operationId,
          outcome: "unknown",
          reason: "create-unknown",
        };
      }
      // notFound：provider 明确没有该 operationKey 的资源，才允许发起（唯一一次）create。
      cloudCoreLogger.info(undefined, "cloud create retry after notFound reconciliation", {
        runId: run.runId,
        operationId: leased.operation.operationId,
        attempt: leased.operation.attempt,
      });
    }

    const ticket = await mintRunBootstrapTicket(deps, run, leased.operation.operationId);
    // 请求寿命只在接纳期算一次（01 §4.3）：读持久化的 hardDeadlineAt，不重算；
    // 老 run 无该字段时按旧规则兜底一次。
    const requestedDeadline =
      run.hardDeadlineAt ??
      resolveHardDeadline({
        runStartedAt: run.createdAt,
        deploymentBudgetMs: config.hardRunDurationMs,
        providerMaxLifetimeSeconds: capabilities.maxLifetimeSeconds,
      });

    const attempt = await createSandboxOrReconcile({
      driver,
      runId: run.runId,
      operationAttemptedAtMs: leased.operation.createdAt,
      createInput: {
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
        // 保留键由 driver 从顶层字段写入；当前没有额外标签 → 空对象。
        labels: {},
        signal: signal ?? new AbortController().signal,
      },
    });
    if (attempt.status === "failed") {
      cloudCoreLogger.warn(undefined, "cloud create rejected definitively", {
        runId: run.runId,
        operationId: leased.operation.operationId,
        code: attempt.code,
        detail: attempt.detail,
      });
      return await failAttempt({
        leased,
        run,
        code: attempt.code,
        reason: attempt.reason,
        detail: attempt.detail,
      });
    }
    if (attempt.status === "created" || attempt.status === "reconciled") {
      return await persistRunHandle({
        establish,
        driver,
        leased,
        run,
        handle: attempt.handle,
        deadlineSource: capabilities.deadlineSource,
        workspacePath: workspacePath.path,
        bootstrapTicket: ticket,
        settle: (outcome, errorCode) => settle(leased, outcome, errorCode),
      });
    }
    if (attempt.status === "notFound") {
      return await failAttempt({
        leased,
        run,
        code: "bootstrap_failed",
        reason: "create-failed",
        detail: attempt.detail,
      });
    }
    // 结果未知：保持 ambiguous 等下一次租约对账，绝不自动第二次 create（03 §5）。
    await settle(leased, "ambiguous", "provider_create_unknown");
    cloudCoreLogger.warn(undefined, "cloud create result unknown", {
      runId: run.runId,
      operationId: leased.operation.operationId,
      detail: attempt.detail,
    });
    return {
      operationId: leased.operation.operationId,
      outcome: "unknown",
      reason: "create-unknown",
    };
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
