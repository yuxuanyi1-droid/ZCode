/**
 * 云任务 run 观察轮询（specs/cloud-agent/04 §3.2.4「202 后等待环境」、03 §6.2）。
 *
 * 背景（2026-10-08 实测缺陷）：首条输入 202 accepted 后，run 在服务端异步
 * provisioning → ready，而客户端的详情投影仍是发出前的快照（draft / 无 activeRun），
 * 且 `reloadTask` 没有任何事件通道会在此时触发——用户不刷新页面就看不到任务已启动。
 *
 * 规则（纯函数 + 可注入定时器，node:test 可直接覆盖）：
 * - 只做**有界轮询**：2s 间隔、60s 上限，超时即停（不得用无限轮询掩盖同步缺失）；
 * - run 尚未出现在投影里（draft → start 事务窗口）→ 继续；
 * - run 处于 `provisioning` → 继续（面板需要展示进行中，直到 ready/终态）；
 * - run 处于 `paused` → 继续（2026-10-09 paused 呈现修订）：paused append 202 后由控制面
 *   自驱 resume（或预算耗尽收口停+重开），轮询把 paused→ready/终态的详情翻转带回来，
 *   pane 才能恢复绑定/翻横幅；60s 上限兜底，不无限空转；
 * - run 进入 `ready` 或终态（failed/stopped/expired/draining/disconnected）→ 停：
 *   ready 由 attachment 生命周期接管，终态由任务面板呈现。
 * - 单次刷新失败不中断轮询（网络抖动等下一轮），上限兜底。
 *
 * 状态所有者不变：轮询只调用 `refresh()`（即控制器的 quiet reload），把最新
 * TaskDetailResponse 写回唯一投影（controller state + cloudTasksStore），
 * 本模块不自持任务状态副本。
 */
import type { TaskDetailResponse } from "@zcode/shared";

export const CLOUD_TASK_RUN_WATCH_INTERVAL_MS = 2_000;
export const CLOUD_TASK_RUN_WATCH_TIMEOUT_MS = 60_000;

/** 测试与调用方共用的最小详情形状（不依赖完整 schema）。 */
export interface CloudTaskRunWatchDetail {
  readonly activeRun?: { readonly status: string } | undefined;
  /** 服务端 actions 投影（2026-10-08 终态 run 发送行为修订）：含 `reopen` 即停止。 */
  readonly actions?: readonly string[] | undefined;
}

/**
 * 下一轮是否继续：run 不可见、provisioning 或 paused 时继续；ready/终态即停。
 * 终态判定交给 `cloudRunStatusSchema` 的取值集合，这里不引入第二套状态机。
 *
 * 2026-10-08 终态 run 发送行为修订：服务端详情投影只携带非终态 run，run 从
 * provisioning → 终态的迁移在投影里表现为 `activeRun` 消失；此时服务端 actions
 * 会给出 `reopen`（无有效写 run 的裁决事实）。把它的出现追加为停止条件——
 * 否则该迁移会被误判成「run 尚未出现」而轮询到 60s 超时。
 *
 * 2026-10-09 paused 呈现修订：`paused` 从「停止条件」改为「继续条件」——paused append
 * （发消息即恢复，03 §6 修订）提交后，自驱 resume / 预算耗尽收口都由服务端异步推进，
 * 客户端只有靠这轮有界轮询把 ready（恢复绑定）/ 终态（reopenable 投影）翻回详情投影。
 */
export function shouldContinueCloudTaskRunWatch(detail: CloudTaskRunWatchDetail | null): boolean {
  if (detail?.actions?.includes("reopen")) {
    // 无有效 run 且可重开：没有可等的 run 了。
    return false;
  }
  const status = detail?.activeRun?.status;
  if (!status) {
    // run 还没出现在投影里：首发 202 后的事务窗口，继续等。
    return true;
  }
  return status === "provisioning" || status === "paused";
}

export interface CloudTaskRunWatchHandle {
  /** 停止轮询并放弃未决回调（切换任务 / 组件卸载时必须调用）。 */
  cancel(): void;
}

export interface CloudTaskRunWatchDeps {
  /**
   * 一次静默刷新：返回最新详情（null 表示本轮失败，轮询按「继续」处理直到上限）。
   * 实现方负责把成功结果写入唯一投影，这里不缓存。
   */
  refresh(): Promise<TaskDetailResponse | null>;
  /** 可注入时钟与定时器（默认真实全局）。 */
  now?(): number;
  schedule?(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  cancelScheduled?(timer: ReturnType<typeof setTimeout>): void;
}

/**
 * 启动有界轮询：立即刷一次（202 后尽快把「环境准备中」翻出来），此后每
 * `CLOUD_TASK_RUN_WATCH_INTERVAL_MS` 一次，直到 run 可见且非 provisioning、
 * 或超过 `CLOUD_TASK_RUN_WATCH_TIMEOUT_MS`、或被 `cancel()`。
 */
export function startCloudTaskRunWatch(deps: CloudTaskRunWatchDeps): CloudTaskRunWatchHandle {
  const now = deps.now ?? (() => Date.now());
  const schedule = deps.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancelScheduled = deps.cancelScheduled ?? ((timer) => clearTimeout(timer));

  const startedAt = now();
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async (): Promise<void> => {
    if (cancelled) {
      return;
    }
    let next: TaskDetailResponse | null = null;
    try {
      next = await deps.refresh();
    } catch {
      // 单轮失败保留为「继续等」：终态判定只信下一轮成功的投影，上限兜底。
      next = null;
    }
    if (cancelled) {
      return;
    }
    if (next !== null && !shouldContinueCloudTaskRunWatch(next)) {
      return;
    }
    if (now() - startedAt >= CLOUD_TASK_RUN_WATCH_TIMEOUT_MS) {
      return;
    }
    timer = schedule(() => void tick(), CLOUD_TASK_RUN_WATCH_INTERVAL_MS);
  };

  void tick();
  return {
    cancel() {
      cancelled = true;
      if (timer !== null) {
        cancelScheduled(timer);
        timer = null;
      }
    },
  };
}
