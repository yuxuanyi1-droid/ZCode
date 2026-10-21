# 03 — 云项目与任务管理

> 状态：目标设计。父文档：[00-overview.md](./00-overview.md)。
> 关联：[01-reverse-channel.md](./01-reverse-channel.md)、[02-sandbox-lifecycle.md](./02-sandbox-lifecycle.md)。

## 1. 领域模型

```text
Project（repo 授权域）
  └─ Task（稳定工作委托）
       ├─ TaskInput（持久输入与投递记录）
       ├─ Run（执行尝试，0..n）
       ├─ Projection（已 ingest 的历史记录）
       └─ Artifact / Checkpoint（分支、SHA、PR）
```

| 实体       | 关键字段                                                                                                                                                                     | 所有者                         |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Project    | `id, name, repoUrl, repoOwner, repoName, installationId, defaultBranch, createdAt`                                                                                           | 控制面                         |
| Task       | `id, projectId, title, status, taskStableId, workspaceIdentity, baseBranch, baseSha, taskBranch, activeRunId, nextRunGeneration, revision, archivedAt, createdAt, updatedAt` | 控制面                         |
| Run        | `id, taskId, generation, status, provider, providerHandle, templateVersion, checkoutPath, attachTokenEnc, createdAt, readyAt, endedAt, endReason, lastError, dataAtRisk`     | 控制面                         |
| TaskInput  | `id, taskId, commandId, intent, payloadJson, payloadHash, acceptanceSeq, deliveryStatus, targetRunId, deliveredAt, runtimeAckedAt, lastError, createdAt`                     | 控制面投递与 ACK 投影          |
| Projection | `taskId, logEpoch, seq, kind, payloadJson, ingestedAt`                                                                                                                       | 控制面副本；runtime 是内容权威 |
| Checkpoint | `id, taskId, runId, generation, operationId, state, localSha, remoteSha, riskJson, timestamps`                                                                               | 控制面操作记录；Git 是产物     |
| Artifact   | `taskId, kind(code/noChanges), taskBranch, prNumber, prUrl, prStatus, publishedSha, updatedAt`                                                                               | GitHub 是事实；控制面存投影    |

约束：

1. `Task.status ∈ draft | active | completed | failed | archived`。
2. `Task.taskStableId` 创建时生成且永不变更：小写 `[a-z0-9._-]`，用于 `remote:server:<taskStableId>:<path>`。
3. `Run.generation` 在 Task 内单调递增；`activeRunId` 与 `nextRunGeneration` 在同一事务内更新。
4. `TaskInput.intent ∈ start | append | stop`；`start` 必须是该 Run 的首个输入。
5. 客户端输入中的 Run/generation 只是预期版本，服务端以数据库为准并做 stale 检测。

## 2. 存储

- 独立 SQLite（WAL 模式），文件位于控制面数据卷。
- 单连接 + 串行化 repository 层；不在 HTTP 事件循环执行大查询，列表接口强制 `LIMIT` + 游标。
- 附件（如用户上传）放在受控目录，DB 只存引用。

DDL 草案：

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_url TEXT NOT NULL,
  repo_owner TEXT NOT NULL, repo_name TEXT NOT NULL,
  installation_id TEXT, default_branch TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL, status TEXT NOT NULL,
  task_stable_id TEXT NOT NULL UNIQUE,
  workspace_identity TEXT NOT NULL,
  base_branch TEXT, base_sha TEXT, task_branch TEXT,
  active_run_id TEXT, next_run_generation INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  archived_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  generation INTEGER NOT NULL, status TEXT NOT NULL,
  provider TEXT NOT NULL, provider_handle TEXT,
  template_version TEXT NOT NULL, checkout_path TEXT NOT NULL,
  attach_token_enc TEXT NOT NULL,
  created_at INTEGER NOT NULL, ready_at INTEGER, ended_at INTEGER,
  end_reason TEXT, last_error TEXT, data_at_risk INTEGER NOT NULL DEFAULT 0,
  UNIQUE (task_id, generation)
);

CREATE TABLE inputs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  command_id TEXT NOT NULL,
  intent TEXT NOT NULL,
  payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL,
  acceptance_seq INTEGER NOT NULL,
  delivery_status TEXT NOT NULL,
  target_run_id TEXT, delivered_at INTEGER, runtime_acked_at INTEGER,
  last_error TEXT, created_at INTEGER NOT NULL,
  UNIQUE (task_id, command_id)
);

