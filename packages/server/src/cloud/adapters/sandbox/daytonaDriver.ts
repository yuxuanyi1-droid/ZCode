/**
 * Daytona 沙箱 driver（specs/cloud-agent/01 §4 Provider contract）：实现 SandboxDriverPort。
 * 传输与归一在 daytonaRest.ts / sandboxRest.ts；三分支语义与 E2B 一致，差异不抹平：
 * - 成功：返回 ProviderSandboxHandle（不含任何 attach 凭据）。
 * - 明确失败：4xx 等可判定「未创建」的响应 → 抛归一错误。
 * - 结果未知：网络超时/中断/5xx → 抛 provider_create_unknown，由控制面按 operationKey
 *   对账（findCreateResult），禁止盲目二次 create。
 *
 * 期限/资源/停止语义差异（01 §4.2；不得抹平，也不静默降级）：
 * - `stop`/`pause`/`archive` 只停不删（保留磁盘与计费）→ terminate 只映射 DELETE；
 * - 墙钟 TTL（→ autoDestroyAt）既作硬期限上界也作续期通道（异于 E2B 的 setTimeout 续期）；
 *   idle 类自动回收 create 时显式关闭；snapshot 创建拒绝覆盖 resources（01 §4.3）。
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
  DAYTONA_SANDBOX_CAPABILITIES,
  describeCapabilities,
  resolveEffectiveMaxLifetimeSeconds,
  resolvePauseResumeCapability,
  type SandboxLifetimeOptions,
} from "./capabilities.js";
import { launchDaytonaSupervisor } from "./daytonaBootstrap.js";
import {
  buildDaytonaHandle,
  buildDaytonaLabels,
  createDaytonaRestClient,
  createDaytonaTerminateProbe,
  createDaytonaTtlMinutesClamp,
  DAYTONA_DEFAULT_BASE_URL,
  DAYTONA_DEFAULT_REQUEST_TIMEOUT_MS,
  DAYTONA_GET_RETRY_ATTEMPTS,
  DAYTONA_LIST_LIMIT,
  DAYTONA_PATH_CREATE,
  DAYTONA_PATH_LIST,
  DAYTONA_PATH_SANDBOX,
  DAYTONA_PATH_TTL,
  mapDaytonaSandboxState,
  parseEpochMs,
  readDaytonaListEntries,
} from "./daytonaRest.js";
import { pauseDaytonaSandbox, resumeDaytonaSandbox } from "./daytonaPauseResume.js";
import { inspectDaytonaSandbox } from "./daytonaRest.js";
import {
  boundEvidence,
  createCreateAttemptAnchors,
  createReconcileUnknown,
  matchesOperationKey,
  resolveCreateReconciliation,
} from "./reconcile.js";
import {
  asRecord,
  asString,
  isAbortLike,
  isDefiniteRejection,
  readProviderRejectionMessage,
  type SandboxFetch,
} from "./sandboxRest.js";
import type { SupervisorStartInput, SupervisorStarter } from "./sandboxSupervisorStart.js";

export const DAYTONA_PROVIDER = "daytona";

/** create 结果对账窗口：窗口内「清单查不到」不足以判定未创建（01 §4.1）。 */
export const DAYTONA_DEFAULT_RECONCILIATION_WINDOW_MS = 300_000;

export interface DaytonaDriverOptions extends SandboxLifetimeOptions {
  /** provider API key（dtn_ 前缀）经注入读取；绝不进 URL、日志或 labels。 */
  apiKey: () => string | Promise<string>;
  baseUrl?: string;
  fetch?: SandboxFetch;
  now?: () => number;
  requestTimeoutMs?: number;
  createReconciliationWindowMs?: number;
  /** 测试注入的 supervisor 启动器（缺省 toolbox 会话通道）。 */
  startSupervisor?: SupervisorStarter;
  logger?: CloudAdapterLogger;
}

