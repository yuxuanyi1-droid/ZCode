# W4 — cloud-github（GitHub App、PR 与 git grant）

状态：目标设计。归属：`packages/server/src/cloud/adapters/github` + `adapters/secret`，属于 `cloud-control-plane` 的 adapters 层。
前置：[W0](./W0-contract-freeze.md)。

## 1. 范围

做：GitHub App JWT 与 installation 解析、仓库列表与分支 HEAD、installation token mint（矩阵化最小权限）、draft PR 创建/更新/读取、checks/commit status 投影（M4 起）、GitHub 副作用 outbox（`GitHubEffect`）执行与对账、webhook 验签与 delivery inbox（M7 条件性）、git-grant broker 端点（run-scoped、单次兑换、60s、绑定 task/run/generation/repo/purpose）、云侧部署秘密加载（auth token、App 私钥，0600 fail-closed）。
不做：Task/Run 状态（[W1](./W1-cloud-core.md)）；沙箱内 helper 取回与 push（[W6](./W6-cloud-execution.md)）；HTTP 中间件与主体解析（[W5](./W5-cloud-entry.md)）。

## 2. 冻结依赖

- [09](../09-github-integration.md) 全文（权限矩阵、分支/PR 语义、撤权、webhook、幂等 effect）
- [01 §7.1/§7.2/§7.3](../01-provisioning.md)（凭据边界、git grant、commit 作者）
- [03 §6](../03-control-plane.md)（端点前缀与错误信封）、[12 §1.1/§6](../12-account-domain.md)（账号凭据归 host，本模块只管部署秘密）

## 3. 交付物

```text
packages/server/src/cloud/adapters/github/
  appAuth.ts          App JWT / installation 解析 / 权威 owner-name-defaultBranch
  repositories.ts     仓库列表（基于用户授权的 installation，不用 App JWT 全量列举）
  tokens.ts           mint（单 repo + 最小 permissions）、撤销尽力语义
  branches.ts         refs 查询 / baseSha 冻结 / taskBranch HEAD 核验
  pullRequests.ts     draft PR 创建/更新/读取、no-changes 处理、non-fast-forward 对账
  effects/            GitHubEffect outbox 执行器（幂等键、expectedHeadSha、对账）
  webhook/            验签 + delivery inbox + sender 授权（M7，条件性；未启用时返回 not_implemented）
  ../secret/deploySecrets.ts   部署秘密加载（auth token、App 私钥；缺文件 fail-closed）
  ../secret/gitGrantBroker.ts  run-scoped 单次兑换 broker（hash 持久、过期、撤销；已由 W5 入口装配挂载）
  ../secret/gitGrantRoute.ts   端点 handler（run-scoped 主体由入口的 resolveRunPrincipal 注入；已接线）
```

## 4. 对外接口

- 对 W1：`GitHubPort`（`listRepositories`、`getBranchHead`、`mintToken`、PR 读写、effect 入队）
- 对 W6：`/api/cloud/runs/:runId/git-grant` 的**语义**（run-scoped 认证，只接受执行节点出站；返回短效单次 token）——**端点已交付**：broker/handler 由本模块提供，路由挂载与 Bearer 主体解析由 W5 在入口装配（见 W5 §3，已接线）
- 对 W5：`createGitGrantBroker` / `createGitGrantRouteHandler`（+ `resolveRunPrincipal` 注入点，不在此模块读 cookie/query）；W5 侧装配在 `entry-cloud-git-grant.ts`

## 5. 边界与禁止

- App 私钥、JWT、installation token 只在云服务端；不进沙箱、不进浏览器、不进日志/payload。
- `contents:write` 是 repo 级权限，产品路径只推 `taskBranch`；不得声称已隔离（公开部署前需 write proxy 或等效策略，[01 §7.2](../01-provisioning.md)）。
- 不落 raw token；只持久 grantId/purpose/issuedAt/expiresAt 等元数据与 hash。
- 不得把 webhook 验签成功当作业务授权；sender 授权缺省拒绝。

## 6. 验收

- 权限矩阵用例：`metadata:read` / `contents:read` / `contents:write` / `pull_requests:*` / `checks:*` 各自的最小集，撤权后阻断后续副作用。
- grant 用例：单次兑换、重放拒绝、过期拒绝、旧 run 领取拒绝、磁盘/日志检查无 token。
- PR 用例：创建响应丢失、无 diff（noChanges）、non-fast-forward、base 改名、跨外部 push 对账。
- 覆盖 [10 §6](../10-implementation-plan.md) `B08/B09`、[09 §](../09-github-integration.md) 验收项。
- 真实命令：`pnpm typecheck`、`pnpm lint`、`architecture:check --changed`、模块测试；真实 GitHub 联调用测试仓库，记录权限与响应码证据。

## 7. 前置与并行

被 W0 阻塞；与 W1/W2/W3/W5/W7 并行。阻塞 W6 的 clone/push 通路与 W10 的 GitHub 侧验收。

## 8. 风险与 spike

- installation token 的撤销不可撤回已发 token：先把"发出/过期/撤销"事实持久化，再谈重开（[08 §3](../08-project-task-model.md)）。
- webhook 属 M7 条件性范围，实现前先确认部署模型仍为单用户（[00 §11⑤](../00-overview.md)），否则不要提前引入 delivery inbox。
