/**
 * W6 测试支撑：app 端口的确定性假实现（凭据存储、投影、bootstrap、runtime、git）。
 *
 * 这些假实现只替代**跨进程/跨设备边界**（文件、子进程、网络），保留 app 内部真实逻辑
 * （WAL 状态机、投影 exporter、checkpoint 流程）——否则 B-08/B-09 会变成自证。
 */
import type {
  BootstrapConfigFrame,
  CheckpointRequestFrame,
  CloudStreamCursor,
} from "@zcode/shared";
import type {
  BootstrapPort,
  CheckpointPort,
  CredentialStatePort,
  LocalRpcOwnerPort,
  ProjectionPort,
  ProjectionWalPort,
  RuntimeOwnerPort,
  RuntimeStdioStream,
} from "../src/cloud/execution/app/ports.js";
import type { CredentialStateSnapshot } from "../src/cloud/execution/domain/credentialRotation.js";
import {
  createProjectionWalState,
  type ProjectionWalState,
} from "../src/cloud/execution/domain/projectionWal.js";
import type { WalEntry } from "../src/cloud/execution/domain/projectionWal.js";
import type {
  GitRunOutcome,
  GitRunnerPort,
  SandboxGit,
  SandboxGitGrantPort,
} from "../src/cloud/execution/app/sandboxGit.js";
import { createSandboxGit } from "../src/cloud/execution/app/sandboxGit.js";
import { testLogger } from "./cloudBridgeFakes.js";

/** 共享的本地凭据文件（同一 Map 模拟同一文件系统：跨「进程」恢复可见）。 */
export function createCredentialStore(backing = new Map<string, CredentialStateSnapshot>()): {
  port: CredentialStatePort;
  raw: Map<string, CredentialStateSnapshot>;
  saves: number;
} {
  const store = { saves: 0 };
  return {
    port: {
      async load() {
        return backing.get("state") ?? null;
      },
      async save(state) {
        store.saves += 1;
        backing.set("state", { ...state });
      },
    },
    raw: backing,
    get saves() {
      return store.saves;
    },
  };
}

export interface ProjectionFake extends ProjectionPort {
  readonly wal: ProjectionWalState;
  readonly batches: unknown[][];
  readonly acks: { topic: string; logEpoch: string; lastContiguousSourceSeq: number }[];
  readonly store: ProjectionWalPort & { present(): WalEntry[] };
  readonly stopped: boolean;
  /** 直接注入一条记录（模拟 exporter 写完 WAL 后的待投递状态）。 */
  seed(record: unknown): void;
}

/** 投影面假实现：真实 WAL 状态机 + 内存 store，只把网络投递做成可观察数组。 */
export function createProjectionFake(): ProjectionFake {
  const wal = createProjectionWalState();
  const batches: unknown[][] = [];
  const acks: { topic: string; logEpoch: string; lastContiguousSourceSeq: number }[] = [];
  const persisted: WalEntry[] = [];
  const cursors: CloudStreamCursor[] = [];
  let stopped = false;

  const store: ProjectionWalPort & { present(): WalEntry[] } = {
    async load() {
      return { entries: persisted, cursors, healthy: true };
    },
    async save(entries, nextCursors) {
      persisted.length = 0;
      persisted.push(...entries);
      cursors.length = 0;
      cursors.push(...nextCursors);
    },
    present: () => [...persisted],
  };

  return {
    wal,
    batches,
    acks,
    store,
    get stopped() {
      return stopped;
    },
    seed(record) {
      wal.accept(record as never, 0);
    },
    async onAck(ack) {
      acks.push(ack);
      wal.ack({ topic: ack.topic, logEpoch: ack.logEpoch, sourceSeq: ack.lastContiguousSourceSeq });
      await store.save(wal.exportEntries(), wal.exportCursors());
    },
    async drain(limit) {
      const pending = wal.pending(limit);
      const records = pending.map((entry) => entry.record);
      if (records.length > 0) batches.push(records);
      return { records };
    },
    highWatermarks: () => wal.highWatermarks(),
    ready: () => ({ exporterReady: true, walReady: true }),
    async stop() {
      stopped = true;
    },
  };
}

export interface BootstrapFake extends BootstrapPort {
  readonly configs: BootstrapConfigFrame[];
  readonly phases: string[];
  readonly pid: number;
  stopped: boolean;
}

export function createBootstrapFake(
  runtime: { facts(): { pid: number | null; incarnation: string | null } } = {
    facts: () => ({ pid: 4321, incarnation: "runtime-4321" }),
  },
): BootstrapFake {
  const configs: BootstrapConfigFrame[] = [];
  const phases: string[] = [];
  const fake: BootstrapFake = {
    configs,
    phases,
    pid: runtime.facts().pid ?? 4321,
    stopped: false,
    async run(config) {
      configs.push(config);
      phases.push("ready");
      return {
        configVersion: config.policyVersion,
        runtimeIncarnation: runtime.facts().incarnation ?? "runtime-unknown",
        executionCapabilities: ["stdio-rpc"],
      };
    },
    onPhase(listener) {
      listener({ phase: "registering" });
      return { dispose: () => undefined };
    },
    runtimeFacts: () => runtime.facts(),
  };
  return fake;
}

