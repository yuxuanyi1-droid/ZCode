# Cloud wire 契约（shared）

唯一事实源：本目录。跨包消费方只允许 `import ... from "@zcode/shared"`（
`packages/shared/src/index.ts` 已 `export * from "./cloud/index.js"`）。本目录不含
任何实现（SQLite、SDK、路由、UI 都不在这里）。

## 文件与所有者

| 文件                 | 内容                                                                         | 主要生产方                            | 主要消费方                      |
| -------------------- | ---------------------------------------------------------------------------- | ------------------------------------- | ------------------------------- |
| `identity.ts`        | `cloud-task:<taskId>` 身份构造/解析、身份 key 取值                           | 控制面                                | 控制面、执行节点、UI、CLI 装配  |
| `errors.ts`          | 归一错误码目录与 retryable 语义                                              | 全部适配层                            | HTTP/WS 信封、SDK、UI           |
| `domain.ts`          | Task/Run/Input/Checkpoint/Artifact 实体与状态全集                            | 控制面持久层                          | HTTP 响应、SDK、UI              |
| `user-profile.ts`    | 用户资源 profile：类别/条目/负载/快照/上传与查询/同步结果契约 + 全部上限常量 | 控制面 profile store（P19）、W8 UI    | 控制面、连接期同步编排、SDK、UI |
| `bridge-protocol.ts` | 地址、投影记录、控制帧（`bridge.*`/`checkpoint.*`/`projection.*`）           | 控制面 ⇄ 执行节点 bridge              | W1/W5/W6                        |
| `rpc-protocol.ts`    | `rpc.open/request/response/close` 帧（`rpc.open.serviceScope` 分面）         | 控制面 ⇄ bridge（浏览器经控制面转发） | W5/W6/W7                        |
| `http-contracts.ts`  | 请求 schema、输入/重开/生命周期请求、查询参数                                | 控制面 HTTP 适配层                    | W5/W7/W8/W9                     |
| `endpoints.ts`       | 端点矩阵、通道分面、attachment 白名单、wire 版本、错误码→HTTP 状态           | 控制面入口                            | W5/W7/W8/W9、W10 反查           |
| `responses.ts`       | 错误信封、cursor 分页信封、详情/历史/事件/能力响应                           | 控制面 HTTP 适配层                    | W7/W8/W9                        |

## 端点 ↔ schema 对照表

`request`/`response` 列是 schema 常量名（同 `http-contracts.ts` 的端点矩阵，二者由
`packages/shared/test/cloudHttpContracts.test.ts` 断言一致）。生产者是控制面 HTTP 适配层
（W5 路由 + W1 应用服务）；消费者是客户端 SDK（W7）及其上层 UI/Web（W8/W9）。
所有端点前缀 `/api/cloud`，鉴权与错误信封见 03 §3/§6。

