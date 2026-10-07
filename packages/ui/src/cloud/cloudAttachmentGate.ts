/**
 * 云模式附件能力门控（specs/cloud-agent/04 §3.0.2/§3.4.1、11 §9、12 §5、W8 §3）。
 *
 * **结论：云模式不支持「本地路径暂存」（`promptAttachmentTransferService.stage`）。**
 * 依据（两条，缺一不可）：
 * 1. 浏览器没有本地文件系统：云入口的 `IPlatformService` 把桌面类能力标为不可用
 *    （`packages/web/src/webPlatform.ts:45-50`：`canSelectFilePath: false`、
 *    `selectFile → null`、`selectFiles → []`）。`stage` 的语义是「让宿主读取本地文件路径」
 *    （唯一调用点 `v4/composer/useComposerAttachments.ts:336`），没有本地路径就无从调用；
 *    既有 `:711 if (!platform.canSelectFilePath)` 也已经把路径型入口关掉。
 * 2. `PromptAttachmentTransfer` 不在 `CLOUD_ATTACHMENT_SERVICE_ALLOWLIST`，且**不应**加入：
 *    把它指向 host 会让附件暂存在部署机、返回沙箱读不到的路径（既有守卫
 *    `:354 !result.staged → RemoteAttachmentNotStagedError` 正是为此）。
 * 因此 `useComposerAttachments` 里 `item.localPath && isRemoteAttachmentTarget(target)`
 * 那条分支在云模式下**不可达**——注意云任务 identity 恒非空、该谓词本身会返回 true，
 * 真正的拦截点是平台能力与白名单，不是 identity。
 *
 * 云模式只保留**上传语义**：
 * - draft（无 run / 无 session）：控制面 task-owned 上传 `POST /api/cloud/attachments`，
 *   由 `capabilities.taskOwnedAttachments` 门控；此时 `stage` 与 session-bound 上传都不可用。
 * - ready（有 runtime session 且 attachment 就绪）：session-bound 上传（`attachmentPut`），
 *   经当前 Run attachment 通道落到沙箱。
 *
 * 本模块是这些规则的**唯一判定点**：组件不各自判断 `taskOwnedAttachments`、session 与
 * 执行域，避免 04 §3.0 说的「在多个组件里长出分支判断」。
 */
import type { CloudTaskStatus } from "@zcode/shared";
import type { CloudExecutionScope } from "./cloudServiceScope.js";

export type CloudAttachmentGateReason =
  /** 附件就绪：走 session-bound 上传（经当前 Run attachment）。 */
  | "session-upload"
  /** draft 且部署支持 task-owned 上传：走控制面 `POST /api/cloud/attachments`。 */
  | "task-owned-upload"
  /** draft 且部署未支持 task-owned 上传：入口不可用，必须解释原因。 */
  | "task-owned-upload-unavailable"
  /** 有 session 但 attachment 断连：等重连，不排队、不回落本机。 */
  | "attachment-unavailable"
  /** 还没到可上传的阶段（provisioning / 终态 / 无 run）。 */
  | "session-pending";

export interface CloudAttachmentGate {
  readonly enabled: boolean;
  readonly reason: CloudAttachmentGateReason;
  /** 不可用时给用户看的原因（i18n id）；可用时为 null。 */
  readonly disabledMessageId: string | null;
  /** 附件将被谁读取：当前 Run 会话，或控制面 task-owned 存储。 */
  readonly uploadChannel: "session" | "task-owned" | "none";
  /** 是否可能走「本地路径暂存」分支；云模式恒为 false（见文件头结论）。 */
  readonly localPathStaging: false;
}

export interface CloudAttachmentGateInput {
  /** 执行域是否已就绪（attachment-ready / unavailable）。 */
  readonly executionScope: CloudExecutionScope;
  /** `capabilities.taskOwnedAttachments`：部署是否支持 task-owned 上传（03 §6）。 */
  readonly taskOwnedAttachments: boolean;
  readonly taskStatus: CloudTaskStatus | null;
  /** 当前 Run 是否已有 runtime session（ready 后由 attachment 提供）。 */
  readonly hasRuntimeSession: boolean;
}

export const CLOUD_ATTACHMENT_MESSAGE_IDS = {
  taskOwnedUploadUnavailable: "chat.attachments.cloud.uploadUnavailable",
  attachmentUnavailable: "chat.attachments.cloud.attachmentUnavailable",
  waitingEnvironment: "chat.attachments.cloud.waitingEnvironment",
} as const;

function gate(
  enabled: boolean,
  reason: CloudAttachmentGateReason,
  uploadChannel: CloudAttachmentGate["uploadChannel"],
  disabledMessageId: string | null,
): CloudAttachmentGate {
  return { enabled, reason, uploadChannel, disabledMessageId, localPathStaging: false };
}

export function resolveCloudAttachmentGate(input: CloudAttachmentGateInput): CloudAttachmentGate {
  // 1. 已有 runtime session：唯一路径是 session-bound 上传，且必须先有就绪 attachment。
  if (input.hasRuntimeSession) {
    return input.executionScope === "attachment-ready"
      ? gate(true, "session-upload", "session", null)
      : gate(
          false,
          "attachment-unavailable",
          "none",
          CLOUD_ATTACHMENT_MESSAGE_IDS.attachmentUnavailable,
        );
  }

  // 2. draft：没有沙箱、没有 session，唯一可行的是控制面 task-owned 上传。
  if (input.taskStatus === "draft") {
    return input.taskOwnedAttachments
      ? gate(true, "task-owned-upload", "task-owned", null)
      : gate(
          // 入口不可用 + 明确原因：既不静默停在 waitingSession，也不伪造空附件列表。
          false,
          "task-owned-upload-unavailable",
          "none",
          CLOUD_ATTACHMENT_MESSAGE_IDS.taskOwnedUploadUnavailable,
        );
  }

  // 3. 有任务但还没到可上传阶段（provisioning / 终态 / 无 run）：等环境，不提前上传。
  return gate(false, "session-pending", "none", CLOUD_ATTACHMENT_MESSAGE_IDS.waitingEnvironment);
}

/**
 * 「本地路径暂存」的可用性判定：**恒不可用**，并给出被哪一条挡住。
 *
 * 单独导出是为了让调用点与用例引用**同一条结论**，而不是把
 * `platform.canSelectFilePath` 判断分散到多个组件。
 */
export function describeCloudLocalPathStaging(input: {
  /** 平台是否能返回 agent 可访问的本地绝对路径（web 云入口恒为 false）。 */
  readonly platformCanSelectFilePath: boolean;
}): {
  readonly available: false;
  /** 命中的拦截依据；`allowlist` 恒命中（服务不在 attachment 白名单，且不应加入）。 */
  readonly blockedBy: readonly ("platform" | "allowlist")[];
} {
  return {
    available: false,
    blockedBy: input.platformCanSelectFilePath ? ["allowlist"] : ["platform", "allowlist"],
  };
}
