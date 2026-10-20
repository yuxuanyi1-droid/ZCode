import type { DaemonConnection } from "../adapters/zcode/daemonClient.js";
import type { CloudStore } from "../adapters/storage/db.js";
import type { RunRecord, TaskRecord } from "../domain/types.js";

type BroadcastProjection = (event: { type: "projection"; taskId: string }) => void;

/**
 * 轮询沙箱 daemon 的会话与消息，形成控制面持久投影。
 * 浏览器可以自行创建会话，因此按 listSessions 发现，而不是假设单一 session。
 */
export class ProjectionPoller {
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();

  public constructor(
    private readonly store: CloudStore,
    private readonly broadcast: BroadcastProjection,
  ) {}

  public start(run: RunRecord, task: TaskRecord, connection: DaemonConnection): void {
    this.stop(run.id);
    const epochs = new Map<string, number>();
    let lastSignature = "";
    const timer = setInterval(() => {
      void (async () => {
        try {
          const infos = await connection.callAgent<
            Array<{ sessionId?: string; createdAt?: number }>
          >("listSessions", {
            workspacePath: run.checkoutPath,
            workspaceIdentity: task.workspaceIdentity,
            limit: 50,
          });
          if (!Array.isArray(infos)) {
            return;
          }
          const sessions = infos
            .filter(
              (info): info is { sessionId: string; createdAt?: number } =>
                typeof info?.sessionId === "string" && info.sessionId.length > 0,
            )
            .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0));
          const signature: string[] = [];
          for (const info of sessions) {
            if (!epochs.has(info.sessionId)) {
              epochs.set(info.sessionId, epochs.size + 1);
            }
            const epoch = epochs.get(info.sessionId) ?? 1;
            const messages = await connection.callAgent<Array<Record<string, unknown>>>(
              "readSessionMessages",
              {
                workspacePath: run.checkoutPath,
                workspaceIdentity: task.workspaceIdentity,
                sessionId: info.sessionId,
                limit: 500,
              },
            );
            if (!Array.isArray(messages)) {
              continue;
            }
            messages.forEach((message, index) => {
              this.store.appendProjection({
                taskId: task.id,
                // 每个 Run 使用独立 epoch；会话内序号保持单调。
                logEpoch: run.generation,
                seq: epoch * 1_000_000 + index + 1,
                kind: "message",
                payloadJson: JSON.stringify(message),
              });
            });
            signature.push(`${info.sessionId}:${messages.length}`);
          }
          const current = signature.join("|");
          if (current !== lastSignature) {
            lastSignature = current;
            this.broadcast({ type: "projection", taskId: task.id });
          }
        } catch {
          // 连接断开时停止轮询；重连后由新的 pipeline 恢复。
          this.stop(run.id);
        }
      })();
    }, 1000);
    timer.unref?.();
    this.timers.set(run.id, timer);
  }

  public stop(runId: string): void {
    const timer = this.timers.get(runId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(runId);
    }
  }

  public stopAll(): void {
    const runIds = Array.from(this.timers.keys());
    for (const runId of runIds) {
      this.stop(runId);
    }
  }
}
