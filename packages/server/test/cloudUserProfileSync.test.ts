/**
 * M8 连接期用户资源同步编排验收（specs/cloud-agent 14 §4.1–§4.7/§9.5；W11 §13B）。
 *
 * 覆盖：门控矩阵（未连接/终态/stop/无 run）、逐类别调用形状（mcp 分批 / skills+plugins
 * 分块 / commands+subagents 既有写方法 / agents-md settings-sync）、单条失败不中断其余、
 * skip 语义、epoch 失配 fail、自动触发按 run+epoch 去重、单飞（手动 join 在飞）。
 * 通道调用一律走记录型 fake（`createFakeControlPlaneRpc`），不触碰真实 bridge。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { USER_ARCHIVE_IMPORT_CHUNK_MAX_BYTES } from "@zcode/shared";
import { buildTestPlane, attachReadySession } from "./cloudCoreFakes.js";
import type { TestPlane } from "./cloudCoreFakes.js";
import { createFakeUserProfileStore } from "./cloudCoreAdapterFakes.js";
import { sessionFromAddress } from "../src/cloud/app/attachments/registry.js";
import type { UserProfileEntryRecord } from "../src/cloud/app/ports/userProfileStorePort.js";

const PRINCIPAL = "00000000-0000-4000-8000-0000000000aa";

let counter = 0;

function sha256Hex(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** 造 draft → start（真实接纳事务）→ create，返回 {taskId, runId, runGeneration}。 */
async function draftWithRun(context: TestPlane) {
  counter += 1;
  const project = await context.plane.tasks.createProject({
    principalId: PRINCIPAL,
    repositoryId: 101,
  });
  assert.ok(project.ok);
  const task = await context.plane.tasks.createTask({
    principalId: PRINCIPAL,
    projectId: project.value.projectId,
    title: "Profile sync",
    creationKey: `ck-sync-${counter}`,
    draftStartConfig: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
  });
  assert.ok(task.ok);
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.value.taskId,
    source: "http",
    request: {
      intent: "start",
      commandId: `00000000-0000-4000-8000-00000000${String(8000 + counter).slice(-4)}`,
      prompt: "go",
      expectedTaskRevision: task.value.revision,
      start: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
    },
  });
  assert.equal(submit.ok, true, submit.ok ? "" : `${submit.code}/${submit.reason}`);
  const runId = submit.ok ? (submit.value.runId ?? "") : "";
  await context.plane.provisioning.create.runCreateOnce();
  const run = await context.storage.runs.get(runId);
  assert.ok(run);
  return { taskId: task.value.taskId, runId, runGeneration: run.runGeneration };
}

/** 注册一条 attachment（不置 ready；ready 由用例按需置位）。 */
function registerSession(
  context: TestPlane,
  input: { taskId: string; runId: string; runGeneration: number; connectionEpoch?: number },
): void {
  context.plane.attachments.register(
    sessionFromAddress({
      address: {
        taskId: input.taskId,
        runId: input.runId,
        runGeneration: input.runGeneration,
        workspaceIdentity: `cloud-task:${input.taskId}`,
        workspacePath: "/workspace/demo",
        remoteSessionId: `remote-${input.runId}`,
        connectionEpoch: input.connectionEpoch ?? 1,
      },
      at: context.clock.now(),
    }),
  );
}

function agentsMd(content: string): UserProfileEntryRecord {
  return {
    category: "agents-md",
    entryId: "user-agents",
    enabled: true,
    sha256: sha256Hex(content),
    bytes: Buffer.byteLength(content, "utf8"),
    contentKind: "agents-md",
    content,
  };
}

function markdownEntry(
  category: "commands" | "subagents",
  entryId: string,
  content: string,
): UserProfileEntryRecord {
  return {
    category,
    entryId,
    enabled: true,
    sha256: sha256Hex(content),
    bytes: Buffer.byteLength(content, "utf8"),
    contentKind: "markdown",
    content,
  };
}

function archiveEntry(
  category: "skills" | "plugins",
  entryId: string,
  bytes: Uint8Array,
): UserProfileEntryRecord {
  return {
    category,
    entryId,
    enabled: true,
    sha256: sha256Hex(bytes),
    bytes: bytes.byteLength,
    contentKind: "archive-base64",
    content: Buffer.from(bytes).toString("base64"),
  };
}