| #   | 端点                                                 | 请求 schema                       | 响应 schema                           | 备注（阶段/幂等）                                                                                                                                                                                                                                                                                                                                  |
| --- | ---------------------------------------------------- | --------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `GET /api/cloud/capabilities`                        | —                                 | `capabilitiesResponseSchema`          | 按 `mode` 判别联合（04 §2.1，2026-10-07）：云分支含协议版本、provider 能力与 `principalId`（**客户端 scope 隔离键，非认证凭据**；认证仍走 bearer/lite-token），无凭据时 401；**本地分支无鉴权**返回 `mode=local`（providers/features 空集、`taskOwnedAttachments` 恒 false、协议版本同源），是 Web 启动探测「本地」的唯一答案。两分支都不含 secret |
| 2   | `GET /api/cloud/repositories`                        | —                                 | `cloudRepositoryPageSchema`           | `not_configured`（503）直到 installation 投影装配（03 §6）                                                                                                                                                                                                                                                                                         |
| 3   | `GET /api/cloud/repositories/:repoId/branches`       | —                                 | `cloudBranchPageSchema`               | repo 授权后查询                                                                                                                                                                                                                                                                                                                                    |
| 4   | `GET /api/cloud/projects`                            | —                                 | `cloudProjectPageSchema`              | 分页                                                                                                                                                                                                                                                                                                                                               |
| 5   | `POST /api/cloud/projects`                           | `createCloudProjectRequestSchema` | `cloudProjectRecordSchema`            | creationKey 或唯一约束去重                                                                                                                                                                                                                                                                                                                         |
| 6   | `PATCH /api/cloud/projects/:projectId`               | `patchCloudProjectRequestSchema`  | `cloudProjectRecordSchema`            | revision CAS                                                                                                                                                                                                                                                                                                                                       |
| 7   | `DELETE /api/cloud/projects/:projectId`              | —                                 | `cloudDeletedResponseSchema`          | 有活动任务默认 409                                                                                                                                                                                                                                                                                                                                 |
| 8   | `GET /api/cloud/projects/:projectId/tasks`           | —                                 | `cloudTaskPageSchema`                 | 不查询沙箱                                                                                                                                                                                                                                                                                                                                         |
| 9   | `POST /api/cloud/tasks`                              | `createCloudTaskRequestSchema`    | `cloudTaskRecordSchema`               | 建 draft，creationKey 去重                                                                                                                                                                                                                                                                                                                         |
| 10  | `GET /api/cloud/tasks/:taskId`                       | —                                 | `taskDetailResponseSchema`            | `{task, activeRun?, execution?, latestCheckpoint?, artifact?, actions}`；`actions` 是**服务端推导的能力投影**（`cloudTaskActionSchema` 枚举，仅用于呈现/门控；写操作仍由服务端独立校验，04 §3.3）                                                                                                                                                  |
| 11  | `PATCH /api/cloud/tasks/:taskId`                     | `patchCloudTaskRequestSchema`     | `cloudTaskRecordSchema`               | 仅标题/draftStartConfig + revision                                                                                                                                                                                                                                                                                                                 |
| 12  | `POST /api/cloud/tasks/:taskId/inputs`               | `submitTaskInputSchema`           | `inputReceiptSchema`                  | 202 = 持久接收；start / append 二选一意图                                                                                                                                                                                                                                                                                                          |
| 13  | `GET /api/cloud/tasks/:taskId/inputs`                | —                                 | `inputRecordPageSchema`               | 输入/回执分页                                                                                                                                                                                                                                                                                                                                      |
| 14  | `GET /api/cloud/tasks/:taskId/inputs/:commandId`     | —                                 | `inputReceiptSchema`                  | 解决响应丢失                                                                                                                                                                                                                                                                                                                                       |
| 15  | `POST .../inputs/:commandId/cancel`                  | `cloudEmptyBodySchema`            | `inputReceiptSchema`                  | 幂等撤销                                                                                                                                                                                                                                                                                                                                           |
| 16  | `POST /api/cloud/tasks/:taskId/reopen`               | `reopenCloudTaskRequestSchema`    | `taskDetailResponseSchema`            | 新 run/generation，必须带 `resume` 选择                                                                                                                                                                                                                                                                                                            |
| 17  | `POST /api/cloud/tasks/:taskId/stop`                 | `cloudEmptyBodySchema`            | `taskDetailResponseSchema`            | 原子持久停止屏障                                                                                                                                                                                                                                                                                                                                   |
| 18  | `POST /api/cloud/tasks/:taskId/force-stop`           | `forceStopCloudTaskRequestSchema` | `taskDetailResponseSchema`            | 显式丢失确认 + revision + operationId                                                                                                                                                                                                                                                                                                              |
| 19  | `POST /api/cloud/tasks/:taskId/extend`               | `cloudEmptyBodySchema`            | `cloudExtensionResponseSchema`        | provider 确认期限或标记估计                                                                                                                                                                                                                                                                                                                        |
| 20  | `POST /api/cloud/tasks/:taskId/complete`             | `cloudEmptyBodySchema`            | `taskDetailResponseSchema`            | 显式验收                                                                                                                                                                                                                                                                                                                                           |
| 21  | `POST /api/cloud/tasks/:taskId/archive`              | `cloudEmptyBodySchema`            | `taskDetailResponseSchema`            | 无活动写 run                                                                                                                                                                                                                                                                                                                                       |
| 22  | `POST /api/cloud/tasks/:taskId/reactivate`           | `cloudEmptyBodySchema`            | `taskDetailResponseSchema`            | PR 未 merged 时可转 active                                                                                                                                                                                                                                                                                                                         |
| 23  | `POST /api/cloud/tasks/:taskId/restore`              | `cloudEmptyBodySchema`            | `taskDetailResponseSchema`            | 回 archivedFromStatus                                                                                                                                                                                                                                                                                                                              |
| 24  | `GET /api/cloud/tasks/:taskId/history`               | `cloudHistoryQuerySchema`         | `cloudHistoryPageSchema`              | 只读控制面副本                                                                                                                                                                                                                                                                                                                                     |
| 25  | `GET /api/cloud/tasks/:taskId/events`                | `cloudTaskEventsQuerySchema`      | `cloudTaskEventsResponseSchema`       | `not_implemented`（501）直到 M3 事件源                                                                                                                                                                                                                                                                                                             |
| 26  | `GET /api/cloud/tasks/:taskId/snapshot`              | `cloudSnapshotQuerySchema`        | `cloudProjectionSnapshotSchema`       | 匹配 epoch/cursor                                                                                                                                                                                                                                                                                                                                  |
| 27  | `GET /api/cloud/events`                              | —                                 | `cloudMetadataEventSchema`（SSE）     | 只做通知，不做可靠投递                                                                                                                                                                                                                                                                                                                             |
| 28  | `POST /api/cloud/attachments`                        | 非 JSON 体（multipart）           | `cloudAttachmentUploadResponseSchema` | owner 级持久引用                                                                                                                                                                                                                                                                                                                                   |
| 29  | `POST /api/cloud/github/installations/:id/reconcile` | —                                 | `cloudEmptyBodySchema`                | 管理者主动对账                                                                                                                                                                                                                                                                                                                                     |
| 30  | `POST /api/cloud/github/webhook`                     | —                                 | `cloudEmptyBodySchema`                | `not_implemented`（M7 条件性）                                                                                                                                                                                                                                                                                                                     |
| 31  | `GET /api/cloud/runs/:runId/git-grant`               | —                                 | `cloudGitGrantResponseSchema`         | 执行节点出站、单次兑换（01 §7.2）                                                                                                                                                                                                                                                                                                                  |
| 32  | `GET /api/cloud/assets/:assetId`                     | —                                 | 二进制资产                            | 版本/hash 清单校验（01 §6）                                                                                                                                                                                                                                                                                                                        |

