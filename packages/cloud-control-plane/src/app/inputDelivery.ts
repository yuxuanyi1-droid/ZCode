import type { CloudStore } from "../adapters/storage/db.js";
import type { DaemonConnection } from "../adapters/zcode/daemonClient.js";
import type { InputRecord, RunRecord, TaskRecord } from "../domain/types.js";
import type { ProjectionPoller } from "./projectionPoller.js";

export interface InputDeliveryContext {
  store: CloudStore;
  sessions: Map<string, string>;
  projectIds: Map<string, string>;
  projection: ProjectionPoller;
  broadcast: (event: { type: "task"; taskId: string }) => void;
}

/** 惰性创建 runtime session；浏览器也可能先自行创建，二者共用同一 workspace。 */
export async function ensureSession(
  context: InputDeliveryContext,
  run: RunRecord,
  task: TaskRecord,
  connection: DaemonConnection,
): Promise<string> {
  const existing = context.sessions.get(run.id);
  if (existing) {
    return existing;
  }
  await connection
    .callAgent("initialize", {
      workspacePath: run.checkoutPath,
    })
    .catch(() => undefined);
  const projectId = context.projectIds.get(run.id);
  const snapshot = await connection.callAgent<{
    sessionId?: string;
    session?: { sessionId?: string };
  }>("createSession", {
    ...(projectId ? { projectId } : {}),
    // 只传 path：原始 Web 以 server-info 的 path 作为 workspace key（本地语义）。
    // 传 remote identity 会让 Web 把目标判定为 remote-waiting 并禁用发送。
    workspacePath: run.checkoutPath,
  });
  const sessionId = snapshot?.sessionId ?? snapshot?.session?.sessionId;
  if (!sessionId) {
    throw new Error("createSession returned no sessionId");
  }
  context.sessions.set(run.id, sessionId);
  context.projection.start(run, task, connection);
  return sessionId;
}

export async function deliverPending(
  context: InputDeliveryContext,
  run: RunRecord,
  task: TaskRecord,
  connection: DaemonConnection,
): Promise<void> {
  const inputs = context.store.listDeliverableInputs(task.id, run.id);
  for (const input of inputs) {
    if (input.intent === "stop") {
      continue;
    }
    await deliverOne(context, run, task, connection, input);
  }
}

export async function deliverOne(
  context: InputDeliveryContext,
  run: RunRecord,
  task: TaskRecord,
  connection: DaemonConnection,
  input: InputRecord,
): Promise<void> {
  if (input.deliveryStatus === "acked") {
    return;
  }
  const payload = JSON.parse(input.payloadJson) as {
    prompt?: string;
    modelSelection?: Record<string, unknown>;
  };
  context.store.markInputDelivered(input.id, run.id);
  try {
    const sessionId = await ensureSession(context, run, task, connection);
    await connection.callAgent("sendPrompt", {
      workspacePath: run.checkoutPath,
      sessionId,
      content: payload.prompt ?? "",
      ...(payload.modelSelection ? { modelSelection: payload.modelSelection } : {}),
    });
    context.store.markInputAcked(input.id);
  } catch (error) {
    context.store.markInputFailed(input.id, error instanceof Error ? error.message : String(error));
  }
  context.broadcast({ type: "task", taskId: task.id });
}
