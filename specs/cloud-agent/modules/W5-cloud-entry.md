# W5 — cloud-entry（云入口：host 本体 + cloud 叠加）

状态：目标设计。归属：`packages/server/src/cloud/adapters/entry-cloud*.ts` + 存量 `packages/server/src/http.ts` 的纯搬移抽取，属于 `cloud-control-plane` 的 adapters 层。
前置：[W0](./W0-contract-freeze.md)。

## 1. 范围

做：云入口进程装配 —— 读配置并 fail-closed、把数据目录指向云持久卷、启动 **host 本体**（`createLocalServices`）并挂 host `/ws` 服务通道、把 cloud 模块的 HTTP/WS 路由与后台循环叠加到同一 Hono app、静态托管 Web 产物与 SPA fallback、连接与关闭顺序；把 `http.ts` 的 `/ws` 暴露逻辑**纯搬移**成可复用导出。
不做：账号域实现（host 自带，零改动）；cloud 业务逻辑（[W1](./W1-cloud-core.md)）；provider/GitHub API（[W3](./W3-cloud-sandbox.md)/[W4](./W4-cloud-github.md)）；沙箱内进程（[W6](./W6-cloud-execution.md)）。

## 2. 冻结依赖

- [12 §1.2/§4/§5](../12-account-domain.md)（云入口 = 标准 host 本体 + `/ws` 服务通道）
- [03 §1/§2/§3/§7.1/§8](../03-control-plane.md)（运行模式、边界、主体、两通道分面、启动顺序）
- [07 §2/§5/§12](../07-connection-architecture.md)（端点表、装配 profile）
- [04 §2/§8](../04-web-client.md)（模式与回退）

## 3. 交付物

```text
packages/server/src/entry-http.ts             单一进程入口：读 ZCODE_SERVER_MODE 后分派（cloud → 云入口启动事务；否则既有本地行为）
packages/server/src/http.ts                   local 分支同时回答 GET /api/cloud/capabilities（无鉴权，mode=local，见 §4）
packages/server/src/rpcChannelServer.ts       从 http.ts 抽出的 setupChannelServer / wrapWebSocket / lite-token 校验（行为不变）
packages/server/src/cloud/adapters/
  entry-cloud-config.ts     配置读取与校验（publicOrigin、listenHost/Port、dataDir、providers、webDir、model 静态 fallback）
  entry-cloud-host-body.ts  setDataBaseDir → materialize builtin → createLocalServices；host 服务图生命周期
  entry-cloud-host-ws.ts    host `/ws` 挂载（?token= lite-token）、provisioning source 取用、凭据代际观察
  entry-cloud-server.ts     Hono app 组装：host /ws + cloud 路由（tasks/bridge/interactions）+ 静态托管 + 后台循环 + close 顺序
  entry-cloud-main.ts       云入口进程事务（HOME 隔离 → 动态 import 服务图 → 启动 → 信号收尾），被 entry-http 复用
  entry-cloud-git-grant.ts  执行节点 `GET /api/cloud/runs/:runId/git-grant` 装配（broker + handler + Bearer 主体解析；已交付）
  entry-cloud-secrets.ts    云侧部署秘密加载（与 W4 共用）
  entry-cloud-drivers.ts    driver 装配（仅生产路径；测试可注入）
```

### 3.1 单一入口与模式分派（2026-10-07 修订）

- `packages/server/src/entry-http.ts` 是**唯一**进程入口：先用轻量静态 import 读 `ZCODE_SERVER_MODE`；`=cloud` 时复用云入口启动事务（HOME 隔离 → 动态 import 服务图 → 启动 → 信号收尾），未设置/`local` 走既有本地行为，**其它取值 fail-closed 退出**（不隐式切 local，见 §5）。构建产物仍保留 `entry-cloud`（即 `entry-cloud-main`）这一可执行名：`entry-http` 在 cloud 模式下动态 import 的正是它，运维方也可直接运行。
- **顺序硬约束**：模式读取与 HOME 隔离必须发生在**任何服务图 import 之前**（`services/paths.ts` 在模块加载期固化 `HOME`，见 `entry-cloud-main.ts` 顶部注释与 03 §8）。因此入口对本文件表内的服务图模块一律动态 import，静态 import 只允许轻量配置/隔离助手；否则打包产物会在入口模块求值时就把服务图拉起来，隔离失效并污染运维者真实 home。
- 本地分支（同一天起）也在同一 app 上回答 `GET /api/cloud/capabilities`（**无鉴权**），使 Web 客户端能用一次同源探测确定模式（[04 §2.1](../04-web-client.md)）：本地部署被 token 门挡住时也不能被误判成云入口。

