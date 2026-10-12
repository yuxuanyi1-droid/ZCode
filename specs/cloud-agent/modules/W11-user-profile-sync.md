# W11 — 云用户资源与设置同步（M8）

状态：目标设计（2026-10-11）。归属：跨包，不新增 module 条目；roots = `packages/shared/src/cloud`（契约）、`packages/server/src/cloud/{domain,app,adapters}`（module `cloud-control-plane`，managed）、`packages/server/src/cloud/execution/{domain,app,adapters}` 的资源安装面（module `cloud-execution`，managed，与 W6 交界）、`packages/ui/src/{settings,hooks/cloud,store/cloud}`（W8 宿主扩展）。owner = 云方案维护者。

> **2026-10-11 简化定调（用户最终口径）**：本工作单 §1–§8 为原始目标设计的原文（自举安装 + 帧下发 + 安装器），其中同步通路相关部分**已退役**；§9–§12 是 P18–P20 的历史落位记录。**现行设计见 [14 §4/§9.5](../14-user-profile-sync.md)，实施批次见本文 §13**（A 契约与 services / B 控制面 / C 沙箱清理 / D UI）。

前置：**W0 扩展**（契约冻结，按 [13 §5](../13-module-map.md) 流程）；实现期与 [W6](./W6-cloud-execution.md)（ready 门控/相位）、[W8](./W8-ui-cloud.md)（设置页宿主）、[W2](./W2-cloud-storage.md)（存储落位）交界。契约与同步语义见 [14](../14-user-profile-sync.md)。

## 1. 范围

做：

- **shared 契约**：`bootstrap.resources` 帧严格 schema（profileVersion/transferId/分块/sha256/条目清单/有界 payload）、profile store 端口类型（条目 CRUD、版本递增、版本历史解析）、偏好快照实值 schema、上传 API 的请求/响应 schema（沿用 [03 §6](../03-control-plane.md) 端点矩阵形态）。
- **控制面 store + 上传 API**：用户资源 profile 的持久化（落 cloud.db 或受控附件存储）、条目级 sha256、profileVersion 单调递增、版本历史保留、上传校验（归档格式/上限/膨胀/manifest/路径穿越，复用 SSH 同步实现，不重写）、凭据字段加密存储。
- **`bootstrap.resources` 下发与沙箱安装器**：Run 创建时冻结 `resourcesProfileVersion`；`bootstrap.config` 之后、`ready` 之前分块下发；沙箱侧组装、校验整包 sha256、按 [14 §4.2](../14-user-profile-sync.md) 布局安装（含 `plugins.dirs`/`enabledPlugins` 与 `mcp.servers` 注册合并写、0o600），按 profileVersion 幂等（`applied-resources.json`），部分安装中断可修复。
- **ready 条件 `resources-installed`**：`domain/readyGate.ts` 条件位 + `app/bootstrap.ts` 真实结果驱动（替换硬编码占位方向）。
- **偏好快照实值化**：控制面从 host `settingService` 读值组快照（[14 §6](../14-user-profile-sync.md) 清单）、随自举帧下发；沙箱 responder 从已应用快照应答。
- **W8 设置页 UI**：云设置页资源管理分组（MCP 表单 CRUD、skills/plugins/commands/subagents 归档上传、AGENTS.md 文本编辑、按任务授权开关、版本/错误展示）。

不做：

- hooks（**2026-10-11 冻结：不纳入 M8**，[14 §9.1①](../14-user-profile-sync.md)；SSH 模式 hooks 同样本机零推送，仅远端 scope 直读远端文件 + 信任按机器独立授予）；workspace 级资源；Run 运行中热更新。
- bridge 握手/token 旋转/WAL/投影/checkpoint（[W6](./W6-cloud-execution.md) 范围）；Task/Run 状态机与输入投递（[W1](./W1-cloud-core.md)）；账号域服务本身（host 本体自带，[12 §1.2](../12-account-domain.md)）；不新增浏览器 attachment 通道。
- 不新增模块：在既有 `cloud-control-plane` 与 `cloud-execution` 两模块 roots 内加文件，module 四件套不新建；公开入口导出增补随 W0 扩展冻结。
- 不照搬 SSH"手动推送"交互、不为云客户端恢复三个同步对话框（`shouldShowRemoteSyncActions` 对 `web-remote-replayable` 的关闭结论不变）。

## 2. 冻结依赖

- [14](../14-user-profile-sync.md) 全文（类别、所有者、帧与安装语义、凭据边界、偏好快照、验收）。
- [02 §4/§5.3/§8](../02-bridge-protocol.md)（帧表与方向、ready 顺序、fail-closed 与故障表）、[W0](./W0-contract-freeze.md)（控制帧/welcome/ready 既有字段）。
- [01 §6.1/§6.2/§7.1](../01-provisioning.md)（模板清单、自举通道、凭据边界修订点）、[12 §1.2/§2/§6](../12-account-domain.md)（账号域口径、设置与凭据权威、A-08 重推先例）。
- [07 §7/§8](../07-connection-architecture.md)（服务分区行、authority 与偏好应答）、[03 §6/§7.1](../03-control-plane.md)（HTTP 端点矩阵、通道分面）。
- `packages/shared/src/cloud/endpoints.ts`（attachment 白名单，**不新增** mcp/skills 通道）、`packages/shared/src/cloud/bridge-protocol.ts`（帧 schema 单一来源）。
- SSH 同步既有实现（复用而非重写）：`packages/services/src/skill-sync/*`、`plugin-sync/*`、`mcp-sync/mcpSyncService.ts`、`remote-sync/remoteSyncWriteAccess.ts`；shared 的 `skill-sync.ts`/`plugin-sync.ts`/`mcp-sync.ts` 契约。
- `DESIGN.md`（W8 设置页 UI 复用组件与布局）。

## 3. 交付物

