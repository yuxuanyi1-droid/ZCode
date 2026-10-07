# W8 — ui-cloud（客户端投影与原组件接入）

状态：目标设计。归属：`packages/ui/src/cloud`、`packages/ui/src/hooks/cloud`、`packages/ui/src/store/cloud` + 存量组件的接入点。
前置：[W7](./W7-client-sdk.md)、[W5](./W5-cloud-entry.md)（host `/ws` 语义）。

## 1. 范围

做：服务作用域装配（**base = host `/ws` accessor**，执行域由当前 Run attachment 覆盖，无 attachment 时回落 unavailable）、cloud hooks 与 store（Project/Task/Run/input/receipt/history/attachment 投影）、以及**在原组件上的接入点**：原 `Root`/`RootWorkspaceContent`/`App`/`WorkspaceShellLayout`、原侧栏 Project→Task、composer contextHeader（分支/provider/模板/模型）、SessionPane、设置页「Cloud 运行时」分组入口。
不做：新页面或独立外壳；服务端/SDK；Web 入口与平台适配（[W9](./W9-web-entry.md)）；账号域组件（host 服务直接可用，不加云分支）。

## 2. 冻结依赖

- [04 §3.0/§3.0.1/§3.0.2/§3.1/§3.2/§3.4/§3.4.1](../04-web-client.md)（原 UI 增量边界、接入与删除范围、载荷保持、项目列表、草稿与首输入、输入层次、composer scope）
- [12 §5](../12-account-domain.md)（base accessor = host `/ws`，账号域不经覆盖）+ [03 §7.1](../03-control-plane.md)（两通道分面）
- [11 §9](../11-project-task-creation.md)（CT-01–CT-20 创建场景）、[08 §2/§3](../08-project-task-model.md)（状态与门控）
- `DESIGN.md`（复用组件与布局，不得自行造样式）

## 3. 交付物

```text
packages/ui/src/cloud/
  cloudBrowserServices.ts     base=host accessor；执行域按 attachment 覆盖；断连回落 unavailable
  unavailableServiceAccessor.ts（无 attachment/无沙箱时的显式不可用面）
  cloudUiBootstrap.ts         仅解析 principal/scope 等客户端确认信息（不承载模型目录）
packages/ui/src/hooks/cloud/   useCloudProjects/useCloudTasks/useCloudTask/useCloudTaskHistory/
                              useSubmitCloudInput/useCancelCloudInput/useReopenCloudTask/
                              useCloudCapabilities/useCloudWorkspaceController
packages/ui/src/store/cloud/   cloudProjectsStore/cloudTasksStore/cloudTaskHistoryStore/cloudConversationFold
packages/ui/src/settings/CloudRuntimeSection.tsx   设置页 Cloud 运行时分组的视图
原组件接入点（改造，不新增页面）：Root、root/RootWorkspaceContent、App、app-shell/WorkspaceShellLayout、
                              WorkspaceSidebar/WorkspaceSidebarItem、v4/SessionPane、composer contextHeader 区域
```

## 4. 对外接口

- 对 W9：`CloudServicesProvider`/`CloudWorkspaceProvider` + `createCloudBrowserServices({ hostAccessor })` + hooks/store 公开导出（供 `cloudApp.tsx` 注入）
- 内部契约：组件只经 hooks/service accessor 访问服务（不直连 Repo/SDK，不调 `window.zcode`）

## 5. 边界与禁止

- **禁止**用 `cloudShell` 之类提前返回的自建外壳绕过原 `Root`/`App`；禁止把 taskId 当 runtimeSessionId、把 `cloud-task:*` 当真实路径挂载原组件。
- 账号域（登录/套餐/模型目录/设置）**不加云分支**：走 host `/ws` 的既有服务，组件保持原样。
- 无 ready attachment 时执行类请求返回不可用，不回落本机、不伪造空数据；不得以"永久不可用 stub"充当完成。
- UI 不直接调用 Repo/Service；不新增第二份 Task/Run 权威状态（store 只缓存投影 + optimistic overlay）。
- Cloud 草稿 scope 用 `principal + controlPlaneOrigin + taskId`，不随 runtime session 漂移。

## 6. 验收

- 覆盖 [04 §9](../04-web-client.md) `W-01–W-18` 与 [11 §9](../11-project-task-creation.md) `CT-01–CT-20` 中的 UI 侧：创建/草稿配置/正文/完整 attempt/202 与 ACK 分离/能力门控/原路径回归。
- 必须给出：原 Web UI 与云改造后的对照截图（桌面 + 移动视口）、服务目标证据（哪个调用打到 host `/ws`、哪个打到当前 Run attachment）。
- 关页后仍执行、重开后回放、断连不失效（与 [W7](./W7-client-sdk.md) 联测）。
- 真实命令：`pnpm typecheck`、`pnpm lint`、`architecture:check --changed`、`packages/ui` 测试、浏览器 E2E（fixture 起本地服务，不用真实 provider 也可验证 UI 语义）。

## 7. 前置与并行

被 W7、W5 阻塞；与 W6、W9 并行。阻塞 W9 的完整闭环与 W10 的 UI 验收。

## 8. 风险与 spike

- 服务作用域合并是本工作单最大风险：host accessor 与 attachment 覆盖的边界必须一次定清（哪些服务来自 host、哪些来自沙箱、断连时各自表现），否则会在多个组件里长出分支判断。
- 原组件的无 runtime 边界（附件、文件提及、slash 目录等在 draft 期没有 session）需要按 capability 注入而不是虚构 sessionId（[04 §3.4.1](../04-web-client.md)）。
