/**
 * Cloud 持久输入提交流程（specs/cloud-agent/04 §3.2、§3.4/§3.4.1、03 §6.2、11 §7）。
 *
 * 时序（与 04 §3.2 逐条对应）：
 *
 * ```
 * 1. freezeAttempt  持久冻结 {commandId, 完整 payload, 正文版本}   ← 本地写失败即中止
 * 2. submitInput    POST /api/cloud/tasks/:taskId/inputs (202)
 * 3a. 202           settle(persisted) → UI 显示「已提交，等待环境」
 * 3b. 网络/超时     settle(unknown)   → 保留原 key，刷新后先 query 再决定
 * 3c. 4xx 明确拒绝  settle(rejected)  → 保留正文，结果明确后才允许新意图
 * 4. queryReceipt   GET .../inputs/:commandId 对账（恢复 unknown 的唯一入口）
 * 5. applyReceipt   只清本次正文版本；不合成 CommandAck、不冒充 runtime ACK
 * ```
 *
 * 本模块不 import SDK、不 import React：UI hooks 只做状态绑定。
 */
import type { InputReceipt, SubmitTaskInput } from "@zcode/shared";
import {
  isCloudApiErrorLike,
  isCloudApiErrorRetryable,
  isCloudResyncRequiredError,
  readCloudErrorCode,
} from "./cloudApiErrorLike.js";
import type { CloudControlPlanePort } from "./cloudPorts.js";
import type {
  CloudSubmitAttempt,
  CloudSubmitRequest,
  CloudSubmitSettlement,
} from "@/store/cloud/cloudDraftStore.js";

export interface CloudTaskSubmissionDeps {
  readonly controlPlane: CloudControlPlanePort;
  readonly scopeKey: string;
  readonly taskId: string;
  /** 返回 false 表示本地持久化失败：调用方已阻止本轮 HTTP（04 §3.4.1）。 */
  readonly freezeAttempt: (
    attempt: Omit<CloudSubmitAttempt, "scopeKey" | "phase" | "frozenAt">,
  ) => boolean;
  readonly settleAttempt: (commandId: string, settlement: CloudSubmitSettlement) => void;
  readonly applyReceipt: (commandId: string, receipt: InputReceipt) => void;
}

export type CloudSubmissionOutcome =
  | {
      readonly kind: "persisted";
      /** HTTP 事实：202 = 控制面已持久接收；**不是** runtime ACK（03 §6.2）。 */
      readonly httpStatus: number;
      readonly receipt: InputReceipt;
      /**
       * 本次提交的幂等键（2026-10-08 巡检修订 P2）：客户端 optimistic overlay 用它
       * 关联权威投影（queue/userInput 的 `sourceCommandId`），不造第二份事实。
       */
      readonly commandId: string;
    }
  /** 本地冻结失败：本轮不得发出 HTTP（04 §3.4.1）。 */
  | { readonly kind: "not-frozen"; readonly message: string }
  /** 结果未知：保留原 commandId，先对账再决定（03 §5）。 */
  | { readonly kind: "unknown"; readonly commandId: string; readonly message: string }
  /** 明确失败：保留正文，理由可见（04 §3.4 表「rejected / failed delivery」行）。 */
  | { readonly kind: "rejected"; readonly commandId: string; readonly message: string };

/**
 * 归一错误文案：UI 不解析异常文字（04 §6），只按 code 归类后给出可行动提示；
 * 非结构化错误不猜语义，统一归到 `network_unknown` 这一档（09 §8）。
 */
export function describeCloudSubmissionError(error: unknown): string {
  if (isCloudResyncRequiredError(error)) {
    return "cloud input receipt requires resync";
  }
  const code = readCloudErrorCode(error);
  if (code) {
    return code;
  }
  return error instanceof Error ? error.message : String(error);
}

interface SubmitCloudTaskInputParams {
  readonly commandId: string;
  readonly request: CloudSubmitRequest;
  readonly bodyVersion: number;
  readonly deps: CloudTaskSubmissionDeps;
  readonly signal?: AbortSignal;
}

