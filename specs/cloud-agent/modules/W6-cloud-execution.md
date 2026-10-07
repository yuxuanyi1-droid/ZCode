# W6 — cloud-execution（沙箱内执行节点与 bridge）

状态：目标设计。归属：`packages/server/src/cloud/execution`，module id `cloud-execution`（独立受控子模块 + 独立构建入口）。
前置：[W1](./W1-cloud-core.md)、[W3](./W3-cloud-sandbox.md)、[W5](./W5-cloud-entry.md)。

## 1. 范围

做：沙箱内常驻 supervisor 与 bridge —— 出站 WSS 连接与握手（hello/welcome/ready/heartbeat/phase/fault）、token 轮换与候选恢复、`connectionEpoch` 接管、常驻 stdio RPC owner、浏览器 RPC 转接（`rpc.open/request/response/close`）、canonical 投影 exporter 与 WAL、bootstrap（clone/checkout/taskBranch、runtime 启动、provisioning target 安装、readiness 门控）、sandbox git（git-grant 取回、push、remote SHA 核验）、checkpoint/quiesce 执行、runtime owner（与 SSH 布局同构，网络断不写 stdin EOF）。
不做：Task/Run 状态机与投递编排（[W1](./W1-cloud-core.md)）；provider 生命周期（[W3](./W3-cloud-sandbox.md)）；入口路由与鉴权中间件（[W5](./W5-cloud-entry.md)）。

## 2. 冻结依赖

- [02](../02-bridge-protocol.md) 全文（所有者表、控制帧、握手与旋转、ready、输入通路、投影与 WAL、故障表）
- [01 §6.2/§7.2/§8](../01-provisioning.md)（bootstrap 步骤、git grant、checkpoint 与停止）
- [07 §2.7/§8/§10](../07-connection-architecture.md)（交互同构原则、执行节点 authority、故障表）
- [12 §6](../12-account-domain.md)（envelope 安装：账号态或静态，套餐保持 `zhipu-account`）

## 3. 交付物

```text
packages/server/src/cloud/execution/
  module.ts / contract.ts / contract.example.ts / CONTRACT.md    独立公开契约 + 构建入口
  supervisorMain.ts        常驻进程入口（自举 env 读取、单例、退出诊断）
  bridge/                  出站 WSS、hello/welcome/ready/heartbeat/phase、token 轮换与恢复、epoch 接管
  localRpcOwner.ts         常驻 stdio client（复用 remote/handshake.ts、remote/stdio-socket.ts）
  rpcRelay.ts              rpc.* 帧 ↔ 本地 ChannelServer 的受控转接
  projectionExporter.ts    订阅 V4 conversation topic → WAL → projection.batch/ack
  bootstrap/               clone/checkout/taskBranch、runtime 启动、provisioning target 安装、readiness
  sandboxGit.ts            git-grant 取回、push、ls-remote 核验（token 只过内存/pipe）
  checkpoint.ts            quiesce（投递屏障 + 工作区收口）、commit、push、remote SHA 上报
  runtimeOwner.ts          沙箱内 zcode-server 启动与生命周期（布局同 SSH：~/.zcode/server）
```

## 4. 对外接口

- 对 W5/W1：`/ws/cloud/bridge/:runId` 控制帧与 RPC 帧；`rpc.*` 承载浏览器 ChannelClient
- 对 W3：自举 env 契约、supervisor 启动命令与就绪探测
- 对 W4：`/api/cloud/runs/:runId/git-grant` 取回
- 对 W1：`bridge.ready`、checkpoint 请求/结果、run fault 上报

## 5. 边界与禁止

- **网络断不得给 zcode-server 写 stdin EOF**；不得把网络字节直通到唯一 stdio 管道再在断网时销毁它（[02 §2.7/§3](../02-bridge-protocol.md)）。
- 沙箱专用机制只允许归因到三类：传输、生命周期、无人值守恢复；其他一律不许进交互层（[07 §2.7](../07-connection-architecture.md)）。
- 不得改造 bridge 内部协议、不得引入第二队列；envelope 重推只能是"标记 + 下次连接重装"。
- 不得复制整个 credential store 到沙箱；只按 run 授权清单安装。
- 不得在沙箱内跑控制面逻辑（Task/Run 状态只在云服务端）。

## 6. 验收

- 覆盖 [02 §11](../02-bridge-protocol.md) `B-01–B-16` 中执行节点侧：`B-02`（断网 >2 分钟 PID 不变、Run 非 expired）、`B-03/B-04/B-05`（hello CAS 前后崩溃、丢 welcome 恢复、并发 hello/旧 socket）、`B-08/B-09`（投影 ACK 丢失、commit 与 WAL 之间崩溃）、`B-14`（无页面 prefs/权限应答由节点 responder 负责）。
- bootstrap 与 checkpoint：固定 baseSha/taskBranch、push 丢响应按 remote SHA 对账、no-changes 不建空提交。
- 真实 E2E：真实 provider（E2B 等）跑通 create → 出站 bridge → clone → runtime ready → 首输入 admitted → 模型答复 → stop/终止，记录 PID/沙箱内路径/remote SHA 证据。
- 真实命令：`pnpm typecheck`、`pnpm lint`、`architecture:check --changed`、`node --import tsx --test test/cloud*.test.ts`。

## 7. 前置与并行

被 W1/W3/W5 阻塞；与 W7/W8/W9 并行。阻塞 W10 的故障注入与端到端验收。

## 8. 风险与 spike

- M2 的 P06 spike（canonical projection 钩子是否提供完整已提交记录）是门槛：不成立就先改 [02](../02-bridge-protocol.md) 并给证据，不堆降级分支。
- Bridge 自身崩溃后的恢复边界（v1 不承诺重新接管 stdio 子进程）要如实实现并记录，不得盲 spawn 第二套。
