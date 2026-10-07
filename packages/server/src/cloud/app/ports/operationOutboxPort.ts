/**
 * 外部操作 outbox 端口草案（specs/cloud-agent/03 §5 外部操作不是数据库事务、
 * 01 §5.3 启动对账）。
 *
 * provider create/terminate/extend、checkpoint、PR 发布都不能与 SQLite 组成一个
 * 原子事务，因此统一走「持久 operation 意图 + 租约串行 + ambiguous 对账」：
 * - 网络超时不是失败：结果未知必须保持可查询、可对账的状态，不能盲目重复副作用。
 * - operationId 是幂等键；重试复用同一 id，不生成第二个 operation。
 * - 只有唯一 worker 能领取同一 operation（租约），并发创建不得出现第二条沙箱。
 */
import type { CloudErrorCode } from "@zcode/shared";

/**
 * 外部操作种类。必须与 `GitHubEffectKind`（`gitHubEffectPort.ts`）**同集合**：
 * 新增一类 GitHub 副作用时必须同时在两处登记，避免 outbox 与执行器各自扩张
 * （W4 CR-7；唯一命名差异见下）。
 *
 * - `publish-pr` ≡ effect 的 `pull-request`（同一个 GitHub 发布副作用；08 §8.2 的幂等键前缀
 *   就是 `publish-pr:<runId>:<checkpointId>`，故 outbox 侧保留该名）；
 * - `check` / `comment` 属 09 §3 标注的 M7 条件性：执行器当前以 `failed: not_implemented`
 *   收口，不伪装成功；
 * - `token-revoke` 是 git grant 撤销通路，按尽力语义执行（01 §7.2：已发出的 token 不可收回，
 *   只等最晚到期）。
 */
export type ExternalOperationKind =
  | "create"
  | "terminate"
  | "extend"
  | "checkpoint"
  | "publish-pr"
  | "check"
  | "comment"
  | "token-revoke"
  | "cleanup";

export type ExternalOperationState =
  | "pending"
  | "leased"
  | "settled"
  | "failed"
  /** 结果未知：必须对账，不能被当成 failed（03 §5）。 */
  | "ambiguous";

export interface ExternalOperationRecord {
  operationId: string;
  kind: ExternalOperationKind;
  /** 业务键唯一：同 key 的重复请求返回同一 operation（03 §5）。 */
  idempotencyKey: string;
  taskId?: string;
  runId?: string;
  runGeneration?: number;
  state: ExternalOperationState;
  attempt: number;
  leaseExpiresAt?: number;
  /** 结果引用（provider handle、remote SHA、PR 号等），不含 secret。 */
  resultRef?: string;
  errorCode?: CloudErrorCode;
  createdAt: number;
  updatedAt: number;
}

export interface LeasedOperation {
  operation: ExternalOperationRecord;
  /** 结算必须携带租约令牌：旧租约的迟到结果不得覆盖新 worker。 */
  leaseToken: string;
  leaseExpiresAt: number;
}

export interface OperationOutboxPort {
  /** 入队即持久；同 idempotencyKey 幂等返回既有 operation。 */
  enqueue(request: {
    operationId: string;
    kind: ExternalOperationKind;
    idempotencyKey: string;
    taskId?: string;
    runId?: string;
    runGeneration?: number;
    now: number;
  }): Promise<ExternalOperationRecord>;
  findByKey(idempotencyKey: string): Promise<ExternalOperationRecord | null>;
  get(operationId: string): Promise<ExternalOperationRecord | null>;
  /**
   * 租约领取（W2 口径确认，语义补全）：可领取两类记录——
   * 1) `pending`，或租约已到期的 `leased`；
   * 2) **租约到期且 `state=ambiguous`** 的记录：这是 03 §5/§8 的对账入口（结果未知的
   *    create/terminate/push/PR 不能永远搁置，必须被恢复扫描重新领取并对账）。
   * 同一 operation 不会有两个有效租约；结算必须带 leaseToken。
   */
  leaseNext(request: {
    kinds: readonly ExternalOperationKind[];
    workerId: string;
    leaseMs: number;
    now: number;
  }): Promise<LeasedOperation | null>;
  /** 结算 CAS：租约令牌不匹配返回 false（迟到结果只用于对账）。 */
  settle(request: {
    operationId: string;
    leaseToken: string;
    outcome: "settled" | "ambiguous" | "failed";
    resultRef?: string;
    errorCode?: CloudErrorCode;
    now: number;
  }): Promise<boolean>;
  /** 启动恢复扫描：所有未结算 operation（03 §8）。 */
  listUnsettled(): Promise<ExternalOperationRecord[]>;
}