function mcpEntry(entryId: string, config: Record<string, unknown>): UserProfileEntryRecord {
  const text = JSON.stringify(config);
  return {
    category: "mcp",
    entryId,
    enabled: true,
    sha256: sha256Hex(text),
    bytes: text.length,
    contentKind: "mcp-config",
    content: text,
  };
}

/** 等待条件成立（自动触发是异步的；只在确定性推进后轮询，不用固定 sleep）。 */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`timeout waiting for ${what}`);
}

test("门控矩阵：任务/Run/连接态/stop 各自的结构化 not_ready（14 §4.6）", async () => {
  const context = buildTestPlane();

  // 任务不存在：404 语义（不是 not_ready 的门控）。
  const missing = await context.plane.userProfileSync.syncTaskProfile({
    taskId: "00000000-0000-4000-8000-00000000dead",
    trigger: "manual",
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.code, "not_found");
    assert.equal(missing.reason, "task-not-found");
  }

  // draft 任务（无 activeRun）→ run-not-found。
  const project = await context.plane.tasks.createProject({
    principalId: PRINCIPAL,
    repositoryId: 101,
  });
  assert.ok(project.ok);
  const draft = await context.plane.tasks.createTask({
    principalId: PRINCIPAL,
    projectId: project.value.projectId,
    title: "no run",
    creationKey: `ck-sync-draft-${(counter += 1)}`,
  });
  assert.ok(draft.ok);
  const noRun = await context.plane.userProfileSync.syncTaskProfile({
    taskId: draft.value.taskId,
    trigger: "manual",
  });
  assert.equal(noRun.ok, false);
  if (!noRun.ok) assert.equal(noRun.reason, "run-not-found");

  const target = await draftWithRun(context);

  // 无 attachment → run-not-connected。
  const disconnected = await context.plane.userProfileSync.syncTaskProfile({
    taskId: target.taskId,
    trigger: "manual",
  });
  assert.equal(disconnected.ok, false);
  if (!disconnected.ok) {
    assert.equal(disconnected.code, "not_ready");
    assert.equal(disconnected.reason, "run-not-connected");
  }

  // 有 attachment 但未 ready → 同样 run-not-connected（同步只发生在连接期）。
  registerSession(context, target);
  const notReady = await context.plane.userProfileSync.syncTaskProfile({
    taskId: target.taskId,
    trigger: "manual",
  });
  assert.equal(notReady.ok, false);
  if (!notReady.ok) assert.equal(notReady.reason, "run-not-connected");

  // stop 屏障 → stop-requested。
  const run = context.storage.runsById.get(target.runId);
  assert.ok(run);
  context.storage.runsById.set(target.runId, { ...run, stopRequested: true });
  const stopped = await context.plane.userProfileSync.syncTaskProfile({
    taskId: target.taskId,
    trigger: "manual",
  });
  assert.equal(stopped.ok, false);
  if (!stopped.ok) assert.equal(stopped.reason, "stop-requested");
  context.storage.runsById.set(target.runId, { ...run, stopRequested: false });

  // 终态 run → run-terminal（终态判断先于连接态）。
  context.storage.runsById.set(target.runId, { ...run, status: "stopped" });
  const terminal = await context.plane.userProfileSync.syncTaskProfile({
    taskId: target.taskId,
    trigger: "manual",
  });
  assert.equal(terminal.ok, false);
  if (!terminal.ok) {
    assert.equal(terminal.code, "not_ready");
    assert.equal(terminal.reason, "run-terminal");
  }
});

