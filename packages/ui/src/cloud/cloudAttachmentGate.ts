/**
 * 云模式附件能力门控（specs/cloud-agent/15 §2/§3 R6、04 §3.0.2/§3.4.1、11 §9）。
 *
 * **本轮结论（fail-closed）：云模式不提供附件入口，任何阶段都不上传、不暂存。**
 *
 * 依据：durable input 尚未携带附件引用——附件只有在 UI 本地（或上传到某个宿主）才有
 * 实体，input record / runtime 准入不消费它们。若仍允许选择或上传，发送时只能丢弃，
 * 形成「可上传但发送成功后被静默丢掉」的假支持（spec 15 §2「云附件 v1」决策）。
 *
 * 因此本函数**只服务云模式且恒返回 disabled**，reason 固定为
 * `durable-input-unsupported`，并给出用户可读原因。非云模式不会调用本函数：
 * `useCloudAttachmentGate` 在无云上下文时返回 null，本地 / SSH / 已配对远控附件
 * 路径逐字不变。
 *
 * 「本地路径暂存」在云模式同样恒不可用：浏览器云入口没有本地文件系统
 * （`packages/web/src/webPlatform.ts`：`canSelectFilePath: false`），且
 * `PromptAttachmentTransfer` 不在 `CLOUD_ATTACHMENT_SERVICE_ALLOWLIST`；把它指向
 * host 会让附件暂存在部署机、返回沙箱读不到的路径。见 `describeCloudLocalPathStaging`。
 *
 * 本模块是这些规则的**唯一判定点**：组件不各自判断 task-owned 上传、session 与执行域，
 * 避免 04 §3.0 说的「在多个组件里长出分支判断」。task-owned 附件上传与 durable input
 * 附件引用落地后，再按 spec 重新引入分支，不在 UI 里先留「假可用」通道。
 */
import type { CloudTaskStatus } from "@zcode/shared";
import type { CloudExecutionScope } from "./cloudServiceScope.js";

export type CloudAttachmentGateReason =
  /** durable input 不承载附件引用：云模式任何阶段都不提供附件入口。 */
  "durable-input-unsupported";

export interface CloudAttachmentGate {
  /** 云模式恒为 false：不存在可用附件通道。 */
  readonly enabled: false;
  readonly reason: CloudAttachmentGateReason;
  /** 不可用原因（i18n id）；恒非空，必须展示给用户。 */
  readonly disabledMessageId: string;
  /** 不上传、不暂存、不伪造空附件列表。 */
  readonly uploadChannel: "none";
  /** 云模式恒不进入「本地路径暂存」分支（见文件头）。 */
  readonly localPathStaging: false;
}

export interface CloudAttachmentGateInput {
  /**
   * 执行域是否已就绪（attachment-ready / unavailable）。
   * 字段保留给既有调用方与后续恢复；本轮判定不消费（没有通道可门控）。
   */
  readonly executionScope: CloudExecutionScope;
  /** `capabilities.taskOwnedAttachments`（部署是否支持 task-owned 上传）。本轮不消费。 */
  readonly taskOwnedAttachments: boolean;
  readonly taskStatus: CloudTaskStatus | null;
  /** 当前 Run 是否已有 runtime session。本轮不消费。 */
  readonly hasRuntimeSession: boolean;
}

export const CLOUD_ATTACHMENT_MESSAGE_IDS = {
  durableInputUnsupported: "chat.attachments.cloud.durableInputUnsupported",
} as const;

export function resolveCloudAttachmentGate(_input: CloudAttachmentGateInput): CloudAttachmentGate {
  // 唯一出口：无论 draft / ready / 终态、是否有 session、部署是否声明 task-owned 上传，
  // 都不提供附件入口。返回非法通道或 enabled=true 会让 composer 重新出现「可上传但发送
  // 时被丢弃」的路径（spec 15 §2）。
  return {
    enabled: false,
    reason: "durable-input-unsupported",
    disabledMessageId: CLOUD_ATTACHMENT_MESSAGE_IDS.durableInputUnsupported,
    uploadChannel: "none",
    localPathStaging: false,
  };
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
