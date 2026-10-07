# W0 — 契约冻结（跨包，唯一串行前置）

状态：目标设计。归属：跨包契约，owner = 云方案维护者。roots：`packages/shared/src/cloud`、`architecture-policy.yaml`、各包 `package.json`（脚本/依赖登记）。
本文是 [13 §4](../13-module-map.md) Wave 0 的唯一工作单；**W1–W10 全部依赖它**，未冻结就并行开工必然返工。

## 1. 范围

做：把跨模块的 wire 契约、端点矩阵、DB schema、端口接口、模块登记一次冻结成单一来源；建立测试 runner 入口。
不做：任何业务实现（编排、SQLite、SDK、UI）。本工作单产出的是"类型 + schema + 登记 + 空壳契约"，不是功能。

## 2. 冻结依赖

- [00 §4/§5/§6](../00-overview.md)（所有者、身份、持久承诺）
- [02 §4/§5](../02-bridge-protocol.md)（地址、控制帧、握手）
- [03 §4/§6](../03-control-plane.md)（DB 表与约束、HTTP API 表）、[03 §7.1](../03-control-plane.md)（两个服务通道分面）
- [08 §2](../08-project-task-model.md)（领域模型与状态全集）
- [11 §3](../11-project-task-creation.md)（创建/首发契约）、[12 §4/§6](../12-account-domain.md)（账号域与 envelope）

## 3. 交付物

- `packages/shared/src/cloud/`：`index.ts`（唯一公开入口）、`bridge-protocol.ts`、`http-contracts.ts`、`responses.ts`、`domain.ts`、`rpc-protocol.ts`、`identity.ts`、`errors.ts`
- 端口类型草案（实现留在各自工作单）：`SandboxDriverPort`、`StoragePort`/`TaskRepo`/`RunRepo`/`InputRepo`/`ProjectionRepo`/`ProjectRepo`/`InputPayloadRead`/`RunCredentialRepo`、`OperationOutboxPort`、`GitHubPort`、`AttachmentPort`（控制面 → attachment）与 `AttachmentIngestPort`（attachment → 控制面）
- `architecture-policy.yaml` 登记两条模块：`cloud-control-plane`（root `packages/server/src/cloud`，managed，layers domain/app/adapters，publicEntrypoints `contract.ts`）、`cloud-execution`（root `packages/server/src/cloud/execution`，managed，独立 public entrypoint 与构建入口）
- 两个模块的四件套骨架：`module.ts` / `contract.ts` / `contract.example.ts` / `CONTRACT.md`（参照 [packages/services/src/storage/module.ts](../../../packages/services/src/storage/module.ts) 现有写法）
- 测试 runner 入口登记：`packages/server/test/cloud*.test.ts`、`packages/{shared,client,ui}/test`、`packages/web/test`；不得虚构 `pnpm test`/`pnpm e2e`

## 4. 对外接口（冻结对象）

| 类别     | 冻结内容                                                                                                                          |
| -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 地址     | `CloudRunAddress`、`CloudAttachmentAddress`（含 `workspaceIdentity=cloud-task:<taskId>` 与 `workspacePath` 分离）                 |
| 控制帧   | `bridge.hello/welcome/ready/heartbeat/phase/fault/drain`、`bootstrap.config`、`checkpoint.request/result`、`projection.batch/ack` |
| RPC 帧   | `rpc.open/request/response/close`（有界 base64 字节 + run/generation/epoch，每帧校验）                                            |
| HTTP     | [03 §6](../03-control-plane.md) 端点矩阵、错误信封 `{code,message,retryable,traceId,details?}`、分页信封 `{items,nextCursor?}`    |
| 领域     | Task/Run/Execution/Input/Checkpoint/Artifact 状态全集与 `deliveryStatus` 枚举                                                     |
| DB       | 表名、列、唯一约束、CAS 字段、迁移链编号（依据 [03 §4](../03-control-plane.md)）                                                  |
| 账号分面 | host `/ws`（lite-token）与 `/ws/cloud/tasks/:taskId` 各自的白名单（[03 §7.1](../03-control-plane.md)）                            |

## 5. 边界与禁止

- schema 一律严格（未知字段拒绝、长度/尺寸上限、拒绝未知协议版本），不得用 `z.unknown()` 兜业务字段。
- 不在 shared 里放 server/UI 实现或 SDK；`shared` 不依赖 `server`/`ui`。
- 不得为并行方便把同一规则复制到多个文件；跨包引用只能走 `packages/shared/src/index.ts` 导出。

## 6. 验收

- schema round-trip、非法输入、未知版本拒绝的用例通过（每个 schema 文件至少 1 组）。
- `pnpm architecture:check --changed` 0 violations（两条新模块登记生效）；`pnpm typecheck`、`pnpm lint` 真实结果。
- 交付一份端点/schema 对照表（谁生产、谁消费），供 W1–W9 反查。

## 7. 前置与并行

无前置。**阻塞 W1–W10 全部**。冻结完成前，其他工作单只能做不影响契约的内部准备（测试脚手架、fixture）。

## 8. 风险与 spike

- 端点形状与 DB schema 最容易在 Wave 1 暴露不足：先在 W0 用 [03 §6](../03-control-plane.md) 与 [11 §3](../11-project-task-creation.md) 的用例（CT-01–CT-20）反向核对一遍字段。
- 迁移链编号一旦落地就不能改（[06 §](../06-removal-docker-wsl.md) 数据保护要求），编号前先确认是否有并发 schema 变更。
