# 用户级子智能体配置的远端同步

## 背景与问题

子智能体的用户级配置（内置 `general-purpose` / `Explore` 的模型覆盖、用户级 agent Markdown、
启用/停用状态）存在本机 `<storageRoot>/v2/agents-state.json` 与 `<storageRoot>/agents/*.md`。
SSH 模式下，桌面端设置页始终读写本机（`useBaseWorkspaceServices()`），而执行子任务的 agent
运行在远端主机、只读远端自己的同一组文件。远端文件缺失时，内置子智能体没有 `modelSelection`，
按 `resolveSubagentSelection` 回退到父会话模型——表现为「配置了子智能体模型但实际继承主智能体」。

本 spec 定义手动同步能力：用户在设置页主动把本机用户级子智能体配置推送到当前远端目标，
同步时机由用户决定（与 skills / MCP / plugin 的「同步到远端」入口一致）。

## 产品规则

1. **唯一权威与唯一写入路径**：本机用户级配置是权威，且只有设置页一条写入路径
   （`ISubagentsService` 的写方法）。远端那份是**同步副本**，UI 不提供直接编辑远端副本的入口。
2. **触发方式**：手动。设置页子智能体区域提供「同步子智能体」入口，选择目标远端 environment 后
   由用户勾选要同步的项并确认。不做自动同步、不做连接时后台同步。
3. **同步范围**（仅用户级，且只在用户勾选后写入）：
   - 内置子智能体模型覆盖（`builtInModelSelectionOverrides` 的 `general-purpose` / `Explore`）；
   - 用户级 agent Markdown（`agents/*.md`，只收根目录直接文件——自定义 profile 的发现范围）；
   - 被同步 agent 的启用/停用状态（`disabledAgentIds` 中该 agent 的条目）。
4. **不做的事**：
   - 不删除远端文件（非破坏性，`skills` / MCP 同步同理）；
   - 不同步 `agents/` 子目录内的 Markdown：运行时只发现根目录直接文件，同步子目录会产生
     「已同步但运行时不可见」的文件；
   - 不同步项目级 `.zcode/agents/*.md`（属于仓库内容，远端 agent 直接读远端工作区）；
   - 不同步插件自身与插件 agent Markdown（走 plugin 同步）；插件 agent 的模型覆盖
     在 v1 不进入候选，避免出现「覆盖已同步但插件未装」的假象；
   - 不覆盖本机 agent 能力（插件、MCP、skill 引用）——被引用的资源需要用户自行完成对应同步。
5. **生效时机**：远端 agent 按会话创建 app 时读取用户级配置，因此**对新会话生效**；
   已在运行的会话（含 resident 复用）保持旧 profile。UI 需在结果页提示这一点。
6. **失败语义**：整批 all-or-nothing。任一写入失败时回滚本次已写入的文件与状态，
   逐项返回 `failed`，远端不留下半同步状态。

## 状态所有者与数据流

```
 [本机 Local Host]                     [远端 Host（SSH 目标）]
 设置页(IBaseWorkspaceServices)
   └ ISubagentSyncService ──候选/导出──┐         ┌──状态判定/导入── ISubagentSyncService
      读 agents-state.json             │         │   写 agents-state.json + agents/*.md
      读 agents/*.md                  │         │
                                       ▼         ▼
                            同步弹窗（renderer，manual）
                              本地候选 + 本地 hash/选择
                              → 远端 status（missing/same/different）
                              → 本地 export（选中项内容）
                              → 远端 import（原子写 + 回滚）
                              → 事件通知（刷新列表、提示新会话生效）
```

- 所有者：**本机文件**（权威）→ 弹窗（用户选择）→ **远端文件**（副本）。
- 远端 agent 不参与同步链路，只在下一个 session/create 时读取结果。
- 两个方向都用同一份 `ISubagentSyncService` 接口；「本地/远端」由调用实例所在进程决定，
  与 skill / MCP 同步一致（renderer 拿 base 实例做候选与导出，拿会话实例做状态与导入）。
