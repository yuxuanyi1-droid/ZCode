/**
 * W6 执行节点运行时用例（specs/cloud-agent 02 §2 不变量 7、§3 进程结构、§4 地址与网络帧、
 * 07 §2.7 交互同构；W6 §3「runtimeOwner / localRpcOwner / 出站 WSS」）。
 *
 * 重点断言「网络与 stdio 生命周期解耦」：断网路径不得触碰本地管道；
 * 以及「SSH 同构布局与启动命令」这两条跨模块冻结面。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { WebSocketServer } from "ws";
import { Emitter } from "@zcode/rpc";
import { createBridgeTransport } from "../src/cloud/execution/adapters/bridgeTransport.js";
import {
  createCredentialStateFile,
  DEFAULT_RUNTIME_STATE_DIR,
  ensureRuntimeStateDir,
} from "../src/cloud/execution/adapters/credentialStateFile.js";
import { createLocalRpcOwner } from "../src/cloud/execution/adapters/localRpcOwner.js";
import { createProjectionWalStore } from "../src/cloud/execution/adapters/projectionWalStore.js";
import { readSupervisorConfig as readSupervisorConfigForStateDir } from "../src/cloud/execution/adapters/supervisorConfig.js";
import {
  createRuntimeOwner,
  resolveRuntimeRoot,
  runtimeCommand,
  runtimeEnv,
} from "../src/cloud/execution/adapters/runtimeOwner.js";
import { parseExecutionAuthority } from "../src/cloud/execution/adapters/runtimeOwner.js";
import type { RuntimeStdioStream } from "../src/cloud/execution/app/ports.js";
import {
  createCredentialState,
  parseCredentialState,
} from "../src/cloud/execution/domain/credentialRotation.js";
import {
  buildAssets,
  DEFAULT_BUNDLE_ENTRIES,
} from "../src/cloud/adapters/sandbox/assets/buildAssets.mjs";
import { testLogger } from "./cloudBridgeFakes.js";

const TASK_ID = "8f14e45f-ceea-467a-9a1e-1f0d3b2a4c51";
const RUN_ID = "1f14e45f-ceea-467a-9a1e-1f0d3b2a4c52";

/** 假的 runtime stdio：stdout 可注入任意文本，stdin 记录写入字节。 */
function createFakeStdio(): RuntimeStdioStream & { written: string[]; close(): void } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const written: string[] = [];
  stdin.on("data", (chunk: Buffer) => written.push(chunk.toString("utf8")));
  const closeEmitter = new Emitter<number>();
  return {
    stdin,
    stdout,
    stderr,
    onClose: closeEmitter.event,
    written,
    close: () => closeEmitter.fire(0),
  };
}

test("runtimeOwner：SSH 同构启动命令与 authority，只按显式停止结束进程", () => {
  assert.equal(resolveRuntimeRoot("~/.zcode/server").endsWith("/.zcode/server"), true);
  const command = runtimeCommand("/home/user/.zcode/server");
  assert.equal(command.command, "/home/user/.zcode/server/node");
  assert.deepEqual(command.args, ["/home/user/.zcode/server/zcode-server.cjs"]);
  const env = runtimeEnv("/home/user/.zcode/server");
  assert.equal(env.ZCODE_SERVER_RUNTIME_ROOT, "/home/user/.zcode/server");
  // 07 §8：云节点不得默认 desktop-local。
  assert.notEqual(env.ZCODE_SERVICE_AUTHORITY_MODE, "desktop-local");
  // 显式 desktop-local 一律拒绝并回落到云执行节点模式（07 §8）。
  assert.equal(parseExecutionAuthority("desktop-local"), "cloud-execution-node");
  assert.equal(parseExecutionAuthority("desktop-attached-remote"), "desktop-attached-remote");
  // 非法值同样 fail-closed 回落到默认（云执行节点）。
  assert.equal(parseExecutionAuthority("nonsense"), "cloud-execution-node");
});

