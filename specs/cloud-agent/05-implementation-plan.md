# 05 — 实施计划与验收

> 状态：目标设计。父文档：[00-overview.md](./00-overview.md)。

## 1. 里程碑

| 里程碑          | 交付物                                                                                        | 退出条件                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| M0 基座         | 四个包骨架、依赖账本、边界测试、`cloud-protocol` 帧与 schema、根脚本/架构登记                 | `pnpm typecheck`、`pnpm lint`、边界测试通过                                                    |
| M1 反向通道     | `cloud-bridge`、tunnel 客户端/服务端、TunnelDuplex、daemon 握手、local provider 起真实 daemon | 集成测试：真实 daemon 经反向通道完成 `server-info` + `/ws` RPC 往返；断线重连后 session 不重启 |
| M2 任务管理     | 控制面 domain/app/storage、输入 outbox、投影 ingest、HTTP API                                 | 单测 + 集成：创建任务、提交输入、ACK、历史回放、幂等                                           |
| M3 生命周期     | Run 状态机、供给编排、ready 屏障、停止/drain、reconcile、fencing                              | 故障矩阵（控制面重启、daemon 崩溃、隧道断开）通过                                              |
| M4 Web          | 登录、项目/任务列表、任务视图（会话流/输入/停止/历史）、账号域代理                            | 本地 E2E：浏览器完成一次完整任务闭环                                                           |
| M5 账号域与生态 | account daemon sidecar、通道代理、provisioning 下发、provider adapters（e2b/modal/daytona）   | provisioning 单测 + 代理通道集成；provider adapter 单测                                        |
| M6 产物与验收   | GitHub adapter（分支/PR 记录）、完整验收脚本、文档收尾                                        | 全部验收命令通过；推送分支                                                                     |

依赖关系：M0 → M1 →（M2 与 M3 可并行）→ M4 → M5 → M6。M2/M3 在 M1 的 tunnel 契约稳定后即可并行开发。

## 2. 关键 spike（M1 前置）

| #   | 问题                                                                 | 验证方式                                        | 失败时的替代                                                              |
| --- | -------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------- |
| S1  | `ws` 客户端能否在自定义 duplex 上完成 upgrade                        | 本地脚本：真实 daemon + 手工 duplex             | 改用 `http.request` 手工 upgrade + 自实现 WS 帧；或 bridge 直接代理 WS 帧 |
| S2  | `ZCODE_SERVER_SKIP_SERVICE_REGISTRATION=1` 的 detached fallback 行为 | 本地起 daemon，检查 status.json/PID             | 由 bridge 直接 spawn `serve --supervisor` 并持有子进程                    |
| S3  | `serve --daemon --json` 的 ready 输出与退出码                        | 实测 v3.16.2                                    | 只读 `run/status.json` 轮询                                               |
| S4  | `ZCODE_SERVER_ID` 对 identity 的影响                                 | 起 daemon + createSession，检查会话 workspaceId | 控制面显式传 workspaceId（已计划）                                        |
| S5  | 浏览器侧 `connectViaWebSocket` 对未知通道的行为                      | 连接白名单 ChannelServer 调用禁用通道           | 客户端按 accessor 能力裁剪                                                |

## 3. 测试策略

| 层          | 范围                                                 | 工具                                  |
| ----------- | ---------------------------------------------------- | ------------------------------------- |
| 协议单测    | 帧编解码、schema 边界、错误码                        | vitest                                |
| bridge 单测 | 配置校验、流表、背压、重连退避                       | vitest（fake socket）                 |
| 控制面单测  | 状态机、outbox、投影、fencing                        | vitest（fake provider / fake daemon） |
| 集成        | 真实 daemon + 真实 bridge + 控制面（local provider） | vitest + 子进程                       |
| Web         | 构建通过 + 关键组件单测                              | vitest + vite build                   |
| 边界        | 依赖账本扫描                                         | vitest                                |
| 验收        | typecheck / lint / architecture / test:cloud / E2E   | 根脚本                                |

集成测试默认不依赖外部网络与真实 provider；e2b/modal/daytona 只跑 adapter 单测（fake HTTP）。

## 4. 验收记录（本次实施）

### 4.1 静态与单测

