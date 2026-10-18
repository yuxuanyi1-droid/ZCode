# Spec 15 — Cloud Agent 评审问题修复实施

状态：**已实施（2026-10-17）**。本文冻结本轮修复的行为、所有者与验收口径；代码实现按本文执行，源文档（00–04/08/12/14/10）已按实施结果回写。实施结果与未验证项见 §6。

## 1. 范围与原则

来源：本分支 review 发现的 P0/P1/P2 问题。原则：

- spec 先行：本文先冻结行为，再改代码；
- 单一所有者：不新增第二套队列 / 第二份状态；
- fail-closed：恢复、鉴权、保存、附件等不确定情形不得伪造成功；
- 保留与本任务无关的本地改动（bots/subagents 重构等）。

## 2. 决策冻结

| 决策             | 内容                                                                                                                                                                                              | 理由                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Project 删除     | 采用软删除（`projects.archived_at`），列表过滤；任务历史保留；有活动任务仍 409                                                                                                                    | 03 §6「明确归档，不静默销毁」；避免任务外键孤儿                                                           |
| 云附件（v1）     | 本轮 fail-closed：云模式不提供附件入口；`cloudAttachmentGate` 恒 disabled 并给出原因；不静默上传后丢弃                                                                                            | 04 §3.0.2 要求 durable input 保存附件引用；task-owned 上传未实现前不能假装支持                            |
| 交互决定         | 新增 durable HTTP 端点，接线既有 `InteractionCommands`；云模式 UI 不再直发 attachment                                                                                                             | 03 §7.2、04 §3.0.2                                                                                        |
| 客户端直连写命令 | 服务端 `client` scope 拦截 `resolveInteraction`/`createSession`/`sendText`/`stop`；UI 仅拦截 `createSession`/`sendText`（任务输入）；编辑/重试/反馈/队列等既有写方法保留（2026-10-18 服务端扩展） | 审批、任务输入与停止必须经 durable gateway；其余编辑类写命令整体拦截会破坏既有按钮，列为遗留 durable 化项 |
| Profile 加密     | 仅 `mcp-config` 正文加密落库（`enc:v1:` 信封，AES-256-GCM，复用 credential cipher provider）；读路径解密；旧明文兼容读                                                                            | 14 §5                                                                                                     |
| A-08             | 每次新连接比较 `credentialGeneration`/policy；落后时在 ready 前重装 envelope，不重新 clone                                                                                                        | 12 §6 A-08                                                                                                |
| create 重试      | 已有 handle 直接进入恢复；`attempt > 1` 先 `findCreateResult`；unknown 不 create                                                                                                                  | 03 CP-04、01 §5.1                                                                                         |
| 恢复路径         | create/startup/readiness 共用 `establishRunHandle`：持久 workspacePath → clone grant → startSupervisor → settle                                                                                   | 02 §5.3、01 §5.3                                                                                          |

## 3. 工作项

### R1 Provisioning 幂等与恢复（P0/P1）

- `createOperation.runCreateOnce`：run 已有 `providerHandle` → 跳过 create；operation `attempt > 1` 或状态 ambiguous → 先按 operationKey `findCreateResult`（锚点 `createdAt`）；created → 走恢复；notFound → 才 create；unknown → 保持 ambiguous。
- 新 `establishRunHandle`（create/startup/readiness 共用）：计算并持久 `workspacePath`、`recordProviderHandle`、签发 clone grant、启动 supervisor、结算操作；stopRequested/late handle 只清理不启动。
- startup/readiness 的 provider paused 观测：run=ready 时按事实收敛到 paused 或 resume，不把无连接 run 留在 ready。
- 验收：create 成功、handle 落库前崩溃 → 重启后 `driver.create` 只调用一次且能 ready；恢复路径持久 workspacePath；paused 启动对账自愈。

### R2 信任边界与投递顺序（P1）