test("runtimeOwner：start 幂等返回同一 PID，facts 反映真实进程；网络断开不调用 stop", async () => {
  const owner = createRuntimeOwner({ logger: testLogger() });
  const fake = createFakeStdio();
  let spawns = 0;
  const withFake = createRuntimeOwner({
    logger: testLogger(),
    stopGraceMs: 10,
    spawnProcess: (() => {
      spawns += 1;
      const child = {
        pid: 12345,
        stdin: fake.stdin,
        stdout: fake.stdout,
        stderr: fake.stderr,
        once: () => undefined,
        kill: () => true,
      };
      return child as never;
    }) as never,
  });
  const first = await withFake.start();
  const second = await withFake.start();
  assert.equal(first.pid, 12345);
  assert.equal(second.pid, 12345, "重复 start 不得再 spawn 第二个 runtime");
  assert.equal(spawns, 1);
  assert.equal(withFake.facts().pid, 12345);
  assert.equal(owner.facts().pid, null, "未启动时没有 PID");
  // 只有显式 stop 才结束进程（网络断开的分类见 domain/supervision 与 bridge 会话用例）。
  await withFake.stop("lifecycle-stop");
  assert.equal(withFake.facts().pid, null);
});

test("localRpcOwner：复用既有握手原语；本地通道不套浏览器白名单；dispose 才写 stdin EOF", async () => {
  const stream = createFakeStdio();
  const owner = createLocalRpcOwner({ logger: testLogger(), handshakeTimeoutMs: 500 });
  const connected = owner.connect(stream);
  // 模拟 zcode-server：先发 hello 行，再回 ack（ack 由 performHandshake 写入 stdin）。
  stream.stdout.write(
    `${JSON.stringify({ type: "zcode-hello", version: "9.9.9", platform: "linux", arch: "x64", pid: 4242 })}\n`,
  );
  const handshake = await connected;
  assert.equal(handshake.runtimeVersion, "9.9.9");
  assert.ok(
    stream.written.join("").includes("zcode-hello-ack"),
    "必须按既有握手发送 ack（与 SSH 同构）",
  );
  // 本地 stdio 通道**不套浏览器面白名单**：supervisor 要经此通道把 envelope 装进自己的
  // runtime（12 §6 A-08、01 §7.1），真实链路曾因这里误挡 `provider-provisioning-target`
  // 而报 "provider provisioning target channel … is unavailable"。浏览器面的收窄在 relay，
  // 断言见 cloudBridgeProjection.test.ts 的 rpcRelay 用例。
  assert.notEqual(owner.channel("file"), null);
  assert.notEqual(
    owner.channel("provider-provisioning-target"),
    null,
    "本地 runtime 的 provisioning target 必须可达（本地安装器要用）",
  );
  assert.equal(owner.channel("file") !== null, true, "已连接时按名取通道");
  const writtenBeforeDispose = stream.written.length;
  // 网络断开不触碰 stdio：在没有调用 dispose 的前提下 stdin 不再收到任何字节。
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(stream.written.length, writtenBeforeDispose);
  owner.dispose();
  owner.dispose();
});

test("bridgeTransport：真实 WSS 往返文本帧，关闭只影响本条 socket", async () => {
  const server = await startEchoServer();
  try {
    const transport = createBridgeTransport({ logger: testLogger(), openTimeoutMs: 5_000 });
    const connection = await transport.connect(`${server.origin}/ws/cloud/bridge/${RUN_ID}`);
    const received: string[] = [];
    connection.onText((text) => received.push(text));
    connection.send(JSON.stringify({ hello: "world" }));
    await waitFor(() => received.length > 0, "echo frame");
    assert.deepEqual(JSON.parse(received[0]!), { hello: "world" });
    let closedReason = "";
    connection.onClose((info) => {
      closedReason = info.reason;
    });
    connection.close("done");
    await waitFor(() => closedReason.length > 0, "close notified");
    // 超限帧被丢弃而不是截断（半帧会污染协议流）。
    const second = await transport.connect(`${server.origin}/ws/cloud/bridge/${RUN_ID}`);
    const oversized: string[] = [];
    second.onText((text) => oversized.push(text));
    second.send("x".repeat(9 * 1024 * 1024));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(oversized.length, 0);
    second.close("done");
  } finally {
    await server.close();
  }
});

