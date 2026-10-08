/**
 * Modal 沙箱 driver（specs/cloud-agent/01 §4 Provider contract）：实现 SandboxDriverPort。
 *
 * 通道（01 §6.2 实施决议）：Modal 官方只提供 Python/JS/Go SDK（gRPC），没有文档化的
 * HTTP/REST 沙箱 API；本 driver 以**官方 Python SDK 为调用面**，经受控一次性子进程桥
 * （modalSdkBridge.ts + modal/modal_bridge.py）完成 create/exec/terminate/inspect/list——
 * 不手写 gRPC、不伪造能力。未注入桥时退回**门禁降级**（create 本地确定性拒绝，不发起
 * provider 请求、不占 quota）；两条路径的能力声明分开（capabilities.ts）。
 *
 * 三分支语义（与 e2bDriver/daytonaDriver 一致，差异不抹平）：成功返回 handle（不含
 * attach 凭据）；桥报告 definite=true（校验/依赖缺失/镜像构建失败/provider 拒绝）→ 抛
 * 归一错误（调桥前先做本地校验）；definite=false（网络/服务超时）或进程级失败（超时被杀/
 * 无响应行/abort）→ provider_create_unknown，由控制面按 operationKey 对账，禁止盲目二次 create。
 *
 * 能力边界（01 §4.2，如实声明）：
 * - `deadlineSource=estimated`：create 的硬超时由 provider 执行，但没有 provider 返回的
 *   期限时间戳 → 记 estimate，不写成 providerDeadline；
 * - `canExtendDeadline=false`：官方无运行中改 timeout 的通道 → 返回 `unsupported`，
 *   首建到硬上限、由控制面按 idle 提前回收（01 §4.3）；
 * - 沙箱生命周期 = 镜像 CMD（必须常驻/阻塞占位）+ create timeout；不设 idle_timeout。
 */
import { createServiceLogger } from "@zcode/services/node";
import type {
  CreateReconciliation,
  DeadlineResult,
  ProviderObservation,
  ProviderSandboxHandle,
  SandboxCreateInput,
  SandboxDriverPort,
  TerminationObservation,
} from "../../app/ports/sandboxDriverPort.js";
import { CloudAdapterError, type CloudAdapterLogger } from "./adapterError.js";
import {
  describeCapabilities,
  MODAL_GATED_CAPABILITIES,
  unsupportedPauseResume,
  MODAL_SDK_CHANNEL_CAPABILITIES,
  resolveEffectiveMaxLifetimeSeconds,
  type SandboxLifetimeOptions,
} from "./capabilities.js";
import { launchModalSupervisor } from "./modalBootstrap.js";
import {
  buildModalTags,
  modalBridgeDefiniteError,
  modalBridgeUnknownOutcome,
  MODAL_DEFAULT_APP_NAME,
  type ModalSdkBridge,
} from "./modalSdkBridge.js";
import {
  boundEvidence,
  createCreateAttemptAnchors,
  createReconcileUnknown,
  resolveCreateReconciliation,
} from "./reconcile.js";
import type { SupervisorStartInput, SupervisorStarter } from "./sandboxSupervisorStart.js";

export const MODAL_PROVIDER = "modal";

/** create 结果对账窗口：窗口内「清单查不到」不足以判定未创建（01 §4.1）。 */
export const MODAL_DEFAULT_RECONCILIATION_WINDOW_MS = 300_000;
const DEFAULT_WORKDIR = "/workspace";

export interface ModalDriverOptions extends SandboxLifetimeOptions {
  /** SDK 子进程桥（modalSdkBridge.ts）：唯一的 Modal 控制面通道；未注入 → 门禁降级。 */
  bridge?: ModalSdkBridge;
  /** 模板镜像来源（01 §6.2）：显式 dockerfile 优先，其次 templateDir 内 Dockerfile。 */
  imageDockerfile?: string;
  templateDir?: string;
  imageContextDir?: string;
  /** Modal App 名（沙箱必须归属 App；缺省 zcode-cloud-agent）。 */
  appName?: string;
  /** 沙箱工作目录（缺省 /workspace，01 §6.2 步骤 2 的 workspacePath 根）。 */
  workdir?: string;
  createReconciliationWindowMs?: number;
  /** 测试注入的 supervisor 启动器（缺省按 bridge 选通道/门禁）。 */
  startSupervisor?: SupervisorStarter;
  /** 测试注入的退避等待（supervisor 启动重试）。 */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: CloudAdapterLogger;
}