M8 用户资源 profile 端点（`GET /api/cloud/user-profile`、`…/version`、
`GET|PUT|PATCH|DELETE …/entries/:category/:entryId`）已在 `CLOUD_HTTP_ENDPOINTS` 注册（P19a 4 行 +
P20 追加 2 行，行数据在 `userProfileEndpoints.ts`），SDK 索引（`packages/client/src/cloud/cloudWireSchemas.ts`
的 `CLOUD_SDK_ENDPOINT_SCHEMAS`）成对登记：矩阵里带 request 的写端点必须同时出现在 SDK 索引
（`packages/client/test/cloudSdk.test.ts` 断言），缺失即「声明了却不支持」。

## 帧 ↔ schema 对照

| 帧/信道                                                      | schema                                                                                                                | 生产者                                   | 消费者      |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ----------- |
| `bridge.hello` / `welcome` / `ready` / `heartbeat` / `phase` | `cloudBridgeControlFrameSchema`                                                                                       | bridge ⇄ 控制面                          | W1/W5/W6    |
| `bridge.fault` / `bridge.drain`                              | 同上（双向）                                                                                                          | 任一侧                                   | W1/W5/W6    |
| `bootstrap.config`                                           | `bootstrapConfigFrameSchema` + `bootstrapCloneFactsSchema`（+ 可选 `preferences`：`cloudBootstrapPreferencesSchema`） | 控制面 → bridge（welcome 后、ready 前）  | W1/W6       |
| `checkpoint.request` / `checkpoint.result`                   | `checkpointRequestFrameSchema` / `checkpointResultFrameSchema`                                                        | 控制面 → bridge（停止/保存通路，01 §8）  | W1/W6       |
| `projection.batch` / `projection.ack`                        | `projectionBatchFrameSchema` / `projectionAckFrameSchema`                                                             | 执行节点 exporter / 控制面               | W1/W6       |
| `rpc.open/request/response/close`                            | `cloudRpcFrameSchema`（`rpc.open.serviceScope` = client \| control-plane）                                            | 控制面（构造唯一方）/ 沙箱 ChannelServer | W5/W6/W7    |
| 通道分面                                                     | `CLOUD_SERVICE_CHANNEL_FACETS`、`CLOUD_ATTACHMENT_SERVICE_ALLOWLIST`、`CLOUD_CONTROL_PLANE_SERVICE_ALLOWLIST`         | 控制面入口                               | W5/W7/W8/W9 |