- projection ingest：每条记录强制 `runId === attachment run`、`taskId === run.task`、`runGeneration === current`；任一不符整批拒绝、不回 ACK。
- checkpoint.result：校验 operation 存在、kind=checkpoint、task/run/generation 匹配；`branch === task.taskBranch` 才允许 saved；saved 不被迟到 failed 覆盖。
- dispatcher：delivery tick 先 reconcile；`delivering/uncertain` 先 query，明确 unknown 才同 commandId 重投。
- 验收：跨 run/跨 task/旧 generation 批次拒绝；伪造 checkpoint 拒绝；uncertain 不立即重投。

### R3 生命周期与 API 语义（P1/P2）

- run 终态后按 `taskStatusAfterRunEnd` CAS Task→failed（completed/archived/仍有活动 run 除外）。
- Project 软删除（migration 0009）：`archived_at` 列、列表过滤、删除前置与响应一致。
- complete on paused：先校验 paused 再写 `complete_requested`，被拒绝不残留意图。
- reopen `expectedTaskRevision` 在接纳事务内复核。
- idle drain 使用 `hasCheckpointInFlight`（saving/pending + 2 分钟窗口）。
- 验收：失败 run 的 Task=failed；删除后刷新不出现；paused complete 不残留；reopen 并发 PATCH 返回 stale。

### R4 Profile 加密（P1）

- `mcp-config` 写入前用 `enc:v1:` 信封加密；读回显与连接期同步前解密；旧明文兼容。
- 日志只记 category/entryId/sha256/bytes，不记正文。
- 验收：DB 行无 token 明文；GET 回显与同步内容正确；损坏密文 fail-closed。

### R5 执行节点加固（P1/P2）

- A-08：新连接比较 credentialGeneration/policy/preferences；落后时 ready 前重装 envelope + policy，不重新 clone、不重启 runtime；`bridge.ready.configVersion` 反映新版本。
- projection 批次按编码后字节数 + 记录数切分；单条超限报 fault，禁止整帧 drop 导致 WAL 活锁。
- bridge 入站帧按连接串行处理；同 socket 重复 hello 返回原 epoch/rotationId。
- 验收：token 刷新重连后新 envelope 生效；大 payload 全部 ingest；帧顺序稳定；重复 hello 不递增 epoch。

### R6 云附件与交互（P1）

- 云附件本轮 fail-closed：`resolveCloudAttachmentGate` 在云模式恒 disabled（原因：durable input 附件引用尚未启用）；composer 不再出现可上传但发送丢弃的路径。
- 新增 durable 交互端点：
  - `POST /api/cloud/tasks/:taskId/interactions/:interactionId`（提交决定）
  - `POST /api/cloud/tasks/:taskId/interactions/:interactionId/cancel`（取消意图）
  - `GET /api/cloud/tasks/:taskId/interactions/:interactionId`（回执查询，响应丢失/重启恢复）
    请求体复用 `InteractionCommands` 的字段；shared 端点矩阵/SDK 成对登记。
- 云模式 `V4InteractionDialogs` 经 cloud port 提交；**审批链路双层防御**（2026-10-17 实施口径，2026-10-18 服务端扩展）：
  - 服务端 `rpcRelay` 的 `client` scope 拦截 `resolveInteraction`/`createSession`/`sendText`/`stop`（`CLOUD_BROWSER_DENIED_AGENT_COMMANDS`）——审批决定与任务输入/停止必须经 durable HTTP（`/interactions`、`/inputs`、`/stop`），客户端 scope 直发会绕过 outbox、停止屏障与保存终止链；
  - UI `cloudBrowserServices` 的 `sendConversationCommandV4` 包装拦截 `createSession`/`sendText` 任务输入命令（`durable-input-required`）——输入必须经 HTTP composer。
  - 编辑/重试/反馈/队列等其余 `sendConversationCommandV4` 能力仍走 agent 通道（整体拦截会把这些既有按钮变成 unauthorized），其 durable 化列为遗留项（见 §6）。
- 验收：审批持久记录、重启可恢复投递、ACK 回写；浏览器直发审批/任务输入/停止写命令被结构化拒绝（不再只依赖 UI 防御）；附件入口明确不可用而非静默丢弃。

## 4. 实施顺序与门禁

