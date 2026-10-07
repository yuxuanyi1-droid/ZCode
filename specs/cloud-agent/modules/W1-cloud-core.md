# W1 — cloud-core（`cloud-control-plane` 的 domain + app）

状态：目标设计。归属：`packages/server/src/cloud/{domain,app}`，module id `cloud-control-plane`，owner = 云编排。
前置：[W0](./W0-contract-freeze.md)。

## 1. 范围

做：Task/Run/配额/幂等/保存策略的领域规则；输入接纳与投递编排、attachment 注册与命令路由、投影 ingest 与历史读、供给编排、生命周期与对账、启动恢复。全部**只依赖端口**，不含 IO 实现。
不做：SQLite/worker（[W2](./W2-cloud-storage.md)）、provider SDK（[W3](./W3-cloud-sandbox.md)）、GitHub API（[W4](./W4-cloud-github.md)）、HTTP/WS 路由与进程装配（[W5](./W5-cloud-entry.md)）、沙箱内 bridge（[W6](./W6-cloud-execution.md)）。

## 2. 冻结依赖

- [08](../08-project-task-model.md) 全文（状态全集、单活写入、保存/恢复语义）——**领域规则唯一来源，不得复述改写**
- [03 §4/§5/§6](../03-control-plane.md)（事务、外部操作对账、输入契约）、[03 §6.1/§6.2](../03-control-plane.md)（fingerprint、acceptanceSeq、投递收口）
- [11](../11-project-task-creation.md)（创建/首发/草案配置）、[01 §2/§5](../01-provisioning.md)（供给事务与 readiness）、[02 §2/§6/§7](../02-bridge-protocol.md)（所有者表、输入通路、投影语义）

## 3. 交付物

```text
packages/server/src/cloud/
  domain/    taskRun 状态迁移、quota、idempotency（creationKey/commandId/payloadHash）、savePolicy
  app/
    taskService.ts            Project/Task/draftStartConfig/revision
    runOrchestrator.ts        预约→create→ready→drain 的生命周期编排（经端口）
    inputDelivery/            单一 durable gateway + outbox dispatcher + 取消/对账
    attachments/              CloudAttachmentRegistry、命令路由、心跳看门狗
    commands/                 interaction 决定、stop/reopen/cancel 编排
    projections/              ingest、snapshot/水位、history 读、resume
    provisioning/             create 操作恢复、readiness、补偿清理
    lifecycle/                保活、idle/deadline drain、checkpoint/stop 对账
    reconciler/               启动恢复扫描、provider 存活核验
    credentialAuthorization/  run 授权策略、秘密白名单、git grant 元数据
  contract.ts / contract.example.ts / CONTRACT.md   （对外唯一入口）
```

## 4. 对外接口

- 对 W5（入口）：`assembleCloudControlPlane()`、`registerRoutes(app, …)`、`startCloudLifecycleLoops()`、`close()`
- 对 W6：两个方向的端口对——`AttachmentPort`（命令投递、checkpoint、drain）与 `AttachmentIngestPort`（投影 batch、runtime ACK、run fault）；契约见 `packages/server/src/cloud/app/ports/`
- 对 W2：`StoragePort`/`OperationOutboxPort`/repository 端口（唯一持久入口）
- 对外事件：metadata 投影（`task.changed`/`run.changed` + revision），SSE 只做通知不做可靠投递

## 5. 边界与禁止

- `domain/` 不得 IO、不得读时间以外环境；所有副作用经端口。
- 不得在 app 内 import `adapters/*`、SQLite、provider SDK、Hono（路由属 W5）。
- 不得新建第二套输入队列或把 outbox 当 runtime 队列（[02 §6.1](../02-bridge-protocol.md)）；admission 顺序、busy 队列、权限裁决只在 runtime。
- 不得为了并行方便在 app 内复制 shared schema。

## 6. 验收

- domain 单测：注入 clock、无 IO；覆盖状态迁移、到期、配额、代际、幂等（[10 §5](../10-implementation-plan.md) 层级表）。
- app 集成：只替换端口 fake；覆盖 `CP-02/03/06/07/08/10/11/12/13`（[03 §10](../03-control-plane.md)）与 `CT-01–CT-20` 中非 UI 部分（[11](../11-project-task-creation.md)）。
- 真实命令：`pnpm typecheck`、`pnpm lint`、`architecture:check --changed`、`node --import tsx --test test/cloud*.test.ts`（以届时 package.json 为准）。

## 7. 前置与并行

被 W0 阻塞；与 W2/W3/W4/W5/W7 并行。**阻塞 W6**（attachment/dispatcher 契约）与 W5（装配调用点）。

## 8. 风险与 spike

- 输入去重与外部预检的先后顺序（[03 §6.1](../03-control-plane.md)）是最容易实现错的点：先在 domain 层用表驱动用例固定期望。
- `quiesce` 无等待面这一已知边界（[08 §8.1](../08-project-task-model.md)）必须在代码注释与验收里如实标注，不得用 sleep 冒充同步。
