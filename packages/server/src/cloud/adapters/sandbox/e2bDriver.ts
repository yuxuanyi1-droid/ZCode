/**
 * E2B 沙箱 driver（specs/cloud-agent/01 §4 Provider contract）：实现 SandboxDriverPort。
 * 传输与归一在 e2bRest.ts / sandboxRest.ts；本文件只承载三分支语义：成功返回 handle（不含
 * attach 凭据）；4xx 等可判定「未创建」→ 抛归一错误；网络/中断/5xx → provider_create_unknown，
 * 不写成失败，由控制面按 operationKey 对账（01 §4.1、03 §5）。差异（01 §4.2）：模板固定
 * runtime/资源；`timeout` 是 provider 确认的期限（可续期）但不无限，账号上限由
 * `maxLifetimeSeconds` 收敛、未核实不虚构。
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
import { E2B_SANDBOX_CAPABILITIES, describeCapabilities } from "./capabilities.js";
import { launchE2bSupervisor } from "./e2bBootstrap.js";
import {
  asRecord,
  asString,
  mapE2bSandboxState,
  readProviderRejectionMessage,
  E2B_DEFAULT_BASE_URL,
  E2B_DEFAULT_REQUEST_TIMEOUT_MS,
  E2B_GET_RETRY_ATTEMPTS,
  E2B_PATH_CREATE,
  E2B_PATH_LIST,
  E2B_PATH_SANDBOX,
  E2B_PATH_TIMEOUT,
  E2B_TIMEOUT_BODY_FIELD,
  createE2bRestClient,
  createE2bTerminateProbe,
  isAbortLike,
  isDefiniteRejection,
  type SandboxFetch,
} from "./e2bRest.js";
import {
  boundEvidence,
  buildReconcileLabels,
  createCreateAttemptAnchors,
  createReconcileUnknown,
  matchesOperationKey,
  resolveCreateReconciliation,
} from "./reconcile.js";
import type { SupervisorStartInput, SupervisorStarter } from "./sandboxSupervisorStart.js";

export const E2B_PROVIDER = "e2b";

/** create 结果对账窗口：窗口内「清单查不到」不足以判定未创建（01 §4.1）。 */
export const E2B_DEFAULT_RECONCILIATION_WINDOW_MS = 300_000;

export interface E2bDriverOptions {
  /** provider API key 经注入函数读取；绝不进 URL、日志或 metadata。 */
  apiKey: () => string | Promise<string>;
  baseUrl?: string;
  fetch?: SandboxFetch;
  now?: () => number;
  requestTimeoutMs?: number;
  /** 账号计划核实的生命周期上限（秒）；未核实保持 undefined（不虚构上限）。 */
  maxLifetimeSeconds?: number;
  createReconciliationWindowMs?: number;
  /** supervisor 即时失败探测窗口（毫秒；缺省 3s，见 e2bBootstrap）。 */
  probeWindowMs?: number;
  /** 测试注入的 supervisor 启动器（缺省官方 SDK envd 通道 + 即时失败探测）。 */
  startSupervisor?: SupervisorStarter;
  logger?: CloudAdapterLogger;
}