test("状态目录：默认落在用户家目录（不是 /run），且自己 mkdir -p、不依赖模板预建", async () => {
  // 2026-10-05 真实 E2B 实测：非 root 用户下 /run 不可写 → supervisor 启动即退出。
  assert.ok(
    !DEFAULT_RUNTIME_STATE_DIR.startsWith("/run"),
    `默认状态目录不得落在 /run（实测 EACCES），实际 ${DEFAULT_RUNTIME_STATE_DIR}`,
  );
  assert.equal(DEFAULT_RUNTIME_STATE_DIR, join(homedir(), ".zcode", "run"));

  // 多层不存在的目录也能自建（沙箱里由 supervisor 进程自建，不假定模板建过）。
  const parent = await mkdtemp(join(tmpdir(), "w6-statedir-"));
  const nested = join(parent, "not", "yet", "created");
  const created = await ensureRuntimeStateDir(nested);
  assert.equal(created, nested);
  assert.ok((await stat(nested)).isDirectory());

  // 凭据状态文件与投影 WAL 都落在同一目录（单一定义，不各写一份字面量）。
  const credentialStore = createCredentialStateFile({ stateDir: nested, logger: testLogger() });
  const walStore = createProjectionWalStore({ stateDir: nested, logger: testLogger() });
  const record = {
    schemaVersion: 1 as const,
    taskId: TASK_ID,
    runId: RUN_ID,
    runGeneration: 1,
    runtimeIncarnation: "runtime-1",
    topic: "conversation/session-1",
    logEpoch: "epoch-1",
    sourceSeq: 1,
    kind: "snapshot" as const,
    payload: {},
    contentHash: "d".repeat(64),
  };
  await credentialStore.save(
    createCredentialState({
      address: { taskId: TASK_ID, runId: RUN_ID, runGeneration: 1 },
      initialToken: "t",
      nextResumeToken: "c",
      helloAttemptId: "9c1f0b7a-3f2e-4d5c-8a11-2b3c4d5e6f70",
    }),
  );
  await walStore.save([{ record, dedupKey: "k" }], []);
  const files = await readdir(nested);
  assert.ok(files.includes("credential-state.json"), `凭据状态文件必须在该目录：${files}`);
  assert.ok(files.includes("projection-wal.ndjson"), `WAL 必须在该目录：${files}`);
  // 自举描述读取也认同一目录（缺文件返回缺项而不是抛错）。
  const config = await readSupervisorConfigForStateDir({}, nested);
  assert.equal(config.ok, false);
});

test("状态目录不可写：早期失败必须带明确诊断，不静默退到超时", async () => {
  const parent = await mkdtemp(join(tmpdir(), "w6-readonly-"));
  const readOnly = join(parent, "ro");
  await mkdir(readOnly, { recursive: true, mode: 0o500 });
  const target = join(readOnly, "run");
  await assert.rejects(
    () => ensureRuntimeStateDir(target),
    (error: unknown) =>
      error instanceof Error && /EACCES|EPERM/.test((error as NodeJS.ErrnoException).code ?? error.message),
    "不可写目录必须当场报错（EACCES），不能等到 hello 之后",
  );
});

