# cloud-execution 契约

沙箱内执行节点：常驻 supervisor 与 bridge（specs/cloud-agent/00 §8、02、13 §3）。
独立受控子模块：独立 `domain/app/adapters`、独立公开 contract 与构建入口。

模块根：`packages/server/src/cloud/execution`（比父模块 `cloud-control-plane` 更深，
按最深 root 归属）。依赖父模块只走 `packages/server/src/cloud/contract.ts`，
禁止深导入父模块 app/domain 实现。

## 分层与文件（W6 实现）

- `domain/`：纯决策（握手/旋转状态机、WAL 追加与 ACK 水位、ready 门控判定）。
- `app/`：bridge 编排、rpcRelay、projectionExporter、bootstrap、sandboxGit、checkpoint。
- `adapters/`：出站 WSS、常驻 stdio client、runtime owner。
- 入口：`supervisorMain.ts`。

## 对外面

| 方向     | 出口                                                                        |
| -------- | --------------------------------------------------------------------------- |
| 网络     | `/ws/cloud/bridge/:runId` 控制帧（`bridge.*`、`projection.*`）与 `rpc.*` 帧 |
| 对控制面 | `bridge.ready`、checkpoint 请求/结果、投影 batch、run fault 上报            |
| 对 W3    | 自举 env 契约、supervisor 启动命令与就绪探测                                |
| 对 W4    | `/api/cloud/runs/:runId/git-grant` 单次兑换                                 |

wire 形状唯一事实源是 `@zcode/shared` 的 cloud 公开入口；本模块 `contract.ts`
只做类型与 schema 再导出，不复制定义。attachment 端口（命令投递/checkpoint/drain、
投影 ingest）由父模块 contract 冻结，避免同规则两份定义。

W6 追加的装配入口（`contract.ts` 导出）：

| 导出                                 | 用途                                                                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createCloudCommandTransport`        | 实现父模块 `CloudCommandTransport`/`RuntimeCommandQueryPort`：命令信封经 `rpc.*` 帧走**同一** relay 通路，未接线/断连 fail-closed，不伪造 `sent`（02 §6.1、§2 不变量 6） |
| `bridgeUrl` / `readSupervisorConfig` | 出站 `/ws/cloud/bridge/:runId` 地址与自举 env 读取（W3 模板与运维诊断共用同一构造）                                                                                      |

沙箱 supervisor 装配不进本契约：它由 W3 的 `build:sandbox-assets` 直接从
`sandbox/supervisorMain.ts` 打包，避免云入口拉进沙箱运行时依赖。

## 不变量

0. **权威模式 = `cloud-execution-node`**（`ZCODE_SERVICE_AUTHORITY_MODE`，07 §8 冻结）：
   远端裁剪——**不提供**本机 workspace 执行（云任务落点只有沙箱 attachment，03 §2）；
   runtime preferences/policy 由**节点自身应答**，不依赖浏览器在线；**开启** provider
   provisioning target（账号/静态 envelope 经 `bootstrap.config` 安装，12 §6）。
   既有模式（`desktop-local`/`desktop-attached-remote`/`standalone-server`）语义与解析不变。
1. 网络断开只释放网络 facade：**不给 zcode-server 写 stdin EOF**，不销毁唯一 stdio
   管道，不重启 runtime（02 §2 不变量 7、§3）。
2. 外网 WSS 重连不回放旧帧：新 socket 接管递增 `connectionEpoch`，旧代际帧拒绝
   （02 §2 不变量 3）。
3. token 旋转采用「Bridge 先持久候选、控制面 CAS 切换 hash」；同 attemptId 内容一致
   复用 rotationId，不一致拒绝，两者都失败时 fail closed（02 §5.1/§5.2）。
4. 投影记录按 `(runId, runtimeIncarnation, topic, logEpoch, sourceSeq)` 去重：同键同
   hash 幂等，同键不同 hash 是一致性 fault；ACK 只覆盖连续持久水位，不跳缺口（02 §7.1）。
5. WAL 在收到持久 ACK 前不得清理；WAL 满/不可写时停新投递并有界暂停，不静默丢记录
   （02 §8）。
6. 沙箱专用机制只允许归因到传输、生命周期、无人值守恢复三类（07 §2.7）。

## W6 交付的文件

```text
domain/   credentialRotation.ts 投影恢复阶梯、projectionWal.ts WAL 水位/去重、
          readyGate.ts ready 门控、supervision.ts 断开分类与退避、gitPlan.ts git argv 规划、
          bridgeFrames.ts 帧编解码与方向校验
app/      bridgeSession.ts/bridgeState.ts/bridgeHandshake.ts/bridgeInbound.ts/bridgeHeartbeat.ts
          （握手、epoch 接管、入站路由、heartbeat 与批次）、rpcRelay.ts、commandTransport.ts、
          projectionExporter.ts、bootstrap.ts、sandboxGit.ts、checkpoint.ts、ports.ts
adapters/ bridgeTransport.ts（出站 WSS）、localRpcOwner.ts（常驻 stdio client）、
          runtimeOwner.ts（SSH 同构启动/监督）、credentialStateFile.ts、projectionWalStore.ts、
          gitRunner.ts（git + grant）、provisioningInstaller.ts、sessionTopicSource.ts、
          supervisorConfig.ts、supervisorRuntime.ts（装配）、executionSupport.ts
sandbox/  supervisorMain.ts（W3 构建入口）、runtimeStub.ts（runtime 通路自检）
```

## 测试入口

```
node --import tsx --test packages/server/test/cloud*.test.ts     # 含 execution 用例
```

## 边界与禁止

- 不改造 bridge 内部协议、不引入第二队列；凭据重推只能是「标记 + 下次连接重装」（12 §6）。
- 不复制整个 credential store 到沙箱；只按 run 授权清单安装（01 §7.1）。
- 沙箱内不跑控制面逻辑：Task/Run 状态只在云服务端（03 §2）。