test("逐类别调用形状：mcp / skills / plugins / commands / subagents / agents-md（14 §4.3–§4.5）", async () => {
  const store = createFakeUserProfileStore();
  const context = buildTestPlane({ userProfile: store });
  const rpc = context.fakeControlPlaneRpc;
  assert.ok(rpc);
  const { taskId, runId, runGeneration } = await draftWithRun(context);
  await attachReadySession(context, { taskId, runId, runGeneration });

  const skillBytes = Buffer.from("skill-archive-bytes");
  const pluginBytes = Buffer.alloc(USER_ARCHIVE_IMPORT_CHUNK_MAX_BYTES * 2 + 5, 7);
  const commandText = "---\ndescription: 审查\n---\n请审查这个变更";
  const subagentText = '---\nname: "helper"\ndescription: "帮助者"\n---\n你是助手。';
  store.versions.set(7, [
    mcpEntry("primary", { command: "npx", args: ["-y", "server"] }),
    archiveEntry("skills", "demo", skillBytes),
    archiveEntry("plugins", "tool", pluginBytes),
    markdownEntry("commands", "review.md", commandText),
    markdownEntry("subagents", "helper.md", subagentText),
    agentsMd("# AGENTS"),
  ]);
  store.current = 7;

  // 既有列表回投（create-or-update 判定来源）。
  rpc.respond("commands", "list", {
    commands: [
      {
        id: "zcodeAgent:zcode:global:/review",
        filePath: "/root/.zcode/commands/review.md",
        source: "user",
      },
    ],
  });
  rpc.respond("subagents", "list", {
    agents: [
      {
        id: "agent:user:helper",
        path: "/root/.zcode/agents/helper.md",
        scope: "user",
        source: "user",
      },
    ],
  });
  rpc.respond("skill-sync", "beginUserArchiveImport", { importId: "imp-skill" });
  rpc.respond("skill-sync", "appendUserArchiveImportChunk", {
    receivedChunks: 1,
    receivedBytes: skillBytes.byteLength,
  });
  rpc.respond("skill-sync", "completeUserArchiveImport", { results: [] });
  rpc.respond("plugin-sync", "beginUserArchiveImport", { importId: "imp-plugin" });
  rpc.handle("plugin-sync", "appendUserArchiveImportChunk", (call) => {
    const args = call.args[0] as { chunkIndex: number };
    return {
      status: "ok",
      result: {
        receivedChunks: args.chunkIndex + 1,
        receivedBytes: USER_ARCHIVE_IMPORT_CHUNK_MAX_BYTES * (args.chunkIndex + 1),
      },
    };
  });
  rpc.respond("plugin-sync", "completeUserArchiveImport", { results: [] });
  rpc.respond("mcp-sync", "importMcpServers", {
    results: [{ name: "primary", status: "synced", path: "/root/.zcode/cli/config.json" }],
  });

  const synced = await context.plane.userProfileSync.syncTaskProfile({ taskId, trigger: "manual" });
  assert.equal(synced.ok, true, synced.ok ? "" : `${synced.code}/${synced.reason}`);
  if (!synced.ok) return;
  assert.equal(synced.value.runId, runId);
  assert.equal(synced.value.profileVersion, 7, "同步取最新 profile 版本（不追踪 Run 版本）");
  assert.equal(synced.value.trigger, "manual");
  assert.deepEqual(
    synced.value.results.map((item) => `${item.category}/${item.entryId}:${item.status}`).sort(),
    [
      "agents-md/user-agents:synced",
      "commands/review.md:synced",
      "mcp/primary:synced",
      "plugins/tool:synced",
      "skills/demo:synced",
      "subagents/helper.md:synced",
    ],
  );

  // mcp：单批、localHomeDir 占位、enabled 显式 true（省略会被既有服务判成停用）。
  const mcpCalls = rpc.callsOf("mcp-sync", "importMcpServers");
  assert.equal(mcpCalls.length, 1);
  assert.deepEqual(mcpCalls[0]?.args, [
    {
      servers: [
        { name: "primary", config: { command: "npx", args: ["-y", "server"] }, enabled: true },
      ],
      localHomeDir: "/",
    },
  ]);

  // skills：单块分块导入，逐块 sha256/整包 sha256 由控制面按解码后字节给出。
  const begin = rpc.callsOf("skill-sync", "beginUserArchiveImport");
  assert.equal(begin.length, 1);
  assert.deepEqual(begin[0]?.args, [
    { archiveSha256: sha256Hex(skillBytes), totalBytes: skillBytes.byteLength, chunkCount: 1 },
  ]);
  const appends = rpc.callsOf("skill-sync", "appendUserArchiveImportChunk");
  assert.equal(appends.length, 1);
  assert.deepEqual(appends[0]?.args, [
    {
      importId: "imp-skill",
      chunkIndex: 0,
      chunkSha256: sha256Hex(skillBytes),
      payloadBase64: Buffer.from(skillBytes).toString("base64"),
    },
  ]);
  assert.deepEqual(rpc.callsOf("skill-sync", "completeUserArchiveImport")[0]?.args, [
    { importId: "imp-skill" },
  ]);

  // plugins：>2 块归档（2 满块 + 余量块），块序严格递增且逐块 sha256 与切片一致。
  const pluginBegin = rpc.callsOf("plugin-sync", "beginUserArchiveImport");
  assert.equal(pluginBegin.length, 1);
  assert.deepEqual(pluginBegin[0]?.args, [
    {
      archiveSha256: sha256Hex(pluginBytes),
      totalBytes: pluginBytes.byteLength,
      chunkCount: 3,
    },
  ]);
  const pluginAppends = rpc.callsOf("plugin-sync", "appendUserArchiveImportChunk");
  assert.equal(pluginAppends.length, 3);
  for (const [index, call] of pluginAppends.entries()) {
    const args = call.args[0] as {
      importId: string;
      chunkIndex: number;
      chunkSha256: string;
      payloadBase64: string;
    };
    assert.equal(args.importId, "imp-plugin");
    assert.equal(args.chunkIndex, index, "块序严格从 0 递增");
    const decoded = Buffer.from(args.payloadBase64, "base64");
    assert.ok(decoded.byteLength <= USER_ARCHIVE_IMPORT_CHUNK_MAX_BYTES, "单块 ≤2MiB");
    assert.equal(args.chunkSha256, sha256Hex(decoded), "逐块 sha256 = 解码字节摘要");
    assert.deepEqual(
      decoded,
      pluginBytes.subarray(index * decoded.byteLength, (index + 1) * decoded.byteLength),
    );
  }
  assert.deepEqual(rpc.callsOf("plugin-sync", "completeUserArchiveImport")[0]?.args, [
    { importId: "imp-plugin" },
  ]);

  // commands：既有文件存在 → 走 updateCommandFile（覆盖语义），正文逐字节透传。
  assert.deepEqual(rpc.callsOf("commands", "list")[0]?.args, [{ agentSource: "zcodeAgent" }]);
  assert.equal(rpc.callsOf("commands", "writeCommandFile").length, 0);
  const commandUpdate = rpc.callsOf("commands", "updateCommandFile");
  assert.equal(commandUpdate.length, 1);
  assert.deepEqual(commandUpdate[0]?.args, [
    {
      commandId: "zcodeAgent:zcode:global:/review",
      config: { name: "review", prompt: commandText },
      oldFilePath: "/root/.zcode/commands/review.md",
      storageLevel: "user",
    },
  ]);

  // subagents：markdown front-matter → 既有 create/update 的 SubAgentConfig（覆盖语义）。
  const subagentList = rpc.callsOf("subagents", "list");
  assert.equal(subagentList.length, 1);
  const subagentListArg = subagentList[0]?.args[0] as { mode?: string } | undefined;
  assert.equal(subagentListArg?.mode, "settingsUserOnly", "只读用户级列表");
  assert.equal(rpc.callsOf("subagents", "createAgent").length, 0);
  const subagentUpdate = rpc.callsOf("subagents", "updateAgent");
  assert.equal(subagentUpdate.length, 1);
  assert.deepEqual(subagentUpdate[0]?.args, [
    {
      agentId: "agent:user:helper",
      config: { name: "helper", description: "帮助者", systemPrompt: "你是助手。" },
      oldFilePath: "/root/.zcode/agents/helper.md",
      provider: "glm",
      scope: "user",
    },
  ]);

  // agents-md：settings-sync 的最小写入方法（整文件覆盖）。
  assert.deepEqual(rpc.callsOf("settings-sync", "writeUserAgentsFile")[0]?.args, [
    { content: "# AGENTS" },
  ]);
});