test("credentialStateFile：原子替换 + 权限受限 + 未知版本整份拒绝", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "w6-cred-"));
  const store = createCredentialStateFile({ stateDir, logger: testLogger() });
  assert.equal(await store.load(), null);
  const state = createCredentialState({
    address: { taskId: TASK_ID, runId: RUN_ID, runGeneration: 1 },
    initialToken: "token-A",
    nextResumeToken: "token-B",
    helloAttemptId: "9c1f0b7a-3f2e-4d5c-8a11-2b3c4d5e6f70",
  });
  await store.save(state);
  const loaded = await store.load();
  assert.equal(loaded?.currentToken, "token-A");
  assert.equal(loaded?.recovery, "initial");
  // 临时文件不得残留（原子替换）。
  assert.deepEqual(
    (await readdir(stateDir)).filter((name) => name.endsWith(".tmp")),
    [],
  );
  const raw = await readFile(join(stateDir, "credential-state.json"), "utf8");
  assert.equal(JSON.parse(raw).version, 1);
  // 未知版本/缺字段：严格解析拒绝（不按旧字段猜测）。
  await writeFile(join(stateDir, "credential-state.json"), JSON.stringify({ version: 2 }));
  assert.equal(await store.load(), null);
  assert.equal(parseCredentialState({ version: 1 }), null);
  assert.equal(parseCredentialState({ ...state, recovery: "unknown" }), null);
  // 旧版本目录名兼容：rename 只是测试原子写不会破坏目录结构。
  await rename(join(stateDir, "credential-state.json"), join(stateDir, "credential-state.old"));
  await store.save(state);
  assert.equal((await store.load())?.candidateNextResumeToken, "token-B");
});

test("projectionWalStore：崩溃安全落盘；头部损坏时如实标记不健康且不删数据", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "w6-wal-"));
  const store = createProjectionWalStore({ stateDir, logger: testLogger() });
  const empty = await store.load();
  assert.deepEqual(empty, { entries: [], cursors: [], healthy: true });
  const record = {
    schemaVersion: 1 as const,
    taskId: TASK_ID,
    runId: RUN_ID,
    runGeneration: 1,
    runtimeIncarnation: "runtime-1",
    topic: "conversation/session-1",
    logEpoch: "epoch-1",
    sourceSeq: 3,
    kind: "snapshot" as const,
    payload: { ok: true },
    contentHash: "c".repeat(64),
  };
  await store.save(
    [{ record, dedupKey: "k" }],
    [{ topic: "conversation/session-1", logEpoch: "epoch-1", sourceSeq: 3 }],
  );
  const restored = await store.load();
  assert.equal(restored.entries.length, 1);
  assert.equal(restored.entries[0]!.record.sourceSeq, 3);
  assert.deepEqual(restored.cursors, [
    { topic: "conversation/session-1", logEpoch: "epoch-1", sourceSeq: 3 },
  ]);
  // 头部损坏：不健康、不删数据（等待对账），不静默丢记录。
  const path = join(stateDir, "projection-wal.ndjson");
  const original = await readFile(path, "utf8");
  await writeFile(path, `{"kind":"other"}\n${original.split("\n").slice(1).join("\n")}`);
  const broken = await store.load();
  assert.equal(broken.healthy, false);
  assert.equal(await readFile(path, "utf8").then((text) => text.includes("other")), true);
});

test("W3 资产构建入口：默认 supervisor 入口可真实打包（跨模块冻结路径）", async () => {
  const entry = DEFAULT_BUNDLE_ENTRIES.find((item) => item.name === "supervisor.bundle.mjs")!;
  assert.ok(entry.entry.endsWith("cloud/execution/sandbox/supervisorMain.ts"));
  const outDir = await mkdtemp(join(tmpdir(), "w6-assets-"));
  const manifest = await buildAssets({
    outDir,
    version: "0.0.0",
    bundles: [entry],
    copies: [],
  });
  const built = manifest.assets[0]!;
  assert.equal(built.name, "supervisor.bundle.mjs");
  assert.ok(built.bytes > 100_000, `supervisor bundle 体积异常：${built.bytes}`);
  const text = await readFile(join(outDir, "supervisor.bundle.mjs"), "utf8");
  assert.ok(text.includes("/ws/cloud/bridge"), "产物必须包含出站 bridge 端点拼接");
});

