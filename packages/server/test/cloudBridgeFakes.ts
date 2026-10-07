/**
 * W6 测试支撑：可控时钟、静默 logger、内存 WSS 传输与「控制面 CAS」假实现。
 *
 * 假控制面按 specs/cloud-agent 02 §5.1/§5.2 实现**服务端侧规则**（只存 hash、CAS 切换、
 * 每 socket 递增 connectionEpoch、同 attemptId 内容一致时复用 rotationId），
 * 这样 B-03/B-04/B-05 才能真正验证 bridge 的客户端恢复契约，而不是自证。
 */
import { createHash, randomUUID } from "node:crypto";
import type { BootstrapConfigFrame, CloudBridgeControlFrame, CloudRpcFrame } from "@zcode/shared";
import {
  CLOUD_BRIDGE_PROTOCOL_VERSION,
  cloudBridgeControlFrameSchema,
  cloudRpcFrameSchema,
} from "@zcode/shared";
import type { ExecutionClock, ExecutionLogger } from "../src/cloud/execution/app/ports.js";
import type {
  BridgeConnectionPort,
  BridgeTransportPort,
} from "../src/cloud/execution/app/ports.js";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function testLogger(): ExecutionLogger {
  const noop = (): void => undefined;
  return { debug: noop, info: noop, warn: noop, error: noop, scope: "test" };
}

/** 虚拟时钟：wait 立即 resolve 并推进虚拟时间，让「断网 >2 分钟」可断言而不真等。 */
export interface TestClock extends ExecutionClock {
  readonly elapsedMs: number;
  waits(): number[];
}