test("mcp 分批：序列化后 ≤2MiB/批，批内按 entryId 升序、批间串行", async () => {
  const store = createFakeUserProfileStore();
  const context = buildTestPlane({ userProfile: store });
  const rpc = context.fakeControlPlaneRpc;
  assert.ok(rpc);
  const { taskId, runId, runGeneration } = await draftWithRun(context);
  await attachReadySession(context, { taskId, runId, runGeneration });

  // 9 条 ×250KB 配置：8 条 ≈2.0MB 可同批，第 9 条推到第二批（14 §4.2）。
  const config = { args: ["x".repeat(250_000)], command: "npx" };
  const entries = Array.from({ length: 9 }, (_value, index) =>
    mcpEntry(`server-${String(index).padStart(2, "0")}`, config),
  );
  store.versions.set(2, entries);
  store.current = 2;
  rpc.respond("mcp-sync", "importMcpServers", {
    results: entries.map((entry) => ({ name: entry.entryId, status: "synced" })),
  });

  const synced = await context.plane.userProfileSync.syncTaskProfile({ taskId, trigger: "manual" });
  assert.equal(synced.ok, true, synced.ok ? "" : `${synced.code}/${synced.reason}`);
  const calls = rpc.callsOf("mcp-sync", "importMcpServers");
  assert.equal(calls.length, 2, "超 2MiB 自动分批");
  const batchNames = calls.map((call) =>
    (call.args[0] as { servers: { name: string }[] }).servers.map((server) => server.name),
  );
  assert.deepEqual(
    batchNames.map((names) => names.length),
    [8, 1],
  );
  assert.deepEqual(batchNames[0], [...batchNames[0]!].sort(), "批内按 entryId 升序（确定性）");
  if (synced.ok) {
    assert.equal(synced.value.results.length, 9);
    assert.equal(
      synced.value.results.every((item) => item.status === "synced"),
      true,
    );
  }
});

