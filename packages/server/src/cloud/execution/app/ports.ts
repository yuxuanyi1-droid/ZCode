/**
 * cloud-execution app 层的窄端口（specs/cloud-agent/02 §3/§5/§7，W6 §4 对外接口）。
 *
 * app 只依赖这些接口；出站 WSS、常驻 stdio client、本地文件、git 进程都在 adapters
 * 实现并由入口装配。端口刻意保持窄：会话不需要知道 ws/child_process 的存在。
 */
import type {
  BootstrapConfigFrame,
  CheckpointRequestFrame,
  CloudRunAddress,
  CloudStreamCursor,
} from "@zcode/shared";
import type { Event, IChannel } from "@zcode/rpc";
import type { createServiceLogger } from "@zcode/services/node";
import type { CredentialStateSnapshot } from "../domain/credentialRotation.js";
import type { WalEntry } from "../domain/projectionWal.js";

/** 时钟与等待：可注入，测试用虚拟时钟证明「断网 >2 分钟」而不真等。 */
export interface ExecutionClock {
  now(): number;
  wait(ms: number, signal?: { cancelled(): boolean }): Promise<void>;
}

/** 出站 WSS 连接（adapter 实现；app 只看到文本帧与关闭事件）。 */
export interface BridgeConnectionPort {
  send(text: string): void;
  /** 入站文本帧；解析/方向/尺寸校验在 app 侧（domain/bridgeFrames.ts）。 */
  onText(listener: (text: string) => void): { dispose(): void };
  /** 连接关闭（含错误关闭）；只释放网络 facade，不影响本地 stdio。 */
  onClose(listener: (info: { reason: string; code?: number }) => void): { dispose(): void };
  close(reason: string): void;
}

export interface BridgeTransportPort {
  /** 建立到 `/ws/cloud/bridge/:runId` 的出站连接；失败即 reject（调用方退避重试）。 */
  connect(url: string): Promise<BridgeConnectionPort>;
}

/** 本地凭据文件（发送 hello 之前必须写成功；原子替换、权限受限）。 */
export interface CredentialStatePort {
  load(): Promise<CredentialStateSnapshot | null>;
  save(state: CredentialStateSnapshot): Promise<void>;
}

/** WAL 持久化端口：内存决策在 domain/projectionWal.ts，这里只负责落盘/恢复。 */
export interface ProjectionWalPort {
  /** 启动恢复；`healthy=false` 表示上次写入失败（ready 门控据此拒绝 ready，02 §5.3）。 */
  load(): Promise<{ entries: WalEntry[]; cursors: CloudStreamCursor[]; healthy: boolean }>;
  /** 原子替换当前 WAL 内容（pending 记录 + 已 ACK 水位）。 */
  save(entries: readonly WalEntry[], cursors: readonly CloudStreamCursor[]): Promise<void>;
}

/** 服务日志（AGENTS 日志规范）：`createServiceLogger(scope)` 的形状 + 明确 scope 标签。 */
export type ExecutionLogger = ReturnType<typeof createServiceLogger> & { readonly scope: string };

/** 会话暴露给内部组件的代际上下文（每一帧都按它校验，旧代际拒绝）。 */
export interface AttachmentContext {
  address: CloudRunAddress;
  connectionEpoch: number;
  runGeneration: number;
}

/** 投影 exporter 的会话面：WAL 水位、投递批次、ACK 落盘。 */
export interface ProjectionPort {
  /** 收到持久 ACK：只清匹配源流的连续水位（02 §7.1）。 */
  onAck(frame: { topic: string; logEpoch: string; lastContiguousSourceSeq: number }): Promise<void>;
  /** 待投递批次（有界）；容量耗尽时返回空批并发 fault。 */
  drain(limit: number): Promise<{ records: unknown[] } | { capacityExceeded: true }>;
  highWatermarks(): CloudStreamCursor[];
  /** ready 门控用：exporter/WAL 是否可写（02 §5.3）。 */
  ready(): { exporterReady: boolean; walReady: boolean };
  stop(): Promise<void>;
}

/** bootstrap 运行面（clone/checkout/taskBranch、runtime 启动、envelope 安装、readiness）。 */
export interface BootstrapPort {
  /** 消费 `bootstrap.config`；返回 ready 帧所需的报告（失败抛出带阶段/错误码的错误）。 */
  run(config: BootstrapConfigFrame): Promise<{
    configVersion: string;
    runtimeIncarnation: string;
    executionCapabilities: string[];
  }>;
  /** 上报阶段（bridge.phase）；错误码只带归一码与脱敏诊断。 */
  onPhase(listener: (phase: { phase: string; errorCode?: string; diagnostics?: string }) => void): {
    dispose(): void;
  };
  /** runtime 进程事实（PID/incarnation），用于 heartbeat 与断网不变量断言。 */
  runtimeFacts(): { pid: number | null; incarnation: string | null };
}

/** 运行时进程的 stdio 形状（与 `remote/backend.ts` 的 StdioStream 结构兼容，可直传既有原语）。 */
export interface RuntimeStdioStream {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  onClose: Event<number>;
}

/** 沙箱内 zcode-server 的启动与生命周期（布局同 SSH：`~/.zcode/server`）。 */
export interface RuntimeOwnerPort {
  start(): Promise<{ pid: number; incarnation: string; stream: RuntimeStdioStream }>;
  /** 显式停止（只在生命周期操作里调用；网络断开不触发，02 §3）。 */
  stop(reason: string): Promise<void>;
  facts(): { pid: number | null; incarnation: string | null };
  onExit(listener: (info: { code: number | null; signal: string | null }) => void): {
    dispose(): void;
  };
}

/** 常驻 stdio RPC client（复用 `remote/handshake.ts` 与 `remote/stdio-socket.ts`）。 */
export interface LocalRpcOwnerPort {
  connect(
    stream: RuntimeStdioStream,
  ): Promise<{ runtimeVersion: string; capabilitiesVersion: string }>;
  /** 受控通道访问器：只返回白名单内的本地 channel（relay 用）。 */
  channel(name: string): IChannel | null;
  /** 只在显式停止时调用；网络断开**不得**走到这里（02 §2 不变量 7）。 */
  dispose(): void;
}

/** rpc.* 帧的受控转接（浏览器 ChannelClient ↔ 本地常驻 stdio client）。 */
export interface RpcRelayPort {
  /** 已通过的 attachment 上下文；旧 epoch/旧 generation 的帧在这里被拒绝。 */
  handle(frame: unknown, context: AttachmentContext): void;
  /** 连接释放：清网络侧 client 与订阅，保留 stdio/runtime（02 §0）。 */
  releaseAll(reason: string): void;
}

/** drain（08 §8.1 停止屏障）：先 quiesce + checkpoint，再让上层关连接。 */
export interface DrainPort {
  onDrain(request: { operationId: string; reason: string }): Promise<void>;
}

/** checkpoint 执行面（quiesce → commit → push → remote SHA 核验）。 */
export interface CheckpointPort {
  /** 幂等：同一 operationId 重放复用结果，不产生第二个保存事实（01 §8）。 */
  run(frame: CheckpointRequestFrame): Promise<{
    operationId: string;
    status: "saved" | "failed" | "unknown";
    branch?: string;
    remoteSha?: string;
    hadNewCommits?: boolean;
    errorCode?: string;
    error?: string;
  }>;
}
