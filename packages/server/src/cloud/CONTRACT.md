# cloud-control-plane 契约

Cloud 控制面：云服务端（= 标准 ZCode host 本体 + cloud 叠加层，03 §2、00 §11⑧）内的
沙箱任务编排。唯一 owner：Task/Run/配额/输入接受/投递记录/投影副本的持久应用服务。

模块根：`packages/server/src/cloud`（更深的 `cloud/execution` 归 `cloud-execution`
子模块）。对外只暴露 `contract.ts`（端口类型）；跨包 wire schema 的唯一事实源是
`@zcode/shared` 的 cloud 公开入口（`packages/shared/src/cloud/`）。

## 分层

- `domain/`：纯函数与静态表（run/receipt 状态迁移、配额、幂等判定、保存策略）。
  无 IO、无 `await` 世界、不 import `node:*`。
- `app/ports/`：仅类型（本 W0 冻结）。`StoragePort`/`OperationOutboxPort`/`GitHubPort`/
  `SandboxDriverPort`/`AttachmentPort`；事务、CAS、唯一约束语义写在各端口 JSDoc。
- `app/`：taskService、runOrchestrator、inputDelivery、attachments、projections、
  provisioning、lifecycle、reconciler（W1）。
- `adapters/`：SQLite worker、provider、GitHub、secret、HTTP/WS 入口（W2–W5）。

## 状态所有者（00 §4、02 §2）

| 事实                                | 所有者                   | 本模块职责                                                                                                                     |
| ----------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Task/Run/activeRunId/runGeneration  | 控制面持久库             | 事务分配与 CAS 改写                                                                                                            |
| 已接受、未 admission 的输入         | 控制面 durable outbox    | 只投递与对账，不决定 runtime 准入顺序                                                                                          |
| 已 admission 的输入、轮次、权限裁决 | CLI CommandInbox/runtime | 保存 ACK 投影，不另建队列                                                                                                      |
| 已 ingest 的历史/快照               | 控制面持久投影存储       | 冷启动与回放；不从沙箱拉历史                                                                                                   |
| attachment 连接对象                 | 控制面内存注册表         | 可重建，不是元数据事实源                                                                                                       |
| 浏览器观看连接（任务通道 rpc 流）   | bridge 通道多路复用器    | 可重建连接事实；空闲 pause 的「有客户端连接」判定事实源（08 §7），经 `BrowserWatchPort` 注入 app；bridge ws 在线不代表有人观看 |

## 不变量（类型表达不了的部分）

1. 单活写入 run：每 Task 至多一个有效（非终态）run，由唯一约束 + CAS 分配；断网只进入
   `disconnected`，不授权第二个 run（02 §2 不变量 4、08 §4.2）。
2. 终态 run 不可复活；重开 = 新 runId + 更高 runGeneration（08 §3.2/§9）。
3. `connectionEpoch` 接管严格递增；同 socket 重复 hello 复用原 epoch（02 §5.1）。
4. 接纳是原子事务：Input + Run 意图 + 配额 + create 操作；DB 提交成功才回 accepted/202。
   `(owner, taskId, commandId)` 唯一，同 key 不同 payloadHash 返回 `idempotency_conflict`（03 §6）。
5. 四类确认互不冒充：transport ACK / runtime admission / durable ingest / outbox accepted
   （02 §2 不变量 6）。
6. 外部操作（create/terminate/extend/checkpoint/PR）走 operation + 租约 + 对账；结果未知
   不得写成 failed，也不得盲目重发（03 §5）。
7. 云任务执行目标只路由到沙箱 attachment；无远端 owner 时返回结构化错误，绝不回落 host
   本机执行域（03 §2）。
8. 输入只经一条 durable gateway：HTTP `/inputs` 与 `/ws/cloud/tasks/:taskId` 的发送共用
   同一 application port（03 §7.2、11 §11）。
9. checkpoint/stop 走统一通路（08 §8）：控制面经 `AttachmentPort.requestCheckpoint` 下发，
   传输编码是 bridge 控制帧 `checkpoint.request`/`checkpoint.result`（02 §4，CR-1 冻结）；
   `saved` 必须有 remote SHA 证据，未确认按 operationId 对账，不重做 commit、不伪造 saved。