- 远端链路（桌面 SSH/WSL/Docker）：renderer 会话服务合并（`remoteWorkspaceSessionServices`）
  → window host 远端集合把 `subagent-sync` channel **转发**到 `connectionServices`
  （远端 zcode-server 的 `createLocalServices` 实例）→ 读写远端 HOME。
  window host 集合若漏注册该转发，renderer 会打回本机磁盘并出现「同步成功但远端不生效」；
  `legacyRemoteWorkspaceRpcContract` 已把该 channel 纳入连接时校验。

## 接口

共享类型（`packages/shared/src/subagent-sync.ts`）：

```ts
export type SubagentSyncItemKind = "builtInModelOverride" | "userAgent";
export type SubagentSyncRemoteItemState = "missing" | "same" | "different";
export type SubagentSyncImportStatus = "synced" | "skipped" | "failed";

export interface SubagentSyncCandidate {
  id: string; // builtin:general-purpose | builtin:Explore | user:<posix 相对路径>
  kind: SubagentSyncItemKind;
  name: string;
  relativePath?: string; // userAgent：相对用户级 agents 根，posix 分隔
  agentName?: BuiltInSubagentName; // builtInModelOverride
  modelSelection?: ModelSelection; // builtInModelOverride
  enabled?: boolean; // userAgent：来自本机 disabledAgentIds
  contentHash?: string; // userAgent：sha256
  sizeBytes?: number;
  path: string; // 本机绝对路径，仅用于展示
}

export interface SubagentSyncCandidateListResult {
  candidates: SubagentSyncCandidate[];
  localRoot: string;
}

export interface SubagentSyncRemoteStatus {
  id: string;
  state: SubagentSyncRemoteItemState;
  path?: string;
}

export interface SubagentSyncRemoteStatusResult {
  statuses: SubagentSyncRemoteStatus[];
  remoteRoot: string;
}

export interface SubagentSyncExportedEntry {
  id: string;
  kind: SubagentSyncItemKind;
  name: string;
  agentName?: BuiltInSubagentName;
  modelSelection?: ModelSelection;
  relativePath?: string;
  enabled?: boolean;
  content?: string; // userAgent
}

export interface SubagentSyncExportResult {
  entries: SubagentSyncExportedEntry[];
  localRoot: string;
}

export interface SubagentSyncImportResultItem {
  id: string;
  name: string;
  status: SubagentSyncImportStatus;
  path?: string;
  error?: string;
}

export interface SubagentSyncImportResult {
  results: SubagentSyncImportResultItem[];
  remoteRoot: string;
  rolledBack: boolean;
}
```

服务（`packages/services/src/subagent-sync/subagentSync.ts`，channel `subagent-sync`）：

```ts
export interface ISubagentSyncService {
  listLocalUserSubagentCandidates(): Promise<SubagentSyncCandidateListResult>;
  listRemoteUserSubagentStatuses(params: {
    candidates: Array<{
      id: string;
      kind: SubagentSyncItemKind;
      relativePath?: string;
      contentHash?: string;
      modelSelection?: ModelSelection;
      agentName?: BuiltInSubagentName;
    }>;
  }): Promise<SubagentSyncRemoteStatusResult>;
  exportSubagentConfig(params: { ids: string[] }): Promise<SubagentSyncExportResult>;
  checkRemoteUserSubagentWriteAccess(): Promise<RemoteSyncWriteAccessResult>;
  importSubagentConfig(params: {
    entries: SubagentSyncExportedEntry[];
  }): Promise<SubagentSyncImportResult>;
}
```

`listRemoteUserSubagentStatuses` 的判定：

| 项                   | `missing`           | `same`             | `different`        |
| -------------------- | ------------------- | ------------------ | ------------------ |
| builtInModelOverride | 远端无该 agent 覆盖 | 选择值完全相等     | 选择值不同         |
| userAgent            | 远端无该文件        | 远端文件 hash 相等 | 远端文件 hash 不同 |

## 一致性、幂等与安全

- **路径安全**：`relativePath` 一律按 posix 归一，导入端用与 skill 同步同一套校验
  （拒绝绝对路径、`..`、盘符、空段），并解析到用户级 agents 根之内；越界直接失败。
- **原子写**：agent Markdown 与 `agents-state.json` 都用 `atomicWriteText`（临时文件 + rename）。
- **状态合并**：`agents-state.json` 读-改-写，只改动被勾选的字段
  （内置覆盖键、被同步 agent 的 `disabledAgentIds` 条目），保留其它未知字段。