/**
 * 提交一条持久输入（start / append），或一条显式 reopen。
 *
 * `commandId` 必须由调用方在**用户首次触发**时生成并一直沿用：重试只能重放同一个
 * key，换 key 会造出第二条 accepted input（03 §6.1、11 §7）。
 */
export async function submitCloudTaskInput(
  params: SubmitCloudTaskInputParams,
): Promise<CloudSubmissionOutcome> {
  const { commandId, request, bodyVersion, deps } = params;

  const frozen = deps.freezeAttempt({ commandId, request, bodyVersion });
  if (!frozen) {
    // 本地写入失败必须阻止 Cloud 提交并解释恢复限制：否则刷新后既没有本地记录，
    // 也无法用原 key 对账（04 §3.4.1）。
    return { kind: "not-frozen", message: "cloud submit attempt could not be persisted locally" };
  }

  try {
    const result =
      request.kind === "input"
        ? await deps.controlPlane.submitInput(deps.taskId, request.body as SubmitTaskInput, {
            signal: params.signal,
          })
        : await submitReopen(deps, request.body, params.signal);

    deps.settleAttempt(commandId, {
      phase: "persisted",
      httpStatus: result.httpStatus,
      receipt: result.receipt,
    });
    return {
      kind: "persisted",
      httpStatus: result.httpStatus,
      receipt: result.receipt,
      commandId,
    };
  } catch (error) {
    const message = describeCloudSubmissionError(error);
    if (isDefinitiveCloudFailure(error)) {
      deps.settleAttempt(commandId, { phase: "rejected", message });
      return { kind: "rejected", commandId, message };
    }
    // 结果未知（超时/断网/网关错误）：不能当成没发，也不能自动换 key。
    deps.settleAttempt(commandId, { phase: "unknown", message });
    return { kind: "unknown", commandId, message };
  }
}

interface CloudReopenSubmissionResult {
  readonly httpStatus: number;
  readonly receipt: InputReceipt;
}

async function submitReopen(
  deps: CloudTaskSubmissionDeps,
  body: Extract<CloudSubmitRequest, { kind: "reopen" }>["body"],
  signal: AbortSignal | undefined,
): Promise<CloudReopenSubmissionResult> {
  const detail = await deps.controlPlane.reopenTask(deps.taskId, body, { signal });
  // reopen 的响应是 task detail：投递状态以控制面投影为准，这里只回填 task/run
  // 关联字段，**不合成 runtime ACK**（03 §7.2）。
  return {
    httpStatus: 200,
    receipt: {
      taskId: deps.taskId,
      commandId: body.commandId,
      deliveryStatus: "accepted",
      ...(detail.activeRun
        ? { runId: detail.activeRun.runId, runGeneration: detail.activeRun.runGeneration }
        : {}),
    },
  };
}

/**
 * 对账：刷新后先用**原 commandId**查询，拿到明确 receipt 才允许同 payload 重试
 * （04 §3.2.3「unknown 恢复原 key」、03 §7「命令发送超时先查询 commandId」）。
 */
export async function reconcileCloudTaskInput(
  deps: Pick<CloudTaskSubmissionDeps, "controlPlane" | "taskId" | "applyReceipt">,
  commandId: string,
  options?: { readonly signal?: AbortSignal },
): Promise<InputReceipt> {
  const receipt = await deps.controlPlane.getInput(deps.taskId, commandId, {
    signal: options?.signal,
  });
  deps.applyReceipt(commandId, receipt);
  return receipt;
}

/**
 * 判定是否为「明确失败」：只有服务端给出了确定结论（校验失败、冲突、未授权等）才算；
 * 网关/传输层错误与 unknown 类语义保留为待对账（03 §5「结果未知不得写成 failed」）。
 */
function isDefinitiveCloudFailure(error: unknown): boolean {
  if (!isCloudApiErrorLike(error)) {
    // 非结构化错误（fetch 抛错、超时中止）一律按结果未知处理。
    return false;
  }
  if (isCloudApiErrorRetryable(error)) {
    return false;
  }
  const code = error.code;
  return code !== "network_unknown" && code !== "protocol_incompatible";
}