CREATE TABLE projections (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  log_epoch INTEGER NOT NULL, seq INTEGER NOT NULL,
  kind TEXT NOT NULL, payload_json TEXT NOT NULL, ingested_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, log_epoch, seq)
);

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT NOT NULL,
  generation INTEGER NOT NULL, operation_id TEXT NOT NULL,
  state TEXT NOT NULL, local_sha TEXT, remote_sha TEXT,
  risk_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE artifacts (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  kind TEXT NOT NULL, task_branch TEXT,
  pr_number INTEGER, pr_url TEXT, pr_status TEXT,
  published_sha TEXT, updated_at INTEGER NOT NULL
);
```

## 3. 输入路径与四类确认

```text
submit(commandId, intent, payload)
  → 事务：写入 inputs（status=accepted）+ 更新 Task/Run 意图
  → 返回 receipt（accepted）
  → Run ready 后按 acceptanceSeq 串行投递
  → runtime CommandInbox 幂等 admission
  → runtime ACK → inputs.delivery_status=acked，写投影
```

| 确认             | 含义                            | 是否证明完成           |
| ---------------- | ------------------------------- | ---------------------- |
| accepted receipt | 控制面已持久接收输入            | 否                     |
| transport ACK    | 隧道/帧已送达 bridge            | 否                     |
| runtime ACK      | CLI `CommandInbox` 已 admission | 否                     |
| durable ingest   | 投影批次已持久化                | 否（只证明历史可回放） |

规则：

1. 同一 `(taskId, commandId)` 重复提交幂等返回同一 receipt。
2. 投递失败可重试；重试不改变 `acceptanceSeq`。
3. `stop` 输入独立于普通输入：先持久化 `stop` 意图，再由控制面调用 runtime 停止；`stop` 之后的 `append` 必须被拒绝（返回 `task-stopping`）。
4. 输入正文与附件引用存控制面；沙箱只接收投递内容。

## 4. 投影 ingest 与历史回放

- 控制面在 Run ready 后订阅沙箱 daemon 的 runtime 投影（V4 topic / agent 事件）。
- 每批记录在**一个事务**内校验并写入：`taskId`、`runId`、`generation` 必须与当前 Run 一致；不匹配整批拒绝。
- 游标：`(logEpoch, seq)`；检测到缺口或 runtime 报告 resync 时，重新取快照并从新 epoch 起算。
- 历史接口按游标分页返回；沙箱销毁后仅使用控制面副本（只读）。
- 投影不重新裁决业务：控制面只存结构化记录，不改写 runtime 的会话事实。

## 5. HTTP / WS API

| 方法   | 路径                                          | 说明                                                 |
| ------ | --------------------------------------------- | ---------------------------------------------------- |
| GET    | `/api/cloud/projects`                         | 项目列表                                             |
| POST   | `/api/cloud/projects`                         | 添加仓库（owner/name/defaultBranch）                 |
| DELETE | `/api/cloud/projects/:id`                     | 移除项目（不删除历史任务）                           |
| GET    | `/api/cloud/tasks?projectId=&cursor=&limit=`  | 任务列表（含当前 Run 摘要）                          |
| POST   | `/api/cloud/tasks`                            | 创建 draft 任务（projectId、title、draftConfig）     |
| GET    | `/api/cloud/tasks/:id`                        | 任务详情、Run 列表、Artifact                         |
| POST   | `/api/cloud/tasks/:id/inputs`                 | `{commandId, intent, prompt, attachments?, config?}` |
| GET    | `/api/cloud/tasks/:id/inputs/:commandId`      | receipt / 投递状态                                   |
| GET    | `/api/cloud/tasks/:id/history?cursor=&limit=` | 历史回放                                             |
| POST   | `/api/cloud/tasks/:id/stop`                   | 停止当前 Run                                         |
| POST   | `/api/cloud/tasks/:id/reopen`                 | 新 Run（同 Task）                                    |
| POST   | `/api/cloud/tasks/:id/archive`                | 归档                                                 |
| GET    | `/api/cloud/provider-capabilities`            | 可用 provider 与能力门控                             |
| GET    | `/api/cloud/health`                           | 控制面与 account daemon 状态                         |
| GET    | `/login`、`/logout`                           | 部署 token 换取会话 cookie（原始 Web 的门）          |
| GET    | `/tasks`                                      | 云任务选择页（极简导航，选择后回到原始 Web）         |
| GET    | `/tasks/:id/select`                           | 写入任务 cookie 并跳转 `/`                           |
| WS     | `/ws`、`/ws/host`                             | 透明代理到选中任务 daemon（原始 Web 使用）           |
| HTTP   | `/api/*`（非 `/api/cloud/*`）                 | 代理到选中任务 daemon（如 `/api/server-info`）       |
| WS     | `/ws/cloud`                                   | 云事件（可选，供程序化客户端）                       |
| WS     | `/ws/cloud/tasks/:taskId`                     | 任务 attachment 通道代理（见 §6）                    |
| WSS    | `/api/cloud/bridge/attach`                    | bridge 反向通道（见 01）                             |

认证：所有 HTTP/WS 使用部署级 Bearer token（单用户）；WS 也可用 `?token=`。未认证一律 401/4401。

## 6. 浏览器 attachment 与通道白名单

### 6.1 `/ws`（原始 Web）

- 浏览器使用既有 `packages/web`，只连接 `/ws` 与 `/api/server-info`。
- 控制面把两者透明代理到当前选中任务 daemon，并注入 ingress token；浏览器不接触沙箱网络。
- `/api/server-info` 代理把 `workspaces` 重写为 `[{ path: <checkoutPath> }]`：沙箱 daemon 自身没有登记工作区，原始 Web 以 `workspaces[0]` 作为首屏工作区。不下发 `workspaceIdentity`，否则原始 Web 会进入 remote-waiting 并禁用发送。
- `/ws` 代理在浏览器 upgrade 完成前缓存 daemon→浏览器帧：daemon 在 101 后立即发送协议 Initialize，不能因 `handleUpgrade` 回调晚一拍而丢首帧。
- 控制面自身的 daemon 连接必须先完成 v4 `helloConversationV4 → initializeConversationV4` 握手，`conversationRowsRangeV4` 才可用。
- 任务选择通过 `/tasks` 页面写入 `cloud_task` cookie；未选择时使用最近一个 ready Run。

### 6.2 `/ws/cloud`

由控制面提供 `ChannelServer`：

- **云通道**（控制面实现）：任务列表变更事件、云状态。
- **账号通道代理**：转发到 account daemon 的 `ChannelClient`。

### 6.3 `/ws/cloud/tasks/:taskId`

- 解析 Task 的 `activeRunId` 与当前 attachment；未 ready 返回 503（含 Run 状态与诊断），客户端按退避重试。
- 建立注册：`ChannelServer` 注册**白名单**内的代理通道，每个通道把 `call/listen` 转发到沙箱 daemon 的 `ChannelClient`。
- attachment 被替换（新 epoch）时，服务端关闭旧浏览器连接（4409），客户端重新连接并按游标恢复。

白名单（执行域）：

| 允许                         | 理由                                  |
| ---------------------------- | ------------------------------------- |
| `zcode-agent`                | V4 命令、会话与 topic                 |
| `zcode-session`              | 会话生命周期与配置                    |
| `zcode-task`                 | 任务级查询（只读语义由 runtime 保证） |
| `file`、`file-watcher`       | 任务内文件浏览                        |
| `git`、`git-checkpoint`      | 状态面板与 diff                       |
| `terminal`                   | 任务内终端                            |
| `system`                     | 运行时状态                            |
| `media-preview`              | 预览                                  |
| `prompt-attachment-transfer` | 附件投递                              |

禁止（账号/秘密/宿主能力）：

| 禁止                                                                      | 理由                          |
| ------------------------------------------------------------------------- | ----------------------------- |
| `credential`、`setting`、`oauth`                                          | 账号域；只经 `/ws/cloud` 暴露 |
| `usage-stats`、`coding-plan-subscription`、`client-config`                | 账号域                        |
| `model-selection`、`provider-settings`                                    | Composer 读账号附件，不读沙箱 |
| `provider-provisioning-target`                                            | 仅控制面可调用                |
| `source-server-workspace`、`source-server-management`                     | 宿主/管理能力                 |
| `window-controller`、`broadcast`                                          | 桌面宿主能力                  |
| `plugins`、`plugin-management`、`skill-sync`、`mcp-sync`、`settings-sync` | 管理面；由账号域或控制面处理  |

实现要求：白名单是 `@zcode/cloud-protocol` 中的常量，控制面与 Web 共用；禁止各端硬编码。

## 7. 任务操作语义

- **stop**：写入 `stop` 输入 → 调 runtime 停止 → `draining` → checkpoint（尽力）→ provider 终止 → `stopped`。
- **reopen**：仅终态 Run 可重开；创建新 `generation`，复用 `taskStableId` 与 checkoutPath（新沙箱内相同绝对路径）；历史由投影提供。
- **complete**：runtime 报告完成后写 `Task.status=completed`；PR 状态异步刷新。
- **archive**：只改组织态，不删除历史、不终止运行中的 Run（需先 stop）。
- **删除项目**：只删除授权分组；已存在的 Task 保留（标记 orphan project 引用）。

## 8. 验收场景

1. 创建任务 → 提交首输入 → Run 供给 → 输入被 ACK → 投影落库。
2. 浏览器关闭后重开：任务状态与历史从控制面恢复；在线 Run 可继续。
3. 重复 `commandId`：只产生一条输入、runtime 只执行一次。
4. `stop` 后 `append` 被拒绝；`stop` 幂等。
5. 投影批次中混入错误 generation：整批拒绝，已有投影不变。
6. 沙箱销毁后：历史可读，任务可 reopen。
7. 白名单外通道：调用返回 `unknown channel`，不影响连接。
8. 未认证请求：401/4401。

## 9. 开放问题

- Web 端 Composer 的模型选择以账号附件为准时的刷新时序（会话事件 vs 账号事件）。
- 大附件（>10MB）的传输策略：首版限制大小并走控制面存储；分块/直传后续评估。
- 投影量上限与归档策略（单任务保留窗口）。
