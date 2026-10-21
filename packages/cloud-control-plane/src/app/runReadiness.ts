import type { CloudStore } from "../adapters/storage/db.js";
import type { RunRecord } from "../domain/types.js";
import { isTerminalRun } from "./support.js";

/**
 * 浏览器进入任务时唤醒 paused Run：原始 Web 只会重连 `/api/server-info` 与 `/ws`，
 * 不会调用云 API 提交输入。若 Run 已暂停，先恢复 provider 并等待重新 ready。
 */
export async function ensureRunReadyForAccess(
  store: CloudStore,
  taskId: string,
  resume: (run: RunRecord) => Promise<void>,
): Promise<RunRecord | null> {
  const task = store.getTask(taskId);
  if (!task) {
    return null;
  }
  let run = task.activeRunId ? store.getRun(task.activeRunId) : null;
  if (!run || isTerminalRun(run)) {
    return null;
  }
  if (run.status === "paused") {
    await resume(run);
    run = store.getRun(run.id);
    if (!run) {
      return null;
    }
  }
  if (run.status === "provisioning") {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const current = store.getRun(run.id);
      if (!current || isTerminalRun(current)) {
        return null;
      }
      run = current;
      if (run.status === "ready" || run.status === "paused") {
        break;
      }
    }
  }
  return run.status === "ready" ? run : null;
}
