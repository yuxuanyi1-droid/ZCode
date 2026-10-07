# Cloud wire 契约（shared）

唯一事实源：本目录。跨包消费方只允许 `import ... from "@zcode/shared"`（
`packages/shared/src/index.ts` 已 `export * from "./cloud/index.js"`）。本目录不含
任何实现（SQLite、SDK、路由、UI 都不在这里）。

## 文件与所有者

| 文件                 | 内容                                                               | 主要生产方                      | 主要消费方                     |
| -------------------- | ------------------------------------------------------------------ | ------------------------------- | ------------------------------ |
| `identity.ts`        | `cloud-task:<taskId>` 身份构造/解析、身份 key 取值                 | 控制面                          | 控制面、执行节点、UI、CLI 装配 |
| `errors.ts`          | 归一错误码目录与 retryable 语义                                    | 全部适配层                      | HTTP/WS 信封、SDK、UI          |
| `domain.ts`          | Task/Run/Input/Checkpoint/Artifact 实体与状态全集                  | 控制面持久层                    | HTTP 响应、SDK、UI             |
| `bridge-protocol.ts` | 地址、投影记录、控制帧（`bridge.*`/`checkpoint.*`/`projection.*`） | 控制面 ⇄ 执行节点 bridge        | W1/W5/W6                       |
| `rpc-protocol.ts`    | `rpc.open/request/response/close` 帧                               | 浏览器 ⇄ bridge（经控制面转发） | W5/W6/W7                       |
| `http-contracts.ts`  | 请求 schema、输入/重开/生命周期请求、查询参数                      | 控制面 HTTP 适配层              | W5/W7/W8/W9                    |
| `endpoints.ts`       | 端点矩阵、通道分面、attachment 白名单、wire 版本、错误码→HTTP 状态 | 控制面入口                      | W5/W7/W8/W9、W10 反查          |
| `responses.ts`       | 错误信封、cursor 分页信封、详情/历史/事件/能力响应                 | 控制面 HTTP 适配层              | W7/W8/W9                       |

## 端点 ↔ schema 对照表

`request`/`response` 列是 schema 常量名（同 `http-contracts.ts` 的端点矩阵，二者由
`packages/shared/test/cloudHttpContracts.test.ts` 断言一致）。生产者是控制面 HTTP 适配层
（W5 路由 + W1 应用服务）；消费者是客户端 SDK（W7）及其上层 UI/Web（W8/W9）。
所有端点前缀 `/api/cloud`，鉴权与错误信封见 03 §3/§6。