W0 §4 原冻结的帧清单是 `hello/welcome/ready/heartbeat/phase/fault/drain` + `projection.batch/ack`；
两次裁决后 02 §4 帧表增补 `bootstrap.config` 与 `checkpoint.request`/`checkpoint.result`，本目录已同步
（W0 §4 清单同步为：`bridge.hello/welcome/ready/heartbeat/phase/fault/drain`、`bootstrap.config`、
`checkpoint.request/result`、`projection.batch/ack`）。**`bootstrap.resources` 帧已于 2026-10-11
简化定调中整体退役**（14 §4.8）——帧 schema、分块 payload、union 注册与方向表项一律删除，
`bridge.phase` 的 `installing-resources` 相位一并移除（不留废弃态）。

- `bootstrap.config`：运行配置、clone 事实与 `provisioningEnvelopeJson` 只经已认证的 bridge 通道下发
  （provider env/元数据对 provider API 可读，禁承载凭据；provider 命令通道只下发自举要素，01 §6.2）。
  envelope 内部结构归 provisioning 契约所有，shared 只冻结为有界字符串 + `credentialGeneration`
  代际字段（12 §6 A-08）；凭据正文禁止进日志。可选 `preferences` 块是 M8 的**行为偏好实值快照**
  （帧归属冻结为扩展本帧，14 §9.1③）：`{configVersion, values}`，值类型直接复用源码既有 schema
  （`zcodeModelContextBudgetStrategySchema`、`integratedTerminalShellSelectionSchema` 与三个 boolean，
  不复制枚举）；`values` 全可选，缺席键由 responder 的既有默认值收敛；`bridge.ready.configVersion`
  继续上报"Run 已应用配置版本"。偏好快照与用户资源同步是两条独立通路（资源不经自举帧下发，
  14 §4/§9.5）。
- **退役（2026-10-11 简化定调）**：`bootstrap.resources` 帧、其分块 payload schema、superRefine
  不变量、union 注册、方向表项与 `bridge.phase` 的 `installing-resources` 相位全部删除。用户资源
  同步改走连接期：控制面经 bridge relay 以 `rpc.open.serviceScope="control-plane"` 调沙箱既有
  sync 服务（14 §4），分块导入契约在 `../user-archive-import.ts`（≤2MiB/块，14 §4.4）。
- `checkpoint.request`/`result` 只承载保存/停止通路结果，不替代 outbox operation 事实；result 未确认按
  operationId 对账，不重做 commit、不伪造 saved。`saved` 结果必须携带 git object id 形状的 `remoteSha`，
  由 schema 直接拒绝无证据的 saved；`hadNewCommits` 是 additive 字段，缺席不推断。

## 用户资源 profile（M8；W0 扩展冻结 2026-10-11）

- 类别（`cloudUserProfileCategorySchema`）：`mcp | skills | commands | plugins | subagents | agents-md`。
  **hooks 不纳入 M8**（14 §9.1①：SSH 模式 hooks 同样本机零推送，不构成先例），类别枚举里没有 hooks。
