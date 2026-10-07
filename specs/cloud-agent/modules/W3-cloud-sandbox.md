# W3 — cloud-sandbox（provider 适配与沙箱资产）

状态：目标设计。归属：`packages/server/src/cloud/adapters/sandbox` + 沙箱模板/脚本资产，属于 `cloud-control-plane` 的 adapters 层。
前置：[W0](./W0-contract-freeze.md)。

## 1. 范围

做：E2B / Modal / Daytona 三家 driver 实现 `SandboxDriverPort`（create/inspect/extend/terminate/findCreateResult 与能力声明）、capability 门控、创建结果对账与补偿分类、自举通道（在 create 成功路径内拉起 supervisor，失败即补偿）、沙箱模板与 `start-supervisor.sh`、supervisor/runtime bundle 的构建入口与版本/摘要清单、资产分发端点。
不做：Task/Run 状态（只回 provider observation，由 [W1](./W1-cloud-core.md) 裁决）；bridge 协议与 stdio owner（[W6](./W6-cloud-execution.md)）；入口路由（[W5](./W5-cloud-entry.md)）。

## 2. 冻结依赖

- [01 §4](../01-provisioning.md)（驱动契约、三家差异、期限与配额）、[01 §5](../01-provisioning.md)（供给事务与重启对账）、[01 §6](../01-provisioning.md)（模板与 bootstrap）
- [02 §5.3](../02-bridge-protocol.md)（ready 条件中与本模块相关的部分）、[07 §10](../07-connection-architecture.md)（故障表）
- [10 §6](../10-implementation-plan.md) `B14`（成本/孤儿资源）

## 3. 交付物

```text
packages/server/src/cloud/adapters/sandbox/
  sandboxDriverPort 实现：e2bDriver / modalDriver(+modalSdkBridge) / daytonaDriver
  capabilities.ts        能力声明与门控（未实测解禁前不显示可选）
  reconcile.ts           findCreateResult / 标签关联 / 补偿 terminate 分类
  sandboxSupervisorStart.ts  共用自举契约（env 名映射、有界重试、startSupervisorOrTerminate；只下发自举要素，凭据走 bridge 的 bootstrap.config）
  assets/                版本/hash 清单与分发（bootstrap/runtime bundle）
模板资产：e2b.Dockerfile / Modal image / Daytona snapshot、start-supervisor.sh（flock 单例、0755）
构建入口：新增 package scripts（bundle 构建 + 版本摘要），不进已撤销包
```

## 4. 对外接口

- 对 W1：`SandboxDriverPort` 全量 + 能力声明（`createOperationLookup`、`canInspect`、`canExtendDeadline`、`canConfirmTermination`、`deadlineSource`、`supportsOutboundWss`）
- 对 W6：自举 env 契约（runId/runGeneration/ticket 的通道与名映射）、supervisor 启动命令与就绪探测
- 对 W5：资产分发端点（版本/hash 校验，失败不回退未校验旧包）

## 5. 边界与禁止

- provider SDK 只出现在本模块；调用一律异步 + 有限重试 + 可取消。
- 不得用共同接口抹平期限/资源/停止语义；不支持的能力返回显式能力错误，不伪造成功。
- 无原生 idempotency 时不得声称 exactly-once：未知结果进对账，不自动第二次 create。
- label/tag 不含 prompt、用户内容或凭据；ticket 只经秘密注入通道，不进 argv/URL/日志。

## 6. 验收

- adapter contract 测试：成功 / 明确失败 / 结果未知三分支，含 `create 丢响应`、`迟到 handle`、`terminate 未确认`。
- 每家 provider 真实账号联调（能力、期限、停止、启动开销）后才解除门控；记录真实资源与费用证据。
- 覆盖 [10 §6](../10-implementation-plan.md) `B14`、[01 §10](../01-provisioning.md) 的 provider 差异场景。
- 真实命令：`pnpm typecheck`、`pnpm lint`、`architecture:check --changed`、模块测试；真实联调单独报告环境与限制。

## 7. 前置与并行

被 W0 阻塞；与 W1/W2/W4/W5/W7 并行。**阻塞 W6**（自举通道与模板就绪）。

## 8. 风险与 spike

- Modal 通道（Python SDK 桥）与 Daytona toolbox 通道的可用性需先实测再定实现形态；实测不可用就保持证据化门控，不写降级分支。
- 沙箱内 `~/.zcode/server` 布局必须与 [connect.ts](../../../packages/server/src/remote/connect.ts) 的 SSH 布局一致，否则交互同构失效。