test("单条失败不中断其余；skip 语义沿用既有判重（U-04；14 §4.7）", async () => {
  const store = createFakeUserProfileStore();
  const context = buildTestPlane({ userProfile: store });
  const rpc = context.fakeControlPlaneRpc;
  assert.ok(rpc);
  const { taskId, runId, runGeneration } = await draftWithRun(context);
  await attachReadySession(context, { taskId, runId, runGeneration });

  store.versions.set(3, [mcpEntry("existing", { command: "npx" }), agentsMd("# AGENTS")]);
  store.current = 3;
  rpc.respond("mcp-sync", "importMcpServers", {
    results: [{ name: "existing", status: "skipped", path: "/root/.zcode/cli/config.json" }],
  });

  const synced = await context.plane.userProfileSync.syncTaskProfile({ taskId, trigger: "manual" });
  assert.equal(synced.ok, true);
  if (!synced.ok) return;
  assert.deepEqual(synced.value.results, [
    { category: "mcp", entryId: "existing", status: "skipped" },
    { category: "agents-md", entryId: "user-agents", status: "synced" },
  ]);

  // mcp 调用失败：该条 failed（错误有界、不含正文），agents-md 照常 synced。
  rpc.fail("mcp-sync", "importMcpServers", { reason: "closed", message: "relay down" });
  const partial = await context.plane.userProfileSync.syncTaskProfile({
    taskId,
    trigger: "manual",
  });
  assert.equal(partial.ok, true, "单条失败不 fail run、不 fail 整体响应");
  if (!partial.ok) return;
  const mcpResult = partial.value.results.find((item) => item.category === "mcp");
  assert.equal(mcpResult?.status, "failed");
  assert.ok((mcpResult?.error ?? "").length > 0);
  assert.ok((mcpResult?.error ?? "").length <= 512, "错误文本有界（shared schema 上限）");
  assert.equal(
    partial.value.results.find((item) => item.category === "agents-md")?.status,
    "synced",
    "其余条目不受单条失败影响",
  );
});

test("epoch 失配/断连：该次同步按条目 fail、不重试（14 §4.2/§4.6）", async () => {
  const store = createFakeUserProfileStore();
  const context = buildTestPlane({ userProfile: store });
  const rpc = context.fakeControlPlaneRpc;
  assert.ok(rpc);
  const { taskId, runId, runGeneration } = await draftWithRun(context);
  await attachReadySession(context, { taskId, runId, runGeneration });

  store.versions.set(2, [
    archiveEntry("skills", "demo", Buffer.from("archive")),
    agentsMd("# AGENTS"),
  ]);
  store.current = 2;
  rpc.fail("skill-sync", "beginUserArchiveImport", { reason: "stale", message: "epoch mismatch" });

  const synced = await context.plane.userProfileSync.syncTaskProfile({ taskId, trigger: "manual" });
  assert.equal(synced.ok, true);
  if (!synced.ok) return;
  const skill = synced.value.results.find((item) => item.category === "skills");
  assert.equal(skill?.status, "failed");
  assert.ok((skill?.error ?? "").includes("stale"), "错误定位含传输失败原因");
  assert.equal(rpc.callsOf("skill-sync", "beginUserArchiveImport").length, 1, "失败不自动重试");
  assert.equal(
    synced.value.results.find((item) => item.category === "agents-md")?.status,
    "synced",
  );
});