```text
packages/shared/src/cloud/
  bridge-protocol.ts            bootstrap.resources 帧 schema（分块/有界/严格校验）+ bootstrap.config.preferences 偏好快照块
  user-profile.ts               profile 条目/类别/版本/上传请求响应的严格 schema（W0 扩展冻结；2026-10-11 P18 落档）
  endpoints.ts                  上传 API 端点登记（形状冻结；白名单不新增执行域通道）
packages/server/src/cloud/
  domain/                       条目/版本模型与校验规则（sha256、上限、版本单调）
  app/ports/                    UserProfileStorePort、下发 port（帧 payload 组包）
  app/userProfile/              上传/更新/删除/版本查询用例（鉴权经既有入口）
  adapters/storage/             profile 持久化（cloud.db 或受控附件；凭据加密）
  adapters/ws/                  帧下发编排（bootstrap.config 之后、ready 之前）
packages/server/src/cloud/execution/
  adapters/resourcesInstaller.ts   组装/校验/解包/注册写/幂等（唯一写入方）
  domain/readyGate.ts              新增 resources-installed 条件位（与 W6 交界）
  app/bootstrap.ts                 用真实安装结果驱动条件（去硬编码占位）
  adapters/provisioningInstaller.ts 偏好快照实值安装（升级 applied-policy.json）
packages/ui/src/
  settings/CloudUserResourcesSection.tsx  云设置页资源管理分组（视图）
  hooks/cloud/useCloudUserResources.ts    上传/编辑/删除/版本查询
  store/cloud/cloudUserResourcesStore     投影与 optimistic overlay（不建第二权威）
```

不新增 module 四件套；既有模块的 `contract.ts` 公开入口按 W0 扩展冻结增补导出。

## 4. 对外接口

- **帧**：`bootstrap.resources`（控制面 → Bridge，[14 §4.1](../14-user-profile-sync.md)；“方向表”与严格 schema 在 shared 单一来源）。
- **端口**：`UserProfileStorePort`（条目 CRUD、`nextProfileVersion`、按版本解析快照）；沙箱侧 `ResourcesInstallPort`（`applied()` / `install(payload)` / `stateFile`）。
- **HTTP**：profile 上传/查询端点（形状按 [03 §6](../03-control-plane.md) 矩阵登记；鉴权沿账号域既有面）。**2026-10-11 冻结路径**：`PUT /api/cloud/user-profile/entries/:category/:entryId`、`DELETE …/entries/:category/:entryId`、`GET /api/cloud/user-profile`（快照摘要，无归档正文）、`GET /api/cloud/user-profile/version`；新增错误码 `payload_too_large`/`invalid_entry`/`profile_total_exceeded`/`profile_entries_exceeded`（[14 §9.1](../14-user-profile-sync.md)、`packages/shared/src/cloud/endpoints.ts`）。
- **ready**：`bridge.ready.configVersion` 继续作为已应用配置版本上报；`resources-installed` 是新增 ready 条件（与 [W6](./W6-cloud-execution.md) 交界，条件位在其 §3 交付的 ready 门控内）。
- **UI**：`CloudUserResourcesSection` + `useCloudUserResources` 公开导出，供 W8 设置页宿主注入；组件只经 hooks 访问服务。

## 5. 边界与禁止

- **唯一写入方**：沙箱 HOME 资源内容只由 `resourcesInstaller` 写；不给浏览器/attachment 增加写这些路径的服务通道，也不恢复"手动推送"作为第二路径。
- **凭据边界**：MCP token/headers/env 不进 provider env/元数据、日志、`bridge.phase` 诊断、任务投影与 attachment 面（[14 §5](../14-user-profile-sync.md)）；不得把条目正文写入日志（只记 category/entryId/sha256/bytes）。
- 不得把资源正文塞进 `provisioningEnvelopeJson`；不得为资源改造 bridge 握手/token 旋转；失败只允许"标记 + 下次连接重装"（沿 [12 §6](../12-account-domain.md) A-08 先例）。
- 不得跳过 SSH 同款校验（上限/膨胀/穿越/manifest）；不得新增第二套打包/解包实现。
- UI 不直接调用 Repo/Service、不新增第二份权威状态（只投影 + optimistic overlay，[W8 §5](./W8-ui-cloud.md) 同款规则）。
- 不改其他模块 roots；跨模块接口变更走 [13 §5](../13-module-map.md) 流程；不新增架构模块条目。

## 6. 验收

覆盖 [14 §8](../14-user-profile-sync.md) `U-01–U-12` 全部：

