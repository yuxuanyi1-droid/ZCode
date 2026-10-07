/**
 * 持久层端口 barrel（specs/cloud-agent 03 §4 持久数据与约束、§5 外部操作不是事务、
 * §6.1 接纳事务）。
 *
 * 实现按能力拆分在相邻文件（03 §2「接口按 task/run/projection/lifecycle/credential
 * 能力拆分，单契约不演变为数十个方法的大 Service」），但**本文件保持原有的导出名与
 * 导入路径不变**：`TaskRepo`/`RunRepo`/`InputRepo`/`ProjectionRepo`/`ProjectRepo`/
 * `RunCredentialRepo`/`InputPayloadRead`/`CursorPage`/`OperationOutboxPort` 等一律
 * 经这里可见，消费者（W2 adapters、W1 app）无需改 import。
 *
 * 不变量：同类确认不互相冒充——transport ACK / runtime admission / durable ingest /
 * outbox accepted 是四类不同事实（02 §2 不变量 6）；事务与唯一约束承担状态迁移，
 * 不用设置 JSON 或业务内存表替代（03 §4）。
 */
import type {
  CloudDraftStartConfig,
  CloudErrorCode,
  CloudExecutionConfig,
  CloudExecutionRecipe,
  InputReceipt,
} from "@zcode/shared";
import type { ProjectionRepo } from "./projectionPort.js";
import type { InputPayloadRead, InputRepo } from "./inputPort.js";
import type { ProjectRepo } from "./projectPort.js";
import type { RunCredentialRepo } from "./credentialPort.js";
import type { RunRepo } from "./runPort.js";
import type { TaskRepo } from "./taskPort.js";

export * from "./cursorPage.js";
export * from "./projectPort.js";
export * from "./taskPort.js";
export * from "./runPort.js";
export * from "./inputPort.js";
export * from "./projectionPort.js";
export * from "./credentialPort.js";
export * from "./operationOutboxPort.js";
export * from "./gitGrantPort.js";
export * from "./gitHubEffectPort.js";

// ── 接纳事务（03 §5/§6.1：输入 + run 意图 + 配额 + create 操作同一事务）──

export interface AcceptInputRequest {
  taskId: string;
  commandId: string;
  intent: "start" | "append" | "reopen";
  /**
   * start 的启动选择（W1 CR-1），镜像 wire 的 `SubmitTaskInput.start`（同一
   * `CloudDraftStartConfig` 形状）：`intent=start` 时必须给出，且必须与已持久
   * `draftStartConfig` 一致——接纳事务内校验，不一致返回结构化冲突（03 §6
   * 「事务验证两者一致」）。append 不得携带（不改变已冻结的启动事实）。
   */
  start?: CloudDraftStartConfig;
  /** 规范结构化编码的 fingerprint；同 key 不同 payload 拒绝（03 §6.1）。 */
  payloadHash: string;
  /** 完整正文持久保存；投递只读持久正文，不读调用方内存（02 §6.1）。 */
  prompt: string;
  attachmentIds?: string[];
  requestedConfig?: CloudExecutionConfig;
  resolvedExecutionConfig?: CloudExecutionConfig;
  resolvedAuthorizationRef?: string;
  expectedTaskRevision?: number;
  expectedRunGeneration?: number;
  /** intent=start/reopen 时预检已冻结的 Run 配方与分支；append 不再改写 recipe。 */
  runRecipe?: CloudExecutionRecipe;
  taskBranch?: string;
  /**
   * create 操作的持久意图（operationId 幂等键，03 §5；W1 CR-2）：
   * `intent=start` 时必须给出；`append` 不带——append 不创建 create 操作，也不得传
   * 占位 id（占位 id 会让 outbox 出现永不结算的假操作）。
   */
  createOperationId?: string;
  runId?: string;
  /** 配额上限由 domain 判定后传入，事务内 count+reserve 一次完成（01 §4.3）。 */
  quota: { maxConcurrentRuns: number };
  now: number;
}

/**
 * 接纳结论。
 *
 * `conflict.reason` 是**已关闭的枚举**：附件未发布/不可用**不在**其中——该情形按
 * `validation_failed` 处理（03 §6 校验类错误），不要新造一个 reason 分支
 * （W2 口径确认）。
 */
export type AcceptInputResult =
  | { status: "accepted"; receipt: InputReceipt; runId?: string; runGeneration?: number }
  | { status: "duplicate"; receipt: InputReceipt }
  | {
      status: "conflict";
      code: CloudErrorCode;
      reason:
        | "payload-mismatch"
        | "revision-mismatch"
        | "generation-stale"
        | "not-ready"
        | "quota-exceeded"
        | "stop-requested"
        | "no-active-run"
        | "start-on-active"
        /** start 选择与已持久 draftStartConfig 不一致（03 §6，W1 CR-1）。 */
        | "start-config-mismatch";
    };

export interface StorageReadiness {
  /** 最近已应用迁移 id；migration 未就绪不得服务（03 §8 启动顺序）。 */
  lastAppliedMigrationId: string | null;
  schemaVersion: number;
  writable: boolean;
  attachmentsWritable: boolean;
}

export interface StoragePort {
  readonly projects: ProjectRepo;
  readonly tasks: TaskRepo;
  readonly runs: RunRepo;
  readonly inputs: InputRepo;
  readonly projections: ProjectionRepo;
  readonly credentials: RunCredentialRepo;
  readonly payloads: InputPayloadRead;
  /**
   * 唯一接纳入口（03 §6.1）：先查 duplicate，再检查 revision/Task/Run/stop/配额，
   * 然后同事务写 Input + Run recipe + acceptanceSeq + 配额 + create 操作。
   * 事务外的外部预检结果不得写进本调用之外的第三条路径。
   */
  acceptInput(request: AcceptInputRequest): Promise<AcceptInputResult>;
  /** 启动门：可写性/锁/空间与迁移就绪（03 §4、§8）。 */
  readiness(): Promise<StorageReadiness>;
}