export interface RuntimeFake extends RuntimeOwnerPort {
  readonly stopCalls: string[];
  readonly startCalls: number;
  readonly exitListeners: ((info: { code: number | null; signal: string | null }) => void)[];
  emitExit(code: number | null): void;
}

export function createRuntimeFake(pid = 4321): RuntimeFake {
  const stopCalls: string[] = [];
  const exitListeners: ((info: { code: number | null; signal: string | null }) => void)[] = [];
  let startCalls = 0;
  let alive = true;
  const stream: RuntimeStdioStream = {
    stdin: { write: () => true, end: () => undefined } as unknown as NodeJS.WritableStream,
    stdout: {} as NodeJS.ReadableStream,
    stderr: {} as NodeJS.ReadableStream,
    onClose: () => ({ dispose: () => undefined }),
  };
  return {
    stopCalls,
    exitListeners,
    get startCalls() {
      return startCalls;
    },
    async start() {
      startCalls += 1;
      alive = true;
      return { pid, incarnation: `runtime-${pid}`, stream };
    },
    async stop(reason) {
      stopCalls.push(reason);
      alive = false;
    },
    facts: () => ({ pid: alive ? pid : null, incarnation: alive ? `runtime-${pid}` : null }),
    onExit(listener) {
      exitListeners.push(listener);
      return { dispose: () => undefined };
    },
    emitExit(code) {
      alive = false;
      for (const listener of exitListeners) listener({ code, signal: null });
    },
  };
}

export interface LocalRpcFake extends LocalRpcOwnerPort {
  readonly connects: number;
  readonly disposals: string[];
  /** 注入一个可直接接收 ChannelServer 协议字节的通道实现。 */
  setChannel(
    name: string,
    channel: { call: (c: string, a?: unknown) => Promise<unknown>; listen: () => () => void },
  ): void;
}

export function createLocalRpcFake(): LocalRpcFake {
  const channels = new Map<
    string,
    { call: (c: string, a?: unknown) => Promise<unknown>; listen: () => () => void }
  >();
  const disposals: string[] = [];
  let connectCount = 0;
  const fake: LocalRpcFake = {
    disposals,
    get connects() {
      return connectCount;
    },
    async connect() {
      connectCount += 1;
      return { runtimeVersion: "test", capabilitiesVersion: "test" };
    },
    channel(name) {
      return (channels.get(name) as never) ?? null;
    },
    dispose() {
      disposals.push("dispose");
    },
    setChannel(name, channel) {
      channels.set(name, channel);
    },
  };
  return fake;
}

export interface GitRunnerFake extends GitRunnerPort {
  readonly calls: { argv: readonly string[]; env?: Record<string, string> }[];
  /** 每个命令的返回值；未配置时返回成功空输出。 */
  responses: GitRunOutcome[];
}

export function createGitRunnerFake(): GitRunnerFake {
  const calls: { argv: readonly string[]; env?: Record<string, string> }[] = [];
  const fake: GitRunnerFake = {
    calls,
    responses: [],
    async run(argv, options) {
      calls.push({ argv, env: options.env });
      return fake.responses.shift() ?? { code: 0, stdout: "", stderr: "" };
    },
  };
  return fake;
}

export function createGitGrantFake(issuer = "token-1"): SandboxGitGrantPort {
  return {
    async fetch(purpose) {
      return { token: `${issuer}-${purpose}`, expiresAt: Date.now() + 60_000, repositoryId: 42 };
    },
  };
}

export function createSandboxGitFake(
  runner: GitRunnerFake = createGitRunnerFake(),
): SandboxGit & { runner: GitRunnerFake } {
  const git = createSandboxGit({
    runner,
    grants: createGitGrantFake(),
    logger: testLogger(),
  });
  return Object.assign(git, { runner });
}

export function createCheckpointRecorder(): CheckpointPort & {
  readonly requests: CheckpointRequestFrame[];
} {
  const requests: CheckpointRequestFrame[] = [];
  const results = new Map<string, Awaited<ReturnType<CheckpointPort["run"]>>>();
  return {
    requests,
    async run(frame) {
      const cached = results.get(frame.operationId);
      if (cached) return cached;
      requests.push(frame);
      const result = {
        operationId: frame.operationId,
        status: "saved" as const,
        branch: "zcode/task-1",
        remoteSha: "b".repeat(40),
        hadNewCommits: true,
      };
      results.set(frame.operationId, result);
      return result;
    },
  };
}