- 7 类资源各自"上传 → 创建任务 → 沙箱内生效"（skills 列表 / 命令可调 / 插件加载 + 注册 / MCP 连接 / subagent / AGENTS.md / 偏好按快照应答）——U-01–U-07。
- profile 变更：运行中 Run 不变、新 Run 生效（U-08）；断线重连同版本幂等、部分安装可修复（U-09）。
- 凭据不出现在日志/投影/attachment 白名单/HTTP 响应（U-10）；超限/损坏归档 fail-closed 且错误定位到条目（U-11）；空 profile 与缺帧语义（U-12）。
- 与 [W6](./W6-cloud-execution.md) 联测：未安装资源不得 ready（`resources-installed` 真值驱动，禁止硬编码 true 通过）。
- 真实命令（以届时 package.json 为准，不虚构）：`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、`packages/server`/`packages/shared`/`packages/ui` 新增测试、W8 侧浏览器 E2E（fixture 起本地服务即可验证上传与安装语义）。

## 7. 前置与并行

被 **W0 扩展**阻塞（未冻结不得开工）——**P18 已于 2026-10-11 落地 shared 侧冻结**（`user-profile.ts`、`bridge-protocol.ts` 的 `bootstrap.resources` 与 `bootstrap.config.preferences`、`endpoints.ts` 路径常量、`CONTRACT.md`；`CLOUD_HTTP_ENDPOINTS` 矩阵行与 SDK 索引随 P19 实现成对登记；见 §9 冻结记录与 [14 §9.1](../14-user-profile-sync.md)）；实现期与 W6（ready 门控/相位）、W8（设置页宿主）、W2（存储落位）交界，需先对齐接口再动同一文件。阻塞 [10 §4](../10-implementation-plan.md) 的 P19/P20；完成后交 W10 做跨模块回归与故障注入（安装中断、重连、超大归档）。

## 8. 风险与需要 spike 的点

- **W0 扩展范围最容易漏**：帧 schema、store 契约、偏好快照 schema、上传端点形状四件必须一次冻结；先按 [14 §8](../14-user-profile-sync.md) 用例反向核对字段（U-01–U-12），避免实现中途返工。（2026-10-11 P18：shared 侧三件已冻结——帧、偏好块、上传/查询 schema 与端点常量；store 端口契约随 P19 落服务端。）
- **安装幂等的边界**：`plugins.dirs`/`enabledPlugins` 与 `mcp.servers` 是合并写（不能整体覆盖用户/workspace 既有键），幂等判定必须覆盖"部分安装后重传"；建议 spike 一次"解包中途 kill → 重连重传 → 结果一致"。
- **偏好快照帧归属**：**已冻结（2026-10-11）：扩展 `bootstrap.config` 的可选 `preferences` 块，`bootstrap.resources` 不改作设置载体；不做双写兼容分支**（[14 §9.1③](../14-user-profile-sync.md)）。
- **版本历史保留窗口**：**已冻结（2026-10-11）：保留最近 8 个快照版本；条目按 sha256 去重存储，修剪无引用旧条目**（[14 §9.1④](../14-user-profile-sync.md)；物理落位（cloud.db vs 受控附件存储）仍在实施期定）。
- **归档校验复用**：直接依赖 `packages/services/src/skill-sync|plugin-sync` 的实现意味着 server 侧要么复用 services 公开入口、要么把校验提为 shared。**归档格式/上限已冻结（tar+gzip；skills/commands/subagents 20MiB、plugins 50MiB，[14 §9.1④](../14-user-profile-sync.md)），代码落位改为在 P19 实施期定**（P18 只交付 shared schema，不在 shared 引入 tar/gzip 校验）；不变约束：禁止复制粘贴第二份校验代码。

## 9. 冻结记录（2026-10-11，P18 / W0 扩展）

[14 §9](../14-user-profile-sync.md) 的四项开放问题已全部冻结（决议全文见 [14 §9.1](../14-user-profile-sync.md)），本工作单侧的对应落地物：

| 冻结项         | 决议                                                                                                                                                                       | 落地物（P18）                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| hooks          | 不纳入 M8（SSH 模式同样本机零推送，不构成先例）                                                                                                                            | 类别枚举不含 hooks；不新增 hooks 安装通路                                             |
| 任务级授权     | 默认全开（新 Task 引用全部 enabled 条目）；条目级 `enabled` 逐条关闭；v1 无任务粒度勾选 UI                                                                                 | `cloudUserProfileEntrySchema.enabled`（默认 true）；P19 Task 授权默认引用全部 enabled |
| 偏好快照帧归属 | 扩展 `bootstrap.config` 可选 `preferences` 块（`configVersion` + 实值）；`bootstrap.resources` 只承载资源归档                                                              | `bridge-protocol.ts`：`bootstrapConfigFrameSchema.preferences`（P18）                 |
| 数值上限       | 单条目 skills/commands/subagents 20MiB、plugins 50MiB；mcp ≤256KiB；agents-md ≤256KiB；总量 ≤128MiB；条目 ≤256；保留 8 版本（按 sha256 去重）；分块 ≤512KiB；上传体 ≤80MiB | `user-profile.ts` 具名常量 + 严格 schema（P18）                                       |

仍未冻结（P19 实施期定，义务不变）：store 物理落位（cloud.db vs 受控附件存储）；`~/.agents/*` 兼容读取面是否镜像安装；`transferId` 同版本重连的复用/重开规则；归档校验代码落位（复用 services 公开入口或提为 shared，禁止复制第二份）。

## 10. P19a 落位记录（控制面；2026-10-11）

P19a 只落控制面半边（`packages/server` 的 `cloud-control-plane` 模块 + `packages/client` 的 SDK 索引成对登记 + 本组 spec）；`packages/server/src/cloud/execution/**`（安装器、ready 门控、偏好应答）留在 P19b。落位决议全文见 [14 §9.2](../14-user-profile-sync.md)。

| 冻结项（§9 遗留）      | P19a 决议                                                                                                                                                                                                                                                                                            | 落地物                                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| store 物理落位         | **cloud.db 两表**：`profile_entries`（`(category, entry_id, sha256)` 内容寻址行，正文文本存储，sha256/bytes 服务端派生）+ `profile_versions`（版本 manifest，单调递增）；同 `(category, entry_id)` 的"当前内容"由最高版本 manifest 指定；保留 8 版本、按 `(category, entry_id, sha256)` 引用计数修剪 | 迁移 `0008_user_profile`（`adapters/storage/sqlite/tables/profile.ts`）、`adapters/storage/repositories/userProfileRepo.ts` |
| 归档校验代码落位       | **安装器侧权威**（P19b：tar 安全解包/膨胀/穿越/manifest，复用 SSH 既有实现）+ **上传侧最小前置**（canonical base64、gzip magic、按类别解码字节上限；上传路径不做 tar 解析）                                                                                                                          | `app/userProfile/userProfileService.ts`（准入校验）；发布 tar 校验 P19b                                                     |
| `transferId` 复用/重开 | 同一 run 内**同 `profileVersion` 复用同一 transferId**（重连续传可识别）、版本变化必新开；状态在 attachment 注册表（连接态事实，不持久化）                                                                                                                                                           | `app/attachments/registry.ts` 的 `resourcesTransfer`                                                                        |
| 偏好快照组装           | `bootstrap.config.preferences` = 五键实值 + 内容寻址 `configVersion`（`"prefs-"+sha256(JSON.stringify(values)).slice(0,16)`）；空对象省略整块；经可选 port 注入，未接线不带块、不 fail                                                                                                               | `app/provisioning/bootstrapConfig.ts`、`app/ports/userPreferencesPort.ts`、`adapters/sandbox/hostUserPreferences.ts`        |
| Run 冻结               | `runs.resources_profile_version INTEGER NULL`；**预约事务内**读当前版本写入（无 TOCTOU）；NULL = 空 profile（显式空清单帧，`profileVersion`=1）；冻结版本解析不到 → `invalid_ref` + `profile-version-pruned`                                                                                         | 迁移 `0008` 的 ALTER；`repositories/runRepo.ts`                                                                             |
| 帧下发编排             | `bootstrap.config` 成功后、`ready` 前经既有 bridge 通道按 `chunkIndex` 顺序发送全部分块，任一失败整体 fail-closed；stop 屏障/终态/epoch 校验与 config 同款；同 run/epoch 重发幂等                                                                                                                    | `app/provisioning/bootstrapResources.ts`、`adapters/ws/bridgeChannel.ts`、`adapters/ws/handshake.ts`                        |
| 端点登记（P18 悬项）   | `CLOUD_HTTP_ENDPOINTS` 4 行 + `CLOUD_SDK_ENDPOINT_SCHEMAS` 4 条 + SDK 4 方法（`listUserProfile`/`getUserProfileVersion`/`putUserProfileEntry`/`deleteUserProfileEntry`）；03 §6 正文同步；为行数门禁把行表/路径常量落到 `userProfileEndpoints.ts`/`user-profile.ts`（导出名与公共入口不变）          | shared `endpoints.ts`（矩阵展开）与 `userProfileEndpoints.ts`、client `cloudWireSchemas.ts`/`cloudControlPlaneClient.ts`    |

不随 P19a 落位（P19b）：tar 权威校验与安装布局、`applied-resources.json` 幂等、ready 条件 `resources-installed` 与 `bootstrap.ts` 去硬编码、`~/.agents/*` 镜像决策、沙箱 responder 读已应用快照、W8 设置页 UI（P20）。

## 11. P19b 落位记录（执行节点；2026-10-11）

P19b 落执行节点（沙箱）半边：`bootstrap.resources` 入站重组与安装、ready 条件 `resources-installed`、偏好快照实值应答，并把 `~/.agents/*` 镜像悬项一并冻结。落位决议全文见 [14 §9.3](../14-user-profile-sync.md)；本表只记"决议 → 落地物"。

| 冻结项（§9/§10 遗留）         | P19b 决议                                                                                                                                                                                                                                                                                                              | 落地物                                                                                                                                                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.agents/*` 镜像            | **不镜像**（只装 `~/.zcode` 主面）：镜像会制造第二条写路径与"同一内容两份权威"（[14 §9.3②](../14-user-profile-sync.md)）                                                                                                                                                                                               | 安装器只写 `~/.zcode/{skills,commands,plugins,agents}`、`~/.zcode/AGENTS.md`、`~/.zcode/cli/config.json`                                                                                                                                  |
| 归档校验代码落位（收官）      | 新增 services 通用入口 `@zcode/services/archive`（gzip magic/流式解包/穿越/绝对路径/symlink/成员与总量上限/模式恢复；膨胀 = 类别上限 ×4），安装器唯一使用；SSH skill/plugin sync 的两个既有 extract 本批不收敛（各自带 UI 结构化错误码与 plugin 元数据语义），三处收敛列悬项                                           | `packages/services/src/archive/safeArchiveExtract.ts`（新，export `./archive`）                                                                                                                                                           |
| tar 权威校验与安装布局        | 两阶段提交：解包到目标根 `.install-tmp-<uuid>` → 全部冲突预检 → 顶层条目 rename 进目标根；同名冲突 fail-closed 不覆盖；提交失败回收暂存                                                                                                                                                                                | `execution/adapters/resourcesStaging.ts`、`resourcesInstaller.ts`（新）                                                                                                                                                                   |
| `applied-resources.json` 幂等 | v1 `{version, profileVersion, appliedAt, products[]}`：同版本直接成功返回；版本变化按 `products` 清理后全量重装；**提交前写 `resources-install-journal.json`**（中断后下次安装自清理自己的半成品 → U-09 可修复；不误删用户内容）；成功才写状态文件；`config.json` 读取-合并-写回单写者串行、0600 原子写                | `execution/adapters/resourcesHome.ts`、`resourcesState.ts`（新）                                                                                                                                                                          |
| plugins 注册                  | `plugins.dirs` 追加去重（resolve 后绝对路径）+ `enabledPlugins[name@inline] = 条目 enabled`；插件目录必须有 manifest（否则 fail-closed）；SSH 归档的 `.zcode-plugin-sync.json` 跳过；**marketplace-source 镜像不做**（悬项）                                                                                           | `resourcesStaging.planPluginRegistration`、`resourcesState.applyConfigProducts`                                                                                                                                                           |
| 入站接收与重组                | 按 `transferId` 缓冲（变化即重置）、`chunkIndex` 严格递增、逐帧清单/`chunkCount`/`profileVersion` 一致、逐块与整包 sha256、bundle 过**控制面同一 schema**（经窄入口 `userProfileBundleContract.ts`，不走 `contract.ts` barrel——实测避免 +2.0MB 沙箱产物）、条目内容寻址复核；失败 `bootstrap_failed`、缺帧 `not_ready` | `execution/domain/resourcesBundle.ts`、`execution/app/resourceIntake.ts`（新）、`packages/server/src/cloud/userProfileBundleContract.ts`（新，窄公开入口）                                                                                |
| ready 条件与去硬编码          | `resources-installed` 由本连接真实安装结论驱动（空清单=显式满足）；`preferencesInstalled` 由 policy 安装器落盘结果驱动；相位枚举加 `installing-resources`（shared 冻结帧 + 类型直接引用 + 穷尽断言）                                                                                                                   | `execution/domain/readyGate.ts`、`execution/app/bootstrap.ts`、`packages/shared/src/cloud/bridge-protocol.ts`                                                                                                                             |
| 沙箱 responder 读快照         | `applied-policy.json` v2（`+configVersion`/`preferences` 实值；v1 兼容读）→ `ZCODE_APPLIED_POLICY_SNAPSHOT` 注入 runtime → services 在 `cloud-execution-node` 下取五键实值（Shell 仅 `user-execution`）；缺失/损坏 → 回落沙箱默认值 + 一条 warn（不 fail）；`bridge.ready.configVersion` 用快照版本                    | `execution/adapters/provisioningInstaller.ts`、`adapters/runtimeOwner`（env 注入经 supervisorRuntime）、`packages/services/src/runtimePreferencesSnapshot.ts`（新）、`packages/services/src/node.ts`、`packages/shared/src/runtimeEnv.ts` |

顺带修复：`bridgeSession` 在 `bootstrap.config` 未到时补发 `bridge.ready`（会让全部自举条件被绕过）→ 现改为自举未完成即关连接重连（[14 §9.3⑨](../14-user-profile-sync.md)）。

不随 P19b 落位（后续）：W8 设置页 UI（P20）、marketplace-source 镜像、三处 tar 解包实现收敛、真实沙箱端到端联调与故障注入。

## 12. P20 落位记录（契约小追加 + W8 设置页 UI；2026-10-11）

P20 落「云设置页用户资源管理 UI」与它必需的**两个契约小追加**（先冻结再实现），并顺手修掉实现期发现的元数据权威缺陷。落位决议全文见 [14 §9.4](../14-user-profile-sync.md)；本表只记"决议 → 落地物"。**不动 `cloud/execution/**`\*\*。

| 冻结项                     | P20 决议                                                                                                                                                                                                                            | 落地物                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 契约小追加（14 §9.4①）     | `PATCH …/entries/:category/:entryId`（body 只含 `{enabled}`；**值变化才递增** `profileVersion`）+ `GET …/entries/:category/:entryId`（`{entry, payload}`，UI 编辑回显唯一通路）；条目不存在一律 404 `not_found`，不新增 wire 错误码 | shared `user-profile.ts`（`cloudUserProfileEntryEnabledPatchRequestSchema`/`cloudUserProfileEntryReadResponseSchema`/`cloudUserProfileEntryPatchResponseSchema` 别名）、`userProfileEndpoints.ts` +2 行、client `cloudWireSchemas.ts` +2 条与 `cloudControlPlaneClient.ts`（`getUserProfileEntry`/`setUserProfileEntryEnabled`）、server `adapters/http/userProfileRoutes.ts` +2 路由 |
| store 端口与仓储           | 端口 +`readEntry`（当前版本单条元数据+正文）与 +`setEntryEnabled`（同事务改 manifest + 同步行冗余列 + 值变化才递增）；因行数门禁把内部共享件拆到 `userProfileRepoHelpers.ts`                                                        | `app/ports/userProfileStorePort.ts`、`adapters/storage/repositories/userProfileRepo{.ts,Helpers.ts}`、`storageMethodTypes.ts`、`cloudStorageClient.ts`、app 用例 `userProfile/userProfileService.ts`（`readEntry`/`setEntryEnabled`）                                                                                                                                                 |
| 元数据权威修复（14 §9.4③） | 读路径统一经 `recordOfManifestEntry`：**manifest 提供版本元数据**，内容寻址行只提供正文——否则一次 `enabled` 改写会回溯改变旧版本的下发集合（U-08 失效）                                                                             | `userProfileRepoHelpers.ts`（新组装函数）+ `bootstrapResources.ts` 与 GET 回显共用 `domain/userProfile.ts` 的 `userProfileEntryPayloadFromContent`                                                                                                                                                                                                                                    |
| 凭据边界收窄（14 §9.4②）   | HTTP 面唯一正文出口 = 条目回显 GET（已鉴权、单个、按类别有界）；快照/版本仍只回元数据，日志/诊断/投影/attachment 不变                                                                                                               | 契约 JSDoc 与 CONTRACT.md/03 §6 文字；U-10 断言限定为"除该端点外的任何响应"                                                                                                                                                                                                                                                                                                           |
| W8 设置页 UI               | 「用户资源」分区挂进云分组（GitHub → Sandbox → 用户资源），**只在云模式渲染**；MCP 表单 CRUD、归档上传（4 类）、AGENTS.md 单例文本编辑、条目开关与删除、版本/总量/上限展示、结构化错误文案                                          | `settings/CloudUserResourcesSection.tsx`（+`cloudUserResourcesSectionParts/ArchivePanel/McpPanel/AgentsMdPanel`）、`hooks/cloud/useCloudUserResources.ts`、`store/cloud/cloudUserResourcesStore.ts`、`cloud/userResourcesModel.ts`、`cloud/cloudPorts.ts`（+5 方法）、i18n `settings.cloudUserResources.*`（63 键 ×2 locale）                                                         |
| 发布面                     | 分区与 hook/store/模型按 W8 §4 的"公开入口"导出（W9 宿主持有）                                                                                                                                                                      | `packages/ui/src/index.ts`、`settings/CloudRuntimeSection.tsx`、`hooks/cloud/index.ts`、`store/cloud/index.ts` + `cloud/index.ts` 的端口类型                                                                                                                                                                                                                                          |

验收映射（[14 §8](../14-user-profile-sync.md)）：U-08（运行中 Run 不变）→ P20 的"旧版本 manifest 不被开关改写"用例；U-10（凭据边界）→ 快照无正文 + 条目回显为唯一出口；U-11（错误定位）→ 404/400 的 `details.category/entryId` 用例。真实命令与计数见 [14 §9.4⑤](../14-user-profile-sync.md) 与 [10 §10](../10-implementation-plan.md)。

不随 P20 落位（后续）：agents-md 单例的 store/service 级约束（现仅 UI 单例 + 安装器 fail-closed）；大归档分块/流式上传；marketplace-source 镜像；三处 tar 解包实现收敛；真实沙箱端到端联调与故障注入；UI 的浏览器 E2E（本批 ui 用例为 store + 纯逻辑）。

## 13. 简化改造（连接期同步；2026-10-11 用户定调）

落 [14 §4/§9.5](../14-user-profile-sync.md) 的简化定调：同步改为**连接期**经 bridge relay 调沙箱既有 sync 服务（自动一次 + 连接态手动），自举安装面整体退役。四个批次按"契约与 services → 控制面 → 沙箱清理 → UI"顺序执行（A 未冻结前其余不开工）；每批独立可验证，**不新增 module 条目**、不动其他模块 roots。

### A. 契约与 services

范围：

- `packages/shared/src/cloud/endpoints.ts`：新增 `CLOUD_CONTROL_PLANE_SERVICE_ALLOWLIST`（mcp-sync/skill-sync/plugin-sync/commands/subagents/settings-sync）；浏览器白名单与 denylist 不动。
- shared `cloud/rpc-protocol.ts`：`rpc.open` 增加必填 `serviceScope: "client" | "control-plane"`（严格校验；浏览器不能自报）。
- shared `cloud/user-profile.ts`：归档类别收敛为 skills/plugins；commands/subagents 新增 markdown 文本负载分支（`{category, content}`，≤256KiB，具名 schema）；新增手动同步响应 schema（逐条 `{category, entryId, status, error?}`）。
- `packages/services/src/skill-sync`、`plugin-sync`：新增分块导入方法（`beginUserArchiveImport({archiveSha256, totalBytes, chunkCount})` / `appendUserArchiveImportChunk({importId, chunkIndex, chunkSha256, payloadBase64})` / `completeUserArchiveImport({importId})` / `abortUserArchiveImport({importId})`；形状与上限见 [14 §4.4](../14-user-profile-sync.md)，收块状态机共享实现，complete 委派既有导入链路）。
- `packages/services/src/settings-sync`：新增 `writeUserAgentsFile({content})`（整文件覆盖、原子写、0600、≤256KiB，[14 §4.5](../14-user-profile-sync.md)）。
- shared 移除：`bootstrap.resources` 帧 schema、`bootstrapResourcesFrameSchema` 相关导出、相位枚举里的 `installing-resources`。

验收：typecheck/lint；shared/services 单测（帧 schema 移除后无残留导出、`serviceScope` 校验、文本分支与上限、分块状态机的乱序/缺块/超限/超时、`writeUserAgentsFile` 的覆盖/原子/权限/超限）；`pnpm architecture:check --changed`。

### B. 控制面

范围：

- 新增连接期同步编排（`cloud-control-plane` app 层）：读**最新** profile（不追踪 Run 版本）→ 按 [14 §4.3](../14-user-profile-sync.md) 逐类别调沙箱服务（分批/分块，串行）→ 汇总逐条结果；per-run 单飞与失败不 fail run（结构化日志）。
- 自动触发：attachment registry `markReady`（bridge.ready）后异步发起一次；每 epoch 一次。
- 手动端点：`POST /api/cloud/tasks/:taskId/user-profile-sync`（[03 §6](../03-control-plane.md) 已登记）：连接态且非终态前置（409 `not_ready` + reason `run-not-connected`/`run-terminal`）、stopRequested 屏障、`{runId, profileVersion, trigger, results[]}`；端点矩阵 + SDK 索引成对登记（既有不变量）。
- 退役：`app/provisioning/bootstrapResources.ts`、`adapters/ws/{bridgeChannel,handshake}.ts` 的资源下发接线、attachment registry 的 `resourcesTransferId`/`markBootstrapResourcesSent`、`domain/userProfileBundle.ts`、`userProfileBundleContract.ts` 与 policy `publicEntrypoints` 项；`runs.resources_profile_version` 改为不写不读（列保留，注明废弃）。
- store/上传端点随 A 批契约调整（commands/subagents 文本负载的入库校验、总量与条目数上限口径不变）。

验收：typecheck/lint/architecture；server 单测（自动触发一次与重连再触发、未连接/终态 409、在飞去重、逐条结果汇总、Run 冻结列不写不读、退役文件无残留引用）；`pnpm --filter @zcode/server build:sandbox-assets` 通过。

落位记录（B 批，2026-10-11，已完成）：

- **编排**：`app/userProfile/profileSyncService.ts`（门控/单飞/汇总/日志/自动触发）+ `app/userProfile/profileSyncCategories.ts`（逐类别调用翻译；行数门禁拆分）+ `app/ports/controlPlaneRpcPort.ts` + `domain/userProfileSync.ts`（markdown 分类、base64 纯编解码、分块、mcp 分批、subagents front-matter 映射、错误文本有界）。
- **通道**：`adapters/ws/controlPlaneRpcChannel.ts`（每 Run 一条 `serviceScope:"control-plane"` 流、真实 `ChannelClient`、30s 调用超时）；`bridgeChannel.ts` 装配/响应路由/断连释放/dispose；白名单 `isCloudControlPlaneServiceAllowed` 在 app 层预检（沙箱侧按 scope 选白名单属 C 批）。
- **触发**：`adapters/ws/inbound.ts` 的 `bridge.ready` 分支在 `runs.markReady`/`registry.markReady` 之后异步触发一次（同 run+epoch 去重、失败只记 warn）；手动端点挂 `adapters/http/userProfileRoutes.ts`，shared 矩阵行（`userProfileEndpoints.ts` + `CLOUD_USER_PROFILE_ENDPOINT_PATHS.syncTask`）与 client SDK 方法 `syncTaskUserProfile` 成对登记。
- **退役**：见范围清单（3 个文件删除、attachmentPort/handshake/registry/runRepo/端口/方法表/装配/`contract.ts`/`module.ts`/policy 清线；`runs.resources_profile_version` 不写不读）。
- **store/端点**：`content_kind` 增 `markdown`（迁移 0008 CHECK 就地扩列，未发布功能无需数据迁移）；上传/回显/开关与 markdown 条目对齐。
- **自主决定**（全文见 [10 §10](../10-implementation-plan.md) B 批记录）：commands 以整份 markdown 作 `config.prompt` 逐字节落盘；subagents 由控制面映射 front-matter → `SubAgentConfig`（未知键不携带，"原样落盘"列为悬项）；mcp 显式 `enabled: true`；`HashPort` 增 `sha256HexBytes`；手动 join 保留在飞同步的真实 trigger。
- **验证**：控制面 typecheck 0 错误（execution 15 处归 C、UI 4 处归 D）、lint 0 error（新文件 0/0）、`architecture:check --changed` violations 0、shared 75/75、client 38/38、server 668（654 pass / 6 fail 全为 execution 退役遗留 / 8 skip）、services 42/42；`build:sandbox-assets` 因 C 批未删的 `resourcesBundle.ts` 引用已删窄入口而失败（符合预期）。

### C. 沙箱清理

范围：

- 删除沙箱自研安装器与相关面：`execution/adapters/{resourcesInstaller,resourcesStaging,resourcesHome,resourcesState}.ts`、`execution/app/resourceIntake.ts`、`execution/domain/resourcesBundle.ts` 及 `app/bootstrap.ts`/`domain/readyGate.ts` 中的 `resourcesInstalled` 接线与 `installing-resources` 相位上报（`preferencesInstalled` 的落盘证据驱动保留）。
- `rpcRelay`：按 `serviceScope` 选择白名单（client 走 `CLOUD_ATTACHMENT_SERVICE_ALLOWLIST` 现状；control-plane 走新 allowlist），denylist 对两面生效。
- 保留：偏好快照链（`provisioningInstaller` 的 `applied-policy.json` v2 → responder）、`@zcode/services/archive` 权威解包入口。

验收：typecheck/lint/architecture；沙箱侧 e2e（ready 前 relay 帧仍被丢弃；ready 后控制面 scope 可调 sync 服务、client scope 不能调 allowlist 外通道）；ready 条件恢复 6 条且无 `resources-installed` 残留；`build:sandbox-assets` 产物大小无回退。

落位记录（C 批，2026-10-11，已完成）：

- **退役自研安装链**（逐一删除，14 §4.8）：`execution/{domain/resourcesBundle,app/resourceIntake,adapters/resourcesInstaller,adapters/resourcesStaging,adapters/resourcesHome,adapters/resourcesState}.ts`；`domain/readyGate.ts` 删 `resources-installed` 条件位与 `installing-resources` 相位（`READY_CONDITIONS` 回到 5 项 = 02 §5.3 条件表节点侧 1–5，第 6 条控制面 CAS 不在节点门控内；`PHASE_ORDER` 恢复 6 相位、穷尽断言同步）；`app/bootstrap.ts` 删 resources 选项/`resourcesInstalled`/相位与 intake 接线（**偏好快照链保留**：policy install、`preferencesInstalled` 真值驱动、`configVersion` 上报不动；局部量 `resourcesConfigVersion` 随退役改名 `appliedConfigVersion`）；`app/bridgeInbound.ts` 删 `bootstrap.resources` case；`app/bridgeState.ts` 删 `ResourceIntakePort` 选项与 `resourcesTimeoutMs`；`app/bridgeSession.ts` 删每连接 `resources.begin`（保留"自举未完成不补发 ready"守卫）；`adapters/supervisorRuntime.ts` 删 intake/安装器装配（保留 runtime env 的 `ZCODE_APPLIED_POLICY_SNAPSHOT` 注入——偏好链）。
- **relay 分面（核心新增）**：`app/rpcRelay.ts` 按 `rpc.open.serviceScope` 选注册面——`"client"` = `CLOUD_ATTACHMENT_SERVICE_ALLOWLIST`（现状不变）；`"control-plane"` = 浏览器面 ∪ `CLOUD_CONTROL_PLANE_SERVICE_ALLOWLIST`（并集，C 批定夺：控制面受信、能力 ⊇ 浏览器；并集在执行侧派生，两份表各自仍是 shared 单一来源）；scope 映射不到允许集 → 拒绝该 `rpc.open`（warn + 不建会话，沿既有 stale-frame 拒绝形态）；denylist 对两面生效；未列出的通道名仍不注册（调用停在 ChannelServer 未注册通道的挂起/超时路径，不变）。`app/commandTransport.ts` 的 `rpc.open` 补 `serviceScope:"control-plane"`（其 `zcode-agent` 在并集内）。
- **测试与支撑清理**：删 `cloudResourcesBundle/cloudResourcesInstall/cloudExecutionResourcesE2e.test.ts` + `cloudResourceArchives.ts`；`cloudExecutionResourcesReady.test.ts` 改写（退役断言：条件集恢复 5 项/`installing-resources` 不可解析；保留偏好快照用例）；`cloudExecutionFakes.ts`（删 intake 假件）、`cloudBridgeFakes.ts`（删 `resourcesFrames` 下发；`memoryRpcFrame` 的 `rpc.open` 补 `serviceScope`）、`cloudExecutionBootstrap.test.ts`（无 resources 阶段）、`cloudBridgeSession.test.ts`（B-05 帧补 scope）、`cloudBridgeProjection.test.ts`（relay 帧按 `client` 分面）适配；新增 `cloudExecutionRpcRelayScope.test.ts`（并集常量、client 分面拒 sync 通道且本地服务零调用、control-plane 分面 6 通道 + `zcode-agent` 通过、denylist/未知通道两侧被拒、未知 scope 的 open 被拒）。
- **构建产物**：`build:sandbox-assets` 恢复通过，`supervisor.bundle.mjs` 3523.5 KiB（较 P20 基线 3563.0 KiB 回退为 **−39.5 KiB**，退役安装器后不再拉入 archive/staging 链）；`runtimeStub.bundle.mjs` 3284.1 KiB（+1.0 KiB，A/B 批 shared 增量的既有影响，本批未动其入口链）。
- **自主决定**（全文见 [10 §10](../10-implementation-plan.md) C 批记录）：并集语义只在执行侧准入点派生（不新增 shared 导出）；未知 scope 的 open 拒绝不回 `rpc.close`；未注册通道维持"挂起至超时"零新语义；测试文件名保持（退役断言与偏好用例共处一文件）。

### D. UI

范围：

- 任务视图同步入口：**只在 run 连接态且非 terminal 时渲染**（未连接隐藏，不是禁用态）；点击调手动同步端点并展示逐条结果/错误（i18n，结构化 code/reason 映射）。
- 设置页用户资源分区（P20 已落）随 A 批契约调整：commands/subagents 由归档上传改为**条目列表 + markdown 文本编辑（新建/覆盖）+ 删除**；归档上传面板收敛为 skills/plugins 两类；AGENTS.md 单例编辑与条目开关/删除不变。

验收：`pnpm --filter @zcode/ui test`（store/纯逻辑）；**无头浏览器 E2E**：①未连接 run 的任务视图**无**同步入口；②连接态出现入口且点击后展示结果；③设置页 commands/subagents 为文本编辑面板（无归档上传）、skills/plugins 仍为归档上传；④移动布局与主题（对齐 [W8 §6](./W8-ui-cloud.md)/DESIGN.md）。

落位记录（D 批，2026-10-11，已完成）：

- **设置页录入面**：`settings/cloudUserResourcesMarkdownPanel.tsx`（新）承载 commands/subagents 的条目列表 + markdown 文本编辑（新建/覆盖）+ 删除 + 开关；文件选择读文本并自动取文件名作 `entryId`（非法即时提示）；`CloudUserResourcesSection` 分派 = archive（skills/plugins）/ markdown（commands/subagents）/ mcp / agents-md；`cloud/userResourcesModel.ts` 增 markdown 类别判定、`*.md` entryId 校验（三档失败）、正文 ≤256KiB 预检与上传体构造；`validateUserResourceArchiveFile` 参数收窄为归档类别；B 批移交的 `useCloudUserResources.ts` 4 处类型错误消除（归档分支收敛 + 新增 `saveMarkdownEntry`，pending 动作 `markdown-text`）。
- **任务面板同步入口**：挂载 `app-shell/WorkspaceShellLayout.tsx:1982`（主区状态槽位，与 `CloudTaskRunStatusBanner`/`CloudTaskArchivedBanner` 同区）；门控纯逻辑 `cloud/cloudTaskUserProfileSync.ts`（attachment 在线 = `selectCloudAttachmentForTask` + `activeRun.status === "ready"` 且非终态 → 渲染；未连接/终态不渲染）；hook `hooks/cloud/useCloudTaskUserProfileSync.ts` + 组件 `cloud/CloudTaskUserProfileSyncRow.tsx`；端口 `cloudPorts.ts` 增 `syncTaskUserProfile(taskId)`（与 SDK 既有方法结构一致）。结果内联呈现（计数 + ≤5 条失败简列 + 截断计数 + join 自动同步的真实 `trigger`），409/`run-not-connected` 映射「沙箱未连接」。
- **文案**：设置页顶部说明改连接期语义；删除 `savedNextRun` 等"新任务安装 / 运行中冻结版本"口径；新增 `settings.cloudUserResources.markdown.*`、`validation.markdownSuffix/markdownTooLarge`、`cloud.userProfileSync.*` 键（zh-CN/en-US 同步）。
- **自主决定**（全文见 [10 §10](../10-implementation-plan.md) D 批记录）：连接态取 `activeRun.status === "ready"`（比"非终态"更严，避免 disconnected/draining 下"可点但必 409"）；结果就地内联不弹 toast；join 自动同步时如实提示；markdown entryId 失败分三档；上传体构造下沉纯模块以过 `max-lines`；文件选择只读文本不解析归档。
- **验证**：`pnpm typecheck` 全仓 0 错误；`pnpm lint` 0 error / 77 warning（新文件 0/0，同基线）；`npx oxfmt --check` 本批 21 文件干净；`pnpm architecture:check --changed` violations 0；`pnpm --filter @zcode/ui test` **247 / 247 pass / 0 fail**（新增同步入口 9 例、markdown 形态与面板装配冒烟、i18n 键与文案断言）。**无头浏览器 E2E 未执行**：`packages/ui` 无浏览器/E2E 夹具（纯逻辑 + `react-dom/server` 结构冒烟），验收①②③以门控纯逻辑与面板装配冒烟静态核对，真实交互与移动布局留 W10。

批次边界：A 冻结前 B/C/D 不开工；C 必须在 B 的退役接线完成后执行（避免半退役态）；D 依赖 B 的端点可用。真实沙箱（E2B + 真实控制面）端到端联调与故障注入归 [W10](./W10-verification.md)（[14 §8](../14-user-profile-sync.md) U-01–U-13）。
