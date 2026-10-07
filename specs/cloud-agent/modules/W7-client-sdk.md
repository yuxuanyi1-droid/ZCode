# W7 — client-sdk（云端客户端 SDK）

状态：目标设计。归属：`packages/client/src/cloud`，公开入口经 `packages/client/src/index.ts` 导出。
前置：[W0](./W0-contract-freeze.md)。

## 1. 范围

做：云端 HTTP 传输（显式 origin、幂等键、错误归一）、控制面客户端（Project/Task/Run/Input/receipt/history/capabilities）、attachment 客户端（`/ws/cloud/tasks/:taskId` 的 ChannelClient 承载与订阅）、cursor/恢复语义、取消与重试（同 commandId）。
不做：UI 状态与渲染（[W8](./W8-ui-cloud.md)）；服务端实现（W1/W5）；平台差异（[W9](./W9-web-entry.md) 的 `IPlatformService`）。

## 2. 冻结依赖

- [03 §6/§6.2](../03-control-plane.md)（端点、错误信封、202 vs runtime ACK）、[04 §4/§5/§6](../04-web-client.md)（客户端落点、路由身份、API 映射）
- [02 §2/§4/§7.3](../02-bridge-protocol.md)（owner、地址、快照与 resume）、[07 §9](../07-connection-architecture.md)（多端订阅与恢复）
- W0 冻结的 wire schema（不得在 SDK 内自定义字段名）

## 3. 交付物

```text
packages/client/src/cloud/
  cloudHttpTransport.ts     显式 origin、bearer/cookie 模式、超时与错误归一
  cloudControlPlaneClient.ts projects/tasks/inputs/history/events/capabilities
  cloudAttachClient.ts      /ws/cloud/tasks/:taskId：ChannelClient + 订阅 + 重连
  cloudWireSchemas.ts       运行时校验（消费 shared，不复制）
  cloudApiError.ts          {code,message,retryable,traceId,details?} → 类型化错误，不解析文案
```

## 4. 对外接口

- 供 W8 使用的 hooks 层唯一入口：`createCloudClient({ origin, token, fetch? })` → `{ controlPlane, attach }`
- 订阅接口：`{ cursor, logEpoch }` 恢复；`resync-required` 显式上抛
- 幂等：所有写操作接受外部 `commandId`；重试复用同一 commandId（SDK 不自行生成新 key）

## 5. 边界与禁止

- 不解析错误文案判断语义；不把 token 写入 URL query；不落 localStorage 中的凭据正文。
- 不在此层做业务状态归属（如把 receipt 当 runtime ACK）；不缓存 Task/Run 权威事实。
- 不 import server 实现或 `@zcode/ui`；跨包只走公开入口。

## 6. 验收

- fixture round-trip：每个端点正常/错误/未知字段；未知协议版本拒绝。
- 语义用例：同 commandId 重试返回同 receipt；不同 payload → 409；`202` 与 `admitted` 区分；cursor 越界 → resync。
- 覆盖 [04 §9](../04-web-client.md) `W-05/W-07/W-08/W-09` 的客户端侧断言。
- 真实命令：`pnpm typecheck`、`pnpm lint`、`architecture:check --changed`、`packages/client` 测试。

## 7. 前置与并行

被 W0 阻塞；与 W1–W5 并行（可先对 W0 契约与 fixture 开发）。阻塞 W8（hooks 只经本 SDK 访问服务）。

## 8. 风险与 spike

- attachment 客户端的重连语义最易出错：先固定"断连=释放订阅、不释放沙箱、不重发输入"的用例，再写实现。