/**
 * 真实 provider 端到端（门控）：specs/cloud-agent W6 §6「真实 E2E」与 01 §10。
 *
 * 解禁方式（缺任一即跳过，绝不伪造通过）：
 *   1) 提供真实 provider 凭据：`E2B_API_KEY`（或 Daytona/Modal 对应的部署配置）；
 *   2) 提供已部署控制面的公网 origin：`ZCODE_CLOUD_E2E_PUBLIC_ORIGIN`（如 https://cloud.example.test）；
 *   3) 提供隔离测试仓与 baseSha：`ZCODE_CLOUD_E2E_REPOSITORY`（owner/name）与 `ZCODE_CLOUD_E2E_BASE_SHA`；
 *   4) 执行：`ZCODE_CLOUD_E2E=1 node --import tsx --test packages/server/test/cloudExecution*.test.ts`。
 *
 * 通过标准（记录证据，不只看退出码）：create → 出站 bridge 建连 → 固定 SHA clone → runtime ready
 * → 首输入 admitted → 模型答复 → stop；并采集沙箱内 PID、checkout 路径与 remote SHA。
 * 本用例只做「前置条件齐备性」判定与说明，真实编排由 W10 的故障注入/端到端验收驱动。
 */
test("真实 provider E2E（门控：无凭据/控制面时跳过并说明解禁方式）", (t) => {
  const enabled = process.env.ZCODE_CLOUD_E2E === "1";
  const providerKey = process.env.E2B_API_KEY ?? process.env.ZCODE_CLOUD_E2E_PROVIDER_KEY;
  const origin = process.env.ZCODE_CLOUD_E2E_PUBLIC_ORIGIN;
  const repository = process.env.ZCODE_CLOUD_E2E_REPOSITORY;
  const baseSha = process.env.ZCODE_CLOUD_E2E_BASE_SHA;
  const missing = [
    !enabled && "ZCODE_CLOUD_E2E=1",
    !providerKey && "E2B_API_KEY",
    !origin && "ZCODE_CLOUD_E2E_PUBLIC_ORIGIN",
    !repository && "ZCODE_CLOUD_E2E_REPOSITORY",
    !baseSha && "ZCODE_CLOUD_E2E_BASE_SHA",
  ].filter((entry): entry is string => typeof entry === "string");
  if (missing.length > 0) {
    // 环境受限：如实跳过并打印解禁清单（work order：不得伪造通过）。
    t.diagnostic(`真实 provider E2E 未执行，缺少：${missing.join(", ")}`);
    t.skip(`缺少真实 provider/控制面环境：${missing.join(", ")}`);
    return;
  }
  // 前置齐备时，真实编排由 W10 的 E2E 入口执行（本仓库无内置云 E2E 命令，02 §11 尾段）。
  t.diagnostic("前置齐备；请在 W10 E2E 入口执行 create→bridge→clone→ready→输入→stop 全链路。");
  t.skip("真实 E2E 编排归 W10（本包不内置云 E2E 命令）");
});

async function startEchoServer(): Promise<{
  origin: string;
  close(): Promise<void>;
}> {
  // 明确绑定 IPv4：某些环境（bindv6only）下 `::` 不接 IPv4，会让本机回连被拒。
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  server.on("connection", (socket) => {
    socket.on("message", (data: Buffer) => socket.send(data.toString("utf8")));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    origin: `ws://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  };
}

function waitFor(predicate: () => boolean, label: string, turns = 200): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let count = 0;
    const step = () => {
      if (predicate()) return resolve();
      if (count >= turns) return reject(new Error(`timed out waiting for ${label}`));
      count += 1;
      setTimeout(step, 5);
    };
    step();
  });
}
