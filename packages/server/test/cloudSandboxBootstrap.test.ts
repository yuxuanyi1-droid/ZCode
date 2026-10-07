/**
 * 自举通道契约测试（specs/cloud-agent/01 §6.2 实施决议、§5.1、§9；W3 §4 对 W6）。
 *
 * 断言三件事：
 * 1. **env 名映射**是三家共用的冻结面，自举要素只经 env（不进命令字符串/argv/URL）；
 * 2. **有界重试**：抖动可恢复，超出预算即失败，且退避是有界注入的；
 * 3. **补偿终止分类**：已确认清理 → `bootstrap_failed`；未确认 → `provider_termination_unknown`。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { CloudAdapterLogger } from "../src/cloud/adapters/sandbox/adapterError.js";
import { CloudAdapterError } from "../src/cloud/adapters/sandbox/adapterError.js";
import { createDaytonaSupervisorStarter } from "../src/cloud/adapters/sandbox/daytonaBootstrap.js";
import { createE2bSupervisorStarter } from "../src/cloud/adapters/sandbox/e2bBootstrap.js";
import { createModalSdkSupervisorStarter } from "../src/cloud/adapters/sandbox/modalBootstrap.js";
import type {
  ModalBridgeOp,
  ModalBridgeOutcome,
  ModalSdkBridge,
} from "../src/cloud/adapters/sandbox/modalSdkBridge.js";
import {
  assertSupervisorProcessAlive,
  parseSupervisorFailureLine,
  supervisorExitError,
  buildSupervisorStartInput,
  startSupervisorOrTerminate,
  SUPERVISOR_START_ATTEMPTS,
  SUPERVISOR_START_CMD,
  SUPERVISOR_START_ENV_NAMES,
  supervisorStartBackoffMs,
  supervisorStartEnv,
  type SupervisorStartInput,
} from "../src/cloud/adapters/sandbox/sandboxSupervisorStart.js";
import type {
  SandboxFetch,
  SandboxFetchResponse,
} from "../src/cloud/adapters/sandbox/sandboxRest.js";

const silentLogger: CloudAdapterLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function response(status: number, body: unknown): SandboxFetchResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body ?? ""),
  };
}

const START_INPUT: SupervisorStartInput = {
  operationKey: "op-1",
  runId: "run-1",
  runGeneration: 2,
  publicControlPlaneUrl: "https://control.example.test",
  bootstrapTicket: "ticket-abc",
  taskId: "8f1b0f9e-3b1a-4c2d-9e6f-0a1b2c3d4e5f",
  workspacePath: "/workspace/zcode-repo",
};

test("自举 env 名映射：三家共用同一组键（7 个），ticket 只经 env", () => {
  const env = supervisorStartEnv(START_INPUT);
  assert.deepEqual(env, {
    ZCODE_CLOUD_PUBLIC_ORIGIN: "https://control.example.test",
    ZCODE_CLOUD_RUN_ID: "run-1",
    ZCODE_CLOUD_RUN_GENERATION: "2",
    ZCODE_CLOUD_BOOTSTRAP_TICKET: "ticket-abc",
    ZCODE_CLOUD_OPERATION_KEY: "op-1",
    ZCODE_CLOUD_TASK_ID: "8f1b0f9e-3b1a-4c2d-9e6f-0a1b2c3d4e5f",
    ZCODE_CLOUD_WORKSPACE_PATH: "/workspace/zcode-repo",
  });
  // 凭据与运行配置不走这里：只走 bridge 的 bootstrap.config（02 §4）。
  assert.equal(env["ZCODE_SANDBOX_PROVISIONING_ENVELOPE"], undefined);

  // 冻结的键名常量与实现一致（W6 按这些名字读取）。
  assert.deepEqual(Object.values(SUPERVISOR_START_ENV_NAMES).sort(), [
    "ZCODE_CLOUD_BOOTSTRAP_TICKET",
    "ZCODE_CLOUD_OPERATION_KEY",
    "ZCODE_CLOUD_PUBLIC_ORIGIN",
    "ZCODE_CLOUD_RUN_GENERATION",
    "ZCODE_CLOUD_RUN_ID",
    "ZCODE_CLOUD_TASK_ID",
    "ZCODE_CLOUD_WORKSPACE_PATH",
  ]);
  assert.equal(SUPERVISOR_START_CMD, "/opt/zcode/start-supervisor.sh");
  assert.equal(SUPERVISOR_START_ATTEMPTS, 5);
  // 退避有界（封顶 6s），不出现指数爆炸或无限等待。
  assert.deepEqual([1, 2, 3, 4, 5].map(supervisorStartBackoffMs), [1500, 3000, 4500, 6000, 6000]);
});

test("buildSupervisorStartInput：地址要素取自 create 显式字段，并在 create 前校验", () => {
  const base = {
    operationKey: "op-9",
    runId: "8f1b0f9e-3b1a-4c2d-9e6f-0a1b2c3d4e5f",
    runGeneration: 1,
    bootstrapAddress: {
      taskId: "8f1b0f9e-3b1a-4c2d-9e6f-0a1b2c3d4e5f",
      workspacePath: "/workspace/repo",
    },
    imageRef: "template@1",
    resources: { cpu: 2, memoryMiB: 4096, diskGiB: 10 },
    requestedDeadline: 1,
    publicControlPlaneUrl: "https://c.example",
    bootstrapTicket: "t",
    labels: { taskSlug: "task-1" },
    signal: new AbortController().signal,
  };

  const input = buildSupervisorStartInput(base);
  assert.equal(input.taskId, "8f1b0f9e-3b1a-4c2d-9e6f-0a1b2c3d4e5f");
  assert.equal(input.workspacePath, "/workspace/repo");

  // 非法任务 id / 相对路径 / 空值 → validation_failed（create 之前就拒绝，不占 quota，
  // 也不把非法身份下发给沙箱）。缺失一律拒绝，不编造占位身份。
  for (const invalid of [
    { taskId: "not-a-task-id" },
    { workspacePath: "workspace/repo" },
    { taskId: "" },
    { workspacePath: "" },
  ]) {
    assert.throws(
      () => buildSupervisorStartInput({ ...base, bootstrapAddress: invalid }),
      (error: unknown) => {
        assert.ok(error instanceof CloudAdapterError);
        assert.equal(error.code, "validation_failed");
        return true;
      },
    );
  }
});

test("buildSupervisorStartInput 只搬运 frozen port 的字段", () => {
  const input = buildSupervisorStartInput({
    operationKey: "op-9",
    runId: "run-9",
    runGeneration: 4,
    bootstrapAddress: {
      taskId: "8f1b0f9e-3b1a-4c2d-9e6f-0a1b2c3d4e5f",
      workspacePath: "/workspace/zcode-repo",
    },
    imageRef: "template@1",
    resources: { cpu: 2, memoryMiB: 4096, diskGiB: 10 },
    requestedDeadline: 1,
    publicControlPlaneUrl: "https://c.example",
    bootstrapTicket: "t",
    labels: {},
    signal: new AbortController().signal,
  });
  assert.deepEqual(input, {
    operationKey: "op-9",
    runId: "run-9",
    runGeneration: 4,
    publicControlPlaneUrl: "https://c.example",
    bootstrapTicket: "t",
    taskId: "8f1b0f9e-3b1a-4c2d-9e6f-0a1b2c3d4e5f",
    workspacePath: "/workspace/zcode-repo",
  });
});

test("就绪探测边界：命令仍在运行/退出码 0 通过，非 0 立即退出判失败", () => {
  assertSupervisorProcessAlive(undefined, { provider: "e2b", sandboxId: "s" });
  assertSupervisorProcessAlive(null, { provider: "e2b", sandboxId: "s" });
  assertSupervisorProcessAlive(0, { provider: "e2b", sandboxId: "s" });
  assert.throws(
    () => assertSupervisorProcessAlive(137, { provider: "modal", sandboxId: "s" }),
    (error: unknown) => {
      assert.ok(error instanceof CloudAdapterError);
      assert.equal(error.code, "bootstrap_failed");
      return true;
    },
  );
});

test("startSupervisorOrTerminate：成功不补偿；失败按终止事实分类", async () => {
  const terminated: string[] = [];
  const ok = async (sandboxId: string): Promise<void> => void terminated.push(sandboxId);

  // 成功路径：不调用终止探测。
  await startSupervisorOrTerminate(
    ok,
    async () => {
      throw new Error("must not be called");
    },
    "sbx-1",
    START_INPUT,
    silentLogger,
    "e2b",
  );
  assert.deepEqual(terminated, ["sbx-1"]);

  const failing = async (): Promise<void> => {
    throw new Error("start failed");
  };

  await assert.rejects(
    () =>
      startSupervisorOrTerminate(
        failing,
        async () => ({ ok: true, status: 200 }),
        "sbx-2",
        START_INPUT,
        silentLogger,
        "e2b",
      ),
    (error: unknown) => {
      assert.ok(error instanceof CloudAdapterError);
      assert.equal(error.code, "bootstrap_failed");
      return true;
    },
  );

  // 404（provider 确认资源不存在）等价于已清理。
  await assert.rejects(
    () =>
      startSupervisorOrTerminate(
        failing,
        async () => ({ ok: false, status: 404 }),
        "sbx-3",
        START_INPUT,
        silentLogger,
        "daytona",
      ),
    (error: unknown) => {
      assert.ok(error instanceof CloudAdapterError);
      assert.equal(error.code, "bootstrap_failed");
      return true;
    },
  );

  // 终止未确认（5xx）→ 保留计费槽与 cleanup operation。
  await assert.rejects(
    () =>
      startSupervisorOrTerminate(
        failing,
        async () => ({ ok: false, status: 503 }),
        "sbx-4",
        START_INPUT,
        silentLogger,
        "modal",
      ),
    (error: unknown) => {
      assert.ok(error instanceof CloudAdapterError);
      assert.equal(error.code, "provider_termination_unknown");
      return true;
    },
  );

  // 终止探测自身抛错（网络）→ 同样归未确认，绝不假设已清理。
  await assert.rejects(
    () =>
      startSupervisorOrTerminate(
        failing,
        async () => {
          throw new Error("ECONNRESET");
        },
        "sbx-5",
        START_INPUT,
        silentLogger,
        "e2b",
      ),
    (error: unknown) => {
      assert.ok(error instanceof CloudAdapterError);
      assert.equal(error.code, "provider_termination_unknown");
      return true;
    },
  );
});

// ── Daytona toolbox 通道 ──

interface ToolboxState {
  envCalls: Array<Record<string, string>>;
  execBodies: Array<Record<string, unknown>>;
  sessionProbeStatus: number;
  execStatus: number;
  commandExitCode: number | null;
  failEnvTimes: number;
}

function daytonaFetch(state: ToolboxState): SandboxFetch {
  return async (url, init) => {
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (url.endsWith("/sandbox/sbx-1")) {
      return response(200, { toolboxProxyUrl: "https://toolbox.example.test/" });
    }
    if (url.endsWith("/env")) {
      if (state.failEnvTimes > 0) {
        state.failEnvTimes -= 1;
        return response(500, {});
      }
      state.envCalls.push((body["set"] as Record<string, string>) ?? {});
      return response(200, {});
    }
    if (url.endsWith("/process/session/zcode-supervisor")) {
      return response(state.sessionProbeStatus, {});
    }
    if (url.endsWith("/process/session")) {
      return response(201, {});
    }
    if (url.endsWith("/process/session/zcode-supervisor/exec")) {
      state.execBodies.push(body);
      return response(state.execStatus, { cmdId: "cmd-1" });
    }
    if (url.endsWith("/process/session/zcode-supervisor/command/cmd-1")) {
      return response(200, { exitCode: state.commandExitCode });
    }
    throw new Error(`unexpected url: ${url}`);
  };
}

function newState(overrides: Partial<ToolboxState> = {}): ToolboxState {
  return {
    envCalls: [],
    execBodies: [],
    sessionProbeStatus: 404,
    execStatus: 200,
    commandExitCode: null,
    failEnvTimes: 0,
    ...overrides,
  };
}

test("e2b 即时失败探测：后台命令非 0 退出 → 确定失败、带脱敏原因、不重试", async () => {
  const sleeps: number[] = [];
  const starter = createE2bSupervisorStarter({
    apiKey: () => "k",
    // 复现真实联调：沙箱内脚本因状态目录不可写秒退，stderr 里有原因。
    runCommand: async () => ({
      exitCode: 1,
      stdout: "",
      stderr: `EACCES: permission denied, mkdir '/run/zcode-bridge' (ticket=${"ticket-abc"})`,
    }),
    sleep: async (ms) => void sleeps.push(ms),
    logger: silentLogger,
  });

  await assert.rejects(
    () => starter("sbx-1", START_INPUT),
    (error: unknown) => {
      assert.ok(error instanceof CloudAdapterError);
      assert.equal(error.code, "bootstrap_failed");
      assert.match(error.message, /EACCES: permission denied/);
      assert.equal(error.safeContext?.["exitCode"], 1);
      // 输出片段有界 + 抹掉自举 ticket（绝不把秘密带进错误/日志）。
      assert.ok(!error.message.includes("ticket-abc"));
      assert.match(error.message, /\[redacted\]/);
      assert.ok(String(error.safeContext?.["stderr"] ?? "").length <= 200);
      return true;
    },
  );
  // 立即失败不花任何等待，且**不重试**（沙箱内确定性失败重试无意义，须尽快补偿）。
  assert.deepEqual(sleeps, []);
});

test("e2b 即时失败探测：仍在运行按窗口轮询后视为已拉起，退出码 0 同样成功", async () => {
  const sleeps: number[] = [];
  const running = createE2bSupervisorStarter({
    apiKey: () => "k",
    runCommand: async () => ({ exitCode: undefined, stdout: "boot", stderr: "" }),
    probeWindowMs: 1_000,
    probePollMs: 250,
    sleep: async (ms) => void sleeps.push(ms),
    logger: silentLogger,
  });
  await running("sbx-1", START_INPUT);
  assert.deepEqual(sleeps, [250, 250, 250, 250], "窗口内按 poll 间隔有界轮询");

  // flock 幂等分支：已有实例在跑时脚本立即 exit 0，那是重试的正常结果而不是失败。
  const idempotent = createE2bSupervisorStarter({
    apiKey: () => "k",
    runCommand: async () => ({ exitCode: 0, stdout: "already running", stderr: "" }),
    sleep: async () => {},
    logger: silentLogger,
  });
  await idempotent("sbx-1", START_INPUT);
});

test("supervisor 自报失败行：stage/message 进原因，容错解析、不当协议帧", () => {
  const reported = supervisorExitError({
    provider: "e2b",
    sandboxId: "sbx-1",
    exitCode: 2,
    stdout: [
      "booting supervisor",
      '{"type":"zcode-supervisor-failed","stage":"runtime-ready","message":"EACCES: mkdir ~/.zcode/run"}',
    ].join("\n"),
    stderr: "",
    secrets: [],
  });
  assert.equal(reported.code, "bootstrap_failed");
  assert.equal(reported.safeContext?.["exitCode"], 2);
  assert.equal(reported.safeContext?.["stage"], "runtime-ready");
  assert.match(reported.message, /runtime-ready: EACCES: mkdir/);

  // 结构化行解析失败/不是该行 → 忽略，退回原始输出片段（绝不按帧语义消费）。
  assert.equal(parseSupervisorFailureLine('{"type":"other","stage":"x"}'), undefined);
  assert.equal(parseSupervisorFailureLine('{"type":"zcode-supervisor-failed"'), undefined);
  assert.equal(parseSupervisorFailureLine("plain failure text"), undefined);
  assert.deepEqual(
    parseSupervisorFailureLine('{"type":"zcode-supervisor-failed","message":"boom"}'),
    { message: "boom" },
  );

  const fallback = supervisorExitError({
    provider: "e2b",
    sandboxId: "sbx-2",
    exitCode: 1,
    stdout: "plain failure text",
    secrets: [],
  });
  assert.match(fallback.message, /plain failure text/);
});

test("supervisorExitError：输出先抹秘密再截断，缺失输出也有确定原因", () => {
  const withSecrets = supervisorExitError({
    provider: "e2b",
    sandboxId: "sbx-1",
    exitCode: 3,
    stdout: "line1\nline2 ticket-secret-value",
    stderr: "",
    secrets: ["ticket-secret-value"],
  });
  assert.match(withSecrets.message, /code 3/);
  assert.ok(!withSecrets.message.includes("ticket-secret-value"));
  assert.match(withSecrets.message, /line1 line2 \[redacted\]/);

  const noOutput = supervisorExitError({
    provider: "e2b",
    sandboxId: "sbx-2",
    exitCode: 127,
  });
  assert.match(noOutput.message, /no output captured/);
  assert.equal(noOutput.safeContext?.["stdout"], undefined);
});

test("daytona 通道：自举 env 只经 /env，命令字符串不含要素；重试有界", async () => {
  const state = newState({ failEnvTimes: 1 });
  const sleeps: number[] = [];
  const starter = createDaytonaSupervisorStarter({
    apiKey: () => "dtn_key",
    fetch: daytonaFetch(state),
    sleep: async (ms) => void sleeps.push(ms),
    logger: silentLogger,
  });

  await starter("sbx-1", START_INPUT);
  // 第一次 /env 失败 → 退避一次后成功。
  assert.deepEqual(sleeps, [supervisorStartBackoffMs(1)]);
  assert.equal(state.envCalls.length, 1);
  assert.equal(state.envCalls[0]!["ZCODE_CLOUD_BOOTSTRAP_TICKET"], "ticket-abc");
  // 命令字符串只有固定脚本路径：ticket 不进 argv。
  assert.deepEqual(state.execBodies[0], { command: SUPERVISOR_START_CMD, runAsync: true });
  assert.ok(!JSON.stringify(state.execBodies).includes("ticket-abc"));
});

test("daytona 通道：即时失败探测（非 0 退出）触发有界重试后失败", async () => {
  const state = newState({ commandExitCode: 3 });
  let attempts = 0;
  const starter = createDaytonaSupervisorStarter({
    apiKey: () => "dtn_key",
    fetch: async (url, init) => {
      if (url.endsWith("/process/session/zcode-supervisor/exec")) attempts += 1;
      return daytonaFetch(state)(url, init);
    },
    sleep: async () => {},
    logger: silentLogger,
  });

  await assert.rejects(
    () => starter("sbx-1", START_INPUT),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(`after ${SUPERVISOR_START_ATTEMPTS} attempts`));
      // 失败原因有界且不含 ticket。
      assert.ok(!error.message.includes("ticket-abc"));
      return true;
    },
  );
  assert.equal(attempts, SUPERVISOR_START_ATTEMPTS);
});

test("daytona 通道：会话已存在时复用（GET 200 不重复创建）", async () => {
  const state = newState({ sessionProbeStatus: 200 });
  const created: string[] = [];
  const starter = createDaytonaSupervisorStarter({
    apiKey: () => "dtn_key",
    fetch: async (url, init) => {
      if (url.endsWith("/process/session") && init.method === "POST") created.push(url);
      return daytonaFetch(state)(url, init);
    },
    sleep: async () => {},
    logger: silentLogger,
  });

  await starter("sbx-1", START_INPUT);
  assert.deepEqual(created, [], "会话已存在时不得重复创建");
});

// ── Modal SDK 通道 ──

test("modal 通道：exec 后台拉起脚本，env 只经 exec 载荷；失败重试有界", async () => {
  const calls: Array<{ op: ModalBridgeOp; payload: Record<string, unknown> }> = [];
  let failures = 1;
  const bridge: ModalSdkBridge = {
    async call(op, payload): Promise<ModalBridgeOutcome> {
      calls.push({ op, payload });
      if (failures > 0) {
        failures -= 1;
        return {
          ok: false,
          failure: {
            kind: "bridge",
            code: "provider_unreachable",
            definite: false,
            reason: "unreachable",
          },
        };
      }
      return { ok: true, result: { exitCode: null, detached: true } };
    },
  };
  const sleeps: number[] = [];
  const starter = createModalSdkSupervisorStarter({
    bridge,
    sleep: async (ms) => void sleeps.push(ms),
    logger: silentLogger,
  });

  await starter("sbx-modal", START_INPUT);
  assert.deepEqual(sleeps, [supervisorStartBackoffMs(1)]);
  const exec = calls.at(-1)!;
  assert.equal(exec.op, "exec");
  assert.deepEqual(exec.payload["command"], [SUPERVISOR_START_CMD]);
  assert.equal(exec.payload["mode"], "background");
  assert.equal(
    (exec.payload["env"] as Record<string, string>)["ZCODE_CLOUD_BOOTSTRAP_TICKET"],
    "ticket-abc",
  );
});

test("modal 通道：exec 命令立刻非 0 退出 → 本次尝试失败", async () => {
  let attempts = 0;
  const bridge: ModalSdkBridge = {
    async call(): Promise<ModalBridgeOutcome> {
      attempts += 1;
      return { ok: true, result: { exitCode: 137, detached: true } };
    },
  };
  const starter = createModalSdkSupervisorStarter({
    bridge,
    sleep: async () => {},
    logger: silentLogger,
  });
  await assert.rejects(
    () => starter("sbx-modal", START_INPUT),
    new RegExp(`after ${SUPERVISOR_START_ATTEMPTS} attempts`),
  );
  assert.equal(attempts, SUPERVISOR_START_ATTEMPTS);
});