- 条目形态（14 §4.3/§4.5，2026-10-11 简化修订）：
  - 归档类 = **`skills`/`plugins`**（`CLOUD_USER_PROFILE_ARCHIVE_CATEGORIES`；负载 `{category, archiveBase64}`，
    tar+gzip 归档）；后端导入走分块导入（`user-archive-import.ts`，14 §4.4）。
  - 单文件 markdown 类 = **`commands`/`subagents`**（`CLOUD_USER_PROFILE_MARKDOWN_CATEGORIES`；负载
    `{category, content}`，UTF-8 ≤256KiB/条；`entryId` = 落盘文件名 `<name>.md`，见
    `cloudUserProfileMarkdownEntryIdSchema`——既有条目键形状之上要求 `.md` 后缀）。条目元数据、路径参数与
    同步结果三处都由 schema 强制同一约束。
  - `mcp` = JSON 配置对象；`agents-md` = 单例正文（`entryId = user-agents`，14 §9.4⑥）。
- 条目（`cloudUserProfileEntrySchema`）：`{category, entryId, displayName?, enabled(默认 true), sha256, bytes}`
  ——`entryId` 形状 `^[a-z0-9][a-z0-9-_.]{0,127}$`；`sha256`/`bytes` 由控制面派生（上传请求 schema 直接不收）。
- 上限常量（唯一来源，超限上传即拒绝、不截断；14 §9.1④ 与 2026-10-11 简化修订）：`CLOUD_USER_PROFILE_ENTRY_MAX_BYTES`
  （skills 20MiB、plugins 50MiB、mcp 256KiB JSON、commands/subagents/agents-md 256KiB UTF-8，后三者共用
  `CLOUD_USER_PROFILE_MARKDOWN_MAX_BYTES`/`CLOUD_USER_PROFILE_AGENTS_MD_MAX_BYTES`，其数值唯一来源是
  settings-sync 的 `SETTINGS_SYNC_USER_AGENTS_FILE_MAX_BYTES`）、`CLOUD_USER_PROFILE_TOTAL_MAX_BYTES`=128MiB、
  `CLOUD_USER_PROFILE_MAX_ENTRIES`=256、`CLOUD_USER_PROFILE_RETAINED_VERSIONS`=8（版本快照保留窗口；条目按
  sha256 去重存储）、`CLOUD_PROFILE_UPLOAD_BODY_MAX_BYTES`=80MiB。base64 一律 canonical 校验（线性扫描，
  不用整体正则）并按 padding 精算解码字节数。**帧分块常量（`CLOUD_USER_PROFILE_CHUNK_*`/`…MAX_CHUNKS`）已随
  `bootstrap.resources` 帧退役**；连接期分块导入的单块上限在 `../user-archive-import.ts`。
- 条目清单（快照与帧共用）强制：条目数 ≤256、`bytes` 之和 ≤128MiB、(category, entryId) 唯一；
  快照额外强制 `totalBytes` = 条目 `bytes` 之和。
- 错误码（14 §9.1）：`payload_too_large`(413)、`invalid_entry`(400)、`profile_total_exceeded`(409)、
  `profile_entries_exceeded`(409)；错误信息必须定位到 `category`/`entryId`。
