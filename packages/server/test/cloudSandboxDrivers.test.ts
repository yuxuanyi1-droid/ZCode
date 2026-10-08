/**
 * 沙箱 provider adapter contract 测试（specs/cloud-agent/01 §4、W3 §6 验收）。
 *
 * 覆盖每家的三分支：成功 / 明确失败（4xx，可判定未生效）/ 结果未知（网络、5xx、
 * 取消），外加控制面必须区分的三个边界：
 * - **create 丢响应**：资源已建但响应丢失 → `provider_create_unknown`，绝不写失败；
 * - **迟到 handle**：对账按 operationKey 命中已建资源 → `created`，不建第二个；
 * - **terminate 未确认**：网络/5xx → `unknown`（保留计费槽），404 才是确认已无资源。
 *
 * 全部走注入的 fake fetch / fake bridge：不发起任何真实网络请求。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { CloudAdapterLogger } from "../src/cloud/adapters/sandbox/adapterError.js";
import { CloudAdapterError } from "../src/cloud/adapters/sandbox/adapterError.js";
import {
  listSelectableProviders,
  resolvePauseResumeCapability,
  resolveProviderGate,
  SANDBOX_PROVIDER_GATES,
} from "../src/cloud/adapters/sandbox/capabilities.js";
import { createDaytonaSandboxDriver } from "../src/cloud/adapters/sandbox/daytonaDriver.js";
import { createE2bSupervisorStarter } from "../src/cloud/adapters/sandbox/e2bBootstrap.js";
import { createE2bSandboxDriver } from "../src/cloud/adapters/sandbox/e2bDriver.js";
import { createModalSandboxDriver } from "../src/cloud/adapters/sandbox/modalDriver.js";
import type {
  ModalBridgeOp,
  ModalBridgeOutcome,
  ModalSdkBridge,
} from "../src/cloud/adapters/sandbox/modalSdkBridge.js";
import {
  configuredSandboxProviders,
  createSandboxDriverBindings,
  SANDBOX_ADAPTER_CONTRACT_VERSION,
  SANDBOX_DRIVER_SECRET_NAMES,
} from "../src/cloud/adapters/sandbox/providers.js";
import {
  buildReconcileLabels,
  classifyCompensationTermination,
} from "../src/cloud/adapters/sandbox/reconcile.js";
import type { SupervisorStartInput } from "../src/cloud/adapters/sandbox/sandboxSupervisorStart.js";
import type {
  SandboxFetch,
  SandboxFetchResponse,
} from "../src/cloud/adapters/sandbox/sandboxRest.js";
import type { SandboxCreateInput } from "../src/cloud/app/ports/sandboxDriverPort.js";

const NOW = 1_800_000_000_000;

const silentLogger: CloudAdapterLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function response(status: number, body: unknown): SandboxFetchResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body ?? "")),
  };
}

function createScriptedFetch(
  handler: (call: FetchCall, index: number) => SandboxFetchResponse | Error,
): { fetch: SandboxFetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: SandboxFetch = async (url, init) => {
    const call: FetchCall = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
    };
    calls.push(call);
    const result = handler(call, calls.length - 1);
    if (result instanceof Error) throw result;
    return result;
  };
  return { fetch: fetchImpl, calls };
}

function startInput(overrides: Partial<SupervisorStartInput> = {}): SupervisorStartInput {
  return {
    operationKey: "op-1",
    runId: "run-1",
    runGeneration: 1,
    publicControlPlaneUrl: "https://control.example.test",
    bootstrapTicket: "ticket-secret-value",
    taskId: "8f1b0f9e-3b1a-4c2d-9e6f-0a1b2c3d4e5f",
    workspacePath: "/workspace/zcode-repo",
    ...overrides,
  };
}

function baseInput(overrides: Partial<SandboxCreateInput> = {}): SandboxCreateInput {
  return {
    operationKey: "op-1",
    runId: "run-1",
    runGeneration: 1,
    bootstrapAddress: {
      taskId: "8f1b0f9e-3b1a-4c2d-9e6f-0a1b2c3d4e5f",
      workspacePath: "/workspace/zcode-repo",
    },
    imageRef: "zcode-sandbox-template@1.0.0",
    resources: { cpu: 2, memoryMiB: 4096, diskGiB: 10 },
    requestedDeadline: NOW + 3_600_000,
    publicControlPlaneUrl: "https://control.example.test",
    bootstrapTicket: "ticket-secret-value",
    labels: { taskSlug: "task-1" },
    signal: new AbortController().signal,
    ...overrides,
  };
}

function recordingStarter(): {
  starter: (sandboxId: string, input: SupervisorStartInput) => Promise<void>;
  calls: Array<{ sandboxId: string; input: SupervisorStartInput }>;
  fail: { value: boolean };
} {
  const calls: Array<{ sandboxId: string; input: SupervisorStartInput }> = [];
  const fail = { value: false };
  return {
    calls,
    fail,
    starter: async (sandboxId, input) => {
      calls.push({ sandboxId, input });
      if (fail.value) throw new Error("injected supervisor start failure");
    },
  };
}

// ───────────────────────────── E2B ─────────────────────────────

test("e2b: create 成功返回 handle，自举 env 只走命令通道，标签不含凭据", async () => {
  const starter = recordingStarter();
  const { fetch, calls } = createScriptedFetch((call) => {
    assert.equal(call.method, "POST");
    return response(200, { sandboxID: "sbx-e2b-1", templateRevision: "rev-7" });
  });
  const driver = createE2bSandboxDriver({
    apiKey: () => "e2b-key",
    fetch,
    now: () => NOW,
    startSupervisor: starter.starter,
    logger: silentLogger,
  });

  const handle = await driver.create(baseInput());
  assert.equal(handle.provider, "e2b");
  assert.equal(handle.sandboxId, "sbx-e2b-1");
  assert.equal(handle.templateRevision, "rev-7");
  assert.equal(handle.providerDeadline, NOW + 3_600_000);

  const body = JSON.parse(calls[0]!.body ?? "{}") as Record<string, unknown>;
  assert.equal(body["templateID"], "zcode-sandbox-template@1.0.0");
  assert.equal(body["timeout"], 3600);
  const metadata = body["metadata"] as Record<string, string>;
  assert.equal(metadata["operationKey"], "op-1");
  assert.equal(metadata["runId"], "run-1");
  assert.equal(metadata["runGeneration"], "1");
  assert.equal(metadata["taskSlug"], "task-1");
  // ticket 绝不进 metadata / URL（只经命令 env）。
  assert.ok(!JSON.stringify(body).includes("ticket-secret-value"));
  assert.ok(!calls[0]!.url.includes("ticket-secret-value"));

  // 01 §5.1 第 3 条顺序：create 只建资源并返回 handle，**不在这里拉起 supervisor**
  // （必须先持久 handle/deadline，否则首次握手会因 workspace-path-mismatch 被 1008 拒绝）。
  assert.equal(starter.calls.length, 0);
});

test("e2b: startSupervisor 在持久化后拉起，重复调用走同一 env（幂等由镜像内 flock 保证）", async () => {
  const starter = recordingStarter();
  const { fetch } = createScriptedFetch(() => response(200, { sandboxID: "sbx-e2b-1" }));
  const driver = createE2bSandboxDriver({
    apiKey: () => "k",
    fetch,
    now: () => NOW,
    startSupervisor: starter.starter,
    logger: silentLogger,
  });
  const handle = await driver.create(baseInput());

  await driver.startSupervisor(handle, startInput());
  await driver.startSupervisor(handle, startInput());
  assert.equal(starter.calls.length, 2);
  for (const call of starter.calls) {
    assert.equal(call.sandboxId, "sbx-e2b-1");
    assert.deepEqual(call.input, startInput(), "重复调用传递同一自举要素（脚本侧 flock 去重）");
  }
});

test("e2b: 地址要素进自举 env 但不进 provider metadata；非法地址在启动时拒绝并补偿", async () => {
  const starter = recordingStarter();
  const taskId = "8f1b0f9e-3b1a-4c2d-9e6f-0a1b2c3d4e5f";
  const { fetch, calls } = createScriptedFetch((call) =>
    call.method === "POST" ? response(200, { sandboxID: "sbx-addr" }) : response(200, {}),
  );
  const driver = createE2bSandboxDriver({
    apiKey: () => "k",
    fetch,
    now: () => NOW,
    startSupervisor: starter.starter,
    logger: silentLogger,
  });

  const handle = await driver.create(
    baseInput({
      bootstrapAddress: { taskId, workspacePath: "/workspace/zcode-repo" },
      labels: { taskName: "demo" },
    }),
  );
  await driver.startSupervisor(
    handle,
    startInput({ taskId, workspacePath: "/workspace/zcode-repo" }),
  );
  assert.equal(starter.calls[0]!.input.taskId, taskId);
  assert.equal(starter.calls[0]!.input.workspacePath, "/workspace/zcode-repo");
  // 地址要素不进 provider metadata（provider API 可见面最小化）；调用方标签照旧写入。
  const metadata = JSON.parse(calls[0]!.body ?? "{}")["metadata"] as Record<string, string>;
  assert.equal(metadata["taskName"], "demo");
  assert.equal(metadata["workspacePath"], undefined);
  assert.equal(metadata["taskId"], undefined);
  assert.equal(metadata["operationKey"], "op-1");

  // 非法 taskId / 相对路径：**启动时**拒绝（不把非法或占位身份下发给沙箱），并补偿终止。
  for (const invalid of [{ taskId: "not-a-task-id" }, { workspacePath: "relative/path" }]) {
    await assert.rejects(
      () => driver.startSupervisor(handle, startInput(invalid)),
      (error: unknown) => {
        assert.ok(error instanceof CloudAdapterError);
        assert.equal(error.code, "bootstrap_failed");
        return true;
      },
    );
  }
  assert.equal(starter.calls.length, 1, "非法自举输入不得下发到命令通道");
  assert.equal(calls.at(-1)!.method, "DELETE", "输入非法同样走补偿终止，不留孤儿");
});

test("顺序契约：create 返回 handle 后、持久化之前不得启动 supervisor", async () => {
  const starter = recordingStarter();
  const { fetch } = createScriptedFetch(() => response(200, { sandboxID: "sbx-order" }));
  const driver = createE2bSandboxDriver({
    apiKey: () => "k",
    fetch,
    now: () => NOW,
    startSupervisor: starter.starter,
    logger: silentLogger,
  });

  const handle = await driver.create(baseInput());
  assert.equal(handle.sandboxId, "sbx-order");
  // 关键：create 完成时**没有任何命令通道调用**——控制面必须先持久化 handle/workspacePath，
  // 否则首次 bridge 握手会因 workspace-path-mismatch 被 1008 拒绝（真实现象）。
  assert.equal(starter.calls.length, 0);
});

test("对账恢复路径：create 丢响应后，用对账得到的 handle 才能拉起 supervisor", async () => {
  const starter = recordingStarter();
  const { fetch } = createScriptedFetch((call) => {
    if (call.method === "POST") return response(503, {}); // create 丢响应：资源可能已建
    return response(200, {
      sandboxes: [{ sandboxID: "sbx-recovered", metadata: { operationKey: "op-1" } }],
    });
  });
  const driver = createE2bSandboxDriver({
    apiKey: () => "k",
    fetch,
    now: () => NOW,
    startSupervisor: starter.starter,
    logger: silentLogger,
  });

  await assert.rejects(() => driver.create(baseInput()), /result unknown/);
  assert.equal(starter.calls.length, 0, "create 未知结果时不可能拉起 supervisor");

  const reconciled = await driver.findCreateResult("op-1");
  assert.equal(reconciled.status, "created");
  if (reconciled.status !== "created") return;
  // 这条路径今天必须由控制面显式补一次启动，否则沙箱活着但没人回连。
  await driver.startSupervisor(reconciled.handle, startInput());
  assert.equal(starter.calls.length, 1);
  assert.equal(starter.calls[0]!.sandboxId, "sbx-recovered");
});

test("e2b: create 明确失败（4xx）抛归一错误，且不启动 supervisor", async () => {
  const starter = recordingStarter();
  const { fetch } = createScriptedFetch(() => response(400, { message: "invalid template" }));
  const driver = createE2bSandboxDriver({
    apiKey: () => "k",
    fetch,
    now: () => NOW,
    startSupervisor: starter.starter,
    logger: silentLogger,
  });

  await assert.rejects(
    () => driver.create(baseInput()),
    (error: unknown) => {
      assert.ok(error instanceof CloudAdapterError);
      assert.equal(error.code, "validation_failed");
      assert.equal(error.retryable, false);
      return true;
    },
  );
  assert.equal(starter.calls.length, 0);
});

test("e2b: supervisor 秒退（探测命中）→ startSupervisor 抛确定错误并补偿终止", async () => {
  const { fetch, calls } = createScriptedFetch((call) =>
    call.method === "POST" ? response(200, { sandboxID: "sbx-probe" }) : response(200, {}),
  );
  const starter = createE2bSupervisorStarter({
    apiKey: () => "k",
    runCommand: async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "EACCES: permission denied, mkdir '/run/zcode-bridge'",
    }),
    sleep: async () => {},
    logger: silentLogger,
  });
  const driver = createE2bSandboxDriver({
    apiKey: () => "k",
    fetch,
    now: () => NOW,
    startSupervisor: starter,
    logger: silentLogger,
  });

  const handle = await driver.create(baseInput());
  await assert.rejects(
    () => driver.startSupervisor(handle, startInput()),
    (error: unknown) => {
      assert.ok(error instanceof CloudAdapterError);
      assert.equal(error.code, "bootstrap_failed");
      assert.match(error.message, /EACCES: permission denied/);
      // 原因进错误消息（控制面 last_error 可读），不只是日志。
      assert.match(error.message, /\[reason: /);
      return true;
    },
  );
  // 失败即补偿终止（01 §5.1/§9）：不留孤儿，也不把失败留给 readiness 超时。
  assert.equal(calls.at(-1)!.method, "DELETE");
});

test("e2b: create 5xx/网络 → provider_create_unknown；迟到 handle 由对账命中", async () => {
  const starter = recordingStarter();
  let listAttempt = 0;
  const { fetch } = createScriptedFetch((call) => {
    if (call.method === "POST") return response(503, { message: "service unavailable" });
    listAttempt += 1;
    // 资源其实已创建：对账清单里存在同 operationKey 的沙箱（迟到 handle）。
    return response(200, {
      sandboxes: [{ sandboxID: "sbx-e2b-late", metadata: { operationKey: "op-1" } }],
    });
  });
  const driver = createE2bSandboxDriver({
    apiKey: () => "k",
    fetch,
    now: () => NOW,
    startSupervisor: starter.starter,
    logger: silentLogger,
  });

  await assert.rejects(
    () => driver.create(baseInput()),
    (error: unknown) => {
      assert.ok(error instanceof CloudAdapterError);
      assert.equal(error.code, "provider_create_unknown");
      return true;
    },
  );

  const reconciled = await driver.findCreateResult("op-1");
  assert.equal(listAttempt, 1);
  assert.deepEqual(reconciled, {
    status: "created",
    handle: { provider: "e2b", sandboxId: "sbx-e2b-late" },
  });
});

test("e2b: 对账窗口内查不到 → unknown；超出窗口且无资源 → notFound", async () => {
  let clock = NOW;
  // POST（create）确定性失败：模板不存在；GET（清单查询）成功但没有该资源。
  const scripted = createScriptedFetch((call) =>
    call.method === "POST"
      ? response(404, { message: "template not found" })
      : response(200, { sandboxes: [] }),
  );
  const driver = createE2bSandboxDriver({
    apiKey: () => "k",
    fetch: scripted.fetch,
    now: () => clock,
    createReconciliationWindowMs: 60_000,
    logger: silentLogger,
  });

  await assert.rejects(
    () => driver.create(baseInput({ operationKey: "op-window" })),
    (error: unknown) => {
      assert.ok(error instanceof CloudAdapterError);
      assert.equal(error.code, "unsupported_template");
      return true;
    },
  );

  // 窗口内（本进程记录过尝试）→ unknown：在途 create 可能稍后落地。
  const withinWindow = await driver.findCreateResult("op-window");
  assert.deepEqual(withinWindow, { status: "unknown", errorCode: "provider_create_unknown" });

  // 超出窗口 → notFound（重试安全）。
  clock += 120_000;
  const beyondWindow = await driver.findCreateResult("op-window");
  assert.deepEqual(beyondWindow, { status: "notFound" });

  // 完全没有锚点（跨进程且调用方未提供）→ 保守 unknown，而不是 notFound。
  const noAnchor = await driver.findCreateResult("op-from-previous-process");
  assert.deepEqual(noAnchor, { status: "unknown", errorCode: "provider_create_unknown" });

  // CR-2：控制面持久的尝试时间可独立判定，不依赖进程内锚点（重启后仍能收敛）。
  const durableBeyond = await driver.findCreateResult("op-from-durable", {
    operationAttemptedAtMs: clock - 10 * 60_000,
  });
  assert.deepEqual(durableBeyond, { status: "notFound" });
  const durableWithin = await driver.findCreateResult("op-from-durable", {
    operationAttemptedAtMs: clock - 30_000,
  });
  assert.deepEqual(durableWithin, { status: "unknown", errorCode: "provider_create_unknown" });

  // durable 值优先于进程内锚点：进程内仍说「窗口内」，durable 已明显超出 → notFound。
  await assert.rejects(
    () => driver.create(baseInput({ operationKey: "op-precedence" })),
    () => true,
  );
  const precedence = await driver.findCreateResult("op-precedence", {
    operationAttemptedAtMs: clock - 10 * 60_000,
  });
  assert.deepEqual(precedence, { status: "notFound" });
});

test("e2b: inspect/terminate/extend 的三分支与终态证据来源", async () => {
  const scripted: Array<SandboxFetchResponse | Error> = [];
  const { fetch } = createScriptedFetch(() => scripted.shift() ?? new Error("unexpected call"));
  const driver = createE2bSandboxDriver({
    apiKey: () => "k",
    fetch,
    now: () => NOW,
    logger: silentLogger,
  });
  const handle = { provider: "e2b", sandboxId: "sbx-1" };

  scripted.push(response(404, {}));
  assert.deepEqual(await driver.inspect(handle), {
    status: "notFound",
    observedAt: NOW,
    evidenceSource: "provider-api",
    evidence: "e2b GET /sandboxes/sbx-1 -> 404 not-found",
  });

  scripted.push(response(401, {}));
  assert.deepEqual(await driver.inspect(handle), {
    status: "unknown",
    observedAt: NOW,
    evidenceSource: "provider-api",
    evidence: "e2b GET /sandboxes/sbx-1 -> 401 auth-lost",
    errorCode: "permission_revoked",
  });

  scripted.push(new Error("socket hang up"));
  const unreachable = await driver.inspect(handle);
  assert.deepEqual(unreachable, {
    status: "unknown",
    observedAt: NOW,
    evidenceSource: "none",
    evidence: "e2b GET /sandboxes/sbx-1 -> network-error",
    errorCode: "provider_unreachable",
  });

  scripted.push(response(200, { state: "running" }));
  const running = await driver.inspect(handle);
  assert.equal(running.status, "running");
  assert.equal(running.evidence, "e2b GET /sandboxes/sbx-1 -> 200 state=running");
  // 证据有界（≤160 字符）且不含自举票据/labels（01 §9 审计边界）。
  for (const observation of [running, unreachable]) {
    assert.ok(observation.evidence !== undefined);
    assert.ok(observation.evidence.length <= 160);
    assert.ok(!observation.evidence.includes("ticket-secret-value"));
    assert.ok(!observation.evidence.includes("task-1"));
  }

  scripted.push(response(200, { state: "weird-state" }));
  const unmapped = await driver.inspect(handle);
  assert.equal(unmapped.status, "unknown");
  assert.match(unmapped.evidence ?? "", /unmapped-state=weird-state/);

  scripted.push(response(200, {}));
  assert.deepEqual(await driver.extendDeadline(handle, NOW + 7_200_000), {
    status: "confirmed",
    expiresAt: NOW + 7_200_000,
  });

  scripted.push(response(429, {}));
  await assert.rejects(
    () => driver.extendDeadline(handle, NOW + 7_200_000),
    (error: unknown) => {
      assert.ok(error instanceof CloudAdapterError);
      assert.equal(error.code, "rate_limited");
      return true;
    },
  );

  scripted.push(response(200, {}));
  assert.deepEqual(await driver.terminate(handle), { status: "terminated" });

  // terminate 未确认：5xx / 网络 → unknown（保留计费槽），不是 notTerminated。
  scripted.push(response(503, {}));
  assert.deepEqual(await driver.terminate(handle), {
    status: "unknown",
    errorCode: "provider_termination_unknown",
  });
  scripted.push(new Error("ECONNRESET"));
  assert.deepEqual(await driver.terminate(handle), {
    status: "unknown",
    errorCode: "provider_termination_unknown",
  });

  // provider 明确拒绝终止 → notTerminated（资源确认仍在）。
  scripted.push(response(403, {}));
  assert.deepEqual(await driver.terminate(handle), {
    status: "notTerminated",
    errorCode: "permission_revoked",
  });
});

test("e2b: supervisor 启动失败 → 补偿终止并按 provider 事实分类", async () => {
  const starter = recordingStarter();
  starter.fail.value = true;

  // 已确认清理（DELETE 200）→ bootstrap_failed。
  const confirmed = createScriptedFetch((call) =>
    call.method === "POST" ? response(200, { sandboxID: "sbx-compensate" }) : response(200, {}),
  );
  const confirmedDriver = createE2bSandboxDriver({
    apiKey: () => "k",
    fetch: confirmed.fetch,
    now: () => NOW,
    startSupervisor: starter.starter,
    logger: silentLogger,
  });
  const confirmedHandle = await confirmedDriver.create(baseInput());
  await assert.rejects(
    () => confirmedDriver.startSupervisor(confirmedHandle, startInput()),
    (error: unknown) => {
      assert.ok(error instanceof CloudAdapterError);
      assert.equal(error.code, "bootstrap_failed");
      return true;
    },
  );
  assert.equal(confirmed.calls.at(-1)!.method, "DELETE", "补偿路径必须真的发起终止");

  // 终止结果未知（DELETE 503）→ provider_termination_unknown（保留槽位对账）。
  const unconfirmed = createScriptedFetch((call) =>
    call.method === "POST" ? response(200, { sandboxID: "sbx-compensate-2" }) : response(503, {}),
  );
  const unconfirmedDriver = createE2bSandboxDriver({
    apiKey: () => "k",
    fetch: unconfirmed.fetch,
    now: () => NOW,
    startSupervisor: starter.starter,
    logger: silentLogger,
  });
  const unconfirmedHandle = await unconfirmedDriver.create(baseInput());
  await assert.rejects(
    () => unconfirmedDriver.startSupervisor(unconfirmedHandle, startInput()),
    (error: unknown) => {
      assert.ok(error instanceof CloudAdapterError);
      assert.equal(error.code, "provider_termination_unknown");
      return true;
    },
  );
});

test("e2b: latest 镜像与保留标签键在本地拒绝（create 前，不占 quota）", async () => {
  const { fetch, calls } = createScriptedFetch(() => response(200, { sandboxID: "sbx" }));
  const driver = createE2bSandboxDriver({
    apiKey: () => "k",
    fetch,
    now: () => NOW,
    startSupervisor: async () => {},
    logger: silentLogger,
  });

  await assert.rejects(
    () => driver.create(baseInput({ imageRef: "zcode-sandbox-template:latest" })),
    (error: unknown) => {
      assert.ok(error instanceof CloudAdapterError);
      assert.equal(error.code, "unsupported_template");
      return true;
    },
  );
  await assert.rejects(
    () => driver.create(baseInput({ labels: { operationKey: "spoofed" } })),
    (error: unknown) => {
      assert.ok(error instanceof CloudAdapterError);
      assert.equal(error.code, "validation_failed");
      return true;
    },
  );
  await assert.rejects(
    () => driver.create(baseInput({ requestedDeadline: NOW - 1000 })),
    (error: unknown) => {
      assert.ok(error instanceof CloudAdapterError);
      assert.equal(error.code, "validation_failed");
      return true;
    },
  );
  assert.equal(calls.length, 0, "本地校验失败不得发起 provider 请求");
});

// ───────────────────────────── Daytona ─────────────────────────────

test("daytona: create 关闭 idle 回收、TTL 取分钟、handle 用 provider 期限", async () => {
  const starter = recordingStarter();
  const { fetch, calls } = createScriptedFetch(() =>
    response(200, {
      id: "sbx-daytona-1",
      snapshot: "zcode-sandbox-template",
      autoDestroyAt: new Date(NOW + 3_600_000).toISOString(),
    }),
  );
  const driver = createDaytonaSandboxDriver({
    apiKey: () => "dtn_key",
    fetch,
    now: () => NOW,
    startSupervisor: starter.starter,
    logger: silentLogger,
  });

  const handle = await driver.create(baseInput());
  assert.equal(handle.sandboxId, "sbx-daytona-1");
  assert.equal(handle.templateRevision, "zcode-sandbox-template");
  assert.equal(handle.providerDeadline, NOW + 3_600_000);

  const body = JSON.parse(calls[0]!.body ?? "{}") as Record<string, unknown>;
  assert.equal(body["snapshot"], "zcode-sandbox-template@1.0.0");
  assert.equal(body["ttlMinutes"], 60);
  assert.equal(body["autoStopInterval"], 0);
  assert.equal(body["autoPauseInterval"], 0);
  assert.equal(body["autoArchiveInterval"], 0);
  assert.equal(body["autoDeleteInterval"], -1);
  // 资源由 snapshot 固定：请求体不带 resources（不伪造设置成功）。
  assert.ok(!("resources" in body));
  assert.equal((body["labels"] as Record<string, string>)["operationKey"], "op-1");
  // create 不拉起 supervisor（01 §5.1 第 3 条顺序）。
  assert.equal(starter.calls.length, 0);

  // 地址要素不进 provider labels（只进自举 env）。
  const withAddress = createScriptedFetch(() =>
    response(200, {
      id: "sbx-addr",
      snapshot: "zcode-sandbox-template",
      autoDestroyAt: new Date(NOW + 3_600_000).toISOString(),
    }),
  );
  const addressDriver = createDaytonaSandboxDriver({
    apiKey: () => "k",
    fetch: withAddress.fetch,
    now: () => NOW,
    startSupervisor: starter.starter,
    logger: silentLogger,
  });
  const addressHandle = await addressDriver.create(
    baseInput({
      bootstrapAddress: {
        taskId: "8f1b0f9e-3b1a-4c2d-9e6f-0a1b2c3d4e5f",
        workspacePath: "/workspace/r",
      },
    }),
  );
  const labels = JSON.parse(withAddress.calls[0]!.body ?? "{}")["labels"] as Record<string, string>;
  assert.equal(labels["workspacePath"], undefined);
  assert.equal(labels["taskId"], undefined);
  await addressDriver.startSupervisor(
    addressHandle,
    startInput({ taskId: "8f1b0f9e-3b1a-4c2d-9e6f-0a1b2c3d4e5f", workspacePath: "/workspace/r" }),
  );
  assert.equal(starter.calls.at(-1)!.input.workspacePath, "/workspace/r");
  assert.equal(starter.calls.at(-1)!.input.taskId, "8f1b0f9e-3b1a-4c2d-9e6f-0a1b2c3d4e5f");
});

test("daytona: create 5xx → unknown；terminate 未确认保留槽位", async () => {
  const { fetch } = createScriptedFetch((call) =>
    call.method === "POST" ? response(500, {}) : response(503, {}),
  );
  const driver = createDaytonaSandboxDriver({
    apiKey: () => "k",
    fetch,
    now: () => NOW,
    startSupervisor: async () => {},
    logger: silentLogger,
  });

  await assert.rejects(
    () => driver.create(baseInput()),
    (error: unknown) => {
      assert.ok(error instanceof CloudAdapterError);
      assert.equal(error.code, "provider_create_unknown");
      return true;
    },
  );
  assert.deepEqual(await driver.terminate({ provider: "daytona", sandboxId: "sbx" }), {
    status: "unknown",
    errorCode: "provider_termination_unknown",
  });
});

test("daytona: 对账按 labels.operationKey 命中；未命中且窗口内 → unknown", async () => {
  const { fetch } = createScriptedFetch(() =>
    response(200, { items: [{ id: "sbx-found", labels: { operationKey: "op-hit" } }] }),
  );
  const driver = createDaytonaSandboxDriver({
    apiKey: () => "k",
    fetch,
    now: () => NOW,
    createReconciliationWindowMs: 60_000,
    logger: silentLogger,
  });

  assert.deepEqual(await driver.findCreateResult("op-hit"), {
    status: "created",
    handle: { provider: "daytona", sandboxId: "sbx-found" },
  });
  assert.deepEqual(await driver.findCreateResult("op-miss"), {
    status: "unknown",
    errorCode: "provider_create_unknown",
  });
  // durable 锚点超出窗口 → notFound（重试安全），不依赖进程内锚点。
  assert.deepEqual(
    await driver.findCreateResult("op-miss", { operationAttemptedAtMs: NOW - 10 * 60_000 }),
    { status: "notFound" },
  );
});

test("daytona: 状态映射区分运行/停止/destroyed/未映射", async () => {
  const scripted: Array<SandboxFetchResponse | Error> = [];
  const { fetch } = createScriptedFetch(() => scripted.shift() ?? new Error("unexpected"));
  const driver = createDaytonaSandboxDriver({
    apiKey: () => "k",
    fetch,
    now: () => NOW,
    logger: silentLogger,
  });
  const handle = { provider: "daytona", sandboxId: "sbx" };

  for (const [state, expected] of [
    ["started", "running"],
    // 2026-10-09 生命周期 v2：paused 是独立观测态（暂停保留期实例被 provider 保留，
    // 不得按 stopped 收口——keepalive liveness 据此区分「保留中」与「已终止」）。
    ["paused", "paused"],
    ["destroying", "stopped"],
    ["destroyed", "notFound"],
    ["error", "unknown"],
  ] as const) {
    scripted.push(response(200, { state }));
    const observation = await driver.inspect(handle);
    assert.equal(observation.status, expected, `state=${state}`);
    // 证据串带 provider 状态原文要点，供运营核对。
    assert.match(observation.evidence ?? "", new RegExp(`state=${state}`));
    assert.ok((observation.evidence ?? "").length <= 160);
  }

  scripted.push(new Error("timeout"));
  const unreachable = await driver.inspect(handle);
  assert.equal(unreachable.status, "unknown");
  assert.equal(unreachable.evidenceSource, "none");
  assert.match(unreachable.evidence ?? "", /network-error/);
});

test("daytona: extend 确认 autoDestroyAt；缺失时按估计上报不冒充确认", async () => {
  const scripted: Array<SandboxFetchResponse | Error> = [
    response(201, { autoDestroyAt: new Date(NOW + 7_200_000).toISOString() }),
    response(201, {}),
  ];
  const { fetch, calls } = createScriptedFetch(() => scripted.shift() ?? new Error("unexpected"));
  const driver = createDaytonaSandboxDriver({
    apiKey: () => "k",
    fetch,
    now: () => NOW,
    logger: silentLogger,
  });
  const handle = { provider: "daytona", sandboxId: "sbx" };

  assert.deepEqual(await driver.extendDeadline(handle, NOW + 7_200_000), {
    status: "confirmed",
    expiresAt: NOW + 7_200_000,
  });
  assert.match(calls[0]!.url, /\/sandbox\/sbx\/ttl\/120$/);

  const estimated = await driver.extendDeadline(handle, NOW + 7_200_000);
  assert.equal(estimated.status, "estimated");
  assert.equal(estimated.status === "estimated" ? estimated.deadlineConfidence : "", "medium");
});

// ───────────────────────────── Modal ─────────────────────────────

function createFakeBridge(
  script: (op: ModalBridgeOp, payload: Record<string, unknown>) => ModalBridgeOutcome | Error,
): {
  bridge: ModalSdkBridge;
  calls: Array<{ op: ModalBridgeOp; payload: Record<string, unknown> }>;
} {
  const calls: Array<{ op: ModalBridgeOp; payload: Record<string, unknown> }> = [];
  const bridge: ModalSdkBridge = {
    async call(op, payload) {
      calls.push({ op, payload });
      const result = script(op, payload);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { bridge, calls };
}

test("modal: 无桥 → 门禁降级（明确能力错误，不发起请求）", async () => {
  const driver = createModalSandboxDriver({ logger: silentLogger });
  const capabilities = await driver.describeCapabilities();
  assert.equal(capabilities.createOperationLookup, "none");
  assert.equal(capabilities.canInspect, false);
  assert.equal(capabilities.canConfirmTermination, false);

  await assert.rejects(
    () => driver.create(baseInput()),
    (error: unknown) => {
      assert.ok(error instanceof CloudAdapterError);
      assert.equal(error.code, "resource_unsupported");
      return true;
    },
  );
  assert.deepEqual(await driver.terminate({ provider: "modal", sandboxId: "sbx" }), {
    status: "unknown",
    errorCode: "resource_unsupported",
  });
  assert.deepEqual(await driver.findCreateResult("op-1"), {
    status: "unknown",
    errorCode: "provider_create_unknown",
  });
});

test("modal: 桥通道 create 成功、tags 只含对账键、supervisor 经 exec 通道拉起", async () => {
  const supervisorStarts: string[] = [];
  const { bridge, calls } = createFakeBridge((op) => {
    if (op === "create") {
      return { ok: true, result: { sandboxId: "sbx-modal-1", dockerfileSha256: "a".repeat(64) } };
    }
    if (op === "exec") return { ok: true, result: { exitCode: null, detached: true } };
    return {
      ok: false,
      failure: { kind: "bridge", code: "not_found", definite: true, reason: "not-found" },
    };
  });
  const driver = createModalSandboxDriver({
    bridge,
    imageDockerfile: "/srv/zcode/templates/modal.Dockerfile",
    now: () => NOW,
    logger: silentLogger,
    startSupervisor: async (sandboxId) => {
      supervisorStarts.push(sandboxId);
    },
  });

  const capabilities = await driver.describeCapabilities();
  assert.equal(capabilities.createOperationLookup, "metadata-search");
  assert.equal(capabilities.canExtendDeadline, false);
  assert.equal(capabilities.deadlineSource, "estimated");

  const handle = await driver.create(baseInput());
  assert.equal(handle.sandboxId, "sbx-modal-1");
  assert.equal(handle.providerDeadline, undefined);
  assert.equal(handle.deadlineEstimate, NOW + 3_600_000);
  assert.equal(handle.templateRevision, `modal-dockerfile@sha256:${"a".repeat(16)}`);

  const createCall = calls.find((call) => call.op === "create")!;
  assert.deepEqual(createCall.payload["tags"], {
    taskSlug: "task-1",
    operationKey: "op-1",
    runId: "run-1",
    runGeneration: "1",
  });
  assert.equal(JSON.stringify(createCall.payload).includes("ticket-secret-value"), false);
  // create 不拉起 supervisor；控制面持久化后调 startSupervisor 才拉起。
  assert.deepEqual(supervisorStarts, []);
  await driver.startSupervisor(
    handle,
    startInput({ taskId: "0a1b2c3d-4e5f-8f1b-0f9e-3b1a4c2d9e6f" }),
  );
  assert.deepEqual(supervisorStarts, ["sbx-modal-1"]);

  assert.deepEqual(await driver.extendDeadline(handle, NOW + 7_200_000), { status: "unsupported" });
});

test("modal: create 明确失败 vs 结果未知；终止未确认保留槽位", async () => {
  const definite = createFakeBridge(() => ({
    ok: false,
    failure: {
      kind: "bridge",
      code: "unsupported_template",
      definite: true,
      reason: "image-build-failed",
      stage: "image",
    },
  }));
  const definiteDriver = createModalSandboxDriver({
    bridge: definite.bridge,
    imageDockerfile: "/tmp/modal.Dockerfile",
    logger: silentLogger,
  });
  await assert.rejects(
    () => definiteDriver.create(baseInput()),
    (error: unknown) => {
      assert.ok(error instanceof CloudAdapterError);
      assert.equal(error.code, "unsupported_template");
      return true;
    },
  );

  const unknown = createFakeBridge(() => ({
    ok: false,
    failure: {
      kind: "timeout",
      code: "provider_unreachable",
      definite: false,
      reason: "timeout-900000ms",
    },
  }));
  const unknownDriver = createModalSandboxDriver({
    bridge: unknown.bridge,
    imageDockerfile: "/tmp/modal.Dockerfile",
    logger: silentLogger,
  });
  await assert.rejects(
    () => unknownDriver.create(baseInput()),
    (error: unknown) => {
      assert.ok(error instanceof CloudAdapterError);
      assert.equal(error.code, "provider_create_unknown");
      return true;
    },
  );

  const { bridge, calls } = createFakeBridge((op) => {
    if (op === "list") return { ok: true, result: { sandboxes: [] } };
    return { ok: true, result: { terminated: true, notFound: true } };
  });
  const reconcileDriver = createModalSandboxDriver({
    bridge,
    imageDockerfile: "/tmp/modal.Dockerfile",
    now: () => NOW,
    createReconciliationWindowMs: 60_000,
    logger: silentLogger,
  });
  assert.deepEqual(await reconcileDriver.terminate({ provider: "modal", sandboxId: "sbx" }), {
    status: "terminated",
  });
  assert.equal(calls.at(-1)!.op, "terminate");
});

test("modal: inspect 用桥报告的证据串，超长与未映射状态都有界可核对", async () => {
  const longEvidence = `modal poll -> ${"x".repeat(400)}`;
  const scripted: Array<Record<string, unknown>> = [
    { status: "running", evidence: "modal poll -> running" },
    { status: "stopped", evidence: longEvidence, exitCode: 137 },
    { status: "weird", evidence: "modal poll -> weird" },
  ];
  const { bridge } = createFakeBridge(() => ({
    ok: true,
    result: scripted.shift() ?? {},
  }));
  const driver = createModalSandboxDriver({ bridge, logger: silentLogger });
  const handle = { provider: "modal", sandboxId: "sbx-modal" };

  const running = await driver.inspect(handle);
  assert.equal(running.status, "running");
  assert.equal(running.evidence, "modal poll -> running");

  const stopped = await driver.inspect(handle);
  assert.equal(stopped.status, "stopped");
  assert.ok((stopped.evidence ?? "").length <= 160, "证据串必须被截断到 160 字符内");

  const unmapped = await driver.inspect(handle);
  assert.equal(unmapped.status, "unknown");
  assert.equal(unmapped.evidence, "modal poll -> weird");
});

test("modal: 镜像来源缺配置在 create 前明确失败（不猜镜像）", async () => {
  const { bridge, calls } = createFakeBridge(() => ({
    ok: true,
    result: { sandboxId: "sbx" },
  }));
  const driver = createModalSandboxDriver({ bridge, logger: silentLogger });
  await assert.rejects(
    () => driver.create(baseInput()),
    (error: unknown) => {
      assert.ok(error instanceof CloudAdapterError);
      assert.equal(error.code, "validation_failed");
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

// ───────────────────────── 能力门控与对账工具 ─────────────────────────

test("能力门控：未实测 provider 默认不可选，显式 opt-in 才可用且保留证据", () => {
  assert.deepEqual(listSelectableProviders(), []);
  for (const provider of ["e2b", "modal", "daytona"] as const) {
    const gate = resolveProviderGate(provider);
    assert.equal(gate.selectable, false);
    assert.equal(gate.evidence.verifiedAt, null);
    assert.ok(gate.evidence.unverified.length > 0, `${provider} 必须列出未验证项`);
  }
  assert.deepEqual(listSelectableProviders({ allowUnverified: ["daytona"] }), ["daytona"]);
  const optedIn = resolveProviderGate("daytona", { allowUnverified: ["daytona"] });
  assert.equal(optedIn.selectable, true);
  assert.match(optedIn.reason ?? "", /not verified/);
});

test("标签对账键：保留键与非法格式在本地拒绝，合法标签原样保留", () => {
  const labels = buildReconcileLabels({
    operationKey: "op-1",
    runId: "run-1",
    runGeneration: 3,
    labels: { taskSlug: "task-1", taskId: "plain-label-value" },
  });
  // 地址要素已改为 create 的显式字段，不再是保留标签：同名调用方标签按普通标签处理。
  assert.deepEqual(labels, {
    taskSlug: "task-1",
    taskId: "plain-label-value",
    operationKey: "op-1",
    runId: "run-1",
    runGeneration: "3",
  });
  assert.throws(
    () =>
      buildReconcileLabels({
        operationKey: "op",
        runId: "run",
        runGeneration: 1,
        labels: { "bad key": "v" },
      }),
    /invalid provider label/,
  );
});

test("补偿终止分类：只有 2xx/404 算已确认清理", () => {
  assert.equal(classifyCompensationTermination({ ok: true, status: 200 }), "terminated");
  assert.equal(classifyCompensationTermination({ ok: false, status: 404 }), "terminated");
  assert.equal(classifyCompensationTermination({ ok: false, status: 503 }), "unknown");
  assert.equal(classifyCompensationTermination({ ok: false, status: 0 }), "unknown");
});

test("门控表与能力表都登记了三家 provider", () => {
  assert.deepEqual(Object.keys(SANDBOX_PROVIDER_GATES).sort(), ["daytona", "e2b", "modal"]);
});

test("driver 绑定表：配置齐全各产出一条，缺秘密不产出，门控与版本随绑定声明", async () => {
  // 缺配置 = 不产出该绑定（不是抛错、不是造空 driver）。
  assert.deepEqual(createSandboxDriverBindings({}), []);
  assert.deepEqual(configuredSandboxProviders({}), []);
  assert.deepEqual(
    configuredSandboxProviders({ modal: { tokenId: "id" } }),
    [],
    "Modal 缺 secret 的一半也不算配置齐全",
  );

  // 配置齐全 → 三家各产出一条绑定（构造期不触达 provider API）。
  // 显式配置之外的 provider 键一律忽略：不配置即不产出。
  const extraProvider = { unsupported: { apiKey: "x" } };
  const bindings = createSandboxDriverBindings({
    e2b: { apiKey: "e2b-key", maxLifetimeSeconds: 3600 },
    modal: { tokenId: "id", tokenSecret: "secret", imageDockerfile: "/tmp/modal.Dockerfile" },
    daytona: { apiKey: "dtn_key" },
    ...extraProvider,
  });
  assert.deepEqual(
    bindings.map((binding) => binding.provider),
    ["e2b", "modal", "daytona"],
  );
  for (const binding of bindings) {
    assert.equal(binding.contractVersion, SANDBOX_ADAPTER_CONTRACT_VERSION);
    assert.deepEqual(binding.requiredSecretNames, SANDBOX_DRIVER_SECRET_NAMES[binding.provider]);
    assert.ok(binding.requiredSecretNames.length > 0);
  }

  // createDriver 只用传入的上下文构造：能力声明与 driver 声明一致（不调 provider API）。
  const logger: CloudAdapterLogger = silentLogger;
  const e2bDriver = bindings[0]!.createDriver({
    provider: "e2b",
    readSecret: () => undefined,
    logger,
  });
  assert.deepEqual(await e2bDriver.describeCapabilities(), {
    createOperationLookup: "metadata-search",
    canInspect: true,
    canExtendDeadline: true,
    canConfirmTermination: true,
    // A-7 实测解禁门禁：声明随 SANDBOX_PAUSE_RESUME_GATES 常量收敛（不硬编码分级；
    // 未实测时为 none，已实测后为声明分级）。
    pauseResume: resolvePauseResumeCapability("e2b"),
    deadlineSource: "provider",
    supportsOutboundWss: true,
    maxLifetimeSeconds: 3600,
  });
  // 部署核实的上限经绑定上下文进入 driver，且**优先于**绑定配置里的同名值。
  const contextCapped = bindings[0]!.createDriver({
    provider: "e2b",
    readSecret: () => undefined,
    logger,
    maxLifetimeSeconds: 900,
  });
  assert.equal((await contextCapped.describeCapabilities()).maxLifetimeSeconds, 900);

  const modalDriver = bindings[1]!.createDriver({
    provider: "modal",
    readSecret: () => undefined,
    logger,
  });
  // 门控不改变能力声明：Modal 仍然如实声明不支持运行中续期。
  assert.equal((await modalDriver.describeCapabilities()).canExtendDeadline, false);

  // 未实测解禁 → 默认不可选（入口据此拒绝启用）；显式 allowUnverified 才放行。
  for (const binding of bindings) {
    assert.equal(resolveProviderGate(binding.provider).selectable, false);
    const optedIn = resolveProviderGate(binding.provider, {
      allowUnverified: [binding.provider],
    });
    assert.equal(optedIn.selectable, true);
    assert.match(optedIn.reason ?? "", /not verified/);
  }
});
