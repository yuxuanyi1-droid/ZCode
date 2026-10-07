/**
 * 云入口两条 WS 通道的真实链路（specs/cloud-agent/modules/W5-cloud-entry.md §6「通道可用」；
 * 03 §7.1、CP-01/CP-11）。
 *
 * 与 `cloudEntryServer.test.ts` 的区别：这里**不注入**控制面，走默认工厂
 * （`contract.ts` 的 `assembleCloudControlPlane`）+ 真 HTTP/WS 升级，证明入口接线真的
 * 把两条 cloud WS 通道开出来了，而不是类型兼容。存储用 W1 的内存测试替身（CP-02 的
 * 故障注入替身），不落真实 `~/.zcode`、不 spawn worker。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ISettingService, ServiceCollection } from "@zcode/services";
import { createServiceLogger } from "@zcode/services/node";
import WebSocket from "ws";
import {
  startCloudServer,
  type CloudServerHandle,
  type StartCloudServerOptions,
} from "../src/cloud/adapters/entry-cloud-server.js";
import { buildCloudTaskWorkspacePath } from "../src/cloud/domain/workspacePath.js";
import type { CloudEntryConfig } from "../src/cloud/adapters/entry-cloud-config.js";
import type { CloudDeploymentSecrets } from "../src/cloud/adapters/entry-cloud-secrets.js";
import type { LoopSchedulerPort } from "../src/cloud/app/ports/loopSchedulerPort.js";
import type { SandboxDriverRegistryPort } from "../src/cloud/app/ports/sandboxDriverRegistryPort.js";
import { FakeClock, createFakeOutbox, createFakeStorage } from "./cloudCoreFakes.js";

const AUTH_TOKEN = "cloud-ws-e2e-token";
const PRINCIPAL = "8f14e45f-ceea-467a-9a1e-1f0d3b2a4c50";
const TASK_ID = "8f14e45f-ceea-467a-9a1e-1f0d3b2a4c51";
const FOREIGN_TASK_ID = "8f14e45f-ceea-467a-9a1e-1f0d3b2a4c52";
const RUN_ID = "1f14e45f-ceea-467a-9a1e-1f0d3b2a4c53";
const PROJECT_ID = "7f14e45f-ceea-467a-9a1e-1f0d3b2a4c60";
const TICKET = "bootstrap-ticket-ws-e2e";
const HELLO_ATTEMPT_ID = "9c1f0b7a-3f2e-4d5c-8a11-2b3c4d5e6f70";

// 工作区路径由控制面唯一计算点给出（`domain/workspacePath.ts`），用例不手写字符串。
const WORKSPACE = buildCloudTaskWorkspacePath("demo");
assert.ok(WORKSPACE.ok);
const WORKSPACE_PATH = WORKSPACE.path;

const ready = {
  lastAppliedMigrationId: "0005_task_input_interaction_decisions",
  schemaVersion: 5,
  writable: true,
  attachmentsWritable: true,
} as const;

const fakeDrivers: SandboxDriverRegistryPort = {
  resolve: async () => null,
  listProviders: async () => [],
};

/** 手动调度器：用例自己驱动，避免后台 tick 干扰（W1 loopSchedulerPort 约定）。 */
function manualScheduler(): LoopSchedulerPort {
  return { schedule: () => () => {}, delay: () => () => {} };
}

const quietLogger = createServiceLogger("cloud-ws-e2e-test", {
  sink: { log: () => undefined, warn: () => undefined, error: () => undefined },
  isDebugEnabled: false,
});

function testSecrets(): CloudDeploymentSecrets {
  return {
    authToken: AUTH_TOKEN,
    principalId: PRINCIPAL,
    describe: () => ({
      principalId: PRINCIPAL,
      authToken: "configured",
      credentialSecret: "absent",
      gitHubApp: "absent",
    }),
  };
}

function hostServices(): ServiceCollection {
  return new ServiceCollection().register(ISettingService, {
    get: async () => ({ ok: true }),
  } as unknown as ISettingService);
}

function baseConfig(dataDir: string): CloudEntryConfig {
  return {
    mode: "cloud",
    publicOrigin: "http://127.0.0.1:1",
    listenPort: 0,
    dataDir,
    providers: ["e2b"],
    allowUnverifiedProviders: [],
    maxConcurrentRuns: 1,
    secrets: {},
  };
}