- **端点（形状已冻结；矩阵行与 SDK 索引随 P19 登记）**，路径常量唯一来源
  `CLOUD_USER_PROFILE_ENDPOINT_PATHS`：

  | 端点                                                        | 请求 schema                                      | 响应 schema                                 | 语义                                                                                                      |
  | ----------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
  | `GET /api/cloud/user-profile`                               | —                                                | `cloudUserProfileSnapshotSchema`            | 快照摘要：条目元数据 + `profileVersion` + `totalBytes` + `createdAtMs`，**不含归档正文**                  |
  | `GET /api/cloud/user-profile/version`                       | —                                                | `cloudUserProfileVersionResponseSchema`     | 当前生效 `profileVersion`（新 Run 冻结版本的读取点）                                                      |
  | `GET /api/cloud/user-profile/entries/:category/:entryId`    | —                                                | `cloudUserProfileEntryReadResponseSchema`   | 条目元数据 + 正文（按类别有界）；UI 编辑回显**唯一**通路（14 §9.4①）；键不存在 404 `not_found`            |
  | `PUT /api/cloud/user-profile/entries/:category/:entryId`    | `cloudUserProfileEntryUploadRequestSchema`       | `cloudUserProfileEntryUploadResponseSchema` | 幂等整条替换（矩阵首个 PUT）：body = 负载 + `displayName?` + `enabled?`；路径与 body 的 category 必须一致 |
  | `PATCH /api/cloud/user-profile/entries/:category/:entryId`  | `cloudUserProfileEntryEnabledPatchRequestSchema` | `cloudUserProfileEntryUploadResponseSchema` | 条目级 `enabled` 开关（14 §9.4①，矩阵首个 PATCH）：body 只含 `{enabled}`；开关**变化**才递增版本          |
  | `DELETE /api/cloud/user-profile/entries/:category/:entryId` | —                                                | `cloudUserProfileEntryDeleteResponseSchema` | 删除条目并递增 `profileVersion`；运行中 Run 不变、下一 Run 生效（14 §1.2/§8 U-08）                        |

  矩阵行（`CLOUD_HTTP_ENDPOINTS`）与 SDK 索引（`CLOUD_SDK_ENDPOINT_SCHEMAS`）必须成对添加：矩阵里带
  request 的写端点必须同时出现在 SDK 索引（既有覆盖不变量，`packages/client/test/cloudSdk.test.ts`）。

- **凭据边界**：`mcp` 正文（token/headers/env）只经 bridge 认证通道与上传入口流转；禁止进入日志、
  `bridge.phase` 诊断、任务投影/历史/回放；HTTP 面只回条目元数据——**唯一例外是条目回显 GET**
  （14 §9.4① 的显式修订：已鉴权主体按需读取**单个**条目正文供 UI 编辑回显，响应按类别有界）；
  快照/版本端点仍不得携带正文。attachment 面**不新增** mcp/skills 通道
  （`CLOUD_ATTACHMENT_SERVICE_ALLOWLIST` 不变，14 §5）。
- **连接期同步结果（14 §4.6，A 批冻结；手动同步端点由 B 批实现）**：`cloudUserProfileSyncResultItemSchema`
  （逐条 `{category, entryId, status: synced|skipped|failed, error?}`，`error` 有界且不含正文）与
  `cloudUserProfileSyncResponseSchema`（`{runId, profileVersion, trigger, results[]}`，`trigger` =
  `automatic|manual`）。自动同步（bridge ready 后一次）只记日志（runId/epoch/profileVersion/逐条 status，不含正文）；
  手动同步端点 `POST /api/cloud/tasks/:taskId/user-profile-sync`（连接态且非终态，未连接/终态 409
  `not_ready` + reason，03 §6）返回同一形状。

## 版本与严格性策略

- `CLOUD_BRIDGE_PROTOCOL_VERSION` / `CLOUD_RPC_PROTOCOL_VERSION` / `CLOUD_PROJECTION_SCHEMA_VERSION`
  独立版本化（00 §8）。未知版本整帧拒绝（fail-closed），不按旧字段猜测解析。
- 客户端面（`/api/cloud/*`、`/ws/cloud/*`）的协商版本是 `CLOUD_WIRE_PROTOCOL_VERSION`（W7 CR-1），
  支持集为 `CLOUD_WIRE_PROTOCOL_SUPPORTED_VERSIONS`；`capabilitiesResponseSchema.protocolVersion`
  与两者同源。读到不在支持集内的版本 fail-closed，归一为 `protocol_incompatible`。
- `capabilitiesResponseSchema.principalId` 是**客户端 scope 隔离键**（草稿 scope = principal + origin
  - taskId，04 §3.4.1），不是认证凭据、不是 token；认证仍走 bearer / host lite-token（03 §3）。
    客户端不得用它替代鉴权，也不得据此推断权限。该字段**只在云分支存在**（`cloudCapabilitiesResponseSchema`）：
    本地分支没有主体，塞入 `principalId` 会被拒绝。