| 项目                                            | 结果                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------- |
| `pnpm typecheck`                                | 通过                                                                            |
| `pnpm lint`                                     | 新包 0 error / 0 warning；全仓仅既有 warning                                    |
| `pnpm architecture:check --changed`             | violations 0                                                                    |
| `pnpm --filter @zcode/cloud-protocol test`      | 10 通过                                                                         |
| `pnpm --filter @zcode/cloud-bridge test`        | 5 通过                                                                          |
| `pnpm --filter @zcode/cloud-control-plane test` | 11 通过（含真实 bridge + 反向通道 + daemon 协议的端到端生命周期与边界依赖扫描） |

### 4.2 真实链路验收

| 场景                                   | 结果                                                                                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 本地 provider + 真实 daemon + 真实模型 | Run ready；API `start`/`append` 输入 runtime ACK；v4 投影落库；助手回复与用户输入均在云历史中                                                                                        |
| 原始 Web（未改 UI）                    | 登录门 → 任务选择 → 首页加载；选择任务项目后发送消息，收到模型回复（“界面消息已收到”，耗时 4s）                                                                                      |
| 停止与重开                             | stop 后 Run 终态、任务 completed；reopen 后新 generation 就绪；历史同时包含旧 Run 与新 Run 的投影                                                                                    |
| E2B 真实沙箱                           | 创建 → 反向通道连接 → provisioning → checkout → ready；输入 runtime ACK；模型回复入投影；空闲暂停；`/api/server-info` 唤醒后 14.8s 内重新 ready；`/ws` 代理收到 daemon Initialize 帧 |
| GitHub App                             | installation token、分支创建、commit、PR 创建与关闭、分支删除全部通过                                                                                                                |

已知限制：

- 原始 Web 在普通 Web 模式下按 `workspacePath` 工作（不下发 identity）；项目分组写入（`task-groups.admit`）会因原始 Web 派生的 `hostId=local` 与独立 server 的 remote hostId 不一致而弹一次 “Group action failed” 提示。会话、发送与项目归属本身仍然生效。
- E2B + 公网隧道下，原始 Web 的项目目录菜单在部分会话中不可用（`useProjectDirectory` 走 remote host 路由失败），因此浏览器内新建会话会提示发送失败；云 API 输入与本地原始 Web 全链路已验收。
- 本地 provider 的 Run 目录会隔离 `HOME`；E2B 使用模板自带的 `/home/user`。

## 5. 验收命令（完整验收）

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm architecture:check --changed
pnpm --filter @zcode/cloud-protocol test
pnpm --filter @zcode/cloud-bridge test
pnpm --filter @zcode/cloud-control-plane test
pnpm build:cloud
pnpm test:cloud          # 含 E2E（local provider + 真实 daemon）
```

通过标准：

1. 全部命令退出码 0。
2. E2E 断言：供给成功、`server-info` 握手、`/ws` RPC 往返、输入 ACK、投影落库、断线重连后会话继续、停止后 Run 终态。
3. 边界测试证明禁止依赖为零。
4. 主仓改动不超过 04 §4 的预算。

## 6. 风险

| 风险                                     | 影响                 | 缓解                                                    |
| ---------------------------------------- | -------------------- | ------------------------------------------------------- |
| ws-over-duplex 不可行（S1）              | 反向通道需要重设计   | 提前 spike；备选方案见 §2                               |
| 沙箱内无 systemd                         | daemon 起不来        | detached fallback + bridge 持有子进程                   |
| 账号域跨进程读取 provisioning 事实不完整 | 沙箱模型不可用       | 首版允许 `credential.load` + 文件读取；记录为已知边界   |
| 原始 Web 只认 path 工作区                | 项目分组提示失败     | 不下发 identity；功能路径已验收，分组提示记录为已知限制 |
| 其它 provider 未验收                     | modal/daytona 不可用 | 能力门控默认隐藏，UI 标注"未验证"                       |
| 单用户 token 被滥用                      | 部署安全             | 部署级 token + HTTPS；多租户前不做公网开放              |

## 7. 交付物清单

- `specs/cloud-agent/00–05`
- `packages/cloud-protocol`
- `packages/cloud-bridge`
- `packages/cloud-control-plane`
- 根脚本、架构登记、边界测试
- 验收记录（命令与结果）