export function createE2bSandboxDriver(options: E2bDriverOptions): SandboxDriverPort {
  const now = options.now ?? Date.now;
  const logger = options.logger ?? createServiceLogger("cloud-sandbox-e2b");
  const rest = createE2bRestClient({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl ?? E2B_DEFAULT_BASE_URL,
    requestTimeoutMs: options.requestTimeoutMs ?? E2B_DEFAULT_REQUEST_TIMEOUT_MS,
    fetch: options.fetch,
    logger,
  });
  const reconciliationWindowMs =
    options.createReconciliationWindowMs ?? E2B_DEFAULT_RECONCILIATION_WINDOW_MS;
  const createAnchors = createCreateAttemptAnchors(now);
  const supervisorOptions = {
    apiKey: options.apiKey,
    ...(options.startSupervisor === undefined ? {} : { startSupervisor: options.startSupervisor }),
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.probeWindowMs === undefined ? {} : { probeWindowMs: options.probeWindowMs }),
    logger,
  };

  /** 期限换算：请求的 epoch 毫秒 → provider 的 timeout 秒（取上限较小值）。 */
  function clampTimeoutSeconds(requestedDeadline: number): number {
    const requested = Math.floor((requestedDeadline - now()) / 1000);
    // provider 能力上限收敛（01 §4.3）：可用期取请求与已核实上限较小值。
    return options.maxLifetimeSeconds !== undefined
      ? Math.min(requested, options.maxLifetimeSeconds)
      : requested;
  }

  return {
    async describeCapabilities() {
      return describeCapabilities(E2B_SANDBOX_CAPABILITIES, options.maxLifetimeSeconds);
    },

    async create(input: SandboxCreateInput): Promise<ProviderSandboxHandle> {
      // create 前本地校验（01 §9）：latest / 已过期请求在本地拒绝，不占 quota。
      const imageRef = input.imageRef.trim();
      if (imageRef.endsWith(":latest") || imageRef === "latest") {
        throw new CloudAdapterError("unsupported_template", "imageRef must not use latest", {
          imageRefLen: imageRef.length,
        });
      }
      const timeoutSeconds = clampTimeoutSeconds(input.requestedDeadline);
      if (timeoutSeconds < 1) {
        throw new CloudAdapterError("validation_failed", "requested deadline already elapsed", {
          requestedDeadline: input.requestedDeadline,
        });
      }
      const requestBody = {
        templateID: imageRef,
        // metadata 只含 operationKey/runId/runGeneration 与调用方标签（01 §4.1）：
        // 不含 prompt、用户内容或凭据。
        metadata: buildReconcileLabels(input, "metadata"),
        timeout: timeoutSeconds,
      };
      createAnchors.record(input.operationKey);
      let response;
      try {
        response = await rest.request(E2B_PATH_CREATE, {
          method: "POST",
          body: requestBody,
          signal: input.signal,
        });
      } catch (error) {
        // rest 层已归一的确定/未知错误原样透传；仅裸网络/编程错误归 unknown。
        if (error instanceof CloudAdapterError) throw error;
        // 本地取消/超时 ≠ provider 未创建：一律进入 create unknown 对账。
        throw rest.unknownOutcomeError("create", "network", error);
      }
      if (!response.ok) {
        if (isDefiniteRejection(response.status)) {
          // provider 原话（有界、脱敏）是定位依据，例如账号的 timeout 上限文案。
          const providerMessage = await readProviderRejectionMessage(response);
          logger.warn(undefined, "e2b create rejected", {
            operationKey: input.operationKey,
            status: response.status,
            ...(providerMessage === undefined ? {} : { providerMessage }),
          });
          throw rest.definiteFailure(response.status, "create", providerMessage);
        }
        throw rest.unknownOutcomeError("create", response.status);
      }
      const body = asRecord(await response.json().catch(() => null));
      const sandboxId = asString(body?.["sandboxID"]) ?? asString(body?.["sandboxId"]);
      if (!sandboxId) {
        // 2xx 但缺 sandboxID：无法建立 handle，按未知处理交给对账（不建第二个）。
        throw rest.unknownOutcomeError("create", response.status);
      }
      logger.info(undefined, "e2b sandbox created", {
        operationKey: input.operationKey,
        runId: input.runId,
        sandboxId,
      });
      return {
        provider: E2B_PROVIDER,
        sandboxId,
        templateRevision:
          asString(body?.["templateRevision"]) ?? asString(body?.["templateID"]) ?? imageRef,
        providerDeadline: now() + timeoutSeconds * 1000,
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
      await launchE2bSupervisor(
        supervisorOptions,
        createE2bTerminateProbe(rest),
        handle.sandboxId,
        startInput,
      );
    },

    async findCreateResult(
      operationKey: string,
      options?: { operationAttemptedAtMs?: number },
    ): Promise<CreateReconciliation> {
      let body: unknown;
      try {
        // E2B 无原生 idempotency key：按清单 metadata.operationKey 对账（01 §4.1）。
        const response = await rest.request(E2B_PATH_LIST, {
          method: "GET",
          attempts: E2B_GET_RETRY_ATTEMPTS,
        });
        if (!response.ok) {
          logger.warn(undefined, "e2b create reconciliation query unavailable", {
            operationKey,
            status: response.status,
          });
          return createReconcileUnknown();
        }
        body = await response.json().catch(() => null);
      } catch (error) {
        logger.warn(undefined, "e2b create reconciliation query failed", {
          operationKey,
          error: isAbortLike(error) ? "aborted" : "network",
        });
        return createReconcileUnknown();
      }
      const record = asRecord(body);
      const entries: unknown[] = Array.isArray(body)
        ? body
        : Array.isArray(record?.["sandboxes"])
          ? (record["sandboxes"] as unknown[])
          : [];
      const match = entries
        .map((entry) => asRecord(entry))
        .find((entry) => matchesOperationKey(entry, "metadata", operationKey));
      const sandboxId = match
        ? (asString(match["sandboxID"]) ?? asString(match["sandboxId"]))
        : undefined;
      return resolveCreateReconciliation(
        match && sandboxId ? { provider: E2B_PROVIDER, sandboxId } : undefined,
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
      const path = E2B_PATH_SANDBOX(handle.sandboxId);
      // 证据串只含端点/状态/状态原文要点（≤160 字符），不含凭据、labels 或响应体。
      const evidenceOf = (outcome: string) => boundEvidence(`e2b GET ${path} -> ${outcome}`);
      let response;
      try {
        response = await rest.request(path, { method: "GET", attempts: E2B_GET_RETRY_ATTEMPTS });
      } catch (error) {
        // 网络超时/权限丢失一律 unknown，不是 notFound（01 §4.1）。
        const cause = isAbortLike(error) ? "aborted" : "network-error";
        logger.warn(undefined, "e2b inspect unavailable", {
          sandboxId: handle.sandboxId,
          error: cause,
        });
        return {
          status: "unknown",
          observedAt: now(),
          evidenceSource: "none",
          evidence: evidenceOf(cause),
          errorCode: "provider_unreachable",
        };
      }
      if (response.status === 404) {
        // provider 明确确认资源不存在 → notFound（可释放计费槽）。
        return {
          status: "notFound",
          observedAt: now(),
          evidenceSource: "provider-api",
          evidence: evidenceOf("404 not-found"),
        };
      }
      if (response.status === 401 || response.status === 403) {
        return {
          status: "unknown",
          observedAt: now(),
          evidenceSource: "provider-api",
          evidence: evidenceOf(`${response.status} auth-lost`),
          errorCode: "permission_revoked",
        };
      }
      if (!response.ok) {
        return {
          status: "unknown",
          observedAt: now(),
          evidenceSource: "provider-api",
          evidence: evidenceOf(`${response.status} provider-error`),
          errorCode: "provider_unreachable",
        };
      }
      const body = asRecord(await response.json().catch(() => null));
      const state = asString(body?.["state"]) ?? asString(body?.["status"]) ?? "";
      const mapped = mapE2bSandboxState(state);
      if (mapped !== undefined) {
        return {
          status: mapped,
          observedAt: now(),
          evidenceSource: "provider-api",
          evidence: evidenceOf(`200 state=${state}`),
        };
      }
      // 未映射的 provider 状态不猜测：unknown + 证据留给运营核对。
      logger.warn(undefined, "e2b inspect returned unmapped state", {
        sandboxId: handle.sandboxId,
        state: state.slice(0, 32),
      });
      return {
        status: "unknown",
        observedAt: now(),
        evidenceSource: "provider-api",
        evidence: evidenceOf(`200 unmapped-state=${state.slice(0, 32)}`),
        errorCode: "provider_unreachable",
      };
    },

    async extendDeadline(
      handle: ProviderSandboxHandle,
      requestedDeadlineMs: number,
    ): Promise<DeadlineResult> {
      if (options.maxLifetimeSeconds === undefined) {
        // 账号上限未核实：不虚构「可续期到任意时刻」（01 §4.2 E2B 行）。
        logger.debug(undefined, "e2b extend without verified account cap", {
          sandboxId: handle.sandboxId,
        });
      }
      const timeoutSeconds = clampTimeoutSeconds(requestedDeadlineMs);
      if (timeoutSeconds < 1) {
        throw new CloudAdapterError("validation_failed", "requested deadline already elapsed", {
          requestedDeadlineMs,
        });
      }
      let response;
      try {
        response = await rest.request(E2B_PATH_TIMEOUT(handle.sandboxId), {
          method: "POST",
          body: { [E2B_TIMEOUT_BODY_FIELD]: timeoutSeconds },
        });
      } catch (error) {
        // 续期结果未知：调用方保持旧已确认期限并重查（01 §4.3），不伪造成功。
        throw rest.unknownOutcomeError("query", "network", error);
      }
      if (response.ok) {
        return { status: "confirmed", expiresAt: now() + timeoutSeconds * 1000 };
      }
      if (isDefiniteRejection(response.status)) {
        throw await rest.rejectionError(response, "extend-deadline");
      }
      throw rest.unknownOutcomeError("query", response.status);
    },

    async terminate(handle: ProviderSandboxHandle): Promise<TerminationObservation> {
      // 终止证据与 inspect 同口径（端点/状态，≤160 字符）。过渡形态：TerminationObservation
      // 契约暂无 evidence 字段（W0 已裁决补，冻结后改返回值），暂经结构化日志留存（01 §9）。
      const evidenceOf = (outcome: string) =>
        boundEvidence(`e2b DELETE ${E2B_PATH_SANDBOX(handle.sandboxId)} -> ${outcome}`);
      let response;
      try {
        response = await rest.request(E2B_PATH_SANDBOX(handle.sandboxId), { method: "DELETE" });
      } catch (error) {
        // 终止结果未知：保留计费槽与 cleanup operation（01 §9），不写成失败。
        const cause = isAbortLike(error) ? "aborted" : "network-error";
        logger.warn(undefined, "e2b terminate result unknown", {
          sandboxId: handle.sandboxId,
          evidence: evidenceOf(cause),
        });
        return { status: "unknown", errorCode: "provider_termination_unknown" };
      }
      if (response.ok || response.status === 404) {
        // 404 是 provider 确认资源不存在的事实，可释放计费槽。
        logger.info(undefined, "e2b sandbox terminated", {
          sandboxId: handle.sandboxId,
          evidence: evidenceOf(`${response.status} confirmed`),
        });
        return { status: "terminated" };
      }
      if (isDefiniteRejection(response.status)) {
        // provider 明确拒绝（如权限/配额）：资源确认仍在，保留槽位与原因。
        const failure = await rest.rejectionError(response, "terminate");
        const providerMessage = failure.safeContext?.["providerMessage"];
        logger.warn(undefined, "e2b terminate rejected", {
          sandboxId: handle.sandboxId,
          evidence: evidenceOf(`${response.status} rejected`),
          errorCode: failure.code,
          ...(providerMessage === undefined ? {} : { providerMessage }),
        });
        return { status: "notTerminated", errorCode: failure.code };
      }
      logger.warn(undefined, "e2b terminate result unknown", {
        sandboxId: handle.sandboxId,
        evidence: evidenceOf(`${response.status} unconfirmed`),
      });
      return { status: "unknown", errorCode: "provider_termination_unknown" };
    },
  };
}