10. 运行配置、clone 事实与 provisioning envelope 只经 bridge 认证通道的 `bootstrap.config`
    帧下发（welcome 之后、ready 之前）；provider env/元数据对 provider API 可读，禁承载凭据，
    provider 命令通道只下发自举要素（01 §6.2、12 §6）。`credentialGeneration` 供 A-08 代际核对。
11. 时间戳统一 epoch 毫秒（对齐 zcode-protocol-v4 Timestamp）。

## DB schema 冻结（03 §4；W2 实现）

表与关键约束（列名以 W2 迁移为准，语义不得偏离）：

| 表                                 | 核心内容                                                                                                                                                                                                                            | 唯一/CAS 约束                                                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `principals`                       | 部署/账号主体与禁用状态                                                                                                                                                                                                             | `principal_id` 唯一                                                                                                 |
| `projects`                         | owner、repo descriptor、展示名                                                                                                                                                                                                      | `(owner_principal_id, repository_id)` 唯一；`revision` CAS                                                          |
| `tasks`                            | owner/project/creationKey/draftStartConfig/冻结分支/状态                                                                                                                                                                            | `task_id` 唯一；`(owner_principal_id, creation_key)` 唯一；`revision` CAS                                           |
| `runs`                             | task/generation/firstInputCommandId/recipe/provider/期限                                                                                                                                                                            | `(task_id, run_generation)` 唯一；每任务至多一个有效写 run；`connection_epoch` CAS                                  |
| `task_inputs`                      | commandId、payloadHash、acceptanceSeq、deliveryStatus                                                                                                                                                                               | `(owner_principal_id, task_id, command_id)` 唯一；`(task_id, acceptance_seq)` 唯一                                  |
| `external_operations`              | create/terminate/extend/checkpoint/publish-pr/check/comment/token-revoke/cleanup 意图                                                                                                                                               | `operation_id` 唯一；`idempotency_key` 唯一；state 提交 CAS                                                         |
| `projection_events`                | topic/logEpoch/sourceSeq/结构化 payload                                                                                                                                                                                             | `(run_id, runtime_incarnation, topic, log_epoch, source_seq)` 唯一                                                  |
| `projection_ingest_cursors`        | 每源流连续 ingest 水位                                                                                                                                                                                                              | `(run_id, topic, log_epoch)` 唯一；水位单调                                                                         |
| `projection_snapshots`             | logEpoch/revision/覆盖 cursor                                                                                                                                                                                                       | 必须声明所覆盖的事件范围                                                                                            |
| `checkpoints`                      | task/run/op、local SHA、confirmed remote SHA、文件范围/风险                                                                                                                                                                         | `operation_id` 唯一；`saved` 必须有 remote SHA                                                                      |
| `task_artifacts`                   | kind=code/noChanges、branch/PR、hash、summaryRef                                                                                                                                                                                    | `(task_id, kind)` 唯一；`noChanges` 必须有摘要                                                                      |
| `run_credentials`                  | bridge 凭据 hash、候选 hash、helloAttemptId、rotationId                                                                                                                                                                             | `run_id` 唯一；只存 hash，明文只经秘密注入通道                                                                      |
| `git_grants`                       | grantId、purpose、issuedAt/expiresAt、hash、单次兑换状态                                                                                                                                                                            | `grant_id` 唯一；兑换 CAS；只持久元数据不持久 raw token                                                             |
| `task_input_interaction_decisions` | 交互决定的持久投递记录：`payload_json`（有界 16 KiB，可恢复投递）+ `payload_hash`（fingerprint）、`kind`、`delivery_status`、`delivery_command_id`（ACK 回写反查键）；取消意图（独立 `cancel_command_id`）per (task_id, command_id) | 决定 `(task_id, interaction_id)` 唯一、`(task_id, delivery_command_id)` 唯一；取消意图 `(task_id, command_id)` 唯一 |
| `account_installations`            | 主体与 installation/repo 权限投影                                                                                                                                                                                                   | `(principal_id, installation_id)` 唯一；M7/公开服务前必需（00 §11⑤ 条件性）                                         |
| `webhook_inbox`                    | deliveryId、payload hash、处理状态                                                                                                                                                                                                  | `delivery_id` 唯一；M7 条件性，未启用时端点返回 `not_implemented`                                                   |

