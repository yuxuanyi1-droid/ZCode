/**
 * 云输入到 V4 命令信封的构造（02 §6.1 唯一写入路径、§6.2 保留既有 V4 语义、
 * 01 §6.2 步骤 7）。
 *
 * 约束：
 * - 首输入复用既有 `createSession.firstInput`，一个稳定 commandId 绑定创建与首条工作；
 *   后续 append 用 `sendText`，仍经过同一接纳/投递 port（02 §6.2、01 §6.2 第 7 条）。
 * - 信封只做「V4 命令原信封」构造，不另建业务协议；构造结果用 shared 的
 *   `parseCommandEnvelope` 校验（信封 schema 无法静态关联 payload，收口在那里）。
 * - `sessionId` 在 createSession 时必须为 null，sendText 必须携带 runtime sessionId。
 * - prompt/secret 不进日志；本函数只做纯映射。
 */
import { parseCommandEnvelope, type CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import type { CloudExecutionConfig } from "@zcode/shared";

export interface BuildEnvelopeInput {
  taskId: string;
  commandId: string;
  /** 首输入为 createSession；后续 append 为 sendText（02 §6.2）。 */
  kind: "createSession" | "sendText";
  prompt: string;
  /** createSession 的 workspaceId：仓库任务恒为 `cloud-task:<taskId>`（02 §2 不变量 1）。 */
  workspaceIdentity: string;
  /** createSession 必须为 null；sendText 必须为当前 run 的 runtimeSessionId。 */
  runtimeSessionId?: string;
  config?: CloudExecutionConfig;
  now: number;
}

export type BuildEnvelopeResult =
  | { ok: true; envelope: CommandEnvelope }
  | { ok: false; reason: string };

export function buildCloudCommandEnvelope(input: BuildEnvelopeInput): BuildEnvelopeResult {
  if (input.kind === "sendText" && !input.runtimeSessionId) {
    // 02 §6.2：session 命令必须携带 sessionId；不得靠重连重造会话。
    return { ok: false, reason: "missing-runtime-session" };
  }
  const config = input.config;
  const payload =
    input.kind === "createSession"
      ? {
          workspaceId: input.workspaceIdentity,
          firstInput: {
            text: input.prompt,
            ...(config?.modelSelection ? { modelSelection: config.modelSelection } : {}),
            ...(config?.mode ? { mode: config.mode } : {}),
            ...(config?.planEnabled !== undefined ? { planEnabled: config.planEnabled } : {}),
          },
          ...(config
            ? {
                config: {
                  ...(config.modelSelection ? { modelSelection: config.modelSelection } : {}),
                  ...(config.mode ? { mode: config.mode } : {}),
                  ...(config.planEnabled !== undefined ? { planEnabled: config.planEnabled } : {}),
                },
              }
            : {}),
        }
      : {
          text: input.prompt,
          ...(config?.modelSelection ? { modelSelection: config.modelSelection } : {}),
          ...(config?.mode ? { mode: config.mode } : {}),
          ...(config?.planEnabled !== undefined ? { planEnabled: config.planEnabled } : {}),
        };

  const candidate = {
    commandId: input.commandId,
    // 控制面作为云任务的唯一发送端；clientId 不携带 secret，也不用于裁决。
    clientId: `cloud-task:${input.taskId}`,
    sessionId: input.kind === "createSession" ? null : (input.runtimeSessionId ?? null),
    type: input.kind,
    payload,
    issuedAt: input.now,
  };
  const parsed = parseCommandEnvelope(candidate);
  if (!parsed.ok) {
    return { ok: false, reason: "invalid-command-envelope" };
  }
  return { ok: true, envelope: parsed.envelope };
}

/**
 * 权限/交互决定的命令信封（03 §7.2：权限应答/取消命令绑定 interactionId/sessionId/logEpoch/
 * currentRun，过时返回 stale；相同审批两端同时提交由 runtime 唯一裁决）。
 * 复用既有 `resolveInteraction` payload，不另建业务协议。
 */
export function buildInteractionCommandEnvelope(input: {
  taskId: string;
  commandId: string;
  runtimeSessionId: string;
  interactionId: string;
  answer: {
    optionId?: string;
    freeText?: string;
    action?: "accept" | "decline" | "cancel";
    content?: Record<string, unknown>;
  };
  now: number;
}): BuildEnvelopeResult {
  const candidate = {
    commandId: input.commandId,
    clientId: `cloud-task:${input.taskId}`,
    sessionId: input.runtimeSessionId,
    type: "resolveInteraction",
    payload: { interactionId: input.interactionId, answer: input.answer },
    issuedAt: input.now,
  };
  const parsed = parseCommandEnvelope(candidate);
  if (!parsed.ok) return { ok: false, reason: "invalid-interaction-envelope" };
  return { ok: true, envelope: parsed.envelope };
}
