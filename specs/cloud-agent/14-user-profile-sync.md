# Spec 14 — 云用户资源与设置同步（M8）

状态：**已实现（2026-10-17 回写；验证状态见 [10 §10](./10-implementation-plan.md)）**。2026-10-11 设计（同日按用户"连接期同步"简化定调修订）已落地，现行设计见 §4 与 §9.5。

父文档：[00-overview.md](./00-overview.md)

关联：[01-provisioning.md](./01-provisioning.md)（§6.1/§6.2/§7.1）、[02-bridge-protocol.md](./02-bridge-protocol.md)（§0/§4/§5.3/§8）、[07-connection-architecture.md](./07-connection-architecture.md)（§7/§8）、[12-account-domain.md](./12-account-domain.md)（§1.2/§2/§6）；工作单 [W11](./modules/W11-user-profile-sync.md)。

本文是 **M8「云用户资源与设置同步」** 的唯一负责文档：控制面侧的用户资源 profile、连接期同步通路（控制面经 bridge relay 调沙箱既有 sync 服务）、凭据边界与行为偏好快照实值化。M8 是 v1 首版范围结论之后的**追加任务**，不回改 00–12 已冻结的结论；凡与既有文档冲突处，以本文为准并按 §7 修订点清单同步指引，旧结论原文保留可追溯。

**2026-10-11 简化定调（用户最终口径，决议全文见 §9.5）**：云相对 SSH 的专有面仅三项——沙箱回连（出站 WSS）、生命周期管理、持久投影/可回放历史；用户资源同步骑 **SSH 同构服务层**（控制面经 bridge relay 调沙箱 runtime 的既有 sync 服务），只做**连接期同步**（bridge ready 后自动一次 + 连接态手动任意次），不做自举期（pre-ready）安装。原"`bootstrap.resources` 帧 + 沙箱自研安装器 + ready 门控"设计整体退役（§4.8）；偏好快照链（`bootstrap.config.preferences`）保留不动（§6）。

## 1. 产品目标与范围

目标：用户在云模式的设置页管理自己的用户级资源；Run 的沙箱**连接建立后**（bridge ready），控制面自动把最新 profile 同步一次进沙箱 HOME，连接态还可手动同步任意次；行为偏好由沙箱从控制面下发的快照应答。客户端关闭、控制面重启、沙箱销毁都不丢失 profile；新 Run 的新沙箱（空 HOME）全量安装最新 profile。语义与 SSH 模式"把本机设置推送进远端"对齐，**且实现同构**：控制面调用的是沙箱 runtime 里既有的 sync/资源服务（`importMcpServers`/`importSkillsArchive`/`importPluginsArchive`/`writeCommandFile`/`writeUserAgentMarkdownFile`），与桌面调用 SSH 远端的是同一批服务、同一套校验与判重（§4.1）；差异只在"驱动方是控制面、时机是连接期"。

### 1.1 纳入类别（7 项）

| 类别                            | SSH 模式参照（手动推送，现状）                                                                                                                           | 云 M8 语义（连接期同步；方法与落点见 §4.3）                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 用户级 MCP servers（配置+凭据） | `RemoteMcpSyncDialog`：本机枚举 → 远端 `~/.zcode/cli/config.json` 的 `mcp.servers` 合并写入（0600）                                                      | 连接期调 `importMcpServers`（同名 skip）→ 同一路径与 0600                                                               |
| skills                          | `RemoteSkillSyncDialog`：本机枚举 → tar+gzip 归档 → 远端 `~/.zcode/skills`；上限 20MiB                                                                   | 归档入 profile → 连接期**分块导入**（§4.4，突破 4MiB 帧限）→ 复用既有校验/解包，上限同 SSH                              |
| 自定义命令                      | 无推送通路（本分支无对应 sync service/对话框）                                                                                                           | **单文件 markdown 条目** → 连接期逐条 `writeCommandFile` 写 `~/.zcode/commands/<entryId>`（覆盖语义，§4.5）             |
| plugins                         | `RemotePluginSyncDialog`：tar+gzip 归档 → 远端 `~/.zcode/plugins`；上限 50MiB；inline 目录 + marketplace source 镜像；写 `plugins.dirs`/`enabledPlugins` | 归档入 profile → 连接期分块导入（§4.4）→ 同一落点与注册（marketplace source 镜像仍不做，§9.3⑥）                         |
| subagents                       | 无推送通路（services/UI 无对应 sync service/对话框）                                                                                                     | **单文件 markdown 条目** → 连接期逐条 `writeUserAgentMarkdownFile` 原样写 `~/.zcode/agents/<entryId>`（覆盖语义，§4.5） |
| 用户全局 AGENTS.md              | 无推送通路                                                                                                                                               | 单例文本条目 → 连接期调 settings-sync 新增的最小写入方法整文件覆盖 `~/.zcode/AGENTS.md`（§4.5）                         |
| agent 行为偏好                  | 无推送通路；由本机 Host 权威应答（[07 §8](./07-connection-architecture.md) 表首行）                                                                      | 快照实值随 `bootstrap.config` 下发，沙箱 responder 从快照应答（§6；不经同步服务调用）                                   |

触发与门控（§4.6）：Run 连接建立（bridge ready）后控制面自动同步一次**最新** profile；手动同步仅在连接态且非终态可用（未连接 UI 不显示入口、服务端 409 拒绝）；不做自举期（pre-ready）安装。

### 1.2 不纳入（明确排除）

- **hooks**：执行面安全敏感（任意命令执行入口），不进入 M8 的自动安装集合；单列为开放问题（§9），需要独立的安全评审（2026-10-11 决议：**不纳入 M8**，见 §9.1①）。
- **workspace 级资源**：随 repo clone 天然进入沙箱（`<workspace>/.zcode/*`、`<workspace>/AGENTS.md` 等），不在 profile 范围。
- **Run 运行中热更新（2026-10-11 简化修订）**：原口径"profile 变更下一 Run 生效、运行中 Run 保持创建时冻结的版本"改为——**同步只发生在连接期**：每次连接自动一次 + 连接态手动任意次；Run 不追踪 profile 版本（`resources_profile_version` 退役）。连接态手动同步对归档与 mcp 类是**只补新增**（同名 skip 不覆盖，改内容需新 Run），对 commands/subagents/AGENTS.md 类是**覆盖写**（§4.7）；"强制覆盖模式"列开放问题（§9.5）。与 [12 §6](./12-account-domain.md) A-08 的凭据重推语义不冲突：凭据刷新是安全需要（过期即失效），用户资源是环境一致性需要，两者刻意分开。
- **多账号共享 / RBAC / 团队资源**：沿 [00 §1](./00-overview.md)、[00 §11⑤](./00-overview.md) 决议——部署模型为单用户，profile 属主是账号本人；多账号时的共享与权限模型不在本里程碑。

### 1.3 里程碑定位

M8 是**独立里程碑**，不回改 v1 首版范围结论（[00 §1](./00-overview.md) 已追加指引）：首版"沙箱模板不带用户设置"（[01 §6.1](./01-provisioning.md)）与"MCP 凭据默认空"（[01 §7.1](./01-provisioning.md)）的结论保留为历史，M8 在其上追加**连接期同步通路**。实施批次（[W11 §13](./modules/W11-user-profile-sync.md)：A 契约与 services / B 控制面 / C 沙箱清理 / D UI）先于实现，契约修订先于实现（[13 §5](./13-module-map.md) 变更流程）。

## 2. 当前源码基线

> 2026-10-11 注：本节是 M8 设计起点（P18 前）的基线快照，原文保留可追溯。"云侧缺口"列中的自举安装面（`bootstrap.resources`、安装器、ready 条件）已由 P18–P20 落地、并于同日简化定调中**整体退役**（§4.8）；现行设计以 §4 为准。下方表格的其余事实（SSH 侧既有服务方法与能力）是现行设计直接复用的对象，仍然有效。