迁移链（冻结，08 §4.3「冻结的 0001 常量不回改」；CR-4 裁决沿用回退前编号，W2 §8 记为单向门）：

```
0001_cloud_control_plane_initial        # 冻结常量，不得回改
0002_run_credentials
0003_git_grants
# 0004 永久退役：原 SSH attachment，随 00 §11⑥ 移除；编号不复用
0005_task_input_interaction_decisions
0006_attachment_objects
0007_run_status_paused                  # 表重建迁移：走 FK 关闭专用通道（见下方规则）
```

规则：**编号一经应用不可改**——只能追加新编号，不得插入、改名、复用退役号或改写已应用
id（中途改号会破坏 checksum 账本与已部署库的恢复承诺）。迁移账本按 id 记录并校验 checksum；
checksum 不匹配或迁移未就绪时启动失败，不得开始 provider 操作（03 §8）。本波次无并发
schema 变更（W0 §8 风险项已确认：Wave 1 只有 W2 的 `adapters/storage` 写 schema）。

**表重建迁移专用通道**：SQLite 无 `ALTER CHECK`，需要 create-new/copy/drop/rename 重建
被其他表 `REFERENCES` 引用的表（如 `0007` 重建 `runs`）时，迁移条目声明
`preStatements`/`postStatements`（事务外钩子，非空即走 `migrations.ts` 的专用执行器）：
`PRAGMA foreign_keys` 在事务内是 no-op，必须先在**事务外**关闭（SQLite
lang_altertable 官方表重建 recipe；FK 开启时 `DROP TABLE` 对子表残留行即报
`FOREIGN KEY constraint failed`，2026-10-09 生产事故），语句序列在单事务内执行，
提交前 `PRAGMA foreign_key_check` 必须为空（非空则整事务回滚、拒绝入账），结束后
`finally` 恢复 `foreign_keys=ON`——失败路径也不得把 FK 关闭泄漏给普通写路径。
普通迁移（钩子为空）保持「单事务 = 语句 + 账本」路径不变，行为与历史版本一致。

### 未发布链上的在修订记录（W0 许可的单向例外）

链的**发布状态**是判断依据：只要从未离开本机、没有任何部署实例（无已应用库、无备份、
无外发构建），就可以在**不改编号**的前提下修订该编号的内容；一旦外发即冻结，后续只能追加。

| 日期       | 编号                                    | 修订内容                                                                                                                                                                                                                                                                      | 原因                                                                                                                         |
| ---------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-07 | `0001_cloud_control_plane_initial`      | `external_operations` 增加 GitHub effect 分面列（`business_key` 唯一部分索引、`desired_revision`、`expected_head_sha`、`payload_ref`、`remote_id`、`next_attempt_at`、`last_error`、`repository_id`、`task_branch`、`base_branch`）与校验用的 `business_key IS NULL` 分面索引 | `GitHubEffectStore` 端口定稿（W2 §4④）；provider 与 effect 两个分面共用一张表                                                |
| 2026-10-07 | `0001_cloud_control_plane_initial`      | `external_operations.kind` CHECK 扩到 10 个值（`ExternalOperationKind` 9 个 + effect 侧 `pull-request`）                                                                                                                                                                      | `ExternalOperationKind` 新增 `check`/`comment`/`token-revoke`（W4 CR-7）；`publish-pr` ≡ `pull-request` 的命名差异被 W0 保留 |
| 2026-10-07 | `0003_git_grants`                       | 按 `GitGrantStore` 端口重写：`(task_id, run_id, run_generation, repository_id, installation_id, purpose, status)`、`proof_hash`、redeem/revoke 时间、token 生命周期、`revoke_outcome_json`；索引改为 `(run_id, purpose, issued_at DESC)`                                      | 端口定稿（W2 §4④）；原 `token_hash` 与旧 purpose 词表已不再被任何端口消费                                                    |
| 2026-10-07 | `0005_task_input_interaction_decisions` | 按 `InteractionDecisionRecord` 对齐：`(task_id, command_id)` 主键 + `(task_id, interaction_id)` 唯一、`kind`/`payload_hash`/`delivery_status`/`runtime_ack_json`/`cancel_command_id`                                                                                          | 交互决定端口定稿（W1 CR-3）；原表的 `session_id/decision/payload_json` 与新记录不一致                                        |
| 2026-10-07 | `0005_task_input_interaction_decisions` | 补 `payload_json`（有界 16 KiB，`CLOUD_INTERACTION_DECISION_PAYLOAD_MAX_CHARS`）：决定载荷必须持久，重启用它重建投递内容；`payload_hash` 语义不变（对 `payload_json` 的规范化 fingerprint）                                                                                   | 冻结构建缺决定载荷，只存 hash 无法满足 04 §3.4.1 的持久投递与崩溃重启恢复（W2 收口发现的真缺口，契约冻结）                   |
| 2026-10-07 | `0005_task_input_interaction_decisions` | 补 `delivery_command_id` + `(task_id, delivery_command_id)` 唯一索引（与 `cancel_command_id` 对称）：记录以 interactionId 为键，无法按 commandId 回写 runtime ACK；`findDecisionByDeliveryCommandId` 是回写入口                                                               | ACK 回写键缺口（W2 第二批功能缺口契约冻结）；唯一约束仍保持 `(task_id, interaction_id)`                                      |

