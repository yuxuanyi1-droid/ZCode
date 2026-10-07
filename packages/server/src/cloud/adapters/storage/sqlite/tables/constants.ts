/**
 * 表定义共享的词表常量（状态与 kind 的 CHECK 值）。
 *
 * 单一来源：每个常量只在这里声明一次，表族文件与适配层校验共用，避免同一词表
 * 在多个文件里各写一份而漂移（03 §4、08 §3）。
 */
export const TASK_STATUS = "'draft','active','completed','failed','archived'";
export const RUN_STATUS =
  "'provisioning','ready','disconnected','draining','stopped','expired','failed'";
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

/** 非终态 run：占配额、占用「唯一有效写 run」名额（01 §4.3、08 §4.2）。 */
export const ACTIVE_RUN_STATUSES = ["provisioning", "ready", "disconnected", "draining"] as const;