| 当前源码                                                                                                                                                    | 已有能力                                                                                                                                          | 云侧缺口                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ui/src/settings/RemoteSyncActions.tsx`、`RemoteMcpSyncDialog.tsx`、`RemoteSkillSyncDialog.tsx`、`RemotePluginSyncDialog.tsx`                      | SSH 目标的三个手动推送对话框（MCP/skills/plugins）                                                                                                | `shouldShowRemoteSyncActions` 对 `web-remote-replayable`（云会话面，[02 §7.4](./02-bridge-protocol.md)）直接返回 false：云客户端不展示、也不存在可复用的"手动推送"交互        |
| `packages/services/src/mcp-sync/mcpSyncService.ts`                                                                                                          | 本机枚举 → 远端 `~/.zcode/cli/config.json` `mcp.servers` 合并写入（`SECRET_CONFIG_FILE_MODE=0o600`）；写前 `checkRemoteSyncDirectoryWriteAccess`  | 依赖"一个活着的远端目标 + 用户点击"；无 profile、无版本、无跨 Run 持久                                                                                                        |
| `packages/services/src/skill-sync/skillSyncService.ts`、`plugin-sync/pluginSyncService.ts`（+ `skillSyncArchive.ts`/`pluginSyncArchive.ts`/`*SyncPath.ts`） | tar+gzip 归档（`DEFAULT_MAX_ARCHIVE_BYTES` = skills 20MiB / plugins 50MiB）、manifest 校验、解包膨胀与路径穿越防护、导入判重                      | 同上；plugin 的 marketplace source 镜像（`marketplace-sources`）与 `plugins.dirs`/`enabledPlugins` 注册只在"推送时点"完成                                                     |
| `packages/services/src/commands/commandsService.ts`、`subagents/subagentStorage.ts`                                                                         | 用户级目录解析（`~/.zcode/commands`、`~/.zcode/agents`，后者随 `~/.zcode/cli/config.json` `storage.dir`）                                         | 无远端推送通路（命令/subagent 从未接入同步）                                                                                                                                  |
| `packages/services/src/node.ts`（`answersRuntimePreferencesLocally`）、`zcode-agent/zcodeAgentService.ts`（`sessionRuntimePreferencesAuthority`）           | 云执行节点按 `local` authority 应答 runtime preferences；`desktop-attached-remote` 走 `external`（[07 §8](./07-connection-architecture.md)）      | 沙箱节点读的是**自己的** settingService（无账号设置，落默认值）；偏好没有从控制面下发的通路                                                                                   |
| `packages/server/src/cloud/execution/adapters/provisioningInstaller.ts`、`domain/readyGate.ts`、`app/bootstrap.ts`                                          | envelope 安装（provider/model + 账号凭据，[01 §6.2](./01-provisioning.md)/[12 §6](./12-account-domain.md)）；ready 条件含 `preferences-installed` | `createPolicySnapshotInstaller` 只写 `{version, policyVersion}`（版本号占位）；无用户资源安装器与对应 ready 条件；`bootstrap.ts` 中 `preferencesInstalled: true` 是硬编码占位 |
| `packages/server/src/cloud/app/config.ts`（`bootstrapPolicyVersion: "cloud-policy-1"`）                                                                     | 策略快照版本作为部署级常量下发（`bootstrap.config` → `bridge.ready.configVersion`）                                                               | 版本没有与账号设置值绑定；快照内容为空                                                                                                                                        |

结论（2026-10-11 简化定调后）：SSH 的"手动导入"**交互**不可照搬（云沙箱无长期目标、无用户交互窗口），但 SSH 的**服务层与校验**直接照搬——控制面在连接期调用沙箱 runtime 的既有 sync/资源服务（§4.1），归档格式、上限、校验与判重全部沿用既有实现，不造第二套打包/校验/安装器。

补注（2026-10-11，P19a–P20 落地后核实）：沙箱 runtime 的 `mcp-sync`/`skill-sync`/`plugin-sync`/`commands`（`writeCommandFile`）/`subagents`（`createAgent`）服务**已注册暴露、authority 无关**；relay `rpc.*` 帧在 ready 前被沙箱 fail-closed 丢弃、ready 后可用；单帧上限 `CLOUD_RPC_PAYLOAD_MAX_BYTES` = 4MiB（[02 §0](./02-bridge-protocol.md)）；sync 导入的判重语义 = 同名冲突 `skip`（逐条结果数组），`importMcpServers` 的 `localHomeDir` 仅用于 filesystem MCP 路径改写（云传占位，§4.2）；无写远端用户级 AGENTS.md 的服务方法（§4.5 新增最小方法）。

## 3. 状态所有者与数据模型

### 3.1 唯一所有者

| 事实                                                    | 唯一所有者                                                                                                                                     | 其他组件职责                                               |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 用户资源 profile（条目集合、每类条目正文、逐条 sha256） | 控制面 **profile store**（属主 = 账号域，[12 §1.2](./12-account-domain.md) 口径；落 cloud.db 或受控附件存储，由 W11 细化）                     | 上传经 W8 设置页；沙箱只接收同步产物，不读 store、不回写   |
| `profileVersion`（单调递增）                            | 控制面 profile store（每次增删改条目/开关值变化后事务内递增）                                                                                  | 作为同步幂等键与 UI 展示值；沙箱不记录"已应用版本"（§4.7） |
| 沙箱内已同步资源（HOME 布局）                           | 沙箱内既有 sync/资源服务（每次连接期同步时点；run 内持久、销毁即灭）                                                                           | 不复制回控制面、不入库；profile 才是权威                   |
| 行为偏好实值                                            | 账号设置权威 = host 本体 `settingService`（[12 §2](./12-account-domain.md)）；Run 已应用版本在节点（[07 §8](./07-connection-architecture.md)） | 控制面读值组快照；沙箱 responder 只读已应用快照            |

**（2026-10-11 简化）** 原"Run 冻结的资源版本"行删除：同步永远取最新 profile，Run 不再冻结资源版本，`runs.resources_profile_version` 列保留不写不读（注明废弃，§4.8）。

### 3.2 数据模型要点

- **profileVersion 单调递增**：控制面 profile store 每完成一次上传/更新/删除/开关值变化事务后 +1。版本号是同步幂等与"改了什么"的核对值，也是 UI 上"当前生效版本"的展示值；不允许回退或复用。**不再作为 Run 冻结锚点**（Run 不追踪版本，§4.7）。
- **每类资源独立条目 + sha256**：条目 = `{category, entryId, sha256, bytes, 正文}`；类别枚举 = §1.1 的 7 项（行为偏好作为账号设置快照，见 §6，可存于同一 store 或 host settingService 投影，W11 冻结）。sha256 用于幂等判定、错误定位（错误信息带 `category/entryId`）与同步结果核对。条目形态分两类：**归档类**（skills/plugins：canonical base64 归档字节）、**文本/JSON 类**（mcp = JSON；commands/subagents = markdown 文本 ≤256KiB/条；agents-md = 正文，单例）。**（2026-10-11：偏好值来源已明确为 host `settingService` 读值快照，载体=扩展 `bootstrap.config`，见 §6 与 §9.1③；物理落位仍待 W11 实施期。）**
- **沙箱内不持久化跨 Run 状态**：同步产物即沙箱 HOME 布局（§4.3）；沙箱销毁内容即灭，没有"沙箱侧第二份 profile"。Run 内重连会再触发一次自动同步，幂等由既有服务的 skip/覆盖语义提供（§4.7），不存在"重放冻结版本"这一条路径。
- **上传路径 = 云 Web 设置页（[W8](./modules/W8-ui-cloud.md) 扩展）**：
  - MCP servers：表单 CRUD（名称、transport、args、env、headers、token 等字段化录入；凭据字段加密存储，见 §5）。
  - skills / plugins：归档上传，**复用 SSH 同步的归档格式、上限与校验**（tar+gzip；skills 20MiB、plugins 50MiB；解包膨胀校验、manifest 校验、路径穿越防护；实现直接复用既有 `skillSyncArchive.ts`/`pluginSyncArchive.ts` 的校验逻辑）。
  - commands / subagents：**单文件 markdown 文本条目**（≤256KiB/条；entryId = 文件名 `*.md`，§4.5），编辑/新建/删除按条目操作，不再走归档上传。
  - 用户全局 AGENTS.md：文本编辑器（单例条目，≤256KiB UTF-8）。
  - 上传即校验、失败即拒绝（fail-closed），错误信息定位到类别与条目；拒绝原因在 UI 可读（对齐 [07 §13](./07-connection-architecture.md) 验收口径）。
- **版本历史保留**：**2026-10-11 冻结：保留最近 8 个快照版本**（原为"在途 Run 引用旧版本"服务，Run 冻结退役后用途收窄为改动追溯与 UI 核对）；条目按 sha256 去重存储，修剪无引用旧条目（§9.1④ 数值与 §9.2① 落位不变）。

## 4. 连接期同步通路（2026-10-11 简化定调重写）

> 本节为**现行设计**（决议记录见 §9.5），取代本节此前版本（`bootstrap.resources` 帧 + 控制面分块下发 + 沙箱自研安装器 + ready 门控）。被取代的决议原文保留在 §9.2–§9.4 可追溯，退役清单见 §4.8。

### 4.1 总框架：相对 SSH 的专有面只有三项

云相对 SSH 的专有面**仅**三项，其余一律骑 SSH 同构服务层：

| 专有面                  | 内容                                              | 归属                                                         |
| ----------------------- | ------------------------------------------------- | ------------------------------------------------------------ |
| ① 沙箱回连              | 执行节点出站 WSS bridge、握手/凭据旋转/ready 门控 | [02](./02-bridge-protocol.md)                                |
| ② 生命周期管理          | Task/Run 创建、provider 预约、停止/保存/归档      | [01](./01-provisioning.md)、[08](./08-project-task-model.md) |
| ③ 持久投影 / 可回放历史 | durable ingest、快照/历史/回放、慢客户端恢复      | [02 §7](./02-bridge-protocol.md)                             |

**用户资源同步不是第四项专有面**：它的形态 = 控制面经 bridge relay 调沙箱 runtime 的**既有服务**，与桌面调 SSH 远端完全同构——`mcp-sync`/`skill-sync`/`plugin-sync`/`commands`/`subagents`/`settings-sync` 全部是既有的 SSH 同步/资源服务（沙箱 runtime 已注册暴露、authority 无关），云侧只新增"谁来调、什么时候调、用什么白名单放行"。由此固定两条边界：

- 安装逻辑的唯一来源 = 既有 sync 服务的导入实现（归档格式、上限、校验、判重、合并写、落盘权限全部沿用）——**不新建安装器、不新增第二条写路径**；
- 沙箱不自研安装器、不落"已安装资源"状态文件：幂等由服务自身的判重/覆盖语义提供（§4.7）。

### 4.2 传输通路（驱动方 = 控制面）

- **驱动方 = 控制面**；被调方 = 沙箱 runtime 的既有服务。沙箱不主动拉取 profile，也不读控制面 store。
- **承载** = bridge 认证通道上的 `rpc.*` 帧（[02 §0/§4](./02-bridge-protocol.md)）：控制面用 `ChannelClient` 发起，沙箱侧 `rpcRelay` 建 `ChannelServer` 转发到本地常驻 stdio client 的同名 channel——与浏览器调用同一套序列化/事件/取消语义，不另造业务协议、不直通 stdio。
- **分面（新增；不得混用）**：`rpc.open` 增加必填 `serviceScope: "client" | "control-plane"`（由控制面构造信封时写入；浏览器字节只作为有界 payload 被包装，**不能自报 scope**）。`client` scope 沿用 `CLOUD_ATTACHMENT_SERVICE_ALLOWLIST`（现状不变）；`control-plane` scope 的准入集 = `CLOUD_ATTACHMENT_SERVICE_ALLOWLIST` **∪** `CLOUD_CONTROL_PLANE_SERVICE_ALLOWLIST`（下表）——**2026-10-11 C 批定夺：控制面是受信基础设施，能力是浏览器面的超集**（命令投递复用浏览器面的 `zcode-agent`、连接期同步用 6 个 sync 通道；浏览器面白名单本身不变）；denylist `CLOUD_ATTACHMENT_DENIED_SERVICE_CHANNELS` 对两面继续生效。白名单常量与浏览器白名单同文件落位（`packages/shared/src/cloud/endpoints.ts`），随 A 批契约冻结：

  ```ts
  /** 控制面发起的 rpc 会话可触达的沙箱服务通道增量（准入集 = 本表 ∪ 浏览器面白名单；只约束控制面方向）。 */
  export const CLOUD_CONTROL_PLANE_SERVICE_ALLOWLIST = [
    "mcp-sync",
    "skill-sync",
    "plugin-sync",
    "commands",
    "subagents",
    "settings-sync",
  ] as const;
  ```

- **ready 前不可达（既有语义）**：relay RPC 帧在沙箱 ready 之前被 fail-closed 丢弃（[02 §5.3](./02-bridge-protocol.md)），因此同步**按构造只发生在连接期**，不存在 pre-ready 安装（§4.6）。
- **帧上限与分块/分批**：单帧 RPC 字节上限 `CLOUD_RPC_PAYLOAD_MAX_BYTES` = 4MiB（[02 §0](./02-bridge-protocol.md)）。归档类走分块导入（§4.4）：原始块 ≤2MiB，双层 base64（条目 payload 一次 + relay 帧一次）后 ≈3.73MiB < 4MiB，留信封余量，实现必须断言编码后帧不超限、超限即 fail-closed；mcp 与单文件条目按"序列化后 ≤2MiB/批"分批调用（批内条目串行、批间串行）。
- **调用序列化**：同一 Run 的同步序列串行（单流顺序调用），不做跨类别并发；重连后的重复同步由 §4.6 单飞去重与 §4.7 判重/覆盖语义保证幂等。
- **`localHomeDir` 传占位**：`importMcpServers` 的 `localHomeDir` 只用于 filesystem MCP 的路径改写；云 profile 没有"本机 home"来源，控制面固定传占位值（`"/"`），不做 home 重写，其余字段原样落盘。
- **失败不 fail run**：任一服务调用/分块传输失败 → 该次同步整体记为失败（逐条结果定位到 `category/entryId`）、只记日志（§4.6）、不改 Run 状态；恢复手段 = 连接态手动同步或重连后的自动同步。

### 4.3 类别映射（条目 → 服务方法 → 落点）

| 类别                         | 条目形态                                    | 调用的既有服务方法                                                                | 沙箱落点（与 SSH 远端同构）                                                 | 落盘语义     |
| ---------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------ |
| 用户级 MCP servers（含凭据） | JSON 条目（≤256KiB）                        | `IMcpSyncService.importMcpServers`（分批）                                        | `~/.zcode/cli/config.json` 的 `mcp.servers`（0o600）                        | 同名 skip    |
| skills                       | tar+gzip 归档（≤20MiB）                     | `ISkillSyncService` 分块导入（§4.4）                                              | `~/.zcode/skills/<dir>/`                                                    | 同名 skip    |
| 自定义命令                   | markdown 单文件（≤256KiB/条）               | `ICommandsService.writeCommandFile`（已存在走 `updateCommandFile`）               | `~/.zcode/commands/<entryId>`（entryId 即文件名）                           | 整条覆盖     |
| plugins                      | tar+gzip 归档（≤50MiB）                     | `IPluginSyncService` 分块导入（§4.4）                                             | `~/.zcode/plugins/<dir>/` + `plugins.dirs`/`enabledPlugins` 注册            | 同名 skip    |
| subagents                    | markdown 单文件（≤256KiB/条）               | `ISubagentsService.writeUserAgentMarkdownFile`（新方法；list 判断存在，原样写入） | `~/.zcode/agents/<entryId>`                                                 | 整条覆盖     |
| 用户全局 AGENTS.md（单例）   | 文本（≤256KiB，entryId 固定 `user-agents`） | settings-sync 新增最小写入方法（§4.5）                                            | `~/.zcode/AGENTS.md`                                                        | 整文件覆盖   |
| agent 行为偏好               | 账号设置快照（非条目）                      | 不经服务调用                                                                      | `bootstrap.config.preferences` → `applied-policy.json` v2 → responder（§6） | 快照实值应答 |

- 落点与校验全部由被调服务实现并保持 SSH 口径；控制面不写沙箱 HOME、不改变既有服务的目标根解析（`getUserZcodeSkillRoot()`/`resolveUserSubagentRoot()`/`getUserZcodePluginRoot()`/`getUserZcodeMcpConfigPath()`/`getUserZcodeAgentsFilePath()`）。
- 目录/文件权限沿用既有服务（凭据类 0o600，同 SSH）；本表只冻结 `~/.zcode` 主面，`~/.agents/*` 兼容读取面**不镜像**（沿用 §9.3② 结论）。
- **agents-md 单例（2026-10-17 收口）**：`category = agents-md` 的条目 `entryId` 必须为 `user-agents`（唯一落点 `~/.zcode/AGENTS.md`）。约束在控制面 domain 层（`domain/userProfile.ts`）判定，PUT 非法 entryId → 400 `invalid_entry`（reason `agents-md-entry-id-must-be-user-agents`）；UI 单例入口与 API 约束同源，直接调 API 也不能写入第二条。
- **subagents 原样落盘（2026-10-17 收口）**：subagents 的沙箱原生形态就是 markdown 文件；控制面不再做 front-matter → `SubAgentConfig` 映射（该映射只服务旧分支，已删除），改为 list 判断存在后调新增方法 `writeUserAgentMarkdownFile({fileName, content})`，正文逐字节落盘（键序/引号/未知键均不改变）。
- 归档类校验与 SSH 导入同款（manifest、解包膨胀、路径穿越、目标根越界拒绝），不得因为"来源是控制面"就跳过校验；唯一写入方 = 被调的既有服务（浏览器/attachment 通道不提供写这些路径的通路，不新增第二写路径）。
- **契约随形态调整**（A 批冻结）：`user-profile.ts` 的归档类别收敛为 `skills`/`plugins`（`CLOUD_USER_PROFILE_ARCHIVE_CATEGORIES`），commands/subagents 新增 markdown 文本负载分支（`{category, content}`，256KiB 与 agents-md 同口径但具名 schema 单列）；store 的 `content_kind` 相应新增文本类（建议 `markdown-text`；agents-md 沿用既有 kind），`archive-base64` 只服务 skills/plugins。上传体上限 80MiB 只对归档类仍有意义。

### 4.4 分块导入（skills / plugins；SSH 将来可共用）

归档 ≤50MiB 而单帧 RPC ≤4MiB，因此 skills/plugins 走**收块缓冲 → 复用既有校验 → 落盘**的分块导入。方法形状（建议冻结；两个服务同款，字段名在 A 批契约定稿）：

| 方法                           | 请求                                                 | 响应                                                                       |
| ------------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------- |
| `beginUserArchiveImport`       | `{archiveSha256, totalBytes, chunkCount}`            | `{importId}`                                                               |
| `appendUserArchiveImportChunk` | `{importId, chunkIndex, chunkSha256, payloadBase64}` | `{receivedChunks, receivedBytes}`                                          |
| `completeUserArchiveImport`    | `{importId}`                                         | 既有导入结果（逐条 `synced`/`skipped`/`failed`，含 `name`/`path`/`error`） |
| `abortUserArchiveImport`       | `{importId}`                                         | `{aborted}`（释放缓冲；断连/超时同样由服务侧清理）                         |

- **上限**：`totalBytes` ≤ 类别上限（skills 20MiB / plugins 50MiB）；`chunkCount` = `ceil(totalBytes / 块大小)`，块大小 ≤2MiB；`payloadBase64` 必须 canonical base64 且解码字节 ≤2MiB。
- **校验**：`chunkIndex` 严格从 0 递增（缺块/乱序/重复一律拒绝）；逐块解码字节 sha256 必须等于 `chunkSha256`；收齐后拼接字节 sha256 必须等于 `archiveSha256`（不符 fail-closed，不半安装）。
- **完成即委派**：`complete` 把重组后的归档字节交给**既有导入实现**（`importSkillsArchive`/`importPluginsArchive` 已接受 `Uint8Array` 入参）→ 沿用其既有 manifest/膨胀/穿越校验与解包落盘（不新增第二份解包实现；`@zcode/services/archive` 的权威通用解包入口定位不变——三处收敛仍是悬项）。
- **单飞与清理**：同一服务同一时刻最多 1 个进行中的导入会话；新 `begin` 废弃旧会话（有界资源）；未完成会话在断连/超时（建议 5 分钟）后释放缓冲，调用方需重新 `begin`。
- **与云解耦**：该形状不依赖 bridge 或控制面，SSH 同步后续可共用（不属本批）。

### 4.5 单文件条目（commands / subagents）与 AGENTS.md 最小写入方法

- **commands / subagents**：条目形态 = **单文件 markdown 文本**（payload = UTF-8 正文 ≤256KiB/条）；`entryId` = **落盘文件名**（`<name>.md`，`<name>` 满足既有条目键形状——小写字母/数字开头、允许 `-_.`、总长 ≤128 字符，故天然排除路径分隔符与 `..`；必须以 `.md` 结尾）。commands 逐条调 `writeCommandFile`（已存在走 `updateCommandFile`），名称合法性与 front-matter 解析由既有服务保留；subagents 逐条调 **`writeUserAgentMarkdownFile`（2026-10-17 新增）**：整文件覆盖、原子写、0600、≤256KiB，payload = 条目原始正文，`fileName` = `entryId`（服务侧校验 `*.md` 且不含路径分隔符），先 `list` 判断存在（存在性不改变覆盖语义）。subagents **不再**把 front-matter 映射为 `SubAgentConfig` 再经 serializer 落盘——规范化序列化会改键序/引号并丢失未知键，原样写入达到**字节级一致**。**消除 tar 解包环节**：这两类不再产生"归档膨胀/路径穿越"失败面。
- **AGENTS.md**：单例条目（`entryId = user-agents`，§9.4 不变），落点 `~/.zcode/AGENTS.md`。既有服务没有写用户级 AGENTS.md 的方法（`settings-sync` 只有 Claude 迁移用的 `copyClaudeAgentsFileToZcodeAgentsFile`，源是本机文件、语义不匹配），**需新增最小写入方法**：
  - 形状：`writeUserAgentsFile({content}) → {path, bytes, sha256}`；语义 = **整文件覆盖写**（不合并、不追加）、UTF-8、≤256KiB（超限拒绝并定位 `entryId`）、自动创建父目录、**原子写**（临时文件 + rename）、文件模式 0600；不提供 `overwrite:false` 分支（覆盖语义由 §4.7 决议固定）。
  - **单例约束在控制面 domain 层收口（2026-10-17）**：`category = agents-md` 的条目 `entryId` 必须为 `user-agents`，PUT 其它 entryId 直接 400 `invalid_entry`（reason `agents-md-entry-id-must-be-user-agents`），不再只靠 UI 限制、也不把"第二条互相覆盖"推迟到同步期。
  - **落点 = `ISettingsSyncService`（`settings-sync`）**。理由：①它是既有"用户级设置文件"服务的唯一相邻落点，且已持有 `getUserZcodeAgentsFilePath()` 目标路径解析；②不新增服务通道，控制面 allowlist 面不为它扩大；③不选新 channel：新建服务与"骑既有服务层"的定调相悖，且会制造第二份设置文件写入口。
- **上传侧（[W8](./modules/W8-ui-cloud.md) 设置页）相应调整**：commands/subagents 由"归档上传"改为"条目列表 + markdown 文本编辑（新建/覆盖）+ 删除"；归档上传面板收敛为 skills/plugins 两类。

### 4.6 触发与门控（自动一次 + 连接态手动）

| 触发 | 时机                                                                                  | 语义与失败处理                                                                                                                                                                                                              |
| ---- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 自动 | 控制面观察到该 Run 的 `bridge.ready`（attachment registry `markReady`）后异步发起一次 | 取**最新** profile（不追踪 Run 创建时版本）；每次重连（新 epoch）ready 后各触发一次；失败**不 fail run**：只记结构化日志（runId/epoch/profileVersion/逐条 status，不含正文），恢复手段 = 连接态手动同步或下次重连的自动同步 |
| 手动 | `POST /api/cloud/tasks/:taskId/user-profile-sync`（[03 §6](./03-control-plane.md)）   | **仅在 Run 连接态（bridge ready）且非终态时可用**；`stopRequested` 屏障与既有停止/终态检查同款；响应 = 本次逐条结果 `{runId, profileVersion, trigger:"manual", results[]}`（200）                                           |

- **未连接/终态拒绝**：未连接 → 409 `not_ready`（reason `run-not-connected`）；终态 → 409 `not_ready`（reason `run-terminal`）。**不新增 wire 错误码**——错误码目录是 shared 冻结面，沿用 §9.2④/§9.4① 的复用先例。
- **门控双保险**：未连接时任务视图**不显示**同步入口（UI 隐藏，不是禁用态）；服务端对直接调用同样拒绝（409）——UI 不是权限边界，服务端前置校验是权威。
- **单飞**：同一 Run 同一时刻至多一个同步序列在飞；在飞期间的自动触发跳过，手动请求等待同一次结果返回（不排队第二次调用）。**落位（B 批）**：manual 请求 join 在飞的自动同步时，响应返回同一次同步的真实结果与真实 `trigger`（不把 `trigger` 伪写成 `manual`），不产生第二次调用。
- **不做自举期（pre-ready）安装**：同步不由 `bootstrap.*` 帧驱动、不参与 ready 判定；ready 门控的 `resources-installed` 条件随安装器退役（§4.8）。
- **结论可见性**：手动同步的逐条结论在响应里返回；自动同步的结论只记日志。**不写入会话投影**（runtime 投影的所有者不变，控制面不得伪造 runtime 事实）；把自动同步结论持久为任务视图可见事实须先定义控制面自有事件类型，列为开放问题（§9.5）。

### 4.7 语义决议（显式）

1. **判重 = SSH 同款 skip（归档与 mcp 类）**：同一沙箱内同名 skill/plugin/mcp 条目跳过不覆盖（逐条 `skipped`）——沿用既有服务语义，不新增覆盖开关。
2. **单文件类 = 覆盖语义**：commands/subagents 逐条覆盖为 profile 正文、AGENTS.md 整文件覆盖（§4.5）。连接态手动同步后这三类即时反映最新 profile（写路径仍是既有服务，不新增）。
3. **新 Run = 新沙箱空 HOME = 全量安装**：新 Run 的沙箱 HOME 为空，全部 enabled 条目都是"新增"、无 skip 命中；"profile 修改后在旧沙箱手动同步只补新增、改内容需新 Run"对归档与 mcp 类成立。
4. **不做自举期安装、不设 pre-ready 门控**（§4.6）。
5. **Run 不追踪 profile 版本**：`runs.resources_profile_version` 退役（列保留、不写不读，注明废弃，§4.8）；同步永远取最新 profile。原 §1.2"运行中不热更新"改为：**同步只发生在连接期——每次连接自动一次 + 连接态手动任意次**。
6. **偏好快照链不变**：行为偏好走 `bootstrap.config.preferences` → `applied-policy.json` v2 → responder（§6），与资源同步是两条独立通路，互不依赖。
7. **"强制覆盖模式"（归档/mcp 改内容也覆盖）不提供**，列为开放问题（§9.5）。

### 4.8 自举期安装退役清单

| 退役项                                                      | 原落位                                                                                                                                                               | 处置                                                         |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `bootstrap.resources` 帧                                    | shared `cloud/bridge-protocol.ts` + [02 §4](./02-bridge-protocol.md) 帧表行 + [02 §5.3](./02-bridge-protocol.md) ready 条件第 4 条                                   | 帧表行与 ready 条件行删除（不留废弃态）；ready 条件恢复 6 条 |
| 控制面分块下发编排                                          | `app/provisioning/bootstrapResources.ts`、`adapters/ws/{bridgeChannel,handshake}.ts`、attachment registry 的 `resourcesTransferId`/`markBootstrapResourcesSent`      | 删除；`transferId` 概念随之退役                              |
| bundle / 分片与窄公开入口                                   | `domain/userProfileBundle.ts`、`userProfileBundleContract.ts`、`cloud-control-plane` 的 `publicEntrypoints` 项                                                       | 删除                                                         |
| 沙箱自研安装器                                              | `execution/adapters/{resourcesInstaller,resourcesStaging,resourcesHome,resourcesState}.ts`、`execution/app/resourceIntake.ts`、`execution/domain/resourcesBundle.ts` | 删除（幂等改由既有服务判重/覆盖提供，§4.1/§4.7）             |
| ready 门控 `resources-installed`                            | `execution/domain/readyGate.ts`                                                                                                                                      | 删除条件；`preferencesInstalled` 的真实证据驱动**保留**      |
| 相位 `installing-resources`                                 | shared `bridgePhaseFrameSchema` + 执行侧 `BootstrapPhase`                                                                                                            | 移除（不留废弃相位）                                         |
| Run 冻结列 `resources_profile_version`                      | 迁移 `0008` 的 ALTER、`runRepo`                                                                                                                                      | **列保留、不写不读**，注明废弃（迁移不回滚）                 |
| `applied-resources.json` / `resources-install-journal.json` | `resourcesState.ts`                                                                                                                                                  | 随安装器删除                                                 |

**保留不动**：profile store 与上传/查询/开关端点（[03 §6](./03-control-plane.md)）、偏好快照链（§6）、`CLOUD_ATTACHMENT_SERVICE_ALLOWLIST`/denylist、`@zcode/services/archive` 权威解包入口、上传侧最小前置校验（归档类的 canonical base64 / gzip magic / 上限）。退役项的原决议见 §9.2–§9.4（历史存档，不再作为现行设计）。

## 5. 凭据与安全边界

- **MCP token / headers / env 属凭据**：控制面**加密存储**（复用 host 本体 `credentialService` 既有加密实现为首选，[12 §2](./12-account-domain.md) 口径；不做第二套加密），只经 **bridge 认证通道上的控制面 → 沙箱同步调用**下发（§4.2，与 envelope 同一条受信通道；不再是资源帧）。
  - **实施状态（2026-10-17，R4）**：`mcp-config` 正文已用 **`enc:v1:` 信封（AES-256-GCM）** 加密落库，复用 credential cipher provider（`packages/services/src/credential/providers/credentialCipherProvider.ts:5-6,56-114`；写入 `packages/server/src/cloud/app/userProfile/userProfileService.ts:154-163`）。`sha256`/`bytes` 仍按**明文**派生（密文随机 IV 会让同一明文每次密文不同，sha 漂移会破坏幂等与版本稳定；`userProfileService.ts:156-162`、`repositories/userProfileRepo.ts:75-92`）。读回显（`userProfileService.ts:219-220`）与连接期同步（`profileSyncService.ts:86-87,185`）解密后使用；**旧明文行兼容读、无回填迁移**（cipher 对无前缀值原样返回）。密文损坏/密钥不匹配时 decrypt 抛 `CREDENTIAL_DECRYPT_ERROR_CODE`（fail-closed，不回退明文、不伪造正文）。密钥来源 = `ZCODE_CREDENTIAL_SECRET`，缺省用机器派生 fallback（`credentialCipherProvider.ts:24-38`）。
- **不进以下任何面**：provider env / provider 元数据（labels/tags，[01 §6.2](./01-provisioning.md) 既有边界）、普通日志与 `bridge.phase` 诊断、任务投影/历史/回放、控制面 HTTP 响应与任务列表投影、attachment 服务暴露面（`packages/shared/src/cloud/endpoints.ts` 的 `CLOUD_ATTACHMENT_SERVICE_ALLOWLIST` **不新增** mcp/skills 类通道；分面语义见 [02 §0](./02-bridge-protocol.md) 与 [03 §7.1](./03-control-plane.md)）。
  - **P20 修订（2026-10-11，见 §9.4②）**："不进任何 HTTP 响应"收窄为：**HTTP 面唯一的正文出口是条目回显 GET**（`GET …/entries/:category/:entryId`，已鉴权主体按需读单个条目、按类别有界）；快照/版本端点仍只回元数据，其余各面（日志/诊断/投影/历史/attachment）不变。U-10 的断言相应限定为"除条目回显 GET 外的任何响应"。
- **修订 [01 §7.1](./01-provisioning.md)**："MCP / registry / 依赖凭据 | 显式授权的 task manifest | 默认空"行的 v1 结论**保留为历史**；M8 起来源 = 控制面用户资源 profile、按任务显式授权（交付集合 = 最新 profile 的 enabled 子集，§4.7），`purpose/origin` 白名单语义保留（仍由控制面解析、客户端不能诱导秘密外送）。
- **任务级授权**：Task 创建/配置携带资源授权集合（**2026-10-11 冻结：默认全开——新建 Task 引用全部 enabled 条目；条目级 `enabled` 开关逐条关闭，v1 无任务粒度勾选 UI，见 §9.1②**）；未授权的条目不参与同步。授权是条目粒度（可按类别或单条开关）。
- 沙箱内落盘权限沿用 SSH 同步服务：凭据类文件 0o600；控制面不把条目正文写进日志（只记 category/entryId/sha256/bytes）。
- 上传通道本身的鉴权沿用账号域（host `/ws` / 云 HTTP 面既有鉴权，[03 §6](./03-control-plane.md)），不新增未鉴权上传入口。

## 6. 行为偏好快照（07 §8 落地）

[07 §8](./07-connection-architecture.md) 表首行要求"执行节点从已授权 configVersion 快照应答"，当前只有版本号占位（§2）。M8 将其升级为**实值快照**：

- **值来源**：控制面在 Run 创建时从云 host 本体 `settingService` 读取账号设置（[12 §2](./12-account-domain.md)：账号设置权威在 host 本体），取 [07 §8](./07-connection-architecture.md) 表首行清单的实值——源码口径（`packages/services/src/node.ts` 的 `resolveSessionRuntimePreferences`）：`askUserQuestionAutoResolutionEnabled`、`nativeSearchEnhancementsEnabled`、`memoryEnabled`、`modelContextBudgetStrategy`、`integratedTerminalShell`（`user-execution` scope）。**（P18 核实：值类型沿用源码既有 schema，shared 侧不复制枚举——`modelContextBudgetStrategy` = `zcodeModelContextBudgetStrategySchema`（`"legacy" | "preflight-v1"`，`packages/shared/src/zcode-protocol/index.ts`）；`integratedTerminalShell` = `integratedTerminalShellSelectionSchema`（`mode: "auto" | "shell"` 判别联合，`packages/shared/src/validationAppSettings.ts`）；`memoryEnabled`/`askUserQuestionAutoResolutionEnabled`/`nativeSearchEnhancementsEnabled` = boolean。）**
- **下发载体**（**2026-10-11 冻结：扩展 `bootstrap.config`（新增可选 `preferences` 块 = `configVersion` + 实值 `values`），见 §9.1③**）：①扩展 `bootstrap.config`（现有 `policyVersion` 字段升级为携带实值快照的 `configVersion` 语义）；②并入资源帧作为"账号级设置"条目。原选项②随资源帧整体退役（§4.8）不再存在；`bridge.ready.configVersion`（[02 §4](./02-bridge-protocol.md)）继续作为"Run 已应用配置版本"上报。
- **沙箱应答**：沙箱内 responder 从**已应用快照**应答（既有 policy 快照安装器 `provisioningInstaller` 落盘，如 `~/.zcode/run/applied-policy.json` 升级为实值 + 版本；该安装器属自举配置链、**不在 §4.8 退役清单内**），不再读沙箱自身 settingService 的默认值；`desktop-attached-remote` 的 external authority 语义不变（[07 §8](./07-connection-architecture.md)）。
- **生效规则**：控制面设置变更 → 签发新 configVersion → **新 Run 生效**；运行中 Run 保留已应用快照（"Config version 属于 Run 已应用配置，设置存储属于账号"，[07 §8](./07-connection-architecture.md) 原文划分不变）。偏好快照链与资源同步（§4）是两条独立通路：资源在连接期可多次同步，偏好快照只在 Run 自举时应用一次。
- 不得让页面/浏览器承担偏好应答，也不得给 `zcodeAgentService` 的既有 15s timeout 加长来"兜底"（[02 §5.3](./02-bridge-protocol.md)、[07 §8](./07-connection-architecture.md) 既有禁令）。

## 7. 与既有文档的关系（修订点清单）

| 文档与位置                                    | 修订内容                                                                                                                                | 状态                                                                                                                                                                                                                                                            |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [00 §1](./00-overview.md)                     | 追加：用户资源与设置同步列为 M8 独立任务（见 14/W11），不属于首版范围结论的推翻                                                         | 本批已落                                                                                                                                                                                                                                                        |
| [01 §6.1](./01-provisioning.md)               | 模板清单"不带用户设置"处追加 M8 指引；模板结论保留                                                                                      | 本批已落                                                                                                                                                                                                                                                        |
| [01 §7.1](./01-provisioning.md)               | MCP/registry/依赖凭据行追加 M8 指引（来源=用户资源 profile；purpose/origin 白名单保留）                                                 | 本批已落                                                                                                                                                                                                                                                        |
| [02 §4](./02-bridge-protocol.md)              | 帧表新增 `bootstrap.resources` 行（时序、分块、sha256、幂等、fail-closed，正文见 14 §4）                                                | 本批已落 → **2026-10-11 简化定调：帧行删除（本批已落）**，见 §4.8/§9.5                                                                                                                                                                                          |
| [07 §7](./07-connection-architecture.md)      | "skills / plugins / MCP / commands / hooks / subagents"行追加 M8 指引                                                                   | 本批已落 → **2026-10-11 措辞修订为"连接期经控制面调用沙箱既有 sync 服务"（本批已落）**，见 §4/§9.5                                                                                                                                                              |
| [07 §8](./07-connection-architecture.md)      | 表首行 runtime preferences 追加"快照实值化见 14 §6"                                                                                     | 本批已落                                                                                                                                                                                                                                                        |
| [10 §4 / §10](./10-implementation-plan.md)    | PR 表追加 P18–P20；PR→工作单映射追加 P18–P20→W11；§10 追加文档修订记录                                                                  | 本批已落                                                                                                                                                                                                                                                        |
| [13 §3](./13-module-map.md)                   | 工作单清单追加 W11 行（职责 + 目标设计状态）                                                                                            | 本批已落                                                                                                                                                                                                                                                        |
| [W0](./modules/W0-contract-freeze.md)         | 冻结对象增补：资源帧 schema、profile store 端口/契约、偏好快照 schema                                                                   | P18/P19 已落（帧/偏好块/条目与上传 schema/端点常量/store 契约）；**2026-10-11 简化：新增控制面专用 allowlist、commands/subagents 文本负载与分块导入方法形状待 A 批冻结；帧 schema 与相位 `installing-resources` 退役**，见 §4.2–§4.5/§4.8                       |
| [02 §5.3](./02-bridge-protocol.md)            | ready 条件表插入第 4 条（用户资源收齐+安装；空清单帧显式；失败不 ready），原 4–6 顺延为 5–7（代码注释的"第 5 条"引用已同步改"第 6 条"） | **P19b 已落 → 2026-10-11 简化定调：第 4 条删除、条件恢复 6 条（本批已落）**，见 §4.8                                                                                                                                                                            |
| [00 §9](./00-overview.md)                     | 阶段表保持 M0–M7 原文，不追加 M8 行；M8 定位以 00 §1 指引与 W11 §13 批次为准                                                            | 本批明确不改                                                                                                                                                                                                                                                    |
| [03 §6/§7.1](./03-control-plane.md)           | M8 不新增浏览器 attachment 通道；profile 上传/查询 HTTP 端点按 03 §6 矩阵登记（P19a 4 行 + P20 追加的 PATCH/GET 2 行）                  | **P18 已在 shared 冻结端点形状**；**P19a/P20 已登记 6 行**（`PATCH`/`GET …/entries/:category/:entryId`，见 §9.4①）；**2026-10-11 简化追加 1 行：手动同步端点 `POST /api/cloud/tasks/:taskId/user-profile-sync`（连接态前置，本批已落）**；attachment 白名单不变 |
| [W11 §12](./modules/W11-user-profile-sync.md) | P20 落位记录：契约小追加、凭据边界收窄、元数据权威修复、UI 分区与悬项                                                                   | **P20 已落**（见 §9.4）；**2026-10-11 简化改造批次见 [W11 §13](./modules/W11-user-profile-sync.md)**                                                                                                                                                            |
| [10 §10](./10-implementation-plan.md)         | M8 简化定调置顶记录（定调、口径修正、退役清单、新增面、验收）                                                                           | 本批已落（10 §10 置顶记录；决议见 §9.5）→ **2026-10-11 A/B/C 批落位记录已追加**（B 批控制面、C 批沙箱清理 + relay 分面）                                                                                                                                        |

## 8. 验收场景

> 2026-10-11 简化定调后的验收集合：原"自举安装 / ready 门控 / 幂等重装"类场景（旧 U-01–U-12）由下列场景替换；偏好快照（旧 U-07）与凭据边界（旧 U-10）以保留语义并入。

| ID   | 场景                                                                      | 必须断言/证据                                                                                                                                                                                                                                                                                                         |
| ---- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U-01 | 自动同步：上传 profile 各类条目 → 创建任务 → 沙箱连接建立（bridge ready） | 无需任何手动操作，沙箱 HOME 落地最新 profile 全部 enabled 条目（skills/commands/plugins/subagents/mcp/AGENTS.md，落点见 §4.3）；同步结论有结构化日志（含 runId/epoch/profileVersion）；Run 不因同步失败被置为 failed                                                                                                  |
| U-02 | 手动同步（连接态）                                                        | `POST /api/cloud/tasks/:taskId/user-profile-sync` 返回 200 + 逐条 `results`（`synced`/`skipped`/`failed` 定位到 `category/entryId`）；连续两次调用结论一致（无重复副作用）；在飞期间重复调用等待同一次结果                                                                                                            |
| U-03 | 未连接/终态拒绝 + UI 门控                                                 | 未连接（无 ready attachment）调用 → 409 `not_ready`（reason `run-not-connected`）；终态 Run → 409（reason `run-terminal`）；**无头浏览器**断言：未连接态任务视图**不渲染**同步入口、连接态渲染且点击可发起；`stopRequested` 后调用被拒                                                                                |
| U-04 | skip 语义（归档与 mcp 类）                                                | 沙箱内已有同名 skill/plugin/mcp 条目时再同步 → 逐条 `status:"skipped"`，既有文件/配置内容 sha256 不变（不被覆盖）；不重复写 `plugins.dirs`/`enabledPlugins`/`mcp.servers`                                                                                                                                             |
| U-05 | 覆盖语义（单文件类）                                                      | 修改 profile 中 command/subagent/AGENTS.md 正文 → 连接态手动同步 → 沙箱 `~/.zcode/commands/<entryId>`、`~/.zcode/agents/<entryId>`、`~/.zcode/AGENTS.md` 正文更新为最新（整条/整文件覆盖）；AGENTS.md 文件 0600、写入原子；**subagents 落盘正文与条目正文逐字节一致**（不经 serializer 规范化：键序/引号/未知键不变） |
| U-06 | 新 Run 全量安装                                                           | 新 Run 的新沙箱（空 HOME）在连接期同步后包含全部 enabled 条目（无 skip 命中）；`resources_profile_version` 不写入、不读取（列保留废弃）                                                                                                                                                                               |
| U-07 | 分块导入（skills/plugins）                                                | ＞4MiB 归档经 `begin/chunk/complete` 成功落盘且内容 sha256 与上传条目一致；任一 relay 帧 ≤4MiB（双层 base64 后）；块乱序/缺块/重复、`chunkSha256` 或 `archiveSha256` 不符 → fail-closed 拒绝且无半安装；未完成会话超时/断连后被清理                                                                                   |
| U-08 | 超限/损坏归档（skills/plugins）                                           | >20MiB/50MiB、解包膨胀、路径穿越、manifest 非法 → 复用既有校验 fail-closed 拒绝，错误定位到 `category/entryId`；不产生半安装                                                                                                                                                                                          |
| U-09 | 单文件条目超限与 entryId 形状                                             | commands/subagents 文本 >256KiB、entryId 不以 `.md` 结尾或含路径分隔符/`..` → 上传即 400/413 拒绝（fail-closed，不截断）；**`agents-md` 条目 `entryId ≠ user-agents` → PUT 400 `invalid_entry`**（单例约束在 domain 层，不推迟到同步）；控制面不本地写沙箱文件                                                        |
| U-10 | 凭据泄漏检查                                                              | MCP token/headers/env 不出现在：日志（含自动/手动同步日志）、`bridge.phase` 诊断、任务投影/历史/回放、attachment 白名单（`CLOUD_ATTACHMENT_SERVICE_ALLOWLIST` 无 mcp/skills 通道）与除条目回显 GET 外的任何 HTTP 响应                                                                                                 |
| U-11 | 偏好快照（保留链路）                                                      | 修改行为偏好（memory/nativeSearch/askUserQuestionAutoResolution/modelContextBudgetStrategy/integratedTerminalShell）→ 新 Run 的 responder 按快照实值应答（对齐 [02 §11](./02-bridge-protocol.md) B-14、[07 §13](./07-connection-architecture.md) C-10）；不回落页面值或沙箱默认值                                     |
| U-12 | 自动同步失败的恢复                                                        | ready 后同步失败（沙箱不可达/调用失败）→ 不 fail run、只记日志；重连再次 ready 触发自动同步成功；或连接态手动同步恢复                                                                                                                                                                                                 |
| U-13 | 自举期无安装（退役断言）                                                  | `bootstrap.resources` 帧不再下发（帧表与 shared schema 无该类型）；ready 条件不含 `resources-installed`（恢复 6 条）；ready 之前不发起任何同步服务调用（relay 帧 pre-ready 被沙箱 fail-closed 丢弃的既有语义不变）                                                                                                    |

## 9. 开放问题（2026-10-11 已全部冻结；原文保留可追溯）

> 状态：本节的四项开放问题已由用户于 **2026-10-11** 冻结（P18 / W0 扩展，决议见 §9.1）；以下 1–4 条为冻结前的原始记录，保留可追溯。§3.2/§4/§6 中形如"由 W11 冻结"的就地指引，凡是 §9.1 已列出者以 §9.1 为准（本次未决议项在 §9.1 尾部单列）。
>
> **2026-10-11 简化定调（用户最终口径）**：§9.1–§9.4 中与安装通路相关的设计（`bootstrap.resources` 帧、分块下发编排、沙箱自研安装器、ready 条件 `resources-installed`、Run 冻结列）**整体退役**，现行设计见 §4（决议记录见 §9.5）；偏好快照链（§9.1③）与 store/上传端点（§9.2①/§9.4）保留。§9.4 的 UI 描述中"归档上传 4 类"与"agents-md 单例"两条已被简化改造触及（commands/subagents 改单文件文本编辑，D 批实施），其余 UI 结论不变。

1. **hooks 是否纳入 profile**：hooks 是执行面入口（可执行任意命令），安全模型与内容类资源不同。建议 M8 不纳入；若纳入，必须先定义"云沙箱内 hooks 的信任边界与静态检查"并单列安全评审，不与内容类资源同一波次。
2. **任务级授权默认值**：①**默认全开**（新建 Task 默认引用全部 profile 条目、可逐条关闭）；②默认全关（逐任务显式勾选）。**建议 ①**：部署模型为可信单用户（[00 §11⑤](./00-overview.md)），profile 是用户自己的资源，"自动获得最新版本"是 M8 的目标语义；默认全关会与目标冲突（每次建任务都要勾选）。若未来部署模型变更，默认全关作为条件性基线。凭据类条目在 UI 上明确标注，降低误用。
3. **偏好快照的帧归属**：①扩展 `bootstrap.config`；②并入 `bootstrap.resources`。**建议 ①**：偏好是小体量标量集合，无需分块；`bootstrap.config` 已承载 `policyVersion`（现由部署常量 `cloud-policy-1` 提供），把它升级为携带实值快照的 `configVersion` 语义改动最小，且 `bridge.ready.configVersion` 上报链路无需新增；`bootstrap.resources` 保持"只承载用户资源归档"的单义。由 W11 冻结并说明理由。
4. **profile 总量上限数值**：单条目上限已由 SSH 同款给出（skills 20MiB / plugins 50MiB），但 profile 总量（全部条目之和）与单账号条目数上限尚无数值。建议总量上限按"单次传输时长 + 沙箱磁盘（01 §6.1 目标 10GiB）"反推，W11 冻结具体值并写入严格 schema（超限上传即拒绝，不截断）。

### 9.1 冻结决议（2026-10-11）

四项决议如下（措辞即最终语义）：

1. **hooks 不纳入 M8**（用户 2026-10-11 确认）。补充调查事实：SSH 模式 hooks 同样本机零推送——不存在远端 hooks 推送通路（无对应 sync service/对话框），仅"远端 scope 直读远端文件 + 信任按机器独立授予"，故不构成"SSH 有通路、云缺失"的先例。云侧既不进自动安装集合，也不进 profile 类别枚举；将来纳入须按原文要求单列安全评审（云沙箱内 hooks 信任边界与静态检查）。
2. **任务级授权默认全开**：新建 Task 默认引用全部 enabled 条目；条目级 `enabled` 开关承担"逐条关闭"，**v1 不做任务粒度勾选 UI**。原文"默认全关作为条件性基线"仅在部署模型变更（多账号/共享）时启用；凭据类条目在 UI 明确标注不变。
3. **偏好快照帧归属 = 扩展 `bootstrap.config`**：新增可选 `preferences` 块（`configVersion` + 实值 `values`，见 §6 值清单）；`bridge.ready.configVersion` 继续作为"Run 已应用配置版本"上报；`bootstrap.resources` 保持"只承载用户资源归档"的单义（不改作账号级设置载体）。理由同原文建议①：偏好多为小体量标量、无需分块，`bootstrap.config` 已有版本位、改动最小，ready 上报链路无需新增。**（2026-10-11 简化修订：本决议的偏好半边——`bootstrap.config.preferences`——不变、保留生效；后半句的 `bootstrap.resources` 帧整体退役（§4.8），"单义载体"的约束随之失效，见 §9.5。）**
4. **数值冻结**（全部写入严格 schema；超限上传即拒绝，不截断）：

   | 项                                | 冻结值                                                              |
   | --------------------------------- | ------------------------------------------------------------------- |
   | 单条目上限（tar+gzip 归档后字节） | skills 20MiB / plugins 50MiB（**commands/subagents 行见下方修订**） |
   | MCP 单条                          | ≤256KiB（`config` JSON）                                            |
   | agents-md 单条                    | ≤256KiB（UTF-8 文本）                                               |
   | profile 总量                      | ≤128MiB（全部条目 `bytes` 之和）                                    |
   | profile 条目数                    | ≤256                                                                |
   | 版本保留                          | 最近 8 个快照版本；条目按 sha256 去重存储，修剪无引用旧条目         |
   | 帧分块 payload                    | ≤512KiB（资源帧退役；连接期分块导入的块大小见 §4.4，≤2MiB）         |
   | 上传 HTTP 请求体上限              | 80MiB                                                               |

   条目 `bytes` 口径：归档类 = 归档字节数；mcp = `config` JSON 字符数（对齐 `CLOUD_PROJECTION_PAYLOAD_MAX_JSON_CHARS` 的 JSON 口径）；agents-md = UTF-8 字节数。

   **2026-10-11 简化修订（就地标注）**：commands/subagents 由"归档 20MiB"改为**单文件 markdown 文本 ≤256KiB/条**（条目形态变更，§4.5）；其余数值（skills/plugins 归档上限、mcp、agents-md、总量 128MiB、条目数 256、版本保留 8、上传体 80MiB）不变。详见 §9.5。

同批追加冻结（非 §9 四问，但同属 W0 扩展的端点与错误码形状，2026-10-11）：

- `PUT /api/cloud/user-profile/entries/:category/:entryId`：请求体 = 条目负载（按 `category` 判别）+ 可选 `displayName` + 可选 `enabled`；响应 `{entry, profileVersion}`。PUT 是本端点矩阵首个 PUT，语义 = 幂等整条替换（同 key 重复提交产生同一 `profileVersion` 结果，不递增两次）。
- **P20 追加（2026-10-11，见 §9.4①）**：`PATCH /api/cloud/user-profile/entries/:category/:entryId`（请求体 `{enabled}`，响应 `{entry, profileVersion}`；toggle 递增版本）与 `GET /api/cloud/user-profile/entries/:category/:entryId`（响应 `{entry, payload}`；HTTP 面唯一正文出口）。
- `DELETE /api/cloud/user-profile/entries/:category/:entryId`：响应 `{profileVersion}`。
- `GET /api/cloud/user-profile`：响应 = profile 快照摘要（条目元数据 + `profileVersion` + `totalBytes` + `createdAtMs`），**不含归档正文**。
- `GET /api/cloud/user-profile/version`：响应 `{profileVersion}`。
- **2026-10-11 简化追加**：`POST /api/cloud/tasks/:taskId/user-profile-sync`（手动同步一次最新 profile；**连接态且非终态前置**，未连接/终态 409 `not_ready`；响应 `{runId, profileVersion, trigger:"manual", results[]}`）——见 §4.6 与 [03 §6](./03-control-plane.md)。
- 新增归一错误码（[errors.ts](../../packages/shared/src/cloud/errors.ts) 目录 + 03 §6 错误信封）：`payload_too_large`（413）、`invalid_entry`（400）、`profile_total_exceeded`（409）、`profile_entries_exceeded`（409）；错误信息必须定位到 `category`/`entryId`（U-11 口径）。
- 契约落档：`packages/shared/src/cloud/user-profile.ts`（schema 单一来源）、`bridge-protocol.ts` 的 `bootstrap.resources` 帧与 `bootstrap.config.preferences` 块、`endpoints.ts` 的路径常量（`CLOUD_HTTP_ENDPOINTS` 矩阵行与 SDK 索引随 P19 实现成对登记：矩阵写端点必须同时在 SDK 索引，`packages/client/test/cloudSdk.test.ts` 既有不变量）、`CONTRACT.md`。文档修订记录见 [10 §10](./10-implementation-plan.md)。

**未随本批冻结（仍在 W11 实施期冻结，义务不变）**：§4.1 `transferId` 同版本重连重传的复用/重开规则；§4.2 `~/.agents/*` 兼容读取面是否镜像安装；§3.1/§3.2 store 物理落位（cloud.db vs 受控附件存储）与归档校验代码落位（services 公开入口 vs 提为 shared；约束：禁止复制第二份校验代码）；§5 任务级授权集合在 Task 记录中的持久形状（默认值语义已在决议 2 冻结）。

### 9.2 P19a 落位决议（控制面；2026-10-11）

P19a 落地 §9.1 遗留的**控制面侧**五项：store 物理落位、归档校验代码落位（上传侧部分）、`transferId` 规则、控制面↔执行节点的传输 bundle 格式、偏好快照组装与 Run 冻结列。措辞即最终语义；执行节点（安装器、ready 条件、`~/.agents/*` 镜像）留在 P19b。

1. **store 物理落位 = cloud.db（SQLite）两表**（§3.1/§3.2 的 cloud.db 分支定案）：
   - `profile_entries`：`(category, entry_id, sha256)` 内容寻址行——列集 = `category`/`entry_id`/`display_name?(NULL)`/`enabled(默认 1)`/`sha256`/`bytes`/`content_kind`/`content`（文本）/`updated_at`；**物理主键 `(category, entry_id, sha256)`**。冻结文本中的 "PRIMARY KEY(category, entry_id)" 语义 = **同一 `(category, entry_id)` 的当前内容唯一**（由最高 `profileVersion` 的 manifest 指定）；物理上允许旧 sha 行共存，否则"保留最近 8 个版本可解析"（§3.2）在条目被替换后立即失效、在途 Run 断连重装会假失败。`sha256`/`bytes` 由控制面从入库内容派生（客户端不传）：归档类 = **解码后归档字节**的 sha256/字节数；mcp = `JSON.stringify(config)` 文本的 UTF-8 字节的 sha256、`bytes` 取 JSON 字符数（§9.1④ 口径）；agents-md = 正文 UTF-8 字节。`content` 三类统一文本存储：`archive-base64`（canonical base64）/`mcp-config`（JSON 文本）/`agents-md`（正文）。
   - `profile_versions`：`(profile_version INTEGER PRIMARY KEY, manifest_json, created_at)`；manifest = 该版本的**全量条目元数据数组**（含 disabled 条目，不含正文），写入事务内递增。
   - 保留最近 **8** 个版本快照（`CLOUD_USER_PROFILE_RETAINED_VERSIONS`）；每写事务后修剪：删除超出窗口的 manifest 行，再删除**不再被任何保留 manifest 引用**的 `profile_entries` 行（按 `(category, entry_id, sha256)` 引用计数）。
   - **mcp 正文加密（2026-10-17 实施回写，R4）**：`content` 列中 `mcp-config` 实际保存 `enc:v1:` 信封（AES-256-GCM，复用 credential cipher），不再保存 JSON 明文；因此 store 无法从密文派生明文事实，mcp 的 `sha256`/`bytes` 由写入方按**明文**计算后随 `contentFacts` 传入（仅 mcp 允许），其余类别仍由 store 从正文派生。旧明文行兼容读（decrypt 对无前缀值原样返回），**无回填迁移**；读回显/同步前解密，密文损坏 fail-closed。
   - PUT 语义 = 幂等整条替换：同 `(category, entry_id)` 且派生 `sha256` 不变时**不递增版本**、返回当前版本（同 key 重复提交同结果）；内容变化或新键才递增。DELETE 删除该键当前行并递增版本；键不存在时整条幂等无操作（版本不变）。
   - 上限校验在写事务内以**真实聚合值**判定（客户端不可自报）：超类别单条上限 → `payload_too_large`（HTTP 413）；正文形状/类别不一致/非法 → `invalid_entry`（400）；`bytes` 总量超 128MiB → `profile_total_exceeded`（409）；条目数超 256 → `profile_entries_exceeded`（409）。错误信息必须定位到 `category`/`entryId`（U-11）。
2. **归档校验代码落位（§9.1 遗留项收口为两段）**：**安装器侧权威**——完整 tar 安全解包、解包膨胀上限、manifest 与路径穿越校验继续沿 14 §4.2"安装器校验与 SSH 导入同款"在 P19b 落位（复用 SSH 既有实现，禁复制第二份）；**上传侧最小前置**——只做三件便宜且 fail-closed 的准入校验：canonical base64（shared schema）、gzip magic（解码前 3 字节比对 `0x1f 0x8b`）、按类别解码字节上限（shared schema 的 4/3 精确算术）。上传侧不做 tar 解析（80MiB 归档在 HTTP 请求路径上解包会拖垮事件循环，且真值校验本就在安装器）。
3. **传输 bundle（控制面 ↔ 执行节点，同包内部）**：bundle = 单份 UTF-8 JSON 文本 `{schemaVersion: 1, profileVersion, entries: [{category, entryId, displayName?, enabled, sha256, bytes, payload}]}`（`payload` 复用 `user-profile.ts` 的条目负载 schema：mcp = JSON 对象、归档 = base64 字符串、agents-md = 文本）。序列化**ASCII 安全**（非 ASCII 字符按 `\uXXXX` 转义）：使"按字符切块"与"按字节切块"同一、且 `HashPort.sha256Hex` 的字符串摘要等于字节摘要。`archiveSha256` = **bundle JSON 字节**的 sha256（内容寻址）；帧 `payload` = bundle 字节按 ≤512KiB（`CLOUD_USER_PROFILE_CHUNK_PAYLOAD_MAX_BYTES`）切片后各自 base64；`chunkSha256` = 该切片字节的 sha256；条目顺序 = `(CLOUD_USER_PROFILE_CATEGORIES 次序, entryId)` 字典序（同一冻结版本可重复组装出同一 `archiveSha256`，重传幂等可核对）。bundle schema 定义放 **server 侧 `domain/`**（控制面与执行节点同包，不进 shared）；只下发 `enabled=true` 条目，帧内 `entries` 清单同为 enabled 子集。
4. **Run 冻结与下发编排**：`runs` 新列 `resources_profile_version INTEGER NULL`（追加迁移 `0008`）；**新 Run 在预约事务内**读 `profile_versions` 当前最大版本写入（同一事务，无 TOCTOU）；`NULL` = 历史 Run 或尚无版本，按**空 profile** 处理（下发显式空清单帧，`profileVersion` 取 1）。下发时序（14 §4.1）：`bootstrap.config` 发送成功后、`bridge.ready` 之前经既有 bridge 通道连续发送 `bootstrap.resources` 全部分块（`chunkIndex` 升序，任一帧发送失败整体 fail-closed：`warn` + 结构化失败，等下次连接重装）；`stopRequested` 屏障与 run 终态检查与 `bootstrap.config` 同款；同一 run/epoch 重复调用幂等（重发不改变状态、不推进 ready）。空 profile（无 enabled 条目或冻结版本为 NULL）**仍显式发送 `chunkCount=0` 的清单帧**（U-12）。冻结版本在 store 中解析不到（版本被修剪或条目已被替换）→ 下发失败（**复用 `invalid_ref`** + reason `profile-version-pruned`，不新增 wire 错误码——错误码目录是 shared 冻结面，P18 只冻结了四个上传类码）。
5. **`transferId` 规则（§4.1 遗留项定案）**：同一 run 内**同一 `profileVersion` 复用同一 `transferId`**（重连重传时执行节点可据此识别"同一次传输的续传"）；冻结版本变化（新 run 或未来版本迁移）**必新开** transferId。状态在控制面 attachment 注册表（连接态事实、可重建），不持久化。
6. **偏好快照组装（§6 实值化的控制面半边）**：`bootstrap.config` 发送时从 host 本体 `settingService` 读五键实值（`askUserQuestionAutoResolutionEnabled`/`nativeSearchEnhancementsEnabled`/`memoryEnabled`/`modelContextBudgetStrategy`/`integratedTerminalShell`，`user-execution` scope 口径），只收进 shared schema 支持的键，读不到的键省略；`configVersion` **内容寻址** = `"prefs-" + sha256(JSON.stringify(values)).slice(0,16)`（同值同 hash，稳定可核对）；`values` 为空对象时**省略整个 `preferences` 块**（兼容旧版 `bootstrap.config` 语义）。偏好读取经 `CloudCoreDeps` 的可选 port 注入，未接线时不带 `preferences` 块、**不 fail**（偏好缺失不是 run 失败条件；沙箱侧应答升级与 ready 断言在 P19b）。
7. **端点登记（P18 悬项成对落地）**：`CLOUD_HTTP_ENDPOINTS` 矩阵新增 4 行（snapshot/version = GET；entry = PUT + DELETE，路径取自 `CLOUD_USER_PROFILE_ENDPOINT_PATHS`），`CLOUD_SDK_ENDPOINT_SCHEMAS` 与 `createCloudControlPlaneClient` 同步登记 4 个方法（`listUserProfile`/`getUserProfileVersion`/`putUserProfileEntry`/`deleteUserProfileEntry`），既有"矩阵写端点必须同时在 SDK 索引"不变量不变；03 §6 正文补 4 行。落位调整（P19a 为满足 `endpoints.ts` 文件行数门禁）：端点行表落 `user-profile-endpoints`（`userProfileEndpoints.ts`），路径常量 `CLOUD_USER_PROFILE_ENDPOINT_PATHS` 随行表落到 `user-profile.ts`（P18 冻结时在 `endpoints.ts`；**导出名与 `@zcode/shared` 公共入口不变**，矩阵仍由 `CLOUD_HTTP_ENDPOINTS` 单点持有）。PUT 的路径参数与请求体都携带 `category`，服务端核验一致（不一致 `invalid_entry`）；`bodyLimit` = 80MiB（`CLOUD_PROFILE_UPLOAD_BODY_MAX_BYTES`，hono body-limit，超限 413 `payload_too_large`）。
8. **单主体部署口径**：profile 属主 = 部署主体（00 §11⑤ 单用户），store 不新增 owner 列；鉴权沿用云 HTTP 面既有 lite-token 中间件（03 §3/§6），不新增未鉴权上传入口。MCP 条目的正文是凭据载体：只经 bridge 认证通道下发，**不进**日志、`bridge.phase` 诊断、任务投影与任何 HTTP 响应（14 §5；snapshot 只有元数据）。

状态所有者与事件顺序（P19a 落位后的唯一写路径；AGENTS：状态/时序改动须给所有者与顺序）：

```text
上传（所有者 = 控制面 profile store；唯一写路径）
  W8 设置页 → PUT /api/cloud/user-profile/entries/:category/:entryId
    → app 准入（严格 schema / 路径↔正文 category 一致 / 单条超限 413 / 归档 gzip magic）
    → 写事务：派生 sha256+bytes → 幂等判定（同 key 同内容不递增）→ 限量判定
              → 条目行 upsert（内容寻址 (category, entry_id, sha256)）
              → profile_versions 递增 + 修剪（保留 8 版本，按 sha256 引用计数删无引用行）
    → 响应 {entry, profileVersion}（元数据，无正文）

Run 冻结与下发（版本冻结一次 / 每连接下发一次）
  接纳事务（runs 预约）: 读 profile_versions 当前版本 → runs.resources_profile_version（同事务，无 TOCTOU）
  bridge 连接:    hello → welcome → bootstrap.config（含 preferences 快照）
                  → bootstrap.resources（chunkIndex 0..N-1，同一 transferId）→ bridge.ready（configVersion 回执）
  发送失败/断连:  不重做 ready、不静默空安装；标记后等下次连接按**同一冻结版本**重放
                  （同版本复用 transferId，帧逐字节可核对：archiveSha256 = bundle 内容寻址）
```

**仍未决（P19b）**：安装器（tar 安全解包/膨胀/穿越/manifest 权威校验、`~/.zcode` 布局与注册合并写、`applied-resources.json` 幂等）；ready 条件 `resources-installed` 与 `bootstrap.ts` 去硬编码占位；`~/.agents/*` 兼容读取面是否镜像；沙箱 responder 从已应用快照应答（§6 沙箱半边）。——**以上四项已由 P19b 收口，见 §9.3**。

### 9.3 P19b 落位决议（执行节点；2026-10-11）

P19b 落地 §9.2 尾部遗留的**执行节点（沙箱）侧**全部内容：`bootstrap.resources` 入站重组、资源安装器与布局、ready 条件 `resources-installed`、偏好快照实值应答；并把 §4.2 尾部"`~/.agents/*` 是否镜像"这一 W11 实施期悬项一并冻结。措辞即最终语义；只动 `packages/server/src/cloud/execution/**`、packages/services（解包帮助函数与 responder）、packages/shared（相位枚举与 env 常量）与 spec，**不动控制面 `cloud/` 其余面与 UI**。

1. **入站接收与重组**（`execution/domain/resourcesBundle.ts` 纯状态机 + `execution/app/resourceIntake.ts` 结论所有者）：
   - 按 `transferId` 建重组缓冲：`transferId` 变化=控制面新开一次传输（版本变化必新开，§9.2⑤）即整批重置；同一 transferId 下 `profileVersion`/`chunkCount`/条目清单必须逐帧一致（清单按 `(category, entryId)` 身份比对，不按位置）；
   - `chunkIndex` 必须严格从 0 递增（缺块/乱序/重复一律拒绝）；逐块 `chunkSha256` = 解码后该块字节摘要；收齐后拼接字节摘要必须等于 `archiveSha256`，累计字节有界（≤分块数上界×单块上界）；
   - bundle JSON 过**控制面同一严格 schema**：经窄入口 `packages/server/src/cloud/userProfileBundleContract.ts` 复用（不复制 schema）；**不走 `contract.ts` barrel**——barrel 会把控制面装配/HTTP/SQLite/GitHub 适配整体拉进沙箱 supervisor 的 esbuild 单文件产物（2026-10-11 实测 +2.0MB，而该资产每次沙箱创建都要取），窄入口只 re-export `domain/userProfileBundle` 与其解析入口，增量 ≈0。为此 `cloud-control-plane` 的 `publicEntrypoints` 增加该窄入口（policy + `module.ts` 同步，`cloudContract.test.ts` 断言更新）；
   - **安装前内容寻址复核**：按 §9.1④ 口径从 payload 复算每条 `sha256`/`bytes`（归档=解码字节；mcp=`JSON.stringify(config)` 文本；agents-md=UTF-8 字节），与条目元数据不符即拒绝（U-11 错误定位到 `category/entryId`）；
   - 结论语义：`complete` → 安装；`chunkCount=0` 空清单帧 → 直接成功（无需安装，显式确认空 profile）；同传输重复帧 → 幂等忽略（不触发第二次安装）；**任何校验失败 → `bootstrap_failed`（retryable）**、未收齐/超时/断连 → `not_ready`——两者都不 ready、不半安装，按 §4.1 等下次连接重装。
2. **安装布局冻结为只装 `~/.zcode` 主面，不镜像 `~/.agents/*`**（§4.2 尾部悬项收口）：`.agents/*` 是 SSH 同步枚举时的兼容读取面，云侧镜像会制造第二条写路径与"同一内容两份权威"，且用户 profile 语义上属 `~/.zcode`（§4.2 表）。
3. **两阶段提交**（`execution/adapters/resourcesStaging.ts` + `resourcesInstaller.ts`）：先把每个归档条目解包到目标根下的 `.install-tmp-<uuid>`（安全解包见第 4 点），完成全部冲突预检后，才把条目内的**顶层目录/文件** rename 进目标根；**同名冲突=安装失败 fail-closed，不覆盖**；提交失败回收暂存目录（不在技能/插件扫描面留下 `.install-tmp-*`）。
4. **权威解包校验落位 = services 新增通用入口**（§9.2② 收官）：`packages/services/src/archive/safeArchiveExtract.ts`，经 `@zcode/services/archive` 公开；语义 = gzip magic（`1f 8b`）前置校验、流式解包、成员路径穿越/绝对路径/盘符/反斜杠拒绝、symlink/hardlink/未知成员类型一律拒绝、成员数与单成员与解包总量三重上限（**膨胀上限 = 类别上限 ×4**，本批冻结值）、可选按归档头恢复文件模式（plugins 可执行位，SSH 同款）。安装器唯一使用，**不复制第二份校验**。SSH skill/plugin sync 的两个既有 extract 本批**不收敛**到该入口（各自携带 UI 消费的结构化错误码 `SkillSyncSizeLimitError.data.phase` 与 plugin 元数据/模式语义），三处收敛列为悬项；禁止第二份权威校验的约束在该收敛前继续有效。
5. **幂等、重装与清理（`applied-resources.json`）**：文件 `stateDir/applied-resources.json` = `{version:1, profileVersion, appliedAt, products[]}`，其中 `products` 是本次安装的产物清单（`{kind:"path"}` 目录/文件 + `{kind:"cli-config"}` 的 config 键：`plugins.dirs` 值 / `plugins.enabledPlugins` 键 / `mcp.servers` 键），即 14 §4.1/§9.3 语义中"按 applied 记录的条目清单删除安装产物"的唯一依据。
   - **同 `profileVersion` 重复下发**：直接成功返回（不重装、不重写 config 键、不重复解包）；
   - **版本不同 → 全量重装**：先按 `products` 清理上一版（目录直接删、config 键按记录移除，其余键保留；删不掉只 `warn` 不失败），再全量安装；
   - **中断可修复（U-09）**：提交前先写 `stateDir/resources-install-journal.json`（同形 `products` 清单），成功后删除；下次安装开头若发现 journal，先按其记录清理自己的半成品再继续——只有"自己记录过的产物"会被删除，因此既能修复中断残留，又绝不误删用户/模板自带内容；**安装成功才写状态文件**（中断 = 无状态文件，下次全量重装）。
   - `config.json` 的读取-合并-写回是**安装器单写者内串行**（同一队列），保留其余键、0600 原子写（临时文件 + rename）；历史文件损坏时 fail-closed（不把损坏文件当空对象覆盖）。
6. **plugins 注册与 manifest**：安装后合并写 `plugins.dirs`（追加绝对路径、按 resolve 后路径幂等去重）与 `enabledPlugins`（键 = 插件 manifest 的 `name` + `@inline`，值 = 条目 `enabled`，SSH 同款派生口径）；每个插件目录**必须带 manifest**（`.zcode-plugin`/`.claude-plugin`/`.codex-plugin` 下的 `plugin.json`，探测顺序同 SSH），缺失即 fail-closed；SSH 插件归档格式自带的顶层元数据文件 `.zcode-plugin-sync.json` 不是插件目录，安装时跳过。**marketplace-source 镜像本批不做**（列入悬项）：profile 只下发 inline 插件目录，`~/.zcode/plugins/marketplace-sources/…` 的镜像与 marketplace 注册留待后续批次。
7. **偏好快照实值链路（§6 沙箱半边）**：
   - `applied-policy.json` 升级 v2：`{version:2, policyVersion, configVersion, preferences:{五键}}`（有 `bootstrap.config.preferences` 时写实值块；无块维持 v1 `{version:1, policyVersion}`，**v1 兼容读**，`applied()` 返回 `policyVersion` 作已应用版本）；
   - supervisor 装配把该文件路径经 `ZCODE_APPLIED_POLICY_SNAPSHOT`（shared 常量，同进 sanitize/passthrough 两张剔除表——只是宿主内部交接的路径，不回传给 agent/Bash/MCP）注入沙箱 runtime；
   - services 侧（`packages/services/src/runtimePreferencesSnapshot.ts`，`resolveSessionRuntimePreferences` 在 authority = `cloud-execution-node` 时）优先读该快照取五键实值应答；`integratedTerminalShell` 仅 `user-execution` scope 消费（既有口径）；env 未注入/文件缺失/JSON 损坏/版本不是 v2/无 `preferences` 块/值形状非法 → **回落沙箱本地设置默认值**，只记一条 `warn`（诊断带原因 + 路径，不带值正文），**不抛、不崩、不 fail 建会话**；
   - `bridge.ready.configVersion`（02 §4）在有偏好块时上报**快照 configVersion**，否则维持 `policyVersion`（§9.2⑥ 的签发口径经此闭环）；重连沿用同一已应用版本。
8. **ready 门控与相位**：
   - `domain/readyGate.ts` 的 `READY_CONDITIONS`/`ReadyChecklist` 增加 **`resources-installed`**，由**本次连接的真实安装结论**驱动（空清单帧=显式满足）；`app/bootstrap.ts` 的 `preferencesInstalled` 从硬编码 `true` 改为由 policy 安装器的落盘结果驱动（§4.1"凡必须有真实证据的条件不得写死 true"）；
   - 相位枚举增加 `installing-resources`（`installing-config` 之后、`exporter-starting` 之前）：落在 shared 冻结帧 `bridgePhaseFrameSchema`（最小扩展），`BootstrapPhase` 类型改为直接引用该帧类型 + 编译期穷尽断言（增删相位立刻编译失败，不留第二份枚举）；
   - 未安装资源（缺帧、校验失败、安装失败）**一律不 ready**：`bootstrap.resources` 缺帧时按 `not_ready` fault 上报并重连，空清单帧正常 ready（U-12 两侧闭合）。
9. **顺带修复的既有缺陷（P19b 接线时发现）**：`app/bridgeSession.ts` 在 `bootstrap.config` 超时未到时仍会发 `bridge.ready`（`configVersion="unknown"`）——该分支会让**全部自举条件**（含新增的 `resources-installed`）被整体绕过，等于假 ready。现改为：自举未完成即关闭连接、按既有重连路径等下次连接（02 §5.3"条件逐条满足才 ready"）。
10. **shared 最小扩展**（三项，均由 P19b 的复用/同步约束推导）：`bridgePhaseFrameSchema` 相位枚举加 `installing-resources`；新增 `ZCODE_APPLIED_POLICY_SNAPSHOT` env 常量（含两张剔除表登记）；`integratedTerminalShellSelectionSchema` 公开再导出（否则 services 校验快照只能复制 `mode` 枚举，违反唯一来源）。

执行侧状态所有者与事件顺序（P19b 落位后的唯一写路径；AGENTS：状态/时序改动须给所有者与顺序）：

```text
每连接（所有者 = bridge session）：begin(资源 intake 重置)
  hello → welcome → bootstrap.config（含 preferences 快照）
    → bootstrap.resources(chunkIndex 0..N-1，同一 transferId)
        → resourcesBundle 重组校验（transferId/顺序/逐块 sha/整包 sha/bundle schema/条目寻址）
        → intake 触发 install（同传输只装一次）→ resourcesInstaller（HOME 唯一写入方）
             冲突预检 → journal → rename/AGENTS.md → config.json 合并写（单写者串行）
             → applied-resources.json（成功证据）→ 删 journal
    → bootstrap 读 intake 结论 → 相位 installing-resources → ready 清单逐条评估
    → bridge.ready（configVersion = 偏好快照 configVersion）
失败/断连：不 ready、不半安装（提交前失败回收暂存；提交后失败留 journal 由下次安装自清理）
   → bootstrap_failed(retryable) → 断连 → 下次连接按**同一冻结版本**重放（transferId 复用、帧逐字节相同）
```

验收映射（14 §8）：U-01–U-06 落盘布局与内容 → 安装器用例；U-07 偏好按快照应答 → services 快照用例 + bootstrap `configVersion` 用例；U-09 重连/中断幂等 → intake/installer/session e2e；U-11 恶意归档拒绝 → `@zcode/services/archive` + 安装器用例；U-12 空清单与缺帧 → reassembly/ready/session e2e 用例；U-10 凭据边界 → 安装器"日志不含正文"用例（attachment 白名单侧不变）。

**仍未决（P20 及后续）**：W8 设置页 UI（上传/编辑/授权开关）；marketplace-source 镜像与 marketplace 注册；三处 tar 解包实现收敛为 `@zcode/services/archive` 单一实现；真实沙箱（E2B/真实 runtime + 真实控制面）端到端联调与故障注入（安装中途 kill、超大归档、真实 HOME 权限）。——**本行前两项中的 W8 设置页 UI 已由 P20 收口，见 §9.4**。

### 9.4 P20 落位决议（契约小追加 + W8 设置页 UI；2026-10-11）

P20 落三件事：①**两个契约小追加**（条目级开关 `PATCH`、条目正文回显 `GET`），先冻结再实现；②W8 云设置页的「用户资源」分区（上传/表单/文本编辑/开关/删除 + 版本与上限展示）；③实现期发现的**元数据权威缺陷**修复（见第 3 点，属 §9.2① 的落地修正，不是新语义）。措辞即最终语义；本批动 `packages/ui`、`packages/shared`（契约追加）、`packages/server`（两 handler + store 两方法）、`packages/client`（SDK 两方法）与 spec，**不动 `cloud/execution/**`\*\*。

1. **契约追加（14 §9.4 本批冻结；此前 §9.1/§9.2 未覆盖）**：

   | 端点                                                       | 请求体                                 | 响应                                     | 语义要点                                                                                                                                                                                                |
   | ---------------------------------------------------------- | -------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `PATCH /api/cloud/user-profile/entries/:category/:entryId` | `{enabled: boolean}`（strict，仅此键） | `{entry, profileVersion}`（与 PUT 同形） | 条目级开关 = §9.1②「默认全开 + 逐条关闭」的落地通路；**没有 `.default(true)`**——漏传 enabled 是 400 `invalid_entry`，把"漏传"当"关闭"会静默改变交付集合；键不存在 → 404 `not_found`（不制造空版本噪声） |
   | `GET /api/cloud/user-profile/entries/:category/:entryId`   | —                                      | `{entry, payload}`（负载按类别判别）     | 条目正文回显：AGENTS.md 文本编辑器与 MCP 表单编辑的**唯一**通路；键不存在 → 404 `not_found`；正文形状/类别不符 → 400 `invalid_entry`；响应按类别天然有界（≤256KiB JSON/文本、≤20/50MiB 归档）           |
   - **toggle 也递增 `profileVersion`**（本批核心语义）：交付集合（manifest 的 enabled 子集）**属于版本**——Run 冻结的是"某个版本的交付集合"，不递增会让"运行中 Run 不变、新 Run 生效"（§1.2/§8 U-08）失去锚点。**但只在开关值真正变化时递增**：请求值等于当前值按"重复提交同结果"返回当前版本（与 PUT 同 key 同内容不递增同型，§9.2①）。
   - **行数门禁的两处拆分**（同 §9.2⑦ 的既有做法，导出名与公共入口不变）：`userProfileRepo.ts` 的内部共享件（派生/manifest 解析/版本行/修剪）落到 `adapters/storage/repositories/userProfileRepoHelpers.ts`；server 测试的 profile fake 落到 `test/cloudCoreUserProfileFakes.ts`（由 `cloudCoreFakes.ts` 统一转出，测试 import 面不变）。
   - 端点登记成对：`CLOUD_HTTP_ENDPOINTS` +2 行（`readUserProfileEntry`/`patchUserProfileEntryEnabled`，行数据在 `userProfileEndpoints.ts`）、`CLOUD_SDK_ENDPOINT_SCHEMAS` +2 条、SDK 方法 `getUserProfileEntry`/`setUserProfileEntryEnabled`；03 §6 正文 +2 行。既有"矩阵写端点必须同时在 SDK 索引"不变量不变。
   - **错误码复用**：条目不存在用既有 `not_found`(404)（不新增 wire 错误码——错误码目录是 shared 冻结面，§9.2④ 同款约束）；PATCH 的 body 形状错误用既有 `invalid_entry`(400)。拒绝原因带 `category`/`entryId`（U-11 口径）。

2. **凭据边界的显式修订（对 §5 与 §9.2⑧ 的落地澄清）**：§5/§9.2⑧ 原文写"mcp 正文…**不进任何 HTTP 响应**"。P20 的编辑回显必须读回单个条目的正文，因此边界收窄为：**HTTP 面唯一的正文出口是条目回显 GET**，且仅限①已鉴权主体（沿用云 HTTP 面既有 lite-token 中间件，§9.2⑧）②按需读取**单个**条目③按类别有界。其余面一律不变：快照/版本端点仍只回元数据；日志、`bridge.phase` 诊断、任务投影/历史/回放、attachment 面（`CLOUD_ATTACHMENT_SERVICE_ALLOWLIST` 不新增通道）都不含正文。§5 的 U-10 断言相应限定为"除条目回显 GET 外的任何响应"。

3. **元数据权威修复（实现期发现的缺陷，P20 必修）**：原 `readVersionEntries` 经 `recordOfRow` 从**内容寻址行**取全部元数据（含 `enabled`），而条目行按 `(category, entry_id, sha256)` 去重共享——一次 `enabled` 改写会回溯改变**旧版本**在下发清单里的取值，U-08「运行中 Run 不变」随即失效；toggle 端点会把这个潜在漂移变成常规路径。现改为读路径统一经 `recordOfManifestEntry`：**manifest 提供该版本的全部元数据**（§9.2①"manifest = 该版本的全量条目元数据数组"），行只提供 `content_kind`/正文；行上的 `enabled`/`display_name`/`bytes` 列降级为"当前版本的冗余投影"，不参与任何决策（显式写入以保持可读）。验收断言见 U-08 的 P20 用例（旧版本 `readVersionEntries` 的 `enabled` 不被开关改写）。

4. **UI 落位（W8 设置页；本节发布面的所有者与顺序）**：

   ```text
   挂载与显示（所有者 = 设置页宿主）
     SettingsPage（activeSection = "cloudRuntime"）→ CloudRuntimeSection（分组外壳）
       └─ CloudUserResourcesSection（新区块，位置沿云分组：GitHub → Sandbox → 用户资源）
          非云模式：CloudRuntimeSection 的 notCloudMode 提示；本区块自身再守卫一次（context 为 null 即不渲染）
          云模式判定 = CloudWorkspaceContext 存在（与 CloudRuntimeSection/设置页 nav 的 isCloudMode 同一依据）

   读（所有者 = 控制面 profile store；UI 只投影）
     useCloudUserResources.load() → GET /api/cloud/user-profile → store.applySnapshot（版本/总量/条目元数据）
     编辑回显            → GET …/entries/:category/:entryId → contentByKey（失效条件 = 条目 sha256 变化）

   写（唯一写路径；optimistic overlay 只在未提交期间存在）
     归档上传 → 客户端前置（entryId 形状 / 类别上限 / 80MiB 上传体预检 / 分块 base64）→ PUT（保留现有 enabled）
     MCP 保存 → JSON.parse 预校验（是对象且 ≤256KiB）→ PUT（保留现有 enabled）
     AGENTS.md 保存 → PUT（保留现有 enabled）
     开关 → setEnabledOverlay + PATCH → 以响应 {entry, profileVersion} 回填并清 overlay；失败回滚 overlay
     删除 → markRemovedOverlay + DELETE → applyDeleteResult（扣减总量）；失败回滚
   ```

   - **agents-md 是单例条目**（固定 `entryId = user-agents`）：安装目标是单文件 `~/.zcode/AGENTS.md`，同一 bundle 内第二个 agents-md 条目会让安装器 fail-closed（P19b 的 claim 冲突）；UI 只提供"编辑这一条"，不给"再建一条"的入口。**schema/store 层未加该约束**（写入第二个 agents-md 条目仍会成功、到安装时才失败）——列为悬项。
   - **归档只做便宜前置**：客户端先拒空文件、超类别上限（`CLOUD_USER_PROFILE_ENTRY_MAX_BYTES`）与超 80MiB 上传体（`CLOUD_PROFILE_UPLOAD_BODY_MAX_BYTES`，base64 会放大 4/3，先拒掉必然 413 的读取），再分块转 canonical base64（32KiB 分块的 `String.fromCharCode` 拼接 + 单次 `btoa`；一次性展开 50MiB 会触发参数上限的栈溢出）。tar 解包/膨胀/穿越/manifest 的权威校验仍在安装器（§9.2② 不变）。
   - **MCP JSON 预校验**只判"是 JSON 对象且 JSON 文本 ≤256KiB"（`cloudUserProfileMcpConfigSchema`），不复刻 MCP 字段 schema（§3.2 口径）；字段语义与凭据字段随配置整条保存。
   - **任务级授权不做 UI**：v1 无任务粒度勾选（§9.1②），条目级开关即"逐条关闭"的落地通路；面板常驻说明"新任务自动安装、运行中任务不受影响"。
   - **文案与错误**：全部经 i18n（`settings.cloudUserResources.*`，zh-CN/en-US 全量补齐 63 键）；结构化错误按 `code`/`reason` 映射到 i18n key（`userResourcesErrorKey`），不解析服务端 message（04 §6）；`payload_too_large`/`profile_total_exceeded`/`profile_entries_exceeded`/`invalid_entry`/`not_found`/`not_configured`/`unauthorized`/网络类各有独立文案。
   - **组件与状态边界**：`store/cloud/cloudUserResourcesStore.ts` 只存投影 + overlay（无第二权威）；`hooks/cloud/useCloudUserResources.ts` 是唯一取数/写入口（组件不直连 SDK/端口）；store 状态用细粒度 selector、动作经 `getState()` 取（避免整个 state 进 useCallback 依赖 → 回填触发重载的回环）。

5. **验收映射与验证（真实执行，2026-10-11，仓库根）**：

   | 命令                                               | 结果                                                                                                                                                   |
   | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | `pnpm typecheck`                                   | 通过（0 错误）                                                                                                                                         |
   | `pnpm lint`                                        | 0 error / 78 warning（与 P19b 基线同数，全部在未改动文件）                                                                                             |
   | `pnpm fmt:check`（本批涉及文件）                   | 全部通过（`oxfmt --check` 干净；全仓既有失败与本次无关）                                                                                               |
   | `pnpm architecture:check --changed`                | **OK：violations 0 / baseline 0 / new 0**                                                                                                              |
   | `pnpm --filter @zcode/shared test`                 | **69 tests / 69 pass / 0 fail**（较基线 +3：PATCH 形状、回显形状、端点登记）                                                                           |
   | `pnpm --filter @zcode/server test`                 | **679 tests / 671 pass / 0 fail / 8 skip**（较基线 +3：toggle 递增与幂等+U-08、PATCH 形状、GET 回显+404）                                              |
   | `pnpm --filter @zcode/client test`                 | **38 tests / 38 pass / 0 fail**（较基线 +1：PATCH/GET 方法与 body 形状）                                                                               |
   | `pnpm --filter @zcode/ui test`                     | **233 tests / 233 pass / 0 fail**（较基线 +15：store 投影/overlay/回填/回滚、分块 base64 对齐参考实现、前置校验、错误映射、i18n 键覆盖、分区渲染冒烟） |
   | `pnpm --filter @zcode/server build:sandbox-assets` | 通过（supervisor bundle 3563.0 KiB；本批未改执行节点，无回退）                                                                                         |

   **UI 侧未执行项（如实记录）**：数据驱动的渲染级行为（act/effect 时序、文件选择、开关点击、乐观回滚在界面上的表现）无自动化覆盖——`packages/ui` 的测试布局是 `node --test` 纯逻辑（无 React renderer/jsdom），W8 §6 要求的浏览器 E2E 不在本批；本批以 store + 纯逻辑用例为准，另加一次 `react-dom/server` 渲染冒烟（覆盖"分区在云模式上下文中可装配、非云模式渲染为空"；注意 zustand v5 在 SSR 下取 `getInitialState()`，SSR 只够断言结构）。

6. **悬项（P20 明确不做或需后续批次）**：
   - **agents-md 单例约束只在 UI**：API 直接写入第二个 agents-md 条目会让该 profile 的每次安装 fail-closed（安装器 claim 冲突）。是否把"单例"提为 store/service 约束（新 `invalid_entry` reason）待与用户对齐后决定。（2026-10-11 简化后：安装器退役，"installer claim 冲突"这一失败面消失；单例约束的动机改为"同一落点 `~/.zcode/AGENTS.md` 的第二条会互相覆盖"，处置见 §9.5 悬项。）**2026-10-17 收口：约束已在控制面 domain 层落地——PUT `agents-md` 且 entryId ≠ `user-agents` → 400 `invalid_entry`（reason `agents-md-entry-id-must-be-user-agents`），见 §4.3/§4.5。**
   - **marketplace-source 镜像与 marketplace 注册**仍不做（P19b 悬项）；UI 不为 profile 条目提供 marketplace source 上传入口。
   - **大归档的分块/流式上传**：本批是"整包 base64 + 单次 PUT"（上限 80MiB 请求体），50MiB 归档的客户端峰值内存约 2.4x 文件；分块上传属契约变更，未列入本批。（2026-10-11 简化：**上传侧不变**；新增的是"控制面 → 沙箱"的分块导入（§4.4），两者独立。）
   - 三处 tar 解包实现收敛为 `@zcode/services/archive`（P19b 悬项）；真实沙箱端到端联调与故障注入（W10）。
   - 既有缺口（非本批引入）：`packages/ui` 的 zh-CN locale 缺 `settings.memory.viewer.disabled`（en-US 有），本批未改。

### 9.5 简化架构修订（2026-10-11 用户定调）

用户 2026-10-11 给出**最终口径**，对 M8 同步设计做整体简化。本节是现行设计的决议记录（措辞即最终语义），取代 §9.1–§9.4 中与安装通路相关的部分；原文保留可追溯。

**1. 总框架（定调原文要点）**：云相对 SSH 的**专有面仅三项**——①沙箱回连（出站 WSS）；②生命周期管理；③持久投影/可回放历史。**其余一切骑 SSH 同构服务层**：用户资源同步 = 控制面经 bridge relay 调沙箱 runtime 的既有 sync 服务（与桌面调 SSH 远端同构），安装逻辑 = 既有 sync 服务单一来源。

**2. 同步语义（三规则）**：

| #   | 规则                                                                                                                                                                                            | 落位      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| ①   | 沙箱连接建立（bridge ready）后**自动同步一次最新 profile**；失败不 fail run（记结构化日志；"任务事件"口径见 §4.6——可手动重试/重连自动恢复）                                                     | §4.6      |
| ②   | **手动同步仅在连接状态下允许**：任务视图的同步入口只在 run 连接态且非 terminal 时显示；未连接时 UI 不显示入口，服务端调用同样拒绝（409 `not_ready`，reason `run-not-connected`/`run-terminal`） | §4.6      |
| ③   | **不做自举期（pre-ready）安装**：不再有 `bootstrap.*` 帧驱动的安装，也不参与 ready 门控                                                                                                         | §4.6/§4.8 |

**3. 口径沿革与两轮修正**：轮 1（P18–P20，已退役）= "Run 自举时安装 + 冻结 `resourcesProfileVersion` + ready 门控"；轮 2（本次，现行）= "连接期同步 + 自动一次 + 连接态手动"。轮 2 内含两处口径修正：

1. **触发从"仅自举一次"改为"每次连接自动一次 + 连接态手动任意次"**——Run 不追踪 profile 版本（`runs.resources_profile_version` 退役，列保留不写不读）；原 §1.2/"下一 Run 生效"的"运行中不热更新"表述随之修订为"同步只发生在连接期"。
2. **commands/subagents 条目从归档改为单文件 markdown 文本**（`entryId` = 文件名 `*.md`、payload = markdown ≤256KiB/条），消除 tar 解包环节；对应上传 UI 由归档上传改为条目文本编辑。

**4. 新增面（A 批契约冻结 + B/C/D 批实现；批次见 [W11 §13](./modules/W11-user-profile-sync.md)）**：

| 新增项                                   | 内容                                                                                                                                                        | 冻结/落地                                           |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 控制面专用 allowlist                     | `CLOUD_CONTROL_PLANE_SERVICE_ALLOWLIST`（mcp-sync/skill-sync/plugin-sync/commands/subagents/settings-sync），只约束控制面方向；浏览器白名单与 denylist 不变 | §4.2，A 批                                          |
| `rpc.open.serviceScope`                  | `"client" \| "control-plane"` 分面；控制面是信封唯一构造方，浏览器不能自报 scope                                                                            | §4.2，A 批                                          |
| 分块导入方法（skill-sync / plugin-sync） | `beginUserArchiveImport` / `appendUserArchiveImportChunk` / `completeUserArchiveImport` / `abortUserArchiveImport`；收块 → 复用既有校验与解包落盘           | §4.4，A 批                                          |
| AGENTS.md 最小写入方法                   | `ISettingsSyncService.writeUserAgentsFile({content})`：整文件覆盖、原子写、0600、≤256KiB                                                                    | §4.5，A 批                                          |
| commands/subagents 文本负载              | `user-profile.ts` 新增 markdown 文本分支；归档类别收敛为 skills/plugins；store 新增文本 `content_kind`                                                      | §4.3/§4.5，A 批                                     |
| 手动同步端点                             | `POST /api/cloud/tasks/:taskId/user-profile-sync`（连接态前置，409 语义）                                                                                   | §4.6，B 批（[03 §6](./03-control-plane.md) 已登记） |
| 任务视图同步入口（UI）                   | 连接态且非 terminal 才渲染；未连接隐藏（非禁用态）；与设置页的用户资源分区配合                                                                              | §4.6，D 批                                          |

**5. 退役清单**：见 §4.8（帧、分块下发、bundle/分片与窄入口、沙箱自研安装器、`resourceIntake`、ready 条件 `resources-installed`、相位 `installing-resources`、Run 冻结列、`applied-resources.json`/journal）。**保留不动**：偏好快照链（`bootstrap.config.preferences` → `applied-policy.json` v2 → responder）、profile store 与上传/查询/开关端点、浏览器 allowlist/denylist、`@zcode/services/archive` 权威解包入口、上传侧最小前置校验。

**6. 悬项（本轮明确不做/待后续）**：

| 悬项                                                                | 说明                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "强制覆盖模式"（归档/mcp 改内容也覆盖）                             | 连接态手动同步对归档与 mcp 类是 skip-only；是否需要显式覆盖入口（新参数或新端点）待与用户对齐后再定（§4.7）                                                                                                                               |
| 自动同步结论的持久可见性                                            | 自动同步结论目前只记日志（不写会话投影，不新增控制面事件类型）；若产品要在任务视图展示"上次自动同步结论"，须先定义控制面自有事件类型（§4.6）                                                                                              |
| `@zcode/services/archive` 在安装器退役后的使用方                    | 分块导入走既有导入链路（`importSkillsArchive`/`importPluginsArchive`）；该权威入口的最终使用方与三处 tar 解包收敛一并定（P19b 悬项）                                                                                                      |
| agents-md 单例约束提级                                              | 安装器退役后失败面从"claim 冲突"变为"两条互相覆盖"；是否在 store/service 层拒绝第二个 agents-md 条目（§9.4⑥ 悬项延续）。**2026-10-17 已收口：控制面 domain 层拒绝非 `user-agents` 的 agents-md PUT（400 `invalid_entry`），见 §4.3/§4.5** |
| marketplace-source 镜像与注册；大归档上传侧分块；真实沙箱端到端联调 | 沿 P19b/P20 悬项，不变                                                                                                                                                                                                                    |

**7. 验收**：§8（U-01–U-13）为现行验收集合；实现批次验收（含无头浏览器）见 [W11 §13](./modules/W11-user-profile-sync.md) 与 [10 §10](./10-implementation-plan.md) 本轮记录。**本轮 spec 修订本身不改代码**（代码由 A–D 批实现）；**实施进度（2026-10-11 晚）：A 批（契约与 services）、B 批（控制面编排/传输/手动端点）、C 批（沙箱执行节点清理 + relay 按 `serviceScope` 分面）已落**，D 批（UI 文本编辑面板 + 任务视图同步入口）待落；分批落位记录见 [W11 §13](./modules/W11-user-profile-sync.md)。