export function createModalSandboxDriver(options: ModalDriverOptions): SandboxDriverPort {
  const now = options.now ?? Date.now;
  const logger = options.logger ?? createServiceLogger("cloud-sandbox-modal");
  const bridge = options.bridge;
  const reconciliationWindowMs =
    options.createReconciliationWindowMs ?? MODAL_DEFAULT_RECONCILIATION_WINDOW_MS;
  const appName = options.appName?.trim() || MODAL_DEFAULT_APP_NAME;
  const workdir = options.workdir?.trim() || DEFAULT_WORKDIR;
  const createAnchors = createCreateAttemptAnchors(now);
  const supervisorOptions = {
    bridge,
    ...(options.startSupervisor === undefined ? {} : { startSupervisor: options.startSupervisor }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    logger,
  };

  /**
   * 镜像来源解析：显式 Dockerfile 优先，其次模板目录内 Dockerfile。缺配置 →
   * validation_failed（不猜默认镜像、不回落 registry 基础镜像）。
   */
  function resolveImageDockerfile(): { dockerfile: string; contextDir?: string } {
    const explicit = options.imageDockerfile?.trim();
    const templateDir = options.templateDir?.trim();
    const dockerfile = explicit || (templateDir ? `${templateDir}/Dockerfile` : "");
    if (!dockerfile) {
      throw new CloudAdapterError(
        "validation_failed",
        "modal template image is not configured; set the modal image dockerfile path or template dir in the deployment config",
        { provider: "modal" },
      );
    }
    const contextDir = options.imageContextDir?.trim();
    return contextDir ? { dockerfile, contextDir } : { dockerfile };
  }

  /** 期限换算：请求 epoch 毫秒 → provider timeout 秒（取生效上限较小值，01 §4.3 修订）。 */
  async function clampTimeoutSeconds(requestedDeadline: number): Promise<number> {
    const requested = Math.floor((requestedDeadline - now()) / 1000);
    const cap = await resolveEffectiveMaxLifetimeSeconds(options);
    return cap !== undefined ? Math.min(requested, cap) : requested;
  }

  /** 补偿终止探测：桥已确认（ok / not_found）才算已清理（01 §5.1）。 */
  const terminateProbe = async (sandboxId: string): Promise<{ ok: boolean; status: number }> => {
    if (!bridge) return { ok: false, status: 0 };
    const outcome = await bridge.call("terminate", { sandboxId });
    if (outcome.ok) return { ok: true, status: 200 };
    if (outcome.failure.kind === "bridge" && outcome.failure.code === "not_found") {
      return { ok: true, status: 404 };
    }
    return { ok: false, status: 0 };
  };

  return {
    async describeCapabilities() {
      return describeCapabilities(
        bridge ? MODAL_SDK_CHANNEL_CAPABILITIES : MODAL_GATED_CAPABILITIES,
        options.maxLifetimeSeconds,
      );
    },

    async create(input: SandboxCreateInput): Promise<ProviderSandboxHandle> {
      if (!bridge) {
        // 门禁降级（无通道）：本地确定性拒绝，不发起任何 provider 请求、不占 quota
        // （01 §9）；不伪造成功、不静默留裸沙箱。
        logger.warn(undefined, "modal create gated: no sdk bridge configured", {
          operationKey: input.operationKey,
        });
        throw new CloudAdapterError(
          "resource_unsupported",
          "modal sdk bridge is not configured; create is gated (no provider request issued)",
          { provider: "modal", operationKey: input.operationKey },
        );
      }
      // 本地校验先于任何 provider 调用：确定失败不得被网络分支改判未知（01 §4.1）。
      const image = resolveImageDockerfile();
      const timeoutSeconds = await clampTimeoutSeconds(input.requestedDeadline);
      if (timeoutSeconds < 1) {
        throw new CloudAdapterError("validation_failed", "requested deadline already elapsed", {
          requestedDeadline: input.requestedDeadline,
        });
      }
      const tags = buildModalTags(input);
      createAnchors.record(input.operationKey);
      const outcome = await bridge.call(
        "create",
        {
          appName,
          image,
          timeoutSeconds,
          workdir,
          tags,
          // 资源请求：Modal 以请求值调度与计费；非法值由 provider 明确拒绝。
          cpu: input.resources.cpu,
          memoryMiB: input.resources.memoryMiB,
        },
        { signal: input.signal },
      );
      if (!outcome.ok) {
        // definite = 明确失败（未创建，可安全重试）；否则结果未知 → 必须先对账。
        if (outcome.failure.definite) {
          logger.warn(undefined, "modal create rejected", {
            operationKey: input.operationKey,
            reason: outcome.failure.reason,
            stage: outcome.failure.stage,
          });
          throw modalBridgeDefiniteError("create", outcome.failure);
        }
        throw modalBridgeUnknownOutcome("create", outcome.failure);
      }
      const sandboxId = asNonEmptyString(outcome.result["sandboxId"]);
      if (!sandboxId) {
        // 桥成功但无 sandboxId：无法建立 handle，按未知处理交给对账。
        throw modalBridgeUnknownOutcome("create", {
          kind: "protocol",
          code: "provider_unreachable",
          definite: false,
          reason: "missing-sandbox-id",
        });
      }
      logger.info(undefined, "modal sandbox created", {
        operationKey: input.operationKey,
        runId: input.runId,
        sandboxId,
      });
      const sha = asNonEmptyString(outcome.result["dockerfileSha256"]);
      return {
        provider: MODAL_PROVIDER,
        sandboxId,
        // 镜像内容版本：Dockerfile 内容 sha256（Modal 端镜像 id 只由 SDK 内部持有）。
        templateRevision: sha
          ? `modal-dockerfile@sha256:${sha.slice(0, 16)}`
          : input.imageRef.trim(),
        // 期限是估计（无 provider 返回的期限时间戳），不写成 providerDeadline。
        deadlineEstimate: now() + timeoutSeconds * 1000,
      };
    },

    /**
     * 拉起沙箱内 supervisor（01 §6.2）：控制面在 `persistHandle()` **成功之后**调用，
     * create 正常路径与对账恢复路径都要调（否则沙箱活着但没人回连）。幂等由镜像内
     * start-supervisor.sh 的 flock 分支保证；失败（含输入非法）→ 补偿终止 + 带原因的确定错误。
     */
    async startSupervisor(
      handle: ProviderSandboxHandle,
      startInput: SupervisorStartInput,
    ): Promise<void> {
      await launchModalSupervisor(supervisorOptions, terminateProbe, handle.sandboxId, startInput);
    },

    async findCreateResult(
      operationKey: string,
      options?: { operationAttemptedAtMs?: number },
    ): Promise<CreateReconciliation> {
      if (!bridge) {
        // 无通道：无法向 provider 求证（可能是历史部署建的资源）→ 保守返回 unknown，
        // 由运营确认，不推测「未创建」（01 §4.1）。
        logger.warn(undefined, "modal create reconciliation unavailable: no sdk bridge", {
          operationKey,
        });
        return createReconcileUnknown();
      }
      // 按 tags.operationKey 查询（服务端 tag 过滤）。**语义边界**：官方 Sandbox.list
      // 固定 include_finished=False，只能看到仍在运行的沙箱——「无结果」证明的是
      // 「没有存活资源」，不是「从未创建」。因此未命中时仍按对账窗口判定，窗口内
      // 返回 unknown（防止在途 create 被二次提交）。
      const outcome = await bridge.call("list", { appName, tags: { operationKey } });
      if (!outcome.ok) {
        logger.warn(undefined, "modal create reconciliation query unavailable", {
          operationKey,
          reason: outcome.failure.reason,
        });
        return createReconcileUnknown();
      }
      const ids = Array.isArray(outcome.result["sandboxes"])
        ? outcome.result["sandboxes"].filter(
            (item): item is string => typeof item === "string" && item.length > 0,
          )
        : [];
      const sandboxId = ids[0];
      return resolveCreateReconciliation(
        sandboxId ? { provider: MODAL_PROVIDER, sandboxId } : undefined,
        {
          // 控制面持久的尝试时间优先（跨重启可用）；进程内锚点只是兜底。
          durableAttemptedAtMs: options?.operationAttemptedAtMs,
          localAttemptedAtMs: createAnchors.resolve(operationKey),
          windowMs: reconciliationWindowMs,
          now: now(),
        },
      );
    },

    async inspect(handle: ProviderSandboxHandle): Promise<ProviderObservation> {
      if (!bridge) {
        // 无通道：能力错误如实返回，不推测资源存活状态。
        return {
          status: "unknown",
          observedAt: now(),
          evidenceSource: "none",
          evidence: boundEvidence("modal inspect gated: no sdk bridge"),
          errorCode: "resource_unsupported",
        };
      }
      const outcome = await bridge.call("inspect", { sandboxId: handle.sandboxId });
      if (!outcome.ok) {
        // 网络/权限丢失一律 unknown，不是 notFound（01 §4.1）。
        const authLost =
          outcome.failure.code === "unauthenticated" ||
          outcome.failure.code === "permission_revoked";
        // 证据只含失败类别与固定 reason 词表，不含请求体/凭据。
        const evidence = boundEvidence(
          `modal inspect ${outcome.failure.kind}:${outcome.failure.reason}`,
        );
        logger.warn(undefined, "modal inspect unavailable", {
          sandboxId: handle.sandboxId,
          evidence,
        });
        return {
          status: "unknown",
          observedAt: now(),
          evidenceSource: outcome.failure.kind === "bridge" ? "provider-api" : "none",
          evidence,
          errorCode: authLost ? "permission_revoked" : "provider_unreachable",
        };
      }
      const status = asNonEmptyString(outcome.result["status"]);
      // 桥报告的 provider 证据（如 "modal poll -> exit 137"）；缺失时回落状态名。
      const evidence = boundEvidence(
        asNonEmptyString(outcome.result["evidence"]) ??
          `modal inspect status=${status ?? "missing"}`,
      );
      if (status === "running") {
        return { status: "running", observedAt: now(), evidenceSource: "provider-api", evidence };
      }
      if (status === "stopped") {
        return { status: "stopped", observedAt: now(), evidenceSource: "provider-api", evidence };
      }
      if (status === "not_found") {
        return { status: "notFound", observedAt: now(), evidenceSource: "provider-api", evidence };
      }
      // 未映射的桥状态不猜测：unknown，证据留给运营核对。
      logger.warn(undefined, "modal inspect returned unmapped status", {
        sandboxId: handle.sandboxId,
        evidence,
      });
      return {
        status: "unknown",
        observedAt: now(),
        evidenceSource: "provider-api",
        evidence,
        errorCode: "provider_unreachable",
      };
    },

    async extendDeadline(): Promise<DeadlineResult> {
      // Modal 不支持运行中续期（01 §4.2 差异表：create timeout 不能等价运行中续期）
      // → 返回能力事实，不伪造成功（01 §4.1）。
      return { status: "unsupported" };
    },

    async terminate(handle: ProviderSandboxHandle): Promise<TerminationObservation> {
      // 终止证据与 inspect 同口径（有界、非敏感）：TerminationObservation 契约里没有
      // evidence 字段，因此证据经结构化日志留存供运营核对（01 §9）。
      // 过渡形态：W0 已裁决给 TerminationObservation 加可选有界 evidence，冻结后改返回值。
      if (!bridge) {
        // 无通道：显式能力错误，不伪造已终止（槽位与配额保持占用，01 §9）。
        logger.warn(undefined, "modal terminate gated: no sdk bridge configured", {
          sandboxId: handle.sandboxId,
          evidence: boundEvidence("modal terminate gated: no sdk bridge"),
        });
        return { status: "unknown", errorCode: "resource_unsupported" };
      }
      const outcome = await bridge.call("terminate", { sandboxId: handle.sandboxId });
      if (outcome.ok) {
        const notFound = outcome.result["notFound"] === true;
        const exitCode = outcome.result["exitCode"];
        logger.info(undefined, "modal sandbox terminated", {
          sandboxId: handle.sandboxId,
          evidence: boundEvidence(
            notFound
              ? "modal terminate -> not-found"
              : `modal terminate -> exitCode=${typeof exitCode === "number" ? exitCode : "unknown"}`,
          ),
        });
        return { status: "terminated" };
      }
      if (outcome.failure.kind === "bridge" && outcome.failure.code === "not_found") {
        // provider 确认资源不存在 → 释放计费槽（与 E2B/Daytona 的 404 同语义）。
        return { status: "terminated" };
      }
      if (outcome.failure.kind === "bridge" && outcome.failure.definite) {
        // provider 明确拒绝（权限/配额/请求非法）：资源确认仍在，保留槽位与原因。
        logger.warn(undefined, "modal terminate rejected", {
          sandboxId: handle.sandboxId,
          evidence: boundEvidence(`modal terminate ${outcome.failure.reason} rejected`),
          errorCode: outcome.failure.code,
        });
        return { status: "notTerminated", errorCode: outcome.failure.code };
      }
      // 终止结果未知：保留计费槽与 cleanup operation（01 §9），不写成失败。
      logger.warn(undefined, "modal terminate result unknown", {
        sandboxId: handle.sandboxId,
        evidence: boundEvidence(
          `modal terminate ${outcome.failure.kind}:${outcome.failure.reason}`,
        ),
      });
      return { status: "unknown", errorCode: "provider_termination_unknown" };
    },

    // Modal 不支持 pause/resume（01 §4.2 修订：目标值 none，终态走 reopen）。
    ...unsupportedPauseResume("modal"),
  };
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
