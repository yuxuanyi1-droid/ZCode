/**
 * 表定义共享的词表常量（状态与 kind 的 CHECK 值）。
 *
 * 单一来源：每个常量只在这里声明一次，表族文件与适配层校验共用，避免同一词表
 * 在多个文件里各写一份而漂移（03 §4、08 §3）。
 *
 * 编号纪律（E-1，2026-10-09 生命周期 v2）：`0001` 的内容一经应用即冻结——开发库
 * 账本已记录其 checksum，原地改写会让启动校验失败。因此 `paused`（08 §3.2 修订）
 * 不改写 `0001` 的 CHECK，而是：
 * - `RUN_STATUS_LEGACY` 冻结 `0001` 使用的原词表（初建表 DDL 专用）；
 * - `RUN_STATUS` 是当前词表（含 `paused`），由 `0007` 的表重建迁移落到 CHECK；
 * - 消费侧统一用 `ACTIVE_RUN_STATUSES` / `TERMINAL` 词表拼 SQL，不手写状态列表。
 */
export const RUN_STATUS_LEGACY =
  "'provisioning','ready','disconnected','draining','stopped','expired','failed'";
/** 当前 RUN_STATUS 词表（0007 起：含 paused，2026-10-09 生命周期 v2）。 */
export const RUN_STATUS =
  "'provisioning','ready','paused','disconnected','draining','stopped','expired','failed'";
export const TASK_STATUS = "'draft','active','completed','failed','archived'";
export const DELIVERY_STATUS =
  "'accepted','delivering','admitted','rejected','uncertain','cancelled'";

/**
 * `external_operations.kind` 的 CHECK：覆盖 `ExternalOperationKind` 的 9 个值
 * （provider/生命周期/发布/清理：create/terminate/extend/checkpoint/publish-pr/
 * check/comment/token-revoke/cleanup）**加** effect 侧的 `pull-request`——W0 明确
 * 保留这一处命名差异（`publish-pr` ≡ `pull-request`，见 operationOutboxPort.ts），
 * 两处各自扩张都会让写入被 CHECK 直接拒绝（W4 CR-7）。
 */
export const OPERATION_KINDS =
  "'create','terminate','extend','checkpoint','publish-pr','check','comment','token-revoke','cleanup','pull-request'";
export const OPERATION_STATES = "'pending','leased','settled','failed','ambiguous'";

/**
 * 非终态 run：占配额、占用「唯一有效写 run」名额（01 §4.3、08 §4.2、08 §6 修订）。
 * `paused` 为 2026-10-09 生命周期 v2 增补：暂停保留期仍占槽（quota_released_at 保持
 * NULL），并发上限 3 时「3 个 paused 占槽 → 第 4 个任务 409」为预期行为。
 *
 * 单点词表（逐消费者核对，见 cloudLifecycleBatch2 测试）：
 * - runRepo：`selectActiveRun`（activeOfTask）/`listNonTerminal`（恢复扫描、dispatcher、
 *   keepalive、readiness、startup、stop sweep、drain、checkpoint sweep 全部经由）；
 * - credentialRepo：`consumeForHello` 的活动 run 存在性校验（resume 回连时 run 仍为
 *   paused，必须放行 hello，否则长暂停后凭据校验永远失败）；
 * - 0007 迁移：`runs_single_active_writer` / `runs_recovery_scan` 部分索引同步含 paused；
 * - 运行时消费者对 paused 的显式分支见 keepalive/startup/dispatcher/pauseResume。
 */
export const ACTIVE_RUN_STATUSES = [
  "provisioning",
  "ready",
  "paused",
  "disconnected",
  "draining",
] as const;
