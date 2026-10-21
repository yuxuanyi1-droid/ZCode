import type { CloudStore } from "../adapters/storage/db.js";
import type { DaemonConnection } from "../adapters/zcode/daemonClient.js";
import type { RunRecord } from "../domain/types.js";
import { CloudError } from "@zcode/cloud-protocol";

/** 诊断：当前 Run 的会话与 v4 行投影（不经过控制面持久层）。 */
export async function debugTask(input: {
  store: CloudStore;
  connections: Map<string, DaemonConnection>;
  taskId: string;
}): Promise<unknown> {
  const task = input.store.getTask(input.taskId);
  if (!task) {
    throw new CloudError("not_found", `task not found: ${input.taskId}`);
  }
  const run = task.activeRunId
    ? input.store.getRun(task.activeRunId)
    : (input.store.listRuns(task.id)[0] ?? null);
  const connection = run ? input.connections.get(run.id) : null;
  if (!run || !connection) {
    return { run, sessions: [], rows: {} };
  }
  const target = {
    workspacePath: run.checkoutPath,
    workspaceIdentity: task.workspaceIdentity,
  };
  const sessions = await connection
    .callAgent<Array<{ sessionId?: string }>>("listSessions", { ...target, limit: 20 })
    .catch((error: unknown) => ({ error: String(error) }));
  const rows: Record<string, unknown> = {};
  if (Array.isArray(sessions)) {
    for (const session of sessions) {
      if (typeof session.sessionId !== "string") continue;
      rows[session.sessionId] = await connection
        .callAgent("conversationRowsRangeV4", { sessionId: session.sessionId, limit: 100 })
        .catch((error: unknown) => String(error));
    }
  }
  return { run: run as RunRecord, sessions, rows };
}