- 所有对象 schema 使用 `.strict()`：未知字段拒绝。
- 业务字段禁止 `z.unknown()` 兜底：投影 payload 与错误 details 用 `z.json()` + 尺寸上限；
  `runtimeAck` 复用既有 V4 `commandAckSchema`（该 schema 自身的未知字段策略属 V4 契约）。
- 尺寸上限：输入正文 200k 字符、附件 16 个、投影 payload 512 KiB、错误 details 8 KiB、
  RPC 帧 4 MiB（base64 上限由字节数推导，线性校验避免正则栈溢出）；M8 用户资源 profile 另有
  `user-profile.ts` 的具名常量（归档单条 skills 20MiB / plugins 50MiB、mcp 256KiB JSON、
  commands/subagents/agents-md 256KiB UTF-8、总量 128MiB、条目 256、上传体 80MiB，见上节）；
  连接期分块导入的单块上限 2MiB 在 `../user-archive-import.ts`（14 §4.4）。

## 沙箱 attachment 的服务通道白名单

- 通道名、命令名、帧事件名沿用既有 V4 协议（`ServiceChannels`），云侧不另造业务协议（02 §0）；
  只冻结 `CLOUD_ATTACHMENT_SERVICE_ALLOWLIST`（允许经 `/ws/cloud/tasks/:taskId` 暴露的
  channel）与 `CLOUD_ATTACHMENT_DENIED_SERVICE_CHANNELS`（账号域/host 本体能力，只在 host `/ws`）。
  UI、SDK、服务端共用这两个常量，禁止任何一端硬编码 channel 字符串。
- **控制面专用白名单**（14 §4.2，2026-10-11 A 批冻结）：`CLOUD_CONTROL_PLANE_SERVICE_ALLOWLIST`
  = `mcp-sync`/`skill-sync`/`plugin-sync`/`commands`/`subagents`/`settings-sync`——控制面以
  `rpc.open.serviceScope="control-plane"` 发起的连接期用户资源同步只放行这批既有服务通道；
  `client` scope 沿用浏览器白名单（不变），denylist 对两面继续生效，两份白名单不得混用。
- 客户端手里的 `{runId, runGeneration, connectionEpoch}` 事实源是 task detail 的 `activeRun`，
  只作 expected 值用于 stale 检测；服务端在 WS upgrade 自行解析 activeRun（04 §5），因此
  浏览器侧没有握手帧。

## 附件上传与错误分类

- `POST /api/cloud/attachments` 是 `multipart/form-data`，字段固定 `file`（单文件）+ 可选
  `taskId`（03 §6，W7 CR-4）；常量 `CLOUD_ATTACHMENT_UPLOAD_FORM` 是唯一来源。未支持
  task-owned 上传的部署返回 `not_configured`。
- `attachment_unavailable`（07 §5）：attachment 不可用时在线文件/终端/system/git 操作返回该码，
  retryable 只表示 attachment 恢复后可重试同一操作；禁止回落 host 本机执行域，也禁止把在线
  执行排进输入 outbox。
- `protocol_incompatible` 也用于「响应不是合法错误信封或不是 JSON」（网关 HTML 502、代理截断
  等）：无法按 `code` 解析时统一归一到该码，禁止解析文案猜测语义（09 §8 归一要求）。
- 错误码 → HTTP 状态映射见 `endpoints.ts` 的 `CLOUD_ERROR_HTTP_STATUS`（测试断言目录完整）。

## 测试入口

每个包用既有 node:test + tsx 约定（仓库没有统一 `pnpm test`/`pnpm e2e`）：

```
node --import tsx --test packages/shared/test/cloud*.test.ts   # wire schema 用例（W0）
node --import tsx --test packages/server/test/cloud*.test.ts   # 控制面/执行节点（W1–W6）
node --import tsx --test packages/client/test/cloud*.test.ts   # SDK（W7）
node --import tsx --test packages/ui/test/cloud*.test.ts       # UI 投影（W8）
node --import tsx --test packages/web/test/cloud*.test.ts      # Web 入口（W9）
```

也可用各包脚本：`pnpm --filter @zcode/{shared,server,client,ui,web} test`。