export function createTestClock(): TestClock {
  let elapsedMs = 0;
  const waits: number[] = [];
  return {
    now: () => 1_700_000_000_000 + elapsedMs,
    async wait(ms) {
      waits.push(ms);
      elapsedMs += ms;
      // 让出一轮事件循环：虚拟时间下重连循环必须能与其他任务交错，否则会饿死测试。
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    get elapsedMs() {
      return elapsedMs;
    },
    waits: () => waits,
  };
}

/** 一条内存连接对：写入对端即触发对端监听（同一 tick，便于确定性断言）。 */
export interface InMemoryConnection extends BridgeConnectionPort {
  /** 测试侧（控制面）→ bridge 的入站帧。 */
  deliver(frame: CloudBridgeControlFrame | CloudRpcFrame): void;
  /** bridge 发出的原始文本帧。 */
  sent: string[];
  sentFrames(): unknown[];
  closedReason(): string | null;
}

export function createMemoryConnectionPair(): {
  bridgeSide: InMemoryConnection;
  controlSide: {
    onFrame(listener: (frame: unknown) => void): { dispose(): void };
    send(frame: CloudBridgeControlFrame | CloudRpcFrame): void;
    close(reason: string): void;
    closed: () => boolean;
  };
} {
  const toBridge = new Set<(text: string) => void>();
  const toControl = new Set<(frame: unknown) => void>();
  const bridgeClose = new Set<(info: { reason: string; code?: number }) => void>();
  const controlClose = new Set<(info: { reason: string; code?: number }) => void>();
  const sent: string[] = [];
  let closeReason: string | null = null;
  let controlClosed = false;

  const fireClose = (reason: string) => {
    if (closeReason === null) closeReason = reason;
    for (const listener of Array.from(bridgeClose)) listener({ reason });
    for (const listener of Array.from(controlClose)) listener({ reason });
  };

  const bridgeSide: InMemoryConnection = {
    send(text) {
      sent.push(text);
      for (const listener of Array.from(toControl)) {
        listener(JSON.parse(text) as unknown);
      }
    },
    onText(listener) {
      toBridge.add(listener);
      return { dispose: () => toBridge.delete(listener) };
    },
    onClose(listener) {
      bridgeClose.add(listener);
      return { dispose: () => bridgeClose.delete(listener) };
    },
    close(reason) {
      fireClose(reason);
    },
    deliver(frame) {
      const text = JSON.stringify(frame);
      for (const listener of Array.from(toBridge)) listener(text);
    },
    sent,
    sentFrames: () => sent.map((text) => JSON.parse(text) as unknown),
    closedReason: () => closeReason,
  };

  return {
    bridgeSide,
    controlSide: {
      onFrame(listener) {
        toControl.add(listener);
        return { dispose: () => toControl.delete(listener) };
      },
      send(frame) {
        if (controlClosed) return;
        bridgeSide.deliver(frame);
      },
      close(reason) {
        controlClosed = true;
        fireClose(reason);
      },
      closed: () => controlClosed,
    },
  };
}

export interface FakeControlPlaneOptions {
  taskId: string;
  runId: string;
  runGeneration: number;
  initialToken: string;
  workspacePath?: string;
  /** 第 N 次 hello 之后的行为：`drop-welcome` 模拟响应丢失。 */
  dropWelcomeOnAttempt?: number;
  /** 模拟「CAS 已提交但控制面在发 welcome 前崩溃」。 */
  crashAfterCasOnAttempt?: number;
  repositoryFullName?: string;
  baseSha?: string;
  taskBranch?: string;
}

export interface RecordedHello {
  frame: Record<string, unknown>;
  accepted: boolean;
  reason?: "bad-credential" | "run-mismatch" | "duplicate-attempt-mismatch";
  rotationId?: string;
  connectionEpoch?: number;
}

/**
 * 控制面假实现：只持久 hash；新 socket 总是递增 connectionEpoch；
 * 同 attemptId + 同候选 + 同 run 复用 rotationId（02 §5.1 第 5 条）。
 */
export class FakeControlPlane {
  readonly hellos: RecordedHello[] = [];
  readonly attachments: { epoch: number; attemptId: string; rotationId: string; socket: number }[] =
    [];
  readonly rejectedFrames: { frame: unknown; reason: string }[] = [];
  private currentHash: string;
  private candidateHash: string | null = null;
  private attempt: { id: string; rotationId: string; candidateHash: string } | null = null;
  private epoch = 0;
  private socketCounter = 0;
  private helloTimes = 0;
  private bootstrapped = false;

  constructor(private readonly options: FakeControlPlaneOptions) {
    this.currentHash = sha256(options.initialToken);
  }

  /** 应当被当前有效凭据接受的 hash（断言用）。 */
  currentCredentialHash(): string {
    return this.currentHash;
  }

  rotationId(): string | null {
    return this.attempt?.rotationId ?? null;
  }

  /**
   * 处理一条入站帧；`socket` 是新连接的序号（每次 connect 递增）。
   * 返回是否为合法 bridge 帧。
   */
  handle(
    frame: unknown,
    control: ReturnType<typeof createMemoryConnectionPair>["controlSide"],
    socket: number,
  ): void {
    const parsed = cloudBridgeControlFrameSchema.safeParse(frame);
    if (parsed.success) {
      if (parsed.data.type === "bridge.hello") {
        this.handleHello(parsed.data as unknown as Record<string, unknown>, control, socket);
        return;
      }
      // 非 hello 的控制帧：按当前 attachment 的代际校验（旧 socket 一律拒绝）。
      const epoch = (parsed.data as { connectionEpoch?: number }).connectionEpoch;
      const current = this.attachments.at(-1);
      if (epoch !== undefined && (!current || epoch !== current.epoch)) {
        this.rejectedFrames.push({ frame: parsed.data, reason: "stale-epoch" });
        return;
      }
      if (parsed.data.type === "bridge.ready" && current && socket !== current.socket) {
        this.rejectedFrames.push({ frame: parsed.data, reason: "stale-socket" });
      }
      return;
    }
    const rpc = cloudRpcFrameSchema.safeParse(frame);
    if (rpc.success) {
      const current = this.attachments.at(-1);
      if (!current || rpc.data.connectionEpoch !== current.epoch || socket !== current.socket) {
        this.rejectedFrames.push({ frame: rpc.data, reason: "stale-attachment" });
        return;
      }
      return;
    }
    this.rejectedFrames.push({ frame, reason: "invalid-frame" });
  }

  private handleHello(
    hello: Record<string, unknown>,
    control: ReturnType<typeof createMemoryConnectionPair>["controlSide"],
    socket: number,
  ): void {
    this.helloTimes += 1;
    const attemptId = String(hello.helloAttemptId);
    const credentialHash = sha256(String(hello.credentialToken));
    const candidateHash = sha256(String(hello.candidateNextResumeToken));
    const record = (accepted: boolean, reason?: RecordedHello["reason"]): RecordedHello => {
      const entry: RecordedHello = { frame: hello, accepted, reason };
      this.hellos.push(entry);
      return entry;
    };

    if (!this.attempt) {
      // 首次 attempt：必须用当前凭据，CAS 切换到候选（02 §5.1 第 3 条）。
      if (credentialHash !== this.currentHash) {
        record(false, "bad-credential");
        this.reject(control, "unauthorized");
        return;
      }
      const rotationId = randomUUID();
      this.attempt = { id: attemptId, rotationId, candidateHash };
      this.candidateHash = candidateHash;
      this.currentHash = candidateHash;
      const entry = record(true);
      if (this.shouldCrashBeforeWelcome()) {
        // CAS 已提交、welcome 未发出：控制面崩溃，socket 断开（02 §5.2 的恢复起点）。
        entry.reason = undefined;
        control.close("control-plane-crash");
        return;
      }
      this.attach(control, attemptId, rotationId, socket, entry);
      return;
    }

    if (this.attempt.id === attemptId) {
      // 同 attempt 重试：要么用候选（首次事务已提交），要么退回原凭据（首次未提交）。
      const candidateMatches = credentialHash === this.attempt.candidateHash;
      const currentMatches = credentialHash === this.currentHash;
      if (!candidateMatches && !currentMatches) {
        record(false, "bad-credential");
        this.reject(control, "unauthorized");
        return;
      }
      // 内容不一致（候选变了）时拒绝，不复用 rotationId（02 §5.1 第 5 条）。
      if (candidateHash !== this.attempt.candidateHash) {
        record(false, "duplicate-attempt-mismatch");
        this.reject(control, "unauthorized");
        return;
      }
      const entry = record(true);
      this.attach(control, attemptId, this.attempt.rotationId, socket, entry);
      return;
    }

    // 新 attempt：旧 token 不能创建不同 attempt/新 attachment（02 §5.2 末段）。
    if (!this.attempt && credentialHash !== this.currentHash) {
      record(false, "bad-credential");
      this.reject(control, "unauthorized");
      return;
    }
    if (credentialHash !== this.currentHash) {
      record(false, "bad-credential");
      this.reject(control, "unauthorized");
      return;
    }
    const rotationId = randomUUID();
    this.attempt = { id: attemptId, rotationId, candidateHash };
    this.candidateHash = candidateHash;
    this.currentHash = candidateHash;
    const entry = record(true);
    this.attach(control, attemptId, rotationId, socket, entry);
  }

  private shouldCrashBeforeWelcome(): boolean {
    return (
      this.options.crashAfterCasOnAttempt !== undefined &&
      this.helloTimes === this.options.crashAfterCasOnAttempt
    );
  }

  private shouldDropWelcome(): boolean {
    return (
      this.options.dropWelcomeOnAttempt !== undefined &&
      this.helloTimes === this.options.dropWelcomeOnAttempt
    );
  }

  private reject(
    control: ReturnType<typeof createMemoryConnectionPair>["controlSide"],
    code: string,
  ): void {
    control.send({
      protocolVersion: CLOUD_BRIDGE_PROTOCOL_VERSION,
      type: "bridge.fault",
      faultCode: code as never,
      message: "credential rejected",
      retryable: false,
    });
    control.close("auth-rejected");
  }

  /** 新 socket 接管：总是递增 connectionEpoch（02 §5.1 第 5 条）。 */
  private attach(
    control: ReturnType<typeof createMemoryConnectionPair>["controlSide"],
    attemptId: string,
    rotationId: string,
    socket: number,
    entry: RecordedHello,
  ): void {
    this.epoch += 1;
    this.socketCounter = Math.max(this.socketCounter, socket);
    entry.rotationId = rotationId;
    entry.connectionEpoch = this.epoch;
    this.attachments.push({ epoch: this.epoch, attemptId, rotationId, socket });
    if (this.shouldDropWelcome()) {
      // welcome 丢失：客户端必须能用同一 attempt 的持久候选恢复（02 §5.2）。
      control.close("welcome-lost");
      return;
    }
    control.send({
      protocolVersion: CLOUD_BRIDGE_PROTOCOL_VERSION,
      type: "bridge.welcome",
      connectionEpoch: this.epoch,
      rotationId,
      capabilities: ["stdio-rpc", "projection-wal"],
      ingestCursors: [],
      policyVersion: "policy-1",
    });
    if (!this.bootstrapped) {
      this.bootstrapped = true;
      control.send(this.bootstrapConfig());
    }
  }

  bootstrapConfig(): BootstrapConfigFrame {
    return {
      protocolVersion: CLOUD_BRIDGE_PROTOCOL_VERSION,
      type: "bootstrap.config",
      taskId: this.options.taskId,
      workspacePath: this.options.workspacePath ?? "/workspace/repo",
      clone: {
        repositoryId: 42,
        repositoryFullName: this.options.repositoryFullName ?? "octo/demo",
        baseSha: this.options.baseSha ?? "a".repeat(40),
        taskBranch: this.options.taskBranch ?? "zcode/task-1",
      },
      provisioningEnvelopeJson: JSON.stringify({ version: 1, providers: [] }),
      credentialGeneration: 1,
      policyVersion: "policy-1",
    };
  }

  /** 建立一条到 fake 控制面的连接（每次调用都是一个新 socket）。 */
  transport(): BridgeTransportPort {
    return {
      connect: async () => {
        const pair = createMemoryConnectionPair();
        const socket = ++this.socketCounter;
        pair.controlSide.onFrame((frame) => this.handle(frame, pair.controlSide, socket));
        return pair.bridgeSide;
      },
    };
  }
}

export function memoryRpcFrame(
  type: "rpc.open" | "rpc.request" | "rpc.close",
  input: {
    runId: string;
    runGeneration: number;
    connectionEpoch: number;
    streamId: string;
    payload?: string;
  },
): CloudRpcFrame {
  const base = {
    protocolVersion: 1 as const,
    runId: input.runId,
    runGeneration: input.runGeneration,
    connectionEpoch: input.connectionEpoch,
    streamId: input.streamId,
  };
  if (type === "rpc.request") {
    return { ...base, type, payload: input.payload ?? "" } as CloudRpcFrame;
  }
  return { ...base, type } as CloudRpcFrame;
}