interface WsClient {
  socket: WebSocket;
  /** 已收到的所有帧（原始文本）。 */
  frames: string[];
  waitForFrame(type: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  waitForClose(timeoutMs?: number): Promise<{ code: number; reason: string }>;
  closed(): { code: number; reason: string } | undefined;
}

function connectCloudWs(url: string): Promise<WsClient> {
  const socket = new WebSocket(url);
  const frames: string[] = [];
  let closed: { code: number; reason: string } | undefined;
  const waiters: { type: string; resolve: (frame: Record<string, unknown>) => void }[] = [];
  const closeWaiters: ((value: { code: number; reason: string }) => void)[] = [];

  socket.on("message", (raw) => {
    const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
    frames.push(text);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    for (const waiter of waiters.splice(0)) {
      if (waiter.type === parsed["type"]) {
        waiter.resolve(parsed);
      } else {
        waiters.push(waiter);
      }
    }
  });
  socket.on("close", (code, reason) => {
    closed = { code, reason: reason.toString() };
    for (const waiter of closeWaiters.splice(0)) {
      waiter(closed);
    }
  });

  const client: WsClient = {
    socket,
    frames,
    waitForFrame(type, timeoutMs = 5_000) {
      const seen = frames.map((item) => safeParse(item)).find((frame) => frame?.["type"] === type);
      if (seen) {
        return Promise.resolve(seen);
      }
      return withTimeout(
        new Promise((resolve) => waiters.push({ type, resolve })),
        timeoutMs,
        `frame ${type}`,
      );
    },
    waitForClose(timeoutMs = 5_000) {
      if (closed) {
        return Promise.resolve(closed);
      }
      return withTimeout(new Promise((resolve) => closeWaiters.push(resolve)), timeoutMs, "close");
    },
    closed: () => closed,
  };

  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("open", () => resolve(client));
  });
}

