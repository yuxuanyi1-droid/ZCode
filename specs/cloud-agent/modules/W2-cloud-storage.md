# W2 — cloud-storage（SQLite worker 与附件存储）

状态：目标设计。归属：`packages/server/src/cloud/adapters/storage`，属于 `cloud-control-plane` 的 adapters 层。
前置：[W0](./W0-contract-freeze.md)。

## 1. 范围

做：独立 SQLite WAL 数据库 + storage worker（同步 `node:sqlite` 只在 worker 内跑）、迁移链、所有 repository port 的实现、附件受控存储（临时对象→校验→原子发布→引用）、启动可写性/锁/空间检测、备份所需的 schema 与投影一致性。
不做：领域规则与编排（[W1](./W1-cloud-core.md)）；附件上传的 HTTP 端点（[W5](./W5-cloud-entry.md)）；投影 exporter/WAL（[W6](./W6-cloud-execution.md)）。

## 2. 冻结依赖

- [03 §4](../03-control-plane.md)（表/约束/事务承诺）、[03 §5](../03-control-plane.md)（外部操作不是 DB 事务）
- [08 §2/§3](../08-project-task-model.md)（字段语义）、[01 §5](../01-provisioning.md)（创建/补偿的持久事实）
- [10 §7](../10-implementation-plan.md)（迁移与发布：additive、版本校验、降级阻止）
- W0 冻结的 DB schema 与迁移编号

## 3. 交付物

```text
packages/server/src/cloud/adapters/storage/
  storageWorkerMain.ts      worker 进程入口（同步 SQL 只在此）
  sqlite/                   schema 定义、迁移 0001..、CAS/唯一约束实现
  repositories/             task/run/input/operation/outbox/projection/checkpoint/artifact/credential
  attachments/              受控附件存储与清扫（内容地址、大小/类型、owner）
  health.ts                 可写性/锁/磁盘空间检测、迁移就绪门
```

## 4. 对外接口

- 实现 W0 冻结的 `StoragePort`、`OperationOutboxPort`、`InputRepo`、`RunRepo`、`TaskRepo`、`ProjectionRepo`、`InputPayloadRead`、`CredentialRepo`（凭据只存 hash/元数据）
- 输入正文读取接口：dispatcher 消费持久正文（[02 §6.1](../02-bridge-protocol.md)），不读调用方内存

## 5. 边界与禁止

- 事务与唯一约束承担状态迁移；**不得**用设置 JSON 或业务内存表替代（[03 §4](../03-control-plane.md)）。
- 不在 HTTP 事件循环执行大型 SQL；不得让 adapters 反向改 Task 状态（只回事实）。
- 不复用现有 tasks-index schema 或 `TaskIndexRepo` 实例；不把 sqlite 文件放多进程共享网络盘。
- 附件不得引用浏览器临时路径；未引用对象按保留期清扫。

## 6. 验收

- repository 集成（临时 SQLite + 临时附件目录）：事务/唯一约束（单有效写 run、`task+acceptanceSeq`、`owner+commandId`）、提交前后 crash、磁盘满/DB worker 错误、迁移链 fresh-DB 与增量一致。
- 覆盖 `CP-02/03/04`（[03 §10](../03-control-plane.md)）与 [10 §6](../10-implementation-plan.md) `B05` 的持久侧断言。
- 真实命令：`pnpm typecheck`、`pnpm lint`、`architecture:check --changed`、`node --import tsx --test test/cloud*.test.ts`。

## 7. 前置与并行

被 W0 阻塞；与 W1/W3/W4/W5/W7 并行。阻塞 W10 的故障注入（需要数据库故障点）。

## 8. 风险与 spike

- `synchronous=FULL` 与吞吐的取舍（[03 §4](../03-control-plane.md)）需要实测数据后再定，并写进迁移说明。
- 迁移链**沿用回退前编号**：`0001`/`0002`/`0003`/`0005` 已冻结，`0004` 永久退役不复用，下一条为 `0006`（依据 `packages/server/src/cloud/CONTRACT.md`；编号一经应用不可改）。开工前若判断需要全新线性链，必须在写代码前提出，不得中途改号。
