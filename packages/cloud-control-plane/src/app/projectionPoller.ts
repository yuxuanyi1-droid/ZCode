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
            // v4 投影：rows/range 是稳定行序（rowId 升序），legacy readSessionMessages
            // 无法解析 v4 消息结构，不能用于云历史。
            const rows = await this.loadRows(connection, info.sessionId, {
              workspacePath: run.checkoutPath,
            });
            rows.forEach((row, index) => {
              this.store.appendProjection({
                taskId: task.id,
                // 每个 Run 使用独立 epoch；会话内序号保持单调。
                logEpoch: run.generation,
                seq: epoch * 1_000_000 + index + 1,
                kind: "row",
                payloadJson: JSON.stringify(row),
              });
            });
            signature.push(`${info.sessionId}:${rows.length}`);
          }
          const current = signature.join("|");
          if (current !== lastSignature) {
            lastSignature = current;
            this.broadcast({ type: "projection", taskId: task.id });
          }
        } catch (error) {
          // 连接断开时停止轮询；重连后由新的 pipeline 恢复。首次失败必须落日志，
          // 不能把“投影一直是空的”静默当成正常结束。
          process.stderr.write(
            `[cloud-projection] ${run.id} polling failed: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          this.stop(run.id);
        }
      })();
    }, 1000);
    timer.unref?.();
    this.timers.set(run.id, timer);
  }

  private async loadRows(
    connection: DaemonConnection,
    sessionId: string,
    target: { workspacePath: string },
  ): Promise<Array<Record<string, unknown>>> {
    const pages: Array<Array<Record<string, unknown>>> = [];
    let beforeRowId: number | undefined;
    for (let page = 0; page < 6; page += 1) {
      const result = await connection.callAgent<{
        rows?: Array<Record<string, unknown>>;
        hasMore?: boolean;
      }>("conversationRowsRangeV4", {
        ...target,
        sessionId,
        limit: 200,
        ...(beforeRowId === undefined ? {} : { beforeRowId }),
      });
      if (!Array.isArray(result?.rows) || result.rows.length === 0) {
        break;
      }
      pages.unshift(result.rows);
      if (!result.hasMore) {
        break;
      }
      const firstRowId = result.rows[0]?.["rowId"];
      if (typeof firstRowId !== "number") {
        break;
      }
      beforeRowId = firstRowId;
    }
    return pages.flat();
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