| 波次 | 工作项          | 并行约束                                               |
| ---- | --------------- | ------------------------------------------------------ |
| W1   | R1、R2          | A（provisioning）与 B（projection/input）文件不重叠    |
| W2   | R3、R4          | C（lifecycle/API/migration 0009）与 D（profile）不重叠 |
| W3   | R6              | 先端点/端口，再 UI；最后拦截直连写命令                 |
| W4   | R5              | 执行节点文件集中，单代理                               |
| W5   | 全量回归 + 真机 | 主会话执行门禁                                         |

每波完成后必须运行：`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、相关包测试；执行节点改动额外跑 `pnpm --filter @zcode/server build:sandbox-assets`。

## 5. 未纳入本轮

- task-owned 附件上传与附件引用随 durable input 下发（R6 只做 fail-closed；完整实现另列）。
- Modal/Daytona 真实账号复验、浏览器双视口 E2E。
- 多账号 / 公开服务 / GitHub webhook（M7 条件性）。

## 6. 实施结果（2026-10-17）

各工作项落位与证据（路径相对仓库根；行号以 2026-10-17 工作树为准）：

| 工作项                 | 实施落位                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 结果                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1 create 幂等与恢复   | `packages/server/src/cloud/app/provisioning/createOperation.ts:145-159,186-230`（已有 handle 直接恢复；attempt>1/ambiguous 先 `findCreateResult`，notFound 才 create）；`recoverHandle.ts:251-364`（`establishRunHandle`：`resolveRunWorkspacePath` → `recordProviderHandle`（含 workspacePath）→ clone grant → `startSupervisor` → 结算；create/startup/readiness 三处共用：`createOperation.ts:55-56`、`reconciler/startup.ts:43-45,126-149`、`provisioning/readiness.ts:36-38,92-101`）。startup 对 provider paused 观测按事实收敛 paused（`startup.ts:151-191`）。                                                                                                                                                                                                                                                                                             | 已实现；单测覆盖 create 恢复/对账/paused 收敛；真实 E2B 崩溃窗口未复验                                                                           |
| R2 信任边界与投递顺序  | projection 逐记录 run/task/generation 校验、任一不符整批拒绝（`app/projections/ingest.ts:54-84`）；checkpoint.result operation 归属/branch/saved 单调（`domain/checkpointPolicy.ts:93-123`、`app/lifecycle/checkpointResults.ts:45-105`）；dispatcher 对 delivering/uncertain 先 query、unknown 才同 commandId 重投（`app/inputDelivery/dispatcher.ts:93-159,206-215`）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 已实现并有单测；真实网络丢包/跨代际注入未做端到端故障注入                                                                                        |
| R3 生命周期与 API 语义 | run 终态后 Task→failed CAS（`app/runOrchestrator.ts:110-146`、`domain/taskRunState.ts:205-220`）；Project 软删除 0009（`adapters/storage/sqlite/schema.ts:95-100`、`tables/projectArchive.ts:12`、`repositories/projectRepo.ts:146-160`、`app/taskService.ts:150-179`）；complete on paused 先拒绝（`app/commands/taskLifecycle.ts:95-106`）；start/reopen 事务内复核 expectedTaskRevision（`adapters/storage/repositories/acceptInput.ts:174-179`）；idle drain 统一 checkpoint 在途窗口（`domain/checkpointPolicy.ts:35-57`、`app/lifecycle/drain.ts:201-216`）；**审批等待不是业务空闲**：`readLatestPendingInteractionCount` 供 idle pause/drain/keepalive 统一读取（`domain/projectionInteractions.ts`、`repositories/projectionInteractionRepo.ts:30-65`、`lifecycle/idlePause.ts:72-90`、`lifecycle/drain.ts:203-216`、`lifecycle/keepalive.ts:116-128`）。 | 已实现；迁移 0009 只追加列，不物理删除；既有库升级路径由迁移测试覆盖；投影最终一致窗口内仍可能短暂误判空闲                                       |
| R4 Profile 加密        | mcp 写入 `enc:v1:` 信封（`app/userProfile/userProfileService.ts:154-163`）；读回显/同步解密且兼容旧明文（`userProfileService.ts:219-220`、`profileSyncService.ts:86-87,185`）；sha256/bytes 按明文派生并随请求写入（`userProfileService.ts:156-162`、`repositories/userProfileRepo.ts:75-92`）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 已实现；密钥来源 `ZCODE_CREDENTIAL_SECRET` 或机器派生 fallback（`packages/services/src/credential/providers/credentialCipherProvider.ts:24-38`） |
| R5 执行节点加固        | A-08 每次新连接比较 applied generation/policy，落后时 ready 前 refresh（`execution/app/bridgeSession.ts:128-182`、`execution/app/bootstrap.ts:193-230`）；projection 批次按编码后 UTF-8 字节（6MiB）+记录数切分，单条超限发不可重试 fault（`execution/app/bridgeHeartbeat.ts:30-122`）；bridge 入站单连接串行（`adapters/ws/bridgeChannel.ts:237-266`）；同 socket 重复 hello 返回原 epoch/rotationId（`adapters/ws/handshake.ts:88-121`）。                                                                                                                                                                                                                                                                                                                                                                                                                       | 已实现并有单测；真实 token 刷新重连未复验                                                                                                        |
| R6 云附件与交互        | 附件门控恒 disabled（`packages/ui/src/cloud/cloudAttachmentGate.ts:60-71`）；交互三端点（`adapters/http/routes.ts:182-216`、`shared/src/cloud/endpoints.ts:239-262`）；服务端拦截 `resolveInteraction`（`execution/app/rpcRelay.ts:71-99`）；UI 拦截 `createSession`/`sendText`（`packages/ui/src/cloud/cloudBrowserServices.ts:102-147`）；云 UI 经 cloud port 提交（`packages/ui/src/v4/useInteractionResolver.ts:50-84`、`cloud/cloudPorts.ts:145-164`）；**ACK 先到竞态**：`setDecisionDeliveryStatus` CAS 返回 null 时重读记录返回真实 `deliveryStatus`（`app/commands/interactions.ts:249-253,279-288`、`app/commands/interactionDecisionTypes.ts:73-86`），`cancelDecision` 同样重读裁决（`interactions.ts:306-370`）。                                                                                                                                     | 已实现；审批/输入直发均结构化拒绝；附件 fail-closed 有 UI 单测；真实联调 approval Write 工具最终 `status=success`                                |

执行的门禁（2026-10-17，仓库根；真实输出）：

| 检查                                | 结果                                                            |
| ----------------------------------- | --------------------------------------------------------------- |
| `pnpm typecheck`                    | 0 错误                                                          |
| `pnpm lint`                         | 0 error / 78 warning（全部既有基线，本轮未新增）                |
| `pnpm architecture:check --changed` | violations 0 / baseline 0 / new 0                               |
| `pnpm --filter @zcode/server test`  | 727 tests：719 pass / 0 fail / 8 skip（既有凭据门控 live 用例） |
| `pnpm --filter @zcode/shared test`  | 81 tests / 81 pass                                              |
| `pnpm --filter @zcode/client test`  | 39 tests / 39 pass                                              |
| `pnpm --filter @zcode/ui test`      | 254 tests / 254 pass                                            |
| `pnpm fmt:check`                    | All matched files use the correct format（3479 files）          |

**真实联调证据（2026-10-17）**：审批链路在真实运行中完成一轮 Write 工具审批，最终 runtime 回执 `status=success`。期间暴露并修复两个缺陷：①提交决定返回 501 是云入口装配漏注入 interaction repo（`adapters/entry-cloud-control-plane.ts:236-240` 现回落到 `storage.interactions`）；②返回 409 `decision-record-missing` 是 runtime ACK 先于控制面写 `delivering` 的竞态（`submitDecision` 现重读记录返回真实状态，见 R6 行）。两者均已修复并由本轮 727 例 server 测试覆盖。

未验证项（如实记录）：R1 的 create 成功/handle 落库前崩溃恢复、R5 的 token 刷新重连仍未有真机复验（单测/装配级证据）；浏览器双视口 E2E（04 W-08/W-14/W-19）未执行；Modal/Daytona 未复验；R6 的编辑/重试/反馈命令 durable 化仍为遗留项；审批投影最终一致窗口内仍可能短暂误判空闲。