function safeParse(text: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** 有界轮询等待（不固定 sleep）：条件成立即返回。 */
async function waitUntil(predicate: () => boolean, label: string, turns = 400): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function withAssembledServer<T>(
  run: (context: {
    handle: CloudServerHandle;
    baseUrl: string;
    wsUrl: string;
    seedTask: (input: {
      taskId: string;
      ownerPrincipalId: string;
      runId?: string;
    }) => Promise<string>;
  }) => Promise<T>,
): Promise<T> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cloud-ws-e2e-"));
  const clock = new FakeClock();
  const outbox = createFakeOutbox();
  const storage = createFakeStorage(clock, outbox);
  let handle: CloudServerHandle | undefined;
  try {
    handle = await startCloudServer({
      config: baseConfig(dataDir),
      secrets: testSecrets(),
      drivers: fakeDrivers,
      hostServices: hostServices(),
      storage: { storage, operations: outbox, readiness: async () => ready },
      // 12 §6：envelope 来源唯一在 host 侧；用例给出一个最小静态 envelope（生产由
      // `getProviderProvisioningSource(hostServices)` 供给，内部结构属 provisioning 契约）。
      hostProvisioningSource: {
        read: async () => ({ provider: "zai", model: "glm-4.6" }),
      } as unknown as StartCloudServerOptions["hostProvisioningSource"],
      listenPort: 0,
      listenHost: "127.0.0.1",
      loopScheduler: manualScheduler(),
      logger: quietLogger,
    });
    const baseUrl = `http://127.0.0.1:${handle.port}`;
    const wsUrl = `ws://127.0.0.1:${handle.port}`;

    const seedTask = async (input: {
      taskId: string;
      ownerPrincipalId: string;
      runId?: string;
    }): Promise<string> => {
      await storage.projects.createOrGet({
        projectId: PROJECT_ID,
        ownerPrincipalId: input.ownerPrincipalId,
        kind: "github-repo",
        repositoryId: 101,
        installationId: 7,
        repoOwner: "octo",
        repoName: "demo",
        defaultBranch: "main",
        now: clock.now(),
      });
      await storage.tasks.createDraft({
        taskId: input.taskId,
        ownerPrincipalId: input.ownerPrincipalId,
        projectId: PROJECT_ID,
        title: "ws-e2e",
        creationKey: `ck-${input.taskId}`,
        workspaceIdentity: `cloud-task:${input.taskId}`,
        now: clock.now(),
      });
      if (!input.runId) {
        return "";
      }
      // 冻结基线：bootstrap.config 的 clone 事实要求 baseSha/taskBranch 已冻结（11 §6）。
      await storage.tasks.freezeBaseline({
        taskId: input.taskId,
        baseBranch: "main",
        baseSha: "a".repeat(40),
        taskBranch: "zcode/ws-e2e",
        now: clock.now(),
      });
      await storage.runs.reserveRun({
        taskId: input.taskId,
        runId: input.runId,
        executionRecipe: {
          provider: "e2b",
          templateRef: "zcode-node24",
          resources: { cpu: 2, memoryMiB: 4096, diskGiB: 10 },
          firstCommandConfig: {},
        },
        workspacePath: WORKSPACE_PATH,
        quota: { maxConcurrentRuns: 4 },
        now: clock.now(),
      });
      await storage.runs.recordProviderHandle({
        runId: input.runId,
        runGeneration: 1,
        provider: "e2b",
        providerHandle: "sbx-ws-e2e",
        workspacePath: WORKSPACE_PATH,
        now: clock.now(),
      });
      await storage.credentials.saveInitial({
        runId: input.runId,
        runGeneration: 1,
        credentialHash: createHash("sha256").update(TICKET).digest("hex"),
        expiresAt: clock.now() + 600_000,
        bootstrapOperationId: input.runId,
      });
      return input.runId;
    };

    return await run({ handle, baseUrl, wsUrl, seedTask });
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("cloud 任务通道：无有效 attachment / 跨主体一律结构化关闭，不回落本机执行域", async () => {
  await withAssembledServer(async ({ wsUrl, seedTask }) => {
    await seedTask({ taskId: TASK_ID, ownerPrincipalId: PRINCIPAL });
    await seedTask({
      taskId: FOREIGN_TASK_ID,
      ownerPrincipalId: "00000000-0000-4000-8000-0000000000aa",
    });

    // 未知 Task：主体校验后 structured close（4404 = not_found）。
    const unknown = await connectCloudWs(
      `${wsUrl}/ws/cloud/tasks/2f14e45f-ceea-467a-9a1e-1f0d3b2a4c99?token=${AUTH_TOKEN}`,
    );
    const unknownClose = await unknown.waitForClose();
    assert.equal(unknownClose.code, 4404);
    assert.match(unknownClose.reason, /task-not-found/);

    // 别人的 Task：同样按 404 语义关闭，不泄漏存在性（03 §3）。
    const foreign = await connectCloudWs(
      `${wsUrl}/ws/cloud/tasks/${FOREIGN_TASK_ID}?token=${AUTH_TOKEN}`,
    );
    const foreignClose = await foreign.waitForClose();
    assert.equal(foreignClose.code, 4404);
    assert.match(foreignClose.reason, /task-not-found/);

    // 自己的 draft Task 但还没有 run：not-ready，不是本机 fallback（CP-11）。
    const notReady = await connectCloudWs(`${wsUrl}/ws/cloud/tasks/${TASK_ID}?token=${AUTH_TOKEN}`);
    const notReadyClose = await notReady.waitForClose();
    assert.equal(notReadyClose.code, 4404);
    assert.match(notReadyClose.reason, /no-active-run/);

    // 未认证升级被 lite-token 拒绝，根本不进控制面。
    await assert.rejects(
      () => connectCloudWs(`${wsUrl}/ws/cloud/tasks/${TASK_ID}`),
      (error: unknown) => error instanceof Error && /401/.test(error.message),
    );
  });
});

test("cloud bridge 通道：真 WebSocket 握手建立 attachment，任务通道随之越过 attachment 校验", async () => {
  await withAssembledServer(async ({ wsUrl, seedTask }) => {
    await seedTask({ taskId: TASK_ID, ownerPrincipalId: PRINCIPAL, runId: RUN_ID });

    // 执行节点 bridge 通道豁免 lite-token：沙箱按设计拿不到浏览器凭据，
    // 它的鉴权是 hello 帧里的 run-scoped 自举 ticket（02 §4/§5.1）。
    const bridge = await connectCloudWs(`${wsUrl}/ws/cloud/bridge/${RUN_ID}`);
    try {
      bridge.socket.send(
        JSON.stringify({
          protocolVersion: 1,
          type: "bridge.hello",
          address: {
            taskId: TASK_ID,
            runId: RUN_ID,
            runGeneration: 1,
            workspaceIdentity: `cloud-task:${TASK_ID}`,
            workspacePath: WORKSPACE_PATH,
            remoteSessionId: `remote-${RUN_ID}`,
          },
          helloAttemptId: HELLO_ATTEMPT_ID,
          credentialToken: TICKET,
          candidateNextResumeToken: "candidate-1",
          runtimeIncarnation: "incarnation-1",
        }),
      );

      const welcome = await bridge.waitForFrame("bridge.welcome").catch((error: unknown) => {
        throw new Error(
          `${String(error)}; frames=${JSON.stringify(bridge.frames.map((f) => safeParse(f)?.["type"]))}; ` +
            `closed=${JSON.stringify(bridge.closed())}`,
        );
      });
      const connectionEpoch = welcome["connectionEpoch"] as number;
      assert.equal(typeof connectionEpoch, "number");
      // bootstrap.config 是 ready 的前置（02 §5.3）。
      await bridge.waitForFrame("bootstrap.config");

      bridge.socket.send(
        JSON.stringify({
          protocolVersion: 1,
          type: "bridge.ready",
          connectionEpoch,
          configVersion: "cfg-1",
          runtimeIncarnation: "incarnation-1",
          exporterReady: true,
          walReady: true,
          executionCapabilities: ["conversation-projection"],
        }),
      );

      // attachment 已 ready：任务通道不再以 4404 关闭，而是建立可用的浏览器会话，并把
      // 浏览器字节经控制面转发到沙箱 bridge（03 §7.1 两个通道分面、W6 rpcRelay 已接线）。
      const taskChannel = await connectCloudWs(
        `${wsUrl}/ws/cloud/tasks/${TASK_ID}?token=${AUTH_TOKEN}`,
      );
      const bridgeFramesBefore = bridge.frames.length;
      taskChannel.socket.send("hello-from-browser");
      await waitUntil(() => bridge.frames.length > bridgeFramesBefore, "browser frame relayed");
      const relayed = safeParse(bridge.frames[bridge.frames.length - 1] ?? "");
      assert.match(String(relayed?.["type"]), /^rpc\./, "浏览器字节必须以 rpc.* 帧到达沙箱");
      assert.equal(taskChannel.closed(), undefined, "已就绪 attachment 的会话保持打开");
    } finally {
      bridge.socket.close();
    }
  });
});

test("lite-token 豁免只作用于 bridge：其余通道与 API 行为不变", async () => {
  await withAssembledServer(async ({ baseUrl, wsUrl, seedTask }) => {
    await seedTask({ taskId: TASK_ID, ownerPrincipalId: PRINCIPAL });

    // bridge 路径：无 token 时不再是 401（由后续 hello 票校验决定成败）。
    const bridge = await connectCloudWs(`${wsUrl}/ws/cloud/bridge/${RUN_ID}`);
    bridge.socket.close();

    // 其余一律仍需 lite token：host 账号域通道、浏览器 attachment、cloud API。
    await assert.rejects(
      () => connectCloudWs(`${wsUrl}/ws`),
      (error: unknown) => error instanceof Error && /401/.test(error.message),
    );
    await assert.rejects(
      () => connectCloudWs(`${wsUrl}/ws/cloud/tasks/${TASK_ID}`),
      (error: unknown) => error instanceof Error && /401/.test(error.message),
    );
    const api = await fetch(`${baseUrl}/api/cloud/capabilities`);
    assert.equal(api.status, 401);
  });
});

test("豁免不代表放宽鉴权：错误/缺失 ticket 的 bridge 连接仍被拒", async () => {
  await withAssembledServer(async ({ wsUrl, seedTask }) => {
    await seedTask({ taskId: TASK_ID, ownerPrincipalId: PRINCIPAL, runId: RUN_ID });

    const hello = (credentialToken: string): string =>
      JSON.stringify({
        protocolVersion: 1,
        type: "bridge.hello",
        address: {
          taskId: TASK_ID,
          runId: RUN_ID,
          runGeneration: 1,
          workspaceIdentity: `cloud-task:${TASK_ID}`,
          workspacePath: WORKSPACE_PATH,
          remoteSessionId: `remote-${RUN_ID}`,
        },
        helloAttemptId: HELLO_ATTEMPT_ID,
        credentialToken,
        candidateNextResumeToken: "candidate-1",
        runtimeIncarnation: "incarnation-1",
      });

    // 空票：帧本身不合契约（ticket 非空），在帧边界被拒——不会进入 welcome。
    const noTicket = await connectCloudWs(`${wsUrl}/ws/cloud/bridge/${RUN_ID}`);
    noTicket.socket.send(hello(""));
    const noTicketClose = await noTicket.waitForClose();
    assert.equal(noTicketClose.code, 1008);
    assert.match(noTicketClose.reason, /invalid-frame/);
    assert.ok(!noTicket.frames.some((frame) => frame.includes("bridge.welcome")));

    // 错票：契约合法但 hash 不匹配 → 凭据校验失败，fault + 关闭（02 §5.1 fail-closed）。
    const wrongTicket = await connectCloudWs(`${wsUrl}/ws/cloud/bridge/${RUN_ID}`);
    wrongTicket.socket.send(hello("not-the-ticket"));
    const wrongFault = await wrongTicket.waitForFrame("bridge.fault");
    assert.equal(wrongFault["faultCode"], "unauthenticated");
    const wrongClose = await wrongTicket.waitForClose();
    assert.equal(wrongClose.code, 1008);
    assert.match(wrongClose.reason, /credential-rejected/);
  });
});