| #   | 端点                                                 | 请求 schema                       | 响应 schema                           | 备注（阶段/幂等）                                                                                                                                                                                 |
| --- | ---------------------------------------------------- | --------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `GET /api/cloud/capabilities`                        | —                                 | `capabilitiesResponseSchema`          | 含协议版本、provider 能力与 `principalId`（**客户端 scope 隔离键，非认证凭据**；认证仍走 bearer/lite-token），不含 secret                                                                         |
| 2   | `GET /api/cloud/repositories`                        | —                                 | `cloudRepositoryPageSchema`           | `not_configured`（503）直到 installation 投影装配（03 §6）                                                                                                                                        |
| 3   | `GET /api/cloud/repositories/:repoId/branches`       | —                                 | `cloudBranchPageSchema`               | repo 授权后查询                                                                                                                                                                                   |
| 4   | `GET /api/cloud/projects`                            | —                                 | `cloudProjectPageSchema`              | 分页                                                                                                                                                                                              |
| 5   | `POST /api/cloud/projects`                           | `createCloudProjectRequestSchema` | `cloudProjectRecordSchema`            | creationKey 或唯一约束去重                                                                                                                                                                        |
| 6   | `PATCH /api/cloud/projects/:projectId`               | `patchCloudProjectRequestSchema`  | `cloudProjectRecordSchema`            | revision CAS                                                                                                                                                                                      |
| 7   | `DELETE /api/cloud/projects/:projectId`              | —                                 | `cloudDeletedResponseSchema`          | 有活动任务默认 409                                                                                                                                                                                |
| 8   | `GET /api/cloud/projects/:projectId/tasks`           | —                                 | `cloudTaskPageSchema`                 | 不查询沙箱                                                                                                                                                                                        |
| 9   | `POST /api/cloud/tasks`                              | `createCloudTaskRequestSchema`    | `cloudTaskRecordSchema`               | 建 draft，creationKey 去重                                                                                                                                                                        |
| 10  | `GET /api/cloud/tasks/:taskId`                       | —                                 | `taskDetailResponseSchema`            | `{task, activeRun?, execution?, latestCheckpoint?, artifact?, actions}`；`actions` 是**服务端推导的能力投影**（`cloudTaskActionSchema` 枚举，仅用于呈现/门控；写操作仍由服务端独立校验，04 §3.3） |
| 11  | `PATCH /api/cloud/tasks/:taskId`                     | `patchCloudTaskRequestSchema`     | `cloudTaskRecordSchema`               | 仅标题/draftStartConfig + revision                                                                                                                                                                |
| 12  | `POST /api/cloud/tasks/:taskId/inputs`               | `submitTaskInputSchema`           | `inputReceiptSchema`                  | 202 = 持久接收；start / append 二选一意图                                                                                                                                                         |
| 13  | `GET /api/cloud/tasks/:taskId/inputs`                | —                                 | `inputRecordPageSchema`               | 输入/回执分页                                                                                                                                                                                     |
| 14  | `GET /api/cloud/tasks/:taskId/inputs/:commandId`     | —                                 | `inputReceiptSchema`                  | 解决响应丢失                                                                                                                                                                                      |
| 15  | `POST .../inputs/:commandId/cancel`                  | `cloudEmptyBodySchema`            | `inputReceiptSchema`                  | 幂等撤销                                                                                                                                                                                          |
| 16  | `POST /api/cloud/tasks/:taskId/reopen`               | `reopenCloudTaskRequestSchema`    | `taskDetailResponseSchema`            | 新 run/generation，必须带 `resume` 选择                                                                                                                                                           |
| 17  | `POST /api/cloud/tasks/:taskId/stop`                 | `cloudEmptyBodySchema`            | `taskDetailResponseSchema`            | 原子持久停止屏障                                                                                                                                                                                  |
| 18  | `POST /api/cloud/tasks/:taskId/force-stop`           | `forceStopCloudTaskRequestSchema` | `taskDetailResponseSchema`            | 显式丢失确认 + revision + operationId                                                                                                                                                             |
| 19  | `POST /api/cloud/tasks/:taskId/extend`               | `cloudEmptyBodySchema`            | `cloudExtensionResponseSchema`        | provider 确认期限或标记估计                                                                                                                                                                       |
| 20  | `POST /api/cloud/tasks/:taskId/complete`             | `cloudEmptyBodySchema`            | `taskDetailResponseSchema`            | 显式验收                                                                                                                                                                                          |
| 21  | `POST /api/cloud/tasks/:taskId/archive`              | `cloudEmptyBodySchema`            | `taskDetailResponseSchema`            | 无活动写 run                                                                                                                                                                                      |
| 22  | `POST /api/cloud/tasks/:taskId/reactivate`           | `cloudEmptyBodySchema`            | `taskDetailResponseSchema`            | PR 未 merged 时可转 active                                                                                                                                                                        |
| 23  | `POST /api/cloud/tasks/:taskId/restore`              | `cloudEmptyBodySchema`            | `taskDetailResponseSchema`            | 回 archivedFromStatus                                                                                                                                                                             |
| 24  | `GET /api/cloud/tasks/:taskId/history`               | `cloudHistoryQuerySchema`         | `cloudHistoryPageSchema`              | 只读控制面副本                                                                                                                                                                                    |
| 25  | `GET /api/cloud/tasks/:taskId/events`                | `cloudTaskEventsQuerySchema`      | `cloudTaskEventsResponseSchema`       | `not_implemented`（501）直到 M3 事件源                                                                                                                                                            |
| 26  | `GET /api/cloud/tasks/:taskId/snapshot`              | `cloudSnapshotQuerySchema`        | `cloudProjectionSnapshotSchema`       | 匹配 epoch/cursor                                                                                                                                                                                 |
| 27  | `GET /api/cloud/events`                              | —                                 | `cloudMetadataEventSchema`（SSE）     | 只做通知，不做可靠投递                                                                                                                                                                            |
| 28  | `POST /api/cloud/attachments`                        | 非 JSON 体（multipart）           | `cloudAttachmentUploadResponseSchema` | owner 级持久引用                                                                                                                                                                                  |
| 29  | `POST /api/cloud/github/installations/:id/reconcile` | —                                 | `cloudEmptyBodySchema`                | 管理者主动对账                                                                                                                                                                                    |
| 30  | `POST /api/cloud/github/webhook`                     | —                                 | `cloudEmptyBodySchema`                | `not_implemented`（M7 条件性）                                                                                                                                                                    |
| 31  | `GET /api/cloud/runs/:runId/git-grant`               | —                                 | `cloudGitGrantResponseSchema`         | 执行节点出站、单次兑换（01 §7.2）                                                                                                                                                                 |
| 32  | `GET /api/cloud/assets/:assetId`                     | —                                 | 二进制资产                            | 版本/hash 清单校验（01 §6）                                                                                                                                                                       |

## 帧 ↔ schema 对照

