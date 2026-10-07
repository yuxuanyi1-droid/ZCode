/**
 * cloud-execution 公开契约：沙箱执行节点 bridge 的对外面（specs/cloud-agent/02）。
 * 控制面与入口侧只从这里 import；bridge 的 WSS 连接、stdio owner、WAL、bootstrap、
 * sandbox git 等实现在模块内部各层（W6）。
 *
 * 本次 W0 只冻结「与外部交换什么」：
 * - wire 形状唯一事实源是 `@zcode/shared` 的 cloud 公开入口（地址、控制帧、RPC 帧、
 *   投影记录），本文件只做类型再导出，不复制 schema；
 * - attachment 端口（命令投递/checkpoint/drain 与投影 ingest）由父模块
 *   cloud-control-plane 的 contract.ts 冻结，避免同一规则出现两份定义；
 * - domain/app/adapters 的具体决策函数（握手 CAS、WAL、ready 门控）属 W6 实现，
 *   W0 不预置空函数占位。
 */
export type {
  BridgeDrainFrame,
  BridgeFaultFrame,
  BridgeHeartbeatFrame,
  BridgeHelloFrame,
  BridgePhaseFrame,
  BridgeReadyFrame,
  BridgeWelcomeFrame,
  CloudAttachmentAddress,
  CloudBridgeControlFrame,
  CloudBridgeFrameDirection,
  CloudBridgeFrameType,
  CloudProjectionRecord,
  CloudRunAddress,
  CloudRpcFrame,
  CloudRpcFrameType,
  CloudStreamCursor,
  ProjectionAckFrame,
  ProjectionBatchFrame,
} from "@zcode/shared";

export {
  CLOUD_BRIDGE_PROTOCOL_VERSION,
  CLOUD_RPC_PROTOCOL_VERSION,
  cloudBridgeControlFrameSchema,
  cloudRpcFrameSchema,
  isCloudBridgeFrameInboundAllowed,
  isCloudRpcFrameInboundAllowed,
} from "@zcode/shared";

// ── W6 追加：对 W5/W1 的装配入口（实现在模块内部各层）──

/**
 * 控制面命令传输缝：把 V4 命令信封经 `rpc.*` 帧送到沙箱 runtime，并提供按 commandId
 * 的事实查询（02 §6.1/§6.2/§6.3）。W5 装配注入；未接线时调用方 fail-closed，
 * 不得伪造 `sent`（02 §2 不变量 6 的四类 ACK 不得互相冒充）。
 *
 * 注意：本入口刻意不导出沙箱 supervisor 装配（`adapters/supervisorRuntime.ts`）——
 * 那条链会拉进沙箱运行时的重型依赖，而 supervisor 由 W3 的 `build:sandbox-assets`
 * 直接从 `sandbox/supervisorMain.ts` 打包，不需要经云入口引用。
 */
export {
  createCloudCommandTransport,
  type CloudCommandTransport,
  type CloudCommandTransportOptions,
  type CommandConnectionKey,
  type CommandQueryResult,
  type CommandRunContext,
  type CommandSendResult,
} from "./app/commandTransport.js";

/** 出站 bridge 地址与自举配置读取（W3 模板/运维诊断共用同一构造，避免各处手写 URL）。 */
export {
  bridgeUrl,
  readSupervisorConfig,
  type SupervisorBootstrapConfig,
} from "./adapters/supervisorConfig.js";
