/**
 * 云模式审批/交互决定的提交语义（specs/cloud-agent 03 §7.2、04 §3.0.2、spec 15 §R6）。
 *
 * 纯逻辑（不依赖 React/DOM），由 `V4InteractionDialogs` 与单测共用：
 * - `resolveCloudInteractionRoute`：是否有 CloudWorkspaceProvider、是否具备 activeRun；
 *   非云模式返回 `local`，调用方继续走既有 agent transport。
 * - 提交结果只按 receipt.deliveryStatus 分类：`admitted` 才算 runtime 已裁决；
 *   accepted/delivering/uncertain 都是「提交中」，不伪造 CommandAck。
 */
import type {
  CloudInteractionDecisionReceipt,
  SubmitCloudInteractionDecisionRequest,
} from "@zcode/shared";
import { readCloudErrorCode, readCloudErrorReason } from "./cloudApiErrorLike.js";
import type { CloudControlPlanePort } from "./cloudPorts.js";
import type { CloudWorkspaceContextValue } from "./cloudWorkspaceContext.js";

/** 只取路由需要的上下文字段，便于单测构造最小事实。 */
export type CloudInteractionContext = Pick<
  CloudWorkspaceContextValue,
  "controlPlane" | "selection" | "taskDetail"
> | null;

export type CloudInteractionRoute =
  | { readonly mode: "local" }
  | {
      readonly mode: "cloud";
      readonly controlPlane: CloudControlPlanePort;
      readonly taskId: string;
      readonly runId: string;
      readonly runGeneration: number;
    }
  /** 云入口已挂载但当前 Task/Run 不可用：fail-closed，不回落 agent 写命令。 */
  | { readonly mode: "cloud-unavailable"; readonly reason: string };

export function resolveCloudInteractionRoute(
  context: CloudInteractionContext,
): CloudInteractionRoute {
  if (!context) return { mode: "local" };
  if (!context.controlPlane) {
    return { mode: "cloud-unavailable", reason: "control-plane-unavailable" };
  }
  const taskId = context.selection.taskId;
  if (!taskId) return { mode: "cloud-unavailable", reason: "task-not-selected" };
  const activeRun = context.taskDetail?.activeRun;
  if (!activeRun) return { mode: "cloud-unavailable", reason: "run-not-active" };
  return {
    mode: "cloud",
    controlPlane: context.controlPlane,
    taskId,
    runId: activeRun.runId,
    runGeneration: activeRun.runGeneration,
  };
}

export interface CloudInteractionDecisionRequestFacts {
  readonly commandId: string;
  readonly runId: string;
  readonly runGeneration: number;
  readonly kind: "permission" | "elicitation";
  /** 与 V4 弹窗的 answer 同形；`content` 的 JSON 合法性由冻结 wire schema 在发送前校验。 */
  readonly answer: {
    optionId?: string;
    freeText?: string;
    action?: "accept" | "decline" | "cancel";
    content?: Record<string, unknown>;
  };
}

export function buildCloudInteractionDecisionRequest(
  facts: CloudInteractionDecisionRequestFacts,
): SubmitCloudInteractionDecisionRequest {
  return {
    commandId: facts.commandId,
    runId: facts.runId,
    runGeneration: facts.runGeneration,
    kind: facts.kind,
    // 弹窗层的 content 来自投影 JSON；SDK 的 parseCloudRequestBody 会用 shared 的
    // `z.json()` 再校验一次，非法内容不会到达线上。
    answer: facts.answer as SubmitCloudInteractionDecisionRequest["answer"],
  };
}

/**
 * 提交结果三态：
 * - admitted：runtime 已裁决，UI 可按成功收口；
 * - pending：控制面已持久接收/正在投递，保持「提交中」直到权威 snapshot 收口；
 * - failed：明确失败或传输失败，走既有错误展示路径。
 */
export type CloudInteractionDecisionOutcome =
  | {
      readonly status: "admitted" | "pending";
      readonly httpStatus: number;
      readonly receipt: CloudInteractionDecisionReceipt;
    }
  | {
      readonly status: "failed";
      readonly message: string;
      readonly httpStatus?: number;
      readonly receipt?: CloudInteractionDecisionReceipt;
    };

export interface SubmitCloudInteractionDecisionInput {
  readonly controlPlane: CloudControlPlanePort;
  readonly taskId: string;
  readonly interactionId: string;
  readonly request: SubmitCloudInteractionDecisionRequest;
  readonly signal?: AbortSignal | undefined;
}

/** 失败文案只用结构化 code/reason；不把 answer 内容带进日志或 UI。 */
function describeFailure(error: unknown): string {
  const code = readCloudErrorCode(error);
  if (code) {
    const reason = readCloudErrorReason(error);
    return reason ? `${code}/${reason}` : code;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function submitCloudInteractionDecision(
  input: SubmitCloudInteractionDecisionInput,
): Promise<CloudInteractionDecisionOutcome> {
  try {
    const submission = await input.controlPlane.submitCloudInteractionDecision(
      input.taskId,
      input.interactionId,
      input.request,
      input.signal === undefined ? undefined : { signal: input.signal },
    );
    const { receipt, httpStatus } = submission;
    switch (receipt.deliveryStatus) {
      case "admitted":
        return { status: "admitted", httpStatus, receipt };
      case "accepted":
      case "delivering":
      case "uncertain":
        return { status: "pending", httpStatus, receipt };
      default:
        return {
          status: "failed",
          message: `interaction-decision-${receipt.deliveryStatus}`,
          httpStatus,
          receipt,
        };
    }
  } catch (error) {
    return { status: "failed", message: describeFailure(error) };
  }
}