- **幂等**：内容未变化时不写（`same` 项在 UI 不可选，服务端也跳过）；
  同一批重复执行不会产生额外写入，逐项结果如实回 `synced` / `skipped`。
- **回滚**：导入前记录被触碰路径的原始内容（不存在的记为空），失败时恢复并删除新建文件；
  回滚失败只降级为日志告警，结果里标记 `rolledBack`。
- **大小上限**：单个 agent Markdown 1 MiB、单批合计 4 MiB，超限报可操作错误（含文件名与限制值）。
- **日志**：只记录项 id、状态、字节数与耗时，不记录 prompt 正文。

## 生效与可见性

- 入口显示条件：目标 host 的 RPC 就绪、目标为 ssh / wsl、`desktop-continuous`、
  且本机存在同步服务；`web-remote-replayable` 不显示（与 skills / MCP / plugin 同步一致）。
- 入口位置与 skills / MCP / plugin 同步对齐，共四处：侧边栏 workspace 「...」菜单、
  SSH/WSL 连接成功后的目录选择页「同步」下拉、设置 → 子智能体页头（右对齐
  `UploadCloud` 图标按钮 + 「当前远端工作区」横幅，`settings.subagents.remoteContext`）。
- 结果页提示「对远端新会话生效」；导入失败并回滚时提示未落任何部分配置。
- 同步成功后刷新设置页列表与 `@` 提及列表（本机列表仍为权威，仅远端副本被更新）。
- 远端 host 必须运行注册了 `subagent-sync` channel 的版本；旧版远端会在状态判定阶段
  返回 RPC 错误并在弹窗内显示，不会静默降级。

## 验收场景

单测（`packages/services/test/subagentSync.test.ts`，vitest + 临时 HOME）：

1. 候选扫描：只收 `agents/` 根目录的直接 Markdown（子目录文件即使存在也不进候选，
   与运行时发现共用同一实现），给出 posix 相对路径、hash、名称与启用状态；
   `agents-state.json` 中的内置覆盖各成一项；未配置覆盖的内置 agent 不出现。
2. 状态判定：文件不存在 → `missing`；内容相同 → `same`；内容不同 → `different`；
   内置覆盖同值 → `same`，异值 → `different`。
3. 导出：只导出被选 id，携带 userAgent 的完整内容与 `enabled`。
4. 导入成功：写入文件、合并内置覆盖、按 `enabled` 增删 `disabledAgentIds`，
   其它状态字段与远端既有文件保持不变；重复导入同一内容不产生写入（mtime 不变）。
5. 导入失败回滚：注入一次写失败，断言已写入的文件与状态恢复原样、结果标记 `rolledBack`。
6. 路径校验：`../x.md`、`/etc/x.md`、`C:\x.md`、空路径全部拒绝。

手工/E2E 场景（交互改动；本环境无法运行桌面 E2E，未执行，已补 test id 供后续用例使用）：

1. SSH 工作区 → 设置 → 子智能体 → `subagent-remote-sync-entry` → 「同步子智能体」→
   勾选「内置 general-purpose 模型覆盖」→ `subagent-remote-sync-start` 同步完成 →
   在远端新建会话派发 general-purpose 子智能体 → 子会话使用配置模型。
2. 远端已存在同内容文件时不提供勾选（显示「已是最新」）；内容不同时显示「将覆盖」并可勾选。
3. 远端断连或 RPC 未就绪时入口不显示；`web-remote-replayable` 客户端不显示入口。
4. 同步后既有会话行为不变（旧 profile），新会话生效。

## 已知限制 / 后续

- 插件 agent 模型覆盖不进入候选（需要先决定它与 plugin 同步的顺序关系）。
- 本机删除用户级 agent 不会删除远端副本（非破坏性；如需镜像删除另开 spec）。
- 子智能体设置页的 Scope 列表只列本机 workspace（远端 tab 被既有实现过滤掉），
  因此远端 workspace 的 workspace 作用域 agent 不在 UI 内编辑；如需，另开 spec 定义远端读写。
- 不做运行中会话的热更新；如需，另开 spec 定义 host→agent 的 reload 语义。