修订只改内容、不动编号，也不动 `0004` 墓碑与退役规则。语句在源码中按表族拆在
`adapters/storage/sqlite/tables/`，拼装顺序即语义（表先于索引、被引用表先于引用表），
由 `sqlite/schema.ts` 统一维持。

## 端口口径（消费者必读）

端口按能力拆分在 `app/ports/`；`storagePort.ts` 保持为 **barrel**（`export *` 各子端口），
`TaskRepo`/`RunRepo`/`InputRepo`/`ProjectionRepo`/`ProjectRepo`/`RunCredentialRepo`/
`InputPayloadRead`/`CursorPage`/`OperationOutboxPort` 等导出名与导入路径不变。

1. `RunRepo.reserveRun` 的冲突**以错误抛出**（`stale` / `active-write-run-exists` /
   `quota_exceeded`），不是失败分支——消费者必须捕获并转成结构化错误。
2. `AcceptInputResult.conflict.reason` 是封闭枚举：附件未发布/不可用不在其中，该情形归
   `validation_failed`（03 §6）。
3. `TaskRepo.transitionStatus.revision` 是**新 revision**（必须严格大于当前值），不是 CAS 期望值；
   期望值形式的 CAS 只在 `patchMetadata.expectedRevision` / `setCompleteRequested.expectedRevision`。
4. `RunCredentialRepo.recoverByAttempt`/`revokeRun`、`ProjectionRepo.recordCheckpoint`、
   `TaskRepo.recordArtifact` **不接受 `now`**：时效/审计时间用 worker 真实时钟。
5. `OperationOutboxPort.leaseNext` 除了 pending/租约到期的 leased，还会领取**租约到期且
   `state=ambiguous`** 的记录（03 §5/§8 的对账入口），不是只领 pending。
6. `GitGrantStore`（`app/ports/gitGrantPort.ts`）是 git grant 的唯一端口定义：单次兑换 CAS、
   过期与 run 撤销后不可兑换、只存 hash 与元数据、不持久 raw token（01 §7.2）。原提议的
   `GitGrantRepo` 作废，不另建第二个。
7. `GitHubEffectStore`（`app/ports/gitHubEffectPort.ts`）是 GitHub effect outbox 的唯一端口定义。
8. **kind 集合必须一致**：`ExternalOperationKind` 与 `GitHubEffectKind` 收敛为同集合
   （`create/terminate/extend/checkpoint/publish-pr/cleanup` + `check/comment/token-revoke`）；
   唯一命名差异是 outbox `publish-pr` ≡ effect `pull-request`（08 §8.2 幂等键前缀即 `publish-pr:`）。
   语义差异由执行器表达：`check`/`comment` 属 M7 条件性、以 `failed: not_implemented` 收口，
   `token-revoke` 按尽力语义执行。新增一类副作用必须同时在两处登记。
