/**
 * ExecutionRun 持久端口（specs/cloud-agent 03 §4 runs 表、08 §3.2/§4.2/§7）。W2 实现。
 *
 * 每 Task 至多一个有效写 run，由唯一约束 + CAS 分配；断网只进入 disconnected，
 * 不授权第二个 run（02 §2 不变量 4、08 §4.2）。
 */
import type { CloudExecutionRecipe, CloudRunRecord, CloudRunStatus } from "@zcode/shared";

export interface ReserveRunRequest {
  taskId: string;
  runId: string;
  /** 事务内递增；task+generation 唯一（08 §4.2）。 */
  executionRecipe: CloudExecutionRecipe;
  firstInputCommandId?: string;
  workspacePath?: string;
  /** 配额预留：provisioning/ready/disconnected/draining 都占槽（01 §4.3）。 */
  quota: { maxConcurrentRuns: number };
  now: number;
}

/** `reserveRun` 的冲突原因（以错误抛出，不是返回值分支）。 */
export type RunReserveConflictReason = "stale" | "active-write-run-exists" | "quota_exceeded";

export interface RunReservation {
  run: CloudRunRecord;
  runGeneration: number;
}

export interface RunRepo {
  get(runId: string): Promise<CloudRunRecord | null>;
  /** 每 Task 至多一个有效写 run；无有效 run 时返回 null（08 §4.2）。 */
  activeOfTask(taskId: string): Promise<CloudRunRecord | null>;
  /**
   * 预约新 Run。
   *
   * **冲突以错误抛出（reject），不是失败分支**：`reason: RunReserveConflictReason`
   * （`stale` / `active-write-run-exists` / `quota_exceeded`）。消费者（W1/W5）必须捕获并
   * 转成结构化错误，不能静默吞掉后继续当作已预约。
   */
  reserveRun(request: ReserveRunRequest): Promise<RunReservation>;
  /** 恢复扫描：列出所有非终态 run（03 §8）。 */
  listNonTerminal(): Promise<CloudRunRecord[]>;
  /** 写 provider handle/deadline：必须同时匹配 runGeneration（01 §5.1 第 3 条）。 */
  recordProviderHandle(request: {
    runId: string;
    runGeneration: number;
    provider: string;
    providerHandle: string;
    workspacePath?: string;
    providerDeadline?: number;
    deadlineEstimate?: number;
    now: number;
  }): Promise<boolean>;
  /** 状态 CAS：旧代际/旧 epoch 一律不生效（08 §4.2）。 */
  transitionStatus(request: {
    runId: string;
    runGeneration: number;
    from: readonly CloudRunStatus[];
    to: CloudRunStatus;
    endReason?: string;
    lastError?: string;
    dataAtRisk?: boolean;
    now: number;
  }): Promise<CloudRunRecord | null>;
  /** 新 socket 接管：epoch 严格递增并返回新值；同 socket 重复 hello 不递增（02 §5.1）。 */
  bumpConnectionEpoch(request: {
    runId: string;
    runGeneration: number;
    expectedEpoch: number;
  }): Promise<number | null>;
  /** 租期事实：只能更新当前代际；估计期限必须带 deadlineConfidence（08 §7）。 */
  updateLease(request: {
    runId: string;
    runGeneration: number;
    expiresAt?: number;
    deadlineEstimate?: number;
    deadlineConfidence?: "low" | "medium" | "high";
    hardDeadlineAt?: number;
    now: number;
  }): Promise<boolean>;
  /** 业务活动更新时间；heartbeat/观看不算活动（08 §7）。 */
  touchBusinessActivity(request: { runId: string; at: number }): Promise<void>;
  /** 停止屏障：持久 stopRequested + operationId，先于任何投递/启动（08 §8.1）。 */
  requestStop(request: { taskId: string; operationId: string; now: number }): Promise<boolean>;
  /** 撤销停止意图：仅用户显式操作且租期允许时（08 §8.1）。 */
  clearStopRequest(request: { taskId: string; expectedOperationId: string }): Promise<boolean>;
  releaseQuota(request: { runId: string; reason: string; now: number }): Promise<void>;
  /** runtime 会话映射（W1 CR-6）：CAS 写，匹配 runGeneration；重连不重造会话（02 §6.2）。 */
  setRunRuntimeSessionId(request: {
    runId: string;
    runGeneration: number;
    runtimeSessionId: string;
    now: number;
  }): Promise<boolean>;
  /**
   * 保存风险标记（W1 CR-6）：CAS 写，只在当前代际生效。`true` 时 UI 必须可见，
   * 且不得宣称工作全部保住（08 §7/§8.2）。
   */
  setRunDataAtRisk(request: {
    runId: string;
    runGeneration: number;
    dataAtRisk: boolean;
    now: number;
  }): Promise<boolean>;
}