export function createDaytonaSandboxDriver(options: DaytonaDriverOptions): SandboxDriverPort {
  const now = options.now ?? Date.now;
  const logger = options.logger ?? createServiceLogger("cloud-sandbox-daytona");
  const requestTimeoutMs = options.requestTimeoutMs ?? DAYTONA_DEFAULT_REQUEST_TIMEOUT_MS;
  const rest = createDaytonaRestClient({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl ?? DAYTONA_DEFAULT_BASE_URL,
    requestTimeoutMs,
    fetch: options.fetch,
    logger,
  });
  const reconciliationWindowMs =
    options.createReconciliationWindowMs ?? DAYTONA_DEFAULT_RECONCILIATION_WINDOW_MS;
  const createAnchors = createCreateAttemptAnchors(now);
  const supervisorOptions = {
    apiKey: options.apiKey,
    ...(options.startSupervisor === undefined ? {} : { startSupervisor: options.startSupervisor }),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    requestTimeoutMs,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    logger,
  };

  // TTL 分钟换算的唯一实现（01 §4.3）：create/extend/resume 共用，向上取整不欠配。
  const clampTtlMinutes = createDaytonaTtlMinutesClamp({
    now,
    resolveMaxLifetimeSeconds: () => resolveEffectiveMaxLifetimeSeconds(options),
  });

  /** inspect 的函数形态（pause 的回查复用同一实现，避免对象字面量内 `this` 依赖）。 */
  // inspect 委托 rest 层实现（pause 的回查复用同一实现）。
  const inspectHandle = (handle: ProviderSandboxHandle): Promise<ProviderObservation> =>
    inspectDaytonaSandbox({ rest, logger, now, sandboxId: handle.sandboxId });

  return {
    async describeCapabilities() {
      return describeCapabilities(
        {
          ...DAYTONA_SANDBOX_CAPABILITIES,
          // A-7 实测解禁门禁：disk 级未实测一律收敛为 "none"（fail-closed，路径不可达）。
          pauseResume: resolvePauseResumeCapability(DAYTONA_PROVIDER),
        },
        options.maxLifetimeSeconds,
      );
    },

    async create(input: SandboxCreateInput): Promise<ProviderSandboxHandle> {
      const imageRef = input.imageRef.trim();
      if (imageRef.endsWith(":latest") || imageRef === "latest") {
        throw new CloudAdapterError("unsupported_template", "imageRef must not use latest", {
          imageRefLen: imageRef.length,
        });
      }
      if (input.requestedDeadline <= now()) {
        throw new CloudAdapterError("validation_failed", "requested deadline already elapsed", {
          requestedDeadline: input.requestedDeadline,
        });
      }
      const ttlMinutes = await clampTtlMinutes(input.requestedDeadline);
      const requestBody = {
        snapshot: imageRef,
        labels: buildDaytonaLabels(input),
        autoStopInterval: 0, // idle 回收显式关闭（01 §4.3）；-1 不自动删除
        autoPauseInterval: 0,
        autoArchiveInterval: 0,
        autoDeleteInterval: -1,
        ttlMinutes,
      };
      createAnchors.record(input.operationKey);
      let response;
      try {
        response = await rest.request(DAYTONA_PATH_CREATE, {
          method: "POST",
          body: requestBody,
          signal: input.signal,
        });
      } catch (error) {
        if (error instanceof CloudAdapterError) throw error;
        throw rest.unknownOutcomeError("create", "network", error);
      }
      if (!response.ok) {
        if (isDefiniteRejection(response.status)) {
          // provider 原话（有界、脱敏）是定位依据：例如快照与 resources 互斥的说明。
          const providerMessage = await readProviderRejectionMessage(response);
          logger.warn(undefined, "daytona create rejected", {
            operationKey: input.operationKey,
            status: response.status,
            ...(providerMessage === undefined ? {} : { providerMessage }),
          });
          throw rest.definiteFailure(response.status, "create", providerMessage);
        }
        throw rest.unknownOutcomeError("create", response.status);
      }
      const body = asRecord(await response.json().catch(() => null));
      const sandboxId = asString(body?.["id"]) ?? asString(body?.["sandboxId"]);
      if (!sandboxId) {
        // 2xx 但缺 id：无法建立 handle，按未知处理交给对账。
        throw rest.unknownOutcomeError("create", response.status);
      }
      logger.info(undefined, "daytona sandbox created", {
        operationKey: input.operationKey,
        runId: input.runId,
        sandboxId,
      });
      return buildDaytonaHandle(sandboxId, imageRef, body, ttlMinutes, now);
    },

    /** 拉起 supervisor（01 §6.2）：`persistHandle()` 之后调用，正常路径与对账恢复路径都要调；
     * 幂等由镜像内 flock 保证；失败（含输入非法）→ 补偿终止 + 带原因的确定错误。 */
    async startSupervisor(
      handle: ProviderSandboxHandle,
      startInput: SupervisorStartInput,
    ): Promise<void> {
      await launchDaytonaSupervisor(
        supervisorOptions,
        createDaytonaTerminateProbe(rest),
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
        const response = await rest.request(`${DAYTONA_PATH_LIST}?limit=${DAYTONA_LIST_LIMIT}`, {
          method: "GET",
          attempts: DAYTONA_GET_RETRY_ATTEMPTS,
        });
        if (!response.ok) {
          logger.warn(undefined, "daytona create reconciliation query unavailable", {
            operationKey,
            status: response.status,
          });
          return createReconcileUnknown();
        }
        body = await response.json().catch(() => null);
      } catch (error) {
        logger.warn(undefined, "daytona create reconciliation query failed", {
          operationKey,
          error: isAbortLike(error) ? "aborted" : "network",
        });
        return createReconcileUnknown();
      }
      const entries = readDaytonaListEntries(body);
      const match = entries
        .map((entry) => asRecord(entry))
        .find((entry) => matchesOperationKey(entry, "labels", operationKey));
      const sandboxId = match ? asString(match["id"]) : undefined;
      return resolveCreateReconciliation(
        match && sandboxId ? { provider: DAYTONA_PROVIDER, sandboxId } : undefined,
        {
          // 控制面持久的尝试时间优先（跨重启可用）；进程内锚点只是兜底。
          durableAttemptedAtMs: options?.operationAttemptedAtMs,
          localAttemptedAtMs: createAnchors.resolve(operationKey),
          windowMs: reconciliationWindowMs,
          now: now(),
        },
      );
    },

    inspect: inspectHandle,

    async extendDeadline(
      handle: ProviderSandboxHandle,
      requestedDeadlineMs: number,
    ): Promise<DeadlineResult> {
      if (requestedDeadlineMs <= now()) {
        throw new CloudAdapterError("validation_failed", "requested deadline already elapsed", {
          requestedDeadlineMs,
        });
      }
      const minutes = await clampTtlMinutes(requestedDeadlineMs);
      let response;
      try {
        response = await rest.request(DAYTONA_PATH_TTL(handle.sandboxId, minutes), {
          method: "POST",
        });
      } catch (error) {
        // 续期结果未知：调用方保持旧已确认期限并重查（01 §4.3），不伪造成功。
        throw rest.unknownOutcomeError("query", "network", error);
      }
      if (response.ok) {
        const confirmed = parseEpochMs(
          asRecord(await response.json().catch(() => null))?.["autoDestroyAt"],
        );
        if (confirmed !== undefined) {
          return { status: "confirmed", expiresAt: confirmed };
        }
        // 响应缺 autoDestroyAt 时按估计上报（不把控制面时间冒充 provider 确认期限）。
        return {
          status: "estimated",
          deadlineEstimate: now() + minutes * 60_000,
          deadlineConfidence: "medium",
        };
      }
      if (isDefiniteRejection(response.status)) {
        throw await rest.rejectionError(response, "extend-deadline");
      }
      throw rest.unknownOutcomeError("query", response.status);
    },

    async terminate(handle: ProviderSandboxHandle): Promise<TerminationObservation> {
      // 终止证据与 inspect 同口径（端点/状态，≤160 字符）：TerminationObservation
      // 契约里没有 evidence 字段，因此证据经结构化日志留存供运营核对（01 §9）。
      // 过渡形态：W0 已裁决给 TerminationObservation 加可选有界 evidence，冻结后改返回值。
      const evidenceOf = (outcome: string) =>
        boundEvidence(`daytona DELETE ${DAYTONA_PATH_SANDBOX(handle.sandboxId)} -> ${outcome}`);
      let response;
      try {
        response = await rest.request(DAYTONA_PATH_SANDBOX(handle.sandboxId), { method: "DELETE" });
      } catch (error) {
        // 终止结果未知：保留计费槽与 cleanup operation（01 §9），不写成失败。
        logger.warn(undefined, "daytona terminate result unknown", {
          sandboxId: handle.sandboxId,
          evidence: evidenceOf(isAbortLike(error) ? "aborted" : "network-error"),
        });
        return { status: "unknown", errorCode: "provider_termination_unknown" };
      }
      if (response.ok || response.status === 404) {
        // DELETE 受理或 404（资源不存在）是释放计费槽的事实；其余分支不释放。
        logger.info(undefined, "daytona sandbox terminated", {
          sandboxId: handle.sandboxId,
          evidence: evidenceOf(`${response.status} confirmed`),
        });
        return { status: "terminated" };
      }
      if (isDefiniteRejection(response.status)) {
        const failure = await rest.rejectionError(response, "terminate");
        const providerMessage = failure.safeContext?.["providerMessage"];
        logger.warn(undefined, "daytona terminate rejected", {
          sandboxId: handle.sandboxId,
          evidence: evidenceOf(`${response.status} rejected`),
          errorCode: failure.code,
          ...(providerMessage === undefined ? {} : { providerMessage }),
        });
        return { status: "notTerminated", errorCode: failure.code };
      }
      logger.warn(undefined, "daytona terminate result unknown", {
        sandboxId: handle.sandboxId,
        evidence: evidenceOf(`${response.status} unconfirmed`),
      });
      return { status: "unknown", errorCode: "provider_termination_unknown" };
    },

    /**
     * disk 级暂停（01 §4.2 修订 2026-10-09）：stop 只停不删、文件系统保留、进程态丢失
     * （须如实向用户披露）。**门禁（A-7）**：能力为 none（未实测）时本地拒绝，不发起
     * provider 请求；分支语义在 daytonaPauseResume.ts。
     */
    async pause(handle: ProviderSandboxHandle): Promise<ProviderObservation> {
      if (resolvePauseResumeCapability(DAYTONA_PROVIDER) === "none") {
        throw new CloudAdapterError(
          "resource_unsupported",
          "capability-not-enabled: daytona pauseResume is gated until real-account verification",
          { sandboxIdLen: handle.sandboxId.length },
        );
      }
      return pauseDaytonaSandbox({
        rest,
        logger,
        now,
        sandboxId: handle.sandboxId,
        inspect: (sandboxId) => inspectHandle({ provider: "daytona", sandboxId }),
      });
    },

    /**
     * disk 级恢复（01 §4.2 修订）：POST start 冷启动，随后尽力把 TTL 续到
     * `requestedDeadline`（B-6 恢复通路同步续展 provider 期限；不放大能力上限）。
     */
    async resume(
      handle: ProviderSandboxHandle,
      requestedDeadline: number,
    ): Promise<ProviderObservation> {
      if (resolvePauseResumeCapability(DAYTONA_PROVIDER) === "none") {
        throw new CloudAdapterError(
          "resource_unsupported",
          "capability-not-enabled: daytona pauseResume is gated until real-account verification",
          { sandboxIdLen: handle.sandboxId.length },
        );
      }
      if (requestedDeadline <= now()) {
        throw new CloudAdapterError("validation_failed", "requested deadline already elapsed", {
          requestedDeadline,
        });
      }
      return resumeDaytonaSandbox({
        rest,
        logger,
        now,
        sandboxId: handle.sandboxId,
        requestedDeadline,
        ttlMinutes: () => clampTtlMinutes(requestedDeadline),
      });
    },
  };
}