| 帧/信道                                                      | schema                                                         | 生产者                                    | 消费者      |
| ------------------------------------------------------------ | -------------------------------------------------------------- | ----------------------------------------- | ----------- |
| `bridge.hello` / `welcome` / `ready` / `heartbeat` / `phase` | `cloudBridgeControlFrameSchema`                                | bridge ⇄ 控制面                           | W1/W5/W6    |
| `bridge.fault` / `bridge.drain`                              | 同上（双向）                                                   | 任一侧                                    | W1/W5/W6    |
| `bootstrap.config`                                           | `bootstrapConfigFrameSchema` + `bootstrapCloneFactsSchema`     | 控制面 → bridge（welcome 后、ready 前）   | W1/W6       |
| `checkpoint.request` / `checkpoint.result`                   | `checkpointRequestFrameSchema` / `checkpointResultFrameSchema` | 控制面 → bridge（停止/保存通路，01 §8）   | W1/W6       |
| `projection.batch` / `projection.ack`                        | `projectionBatchFrameSchema` / `projectionAckFrameSchema`      | 执行节点 exporter / 控制面                | W1/W6       |
| `rpc.open/request/response/close`                            | `cloudRpcFrameSchema`                                          | 浏览器 ChannelClient / 沙箱 ChannelServer | W5/W6/W7    |
| 通道分面                                                     | `CLOUD_SERVICE_CHANNEL_FACETS`                                 | 控制面入口                                | W5/W7/W8/W9 |

W0 §4 原冻结的帧清单是 `hello/welcome/ready/heartbeat/phase/fault/drain` + `projection.batch/ack`；
两次裁决后 02 §4 帧表增补 `bootstrap.config` 与 `checkpoint.request`/`checkpoint.result`，本目录已同步
（W0 §4 清单同步为：`bridge.hello/welcome/ready/heartbeat/phase/fault/drain`、`bootstrap.config`、
`checkpoint.request/result`、`projection.batch/ack`）。

- `bootstrap.config`：运行配置、clone 事实与 `provisioningEnvelopeJson` 只经已认证的 bridge 通道下发
  （provider env/元数据对 provider API 可读，禁承载凭据；provider 命令通道只下发自举要素，01 §6.2）。
  envelope 内部结构归 provisioning 契约所有，shared 只冻结为有界字符串 + `credentialGeneration`
  代际字段（12 §6 A-08）；凭据正文禁止进日志。
- `checkpoint.request`/`result` 只承载保存/停止通路结果，不替代 outbox operation 事实；result 未确认按
  operationId 对账，不重做 commit、不伪造 saved。`saved` 结果必须携带 git object id 形状的 `remoteSha`，
  由 schema 直接拒绝无证据的 saved；`hadNewCommits` 是 additive 字段，缺席不推断。

## 版本与严格性策略

- `CLOUD_BRIDGE_PROTOCOL_VERSION` / `CLOUD_RPC_PROTOCOL_VERSION` / `CLOUD_PROJECTION_SCHEMA_VERSION`
  独立版本化（00 §8）。未知版本整帧拒绝（fail-closed），不按旧字段猜测解析。
- 客户端面（`/api/cloud/*`、`/ws/cloud/*`）的协商版本是 `CLOUD_WIRE_PROTOCOL_VERSION`（W7 CR-1），
  支持集为 `CLOUD_WIRE_PROTOCOL_SUPPORTED_VERSIONS`；`capabilitiesResponseSchema.protocolVersion`
  与两者同源。读到不在支持集内的版本 fail-closed，归一为 `protocol_incompatible`。
- `capabilitiesResponseSchema.principalId` 是**客户端 scope 隔离键**（草稿 scope = principal + origin
  - taskId，04 §3.4.1），不是认证凭据、不是 token；认证仍走 bearer / host lite-token（03 §3）。
    客户端不得用它替代鉴权，也不得据此推断权限。
- 所有对象 schema 使用 `.strict()`：未知字段拒绝。
- 业务字段禁止 `z.unknown()` 兜底：投影 payload 与错误 details 用 `z.json()` + 尺寸上限；
  `runtimeAck` 复用既有 V4 `commandAckSchema`（该 schema 自身的未知字段策略属 V4 契约）。
- 尺寸上限：输入正文 200k 字符、附件 16 个、投影 payload 512 KiB、错误 details 8 KiB、
  RPC 帧 4 MiB（base64 上限由字节数推导，线性校验避免正则栈溢出）。

## 沙箱 attachment 的服务通道白名单

- 通道名、命令名、帧事件名沿用既有 V4 协议（`ServiceChannels`），云侧不另造业务协议（02 §0）；
  只冻结 `CLOUD_ATTACHMENT_SERVICE_ALLOWLIST`（允许经 `/ws/cloud/tasks/:taskId` 暴露的
  channel）与 `CLOUD_ATTACHMENT_DENIED_SERVICE_CHANNELS`（账号域/host 本体能力，只在 host `/ws`）。
  UI、SDK、服务端共用这两个常量，禁止任何一端硬编码 channel 字符串。
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