test("自动触发：同 run+epoch 只同步一次，新 epoch 再触发（14 §4.6）", async () => {
  const store = createFakeUserProfileStore();
  const context = buildTestPlane({ userProfile: store });
  const rpc = context.fakeControlPlaneRpc;
  assert.ok(rpc);
  const { taskId, runId, runGeneration } = await draftWithRun(context);
  await attachReadySession(context, { taskId, runId, runGeneration });
  store.versions.set(2, [mcpEntry("primary", { command: "npx" })]);
  store.current = 2;
  rpc.respond("mcp-sync", "importMcpServers", {
    results: [{ name: "primary", status: "synced" }],
  });

  const statusBefore = (await context.storage.runs.get(runId))?.status;
  context.plane.userProfileSync.triggerAutomatic({
    taskId,
    runId,
    runGeneration,
    connectionEpoch: 1,
  });
  context.plane.userProfileSync.triggerAutomatic({
    taskId,
    runId,
    runGeneration,
    connectionEpoch: 1,
  });
  await waitFor(() => rpc.callsOf("mcp-sync", "importMcpServers").length === 1, "first auto sync");
  // 同 epoch 的第二次触发被去重：不会出现第二次同步序列。
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(rpc.callsOf("mcp-sync", "importMcpServers").length, 1);
  const run = await context.storage.runs.get(runId);
  assert.equal(run?.status, statusBefore, "同步（含失败）不改变 run 状态（不 fail run）");

  // 重连（新 epoch）后的 ready 再触发一次自动同步。
  await attachReadySession(context, { taskId, runId, runGeneration, connectionEpoch: 2 });
  context.plane.userProfileSync.triggerAutomatic({
    taskId,
    runId,
    runGeneration,
    connectionEpoch: 2,
  });
  await waitFor(() => rpc.callsOf("mcp-sync", "importMcpServers").length === 2, "second auto sync");
});

test("单飞：在飞期间手动请求等待同一次结果（不排队第二次调用；14 §4.6）", async () => {
  const store = createFakeUserProfileStore();
  const context = buildTestPlane({ userProfile: store });
  const rpc = context.fakeControlPlaneRpc;
  assert.ok(rpc);
  const { taskId, runId, runGeneration } = await draftWithRun(context);
  await attachReadySession(context, { taskId, runId, runGeneration });
  store.versions.set(2, [mcpEntry("primary", { command: "npx" }), agentsMd("# AGENTS")]);
  store.current = 2;
  const gate = rpc.gate("mcp-sync", "importMcpServers");
  rpc.respond("mcp-sync", "importMcpServers", {
    results: [{ name: "primary", status: "synced" }],
  });

  // 自动同步先在飞（被闸门挂住）。
  context.plane.userProfileSync.triggerAutomatic({
    taskId,
    runId,
    runGeneration,
    connectionEpoch: 1,
  });
  await waitFor(
    () => rpc.callsOf("mcp-sync", "importMcpServers").length === 1,
    "auto sync in flight",
  );

  // 手动请求 join 同一次同步：等闸门放行后返回同一份结果，且不产生第二次调用。
  const manual = context.plane.userProfileSync.syncTaskProfile({ taskId, trigger: "manual" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(rpc.callsOf("mcp-sync", "importMcpServers").length, 1, "join 不排队第二次调用");
  gate.release();
  const joined = await manual;
  assert.equal(joined.ok, true);
  if (joined.ok) {
    assert.equal(joined.value.results.length, 2, "返回在飞同步的同一份逐条结果");
    assert.equal(rpc.callsOf("mcp-sync", "importMcpServers").length, 1);
  }
});

test("未接线：profile store / 控制面 RPC 端口缺失 → not_configured（不伪装成功）", async () => {
  const unwiredRpc = buildTestPlane({ controlPlaneRpc: null });
  const targetA = await draftWithRun(unwiredRpc);
  await attachReadySession(unwiredRpc, targetA);
  const rpcMissing = await unwiredRpc.plane.userProfileSync.syncTaskProfile({
    taskId: targetA.taskId,
    trigger: "manual",
  });
  assert.equal(rpcMissing.ok, false);
  if (!rpcMissing.ok) {
    assert.equal(rpcMissing.code, "not_configured");
    assert.equal(rpcMissing.reason, "control-plane-rpc-missing");
  }

  const unwiredStore = buildTestPlane({ userProfile: null });
  const targetB = await draftWithRun(unwiredStore);
  await attachReadySession(unwiredStore, targetB);
  const storeMissing = await unwiredStore.plane.userProfileSync.syncTaskProfile({
    taskId: targetB.taskId,
    trigger: "manual",
  });
  assert.equal(storeMissing.ok, false);
  if (!storeMissing.ok) {
    assert.equal(storeMissing.reason, "user-profile-store-missing");
  }
});