9. `GitHubPort.publishDraftPullRequest` 返回判别联合：`no-changes` 是**正常结论**而非异常；
   `expectedHeadSha` 漂移返回 `branch_conflict`，不覆盖。
10. `GitHubPort.enqueueEffect` 接受端口级描述符（`EnqueueGitHubEffectRequest`），调用方不构造
    store 内部形状。
11. `InteractionDecisionRecord` 必须带 **`payload_json`**（有界 16 KiB， `CLOUD_INTERACTION_DECISION_PAYLOAD_MAX_CHARS`）：决定要**可恢复投递**——dispatcher 崩溃/
    重启后凭记录重建投递内容（04 §3.4.1）。载荷由 app 层用既有严格 decision schema 校验后写入，
    不得含凭据/token；`payload_hash` 语义不变（对 `payload_json` 的规范 fingerprint，继续承担
    「同键不同内容拒绝」）。端口方法集固定为 `recordDecision` / `getDecision` /
    `setDecisionDeliveryStatus` / `findDecisionByDeliveryCommandId` / `recordCancelIntent` /
    `getCancelIntent`；决定按 `(task_id, interaction_id)` 唯一、另加 `(task_id, delivery_command_id)`
    唯一以支持 ACK 反查（runtime 的 CommandAck 按 commandId 回投，用于回写 `delivery_status`），
    取消意图 per `(task_id, command_id)` 一条且用独立 `cancelCommandId`（不删 runtime 接受事实）。
12. **provider labels/tags/metadata 不得承载控制面数据**：它们对 provider API 可见，只作
    provider 侧对账键（operationKey/runId 等）。`SandboxCreateInput.bootstrapAddress`
    （`{taskId, workspacePath}`，均非秘密）是 supervisor 连接前所需两个值的唯一通路；
    `workspacePath` 由控制面按 01 §6.2 步骤 2 **一处计算**，与 hello 上报值和落库的
    `run.workspacePath` 同源；**凭据绝不放 `bootstrapAddress`**——provider/model envelope 等
    只走已认证的 `bootstrap.config`（12 §6）。
    `SandboxCreateInput.labels` 只放**额外的**非保留标签：保留键 `operationKey`/`runId`/
    `runGeneration` 由 driver 从输入顶层字段自动写入 provider metadata/tags，**调用方传入会被
    确定性拒绝**（`validation_failed: … key reserved: …`，实现见 `adapters/sandbox/reconcile.ts`）；
    键须匹配 `[A-Za-z0-9._-]{1,64}`、值非空且 ≤256 字符。

暂不补的端口（集成阶段欠账，W10 记录）：`account_installations` 与 `webhook_inbox` 属 M7 条件性，
只有 schema、无端口；投影留存/裁剪作业与附件下载端点暂无端口；`MintTokenRequest` 的只读 CI 用途
（checks:read / statuses:read）与 checks 投影读取属 09 §3 标注的 M4 可选，将来补时走一次契约修订。

## 测试入口

从仓库根执行（各包没有统一 `pnpm test`，不得臆造）：

```
node --import tsx --test packages/server/test/cloud*.test.ts     # 本模块（W1/W2/W3/W4/W5）
```

测试文件放在 `packages/server/test/cloud*.test.ts`；node:test + tsx 是本仓库既有约定
（`packages/services/test/*.test.ts` 同款）。跨包 wire schema 用例在
`packages/shared/test/cloud*.test.ts`。

## 端点与 schema 对照

见 `packages/shared/src/cloud/CONTRACT.md`（端点 ↔ 请求/响应 schema ↔ 生产者/消费者）。

## 边界与禁止

- `domain/` 不得 IO；app 不得 import `adapters/*`、SQLite、provider SDK、Hono。
- 不新建第二套输入队列，不把 outbox 当 runtime 队列（02 §6.1）。
- 不复用现有 tasks-index 的 schema 或 `TaskIndexRepo` 实例（03 §4）。
- 不把浏览器临时路径当 durable 附件引用；未引用对象按保留期清扫（03 §4）。