## 4. 对外接口

- 启动：`startCloudServer(options)` → `{ port, principalId, controlPlane, loops, close() }`；测试注入缝（`hostServices`、`drivers`、`listenPort`）不得写真实 `~/.zcode`
- 路由：host `/ws`（lite-token）；`/api/cloud/*`（bearer）；`/ws/cloud/tasks/:taskId`；`/ws/cloud/bridge/:runId`。**执行节点面**（`/ws/cloud/bridge/*`、`/api/cloud/runs/:runId/git-grant`）按前缀/精确路径豁免 lite-token，改用各自的 run-scoped 鉴权（02 §4、01 §7.2）
- 模式探测（2026-10-07，§3.1）：两个模式都回答 `GET /api/cloud/capabilities`。云模式保持现状（需 token，401 未认证）；**本地模式无鉴权**返回 `mode=local`：`providers`/`features` 为空集、`taskOwnedAttachments=false`、`protocolVersion` 与云分支同源（同一 `CLOUD_WIRE_PROTOCOL_VERSION`）；不返回主体、不返回任何能力或秘密。响应形状由 shared 的 `capabilitiesResponseSchema` 按 `mode` 判别联合冻结（`packages/shared/src/cloud/responses.ts`）。
- 配置契约：`ZCODE_SERVER_MODE=local|cloud` 与全部新配置项进入公开配置契约（禁止散落 `process.env` 直读）

## 5. 边界与禁止

- **必须**调用 `createLocalServices` 启动 host 本体（决议⑧）；但**云任务与浏览器执行请求的落点只有沙箱 attachment**：host 执行域不得成为任何云任务/浏览器请求的隐式 fallback（请求无远端 owner 时返回结构化错误）。
- `/ws` 抽取必须是纯搬移（行为不变），local 模式回归通过。
- 不得在入口层内联业务规则（Task/Run/输入状态一律走 [W1](./W1-cloud-core.md) 的 contract）。
- 静态层不得吞掉 `/api/*` 与 `/ws/*` 路径；SPA fallback 只回 index.html。
- 未配置认证/数据目录不可写/迁移未就绪/provider 版本不兼容一律 fail-closed，不隐式切 local。
- 单一入口不得把两种模式混装：`=cloud` 走云启动事务，其余走本地行为；本地分支**不装配任何 cloud 路由**（只有 §4 的模式探测端点），云分支不退化成本地 fallback。

## 6. 验收

- 启动矩阵：缺 auth token、数据目录不可写、迁移失败、provider 版本不兼容 → 明确失败且无 provider 调用。
- 入口分派：`ZCODE_SERVER_MODE=cloud` 时 `entry-http` 起云入口；未设置/`local` 时行为与既有本地入口一致（含 lite-token 三条路径与 `/ws` 语义）。
- 模式探测：本地模式 `GET /api/cloud/capabilities` 在**配置了 authToken 时**仍无鉴权返回 `mode=local`（空能力集、同源 `protocolVersion`）；云模式同路径仍 401（无/错凭据）。
- host 通道：浏览器（或等价测试客户端）经 `/ws?token=` 完成一次账号域 RPC（如读取模型目录/设置），证明零新增装配可用。
- 边界：绕过 UI 请求本机 file/terminal/agent（云任务路径）→ 拒绝；`local` 模式启动与行为回归通过（抽取为纯搬移的证据：`http.ts` 行为 diff 与既有测试）。
- 关闭顺序：delivery loop → lifecycle loops → server close（含连接回收）→ cloud close → host 本体 dispose。
- 覆盖 `CP-01`（[03 §10](../03-control-plane.md)）、`[10 §6](../10-implementation-plan.md) B12` 的平台项。
- 真实命令：`pnpm typecheck`、`pnpm lint`、`architecture:check --changed`、cloud 入口测试。

## 7. 前置与并行

被 W0 阻塞；与 W1–W4、W7 并行。**阻塞 W6 的端点落地与 W8/W9 的 host `/ws` 语义**。

## 8. 风险与 spike

- 启动顺序里 host 本体与 cloud 迁移的先后、以及 host 落 `<dataDir>/.zcode/v2/` 与 cloud `cloud.db` 的目录冲突，需要在实现前用隔离目录跑一次实证（不得写真实 `~/.zcode`）。
- lite-token 校验从 `http.ts` 抽出时容易出现行为漂移，必须用既有测试对照。
