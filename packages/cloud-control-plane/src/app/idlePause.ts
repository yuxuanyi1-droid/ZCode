import type { CloudStore } from "../adapters/storage/db.js";
import type { SandboxDriver, SandboxHandle } from "../adapters/providers/types.js";
import type { RunRecord, TaskRecord } from "../domain/types.js";

/** 空闲暂停：provider 支持 pause 时，无活动达到阈值后冻结沙箱。 */
export class IdlePauseController {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  public constructor(
    private readonly store: CloudStore,
    private readonly drivers: Map<string, SandboxDriver>,
    private readonly seconds: number | null | undefined,
    private readonly onPaused: (runId: string, taskId: string) => void,
  ) {}

  public schedule(run: RunRecord, task: TaskRecord): void {
    if (!this.seconds) {
      return;
    }
    const driver = this.drivers.get(run.provider);
    if (!driver?.capabilities.pause || !driver.pause) {
      return;
    }
    this.reset(run.id, task.id, driver);
  }

  public touch(runId: string): void {
    const timer = this.timers.get(runId);
    if (!timer) {
      return;
    }
    const run = this.store.getRun(runId);
    const task = run ? this.store.getTask(run.taskId) : null;
    const driver = run ? this.drivers.get(run.provider) : null;
    if (!run || !task || !driver || !this.seconds) {
      return;
    }
    this.reset(run.id, task.id, driver);
  }

  public clear(runId: string): void {
    const timer = this.timers.get(runId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(runId);
    }
  }

  public clearAll(): void {
    const runIds = Array.from(this.timers.keys());
    for (const runId of runIds) {
      this.clear(runId);
    }
  }

  private reset(runId: string, taskId: string, driver: SandboxDriver): void {
    this.clear(runId);
    const timer = setTimeout(
      () => {
        void this.pause(runId, taskId, driver);
      },
      (this.seconds ?? 0) * 1_000,
    );
    timer.unref?.();
    this.timers.set(runId, timer);
  }

  private async pause(runId: string, taskId: string, driver: SandboxDriver): Promise<void> {
    this.timers.delete(runId);
    const run = this.store.getRun(runId);
    if (!run || run.status !== "ready" || !run.providerHandle || !driver.pause) {
      return;
    }
    try {
      await driver.pause(JSON.parse(run.providerHandle) as SandboxHandle);
      this.store.updateRun(runId, { status: "paused" });
      this.onPaused(runId, taskId);
    } catch {
      // provider 不支持或暂停失败：保持 ready，等待下一次空闲窗口。
    }
  }
}
