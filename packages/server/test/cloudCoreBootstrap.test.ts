/**
 * W1 bootstrap.config 发送侧与 ready 门控测试（02 §4/§5.3、01 §6.2、12 §6）。
 * 覆盖：clone 事实取自持久 Task/Run、envelope 只来自注入来源、credentialGeneration 代际、
 * ready 前置门控、失败按 run fault 收口（不重做 ready、不用旧凭据重试）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { attachReadySession, buildTestPlane } from "./cloudCoreFakes.js";

const PRINCIPAL = "00000000-0000-4000-8000-0000000000aa";

let counter = 0;

/**
 * 走完「接纳 → create worker」，返回 `{taskId, run}`（需要 create 结果的用例用）。
 */
async function draftWithRun(context: ReturnType<typeof buildTestPlane>) {
  const { taskId, runId } = await draftOnly(context);
  await context.plane.provisioning.create.runCreateOnce();
  const run = await context.storage.runs.get(runId);
  assert.ok(run);
  return { taskId, run };
}

async function draftOnly(context: ReturnType<typeof buildTestPlane>) {
  counter += 1;
  const project = await context.plane.tasks.createProject({
    principalId: PRINCIPAL,
    repositoryId: 101,
  });
  assert.ok(project.ok);
  const task = await context.plane.tasks.createTask({
    principalId: PRINCIPAL,
    projectId: project.value.projectId,
    title: "Bootstrap task",
    creationKey: `ck-bootstrap-${counter}`,
    draftStartConfig: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
  });
  assert.ok(task.ok);
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.value.taskId,
    source: "http",
    request: {
      intent: "start",
      commandId: `00000000-0000-4000-8000-0000000004${String(counter).padStart(2, "0")}`,
      prompt: "go",
      expectedTaskRevision: task.value.revision,
      start: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
    },
  });
  assert.equal(submit.ok, true, submit.ok ? "" : `${submit.code}/${submit.reason}`);
  const runId = submit.ok ? (submit.value.runId ?? "") : "";
  return { taskId: task.value.taskId, runId };
}

/** 造一个不带 templateRef 的 draft（验证部署默认值的接纳期冻结）。 */
async function draftWithoutTemplateRef(context: ReturnType<typeof buildTestPlane>, key: string) {
  const project = await context.plane.tasks.createProject({
    principalId: PRINCIPAL,
    repositoryId: 101,
  });
  assert.ok(project.ok);
  const task = await context.plane.tasks.createTask({
    principalId: PRINCIPAL,
    projectId: project.value.projectId,
    title: "Default template",
    creationKey: key,
    draftStartConfig: { baseBranch: "main", provider: "e2b" },
  });
  assert.ok(task.ok);
  return task.value;
}

test("接纳期冻结：请求不带 templateRef 时用部署默认值写进 recipe（01 §5.1 第 2 条）", async () => {
  const context = buildTestPlane();
  const task = await draftWithoutTemplateRef(context, "ck-default-template");
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.taskId,
    source: "http",
    request: {
      intent: "start",
      commandId: "00000000-0000-4000-8000-000000000901",
      prompt: "go",
      expectedTaskRevision: task.revision,
      start: { baseBranch: "main", provider: "e2b" },
    },
  });
  assert.equal(submit.ok, true, submit.ok ? "" : `${submit.code}/${submit.reason}`);
  const runId = submit.ok ? (submit.value.runId ?? "") : "";
  const run = await context.storage.runs.get(runId);
  assert.equal(run?.executionRecipe?.imageDigest, "img:e2b:zcode-node24", "部署默认模板已冻结");
  assert.equal(run?.executionRecipe?.templateVersion, "rev:zcode-node24");
  assert.equal(
    run?.executionRecipe?.templateRef,
    undefined,
    "resolver 的冻结形状不回默认模板名：用户未显式选择时不写 templateRef",
  );
  const created = await context.plane.provisioning.create.runCreateOnce();
  assert.equal(
    created?.outcome,
    "created",
    "create 用冻结的 imageRef 跑起来（不再 unsupported_template）",
  );
});

test("接纳期拒绝：provider 无部署默认且请求未带 ref（不等到 provisioning 才报错）", async () => {
  const context = buildTestPlane();
  context.templates.setDefault("e2b", undefined);
  const task = await draftWithoutTemplateRef(context, "ck-no-default");
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.taskId,
    source: "http",
    request: {
      intent: "start",
      commandId: "00000000-0000-4000-8000-000000000902",
      prompt: "go",
      expectedTaskRevision: task.revision,
      start: { baseBranch: "main", provider: "e2b" },
    },
  });
  assert.equal(submit.ok, false);
  assert.equal(submit.ok === false && submit.code, "unsupported_template");
  assert.equal(submit.ok === false && submit.reason, "template-unresolved");
  assert.equal(context.storage.createOperations.length, 0, "接纳失败不产生 create 操作");
  assert.equal(context.storage.inputsByKey.size, 0, "也不落 input");
});

test("接纳期拒绝：部署默认是浮动标签（:latest）", async () => {
  const context = buildTestPlane();
  context.templates.setDefault("e2b", "latest");
  const task = await draftWithoutTemplateRef(context, "ck-floating");
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.taskId,
    source: "http",
    request: {
      intent: "start",
      commandId: "00000000-0000-4000-8000-000000000903",
      prompt: "go",
      expectedTaskRevision: task.revision,
      start: { baseBranch: "main", provider: "e2b" },
    },
  });
  assert.equal(submit.ok, false);
  assert.equal(submit.ok === false && submit.reason, "floating-image-tag");
  assert.equal(context.driver.createCalls, 0);
});

test("冻结不漂移：改部署默认后重放同 commandId 不重新解析，新任务才用新默认（03 §6.1）", async () => {
  const context = buildTestPlane();
  const task = await draftWithoutTemplateRef(context, "ck-drift");
  const request = {
    intent: "start" as const,
    commandId: "00000000-0000-4000-8000-000000000904",
    prompt: "go",
    expectedTaskRevision: task.revision,
    start: { baseBranch: "main", provider: "e2b" },
  };
  const first = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.taskId,
    source: "http",
    request,
  });
  assert.equal(first.ok, true);
  const runId = first.ok ? (first.value.runId ?? "") : "";
  const frozenDigest = (await context.storage.runs.get(runId))?.executionRecipe?.imageDigest;

  // 部署默认值变化（W5 侧配置更新）：已接收请求重放必须返回原 receipt，recipe 不漂移。
  context.templates.setDefault("e2b", "zcode-node26");
  const replay = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.taskId,
    source: "http",
    request,
  });
  assert.equal(replay.ok, true);
  assert.deepEqual(replay.ok && replay.value, first.ok && first.value, "同 commandId 返回原回执");
  assert.equal(
    (await context.storage.runs.get(runId))?.executionRecipe?.imageDigest,
    frozenDigest,
    "冻结后不随部署默认变化",
  );

  // 新任务用新默认（默认值只在接纳期解析一次）。
  const secondTask = await draftWithoutTemplateRef(context, "ck-drift-2");
  const second = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: secondTask.taskId,
    source: "http",
    request: {
      ...request,
      commandId: "00000000-0000-4000-8000-000000000905",
      expectedTaskRevision: secondTask.revision,
    },
  });
  assert.equal(second.ok, true);
  const secondRunId = second.ok ? (second.value.runId ?? "") : "";
  assert.equal(
    (await context.storage.runs.get(secondRunId))?.executionRecipe?.imageDigest,
    "img:e2b:zcode-node26",
  );
});

test("create 侧兜底：老 recipe 既无 imageDigest 也无 templateRef 时仍 fail-closed", async () => {
  const context = buildTestPlane();
  const project = await context.plane.tasks.createProject({
    principalId: PRINCIPAL,
    repositoryId: 101,
  });
  assert.ok(project.ok);
  const task = await context.storage.tasks.createDraft({
    taskId: "00000000-0000-4000-8000-0000000009aa",
    ownerPrincipalId: PRINCIPAL,
    projectId: project.value.projectId,
    title: "Legacy recipe",
    creationKey: "ck-legacy",
    workspaceIdentity: "cloud-task:00000000-0000-4000-8000-0000000009aa",
    now: context.clock.now(),
  });
  const reservation = await context.storage.runs.reserveRun({
    taskId: task.taskId,
    runId: "00000000-0000-4000-8000-0000000009ab",
    executionRecipe: {
      provider: "e2b",
      resources: { cpu: 2, memoryMiB: 4096, diskGiB: 10 },
      firstCommandConfig: {},
    },
    quota: { maxConcurrentRuns: 3 },
    now: context.clock.now(),
  });
  await context.outbox.enqueue({
    operationId: "00000000-0000-4000-8000-0000000009ac",
    kind: "create",
    idempotencyKey: `create:${reservation.run.runId}`,
    taskId: task.taskId,
    runId: reservation.run.runId,
    runGeneration: reservation.runGeneration,
    now: context.clock.now(),
  });
  const attempt = await context.plane.provisioning.create.runCreateOnce();
  assert.equal(attempt?.outcome, "failed");
  assert.equal(attempt?.reason, "template-unfrozen");
  assert.equal(context.driver.createCalls, 0, "无冻结模板不得触达 provider");
});

test("supervisor 启动：正常 create 路径恰好一次，自举要素取自同一批局部变量（01 §5.1 第 3 条）", async () => {
  const context = buildTestPlane();
  const { taskId, runId } = await draftOnly(context);
  const created = await context.plane.provisioning.create.runCreateOnce();
  assert.equal(created?.outcome, "created");
  assert.equal(context.driver.startSupervisorCalls, 1, "持久 handle 后启动 supervisor");
  const start = context.driver.lastSupervisorStart;
  assert.equal(start?.sandboxId, `sandbox-${runId}`);
  assert.equal(start?.operationKey, `create:${runId}`);
  assert.equal(start?.runId, runId);
  assert.equal(start?.runGeneration, 1);
  assert.equal(start?.taskId, taskId);
  assert.equal(start?.workspacePath, "/workspace/demo");
  assert.equal(start?.publicControlPlaneUrl, context.plane.config.publicControlPlaneUrl);
  assert.ok((start?.bootstrapTicket.length ?? 0) > 0, "自举票据来自 create 同一批局部变量");
});

test("clone 签发必须先于 supervisor 启动；对账恢复路径同样签发（01 §7.2）", async () => {
  const context = buildTestPlane();
  const sequence = context.gitGrantStore.events;
  const originalStart = context.driver.startSupervisor.bind(context.driver);
  context.driver.startSupervisor = async (handle, input) => {
    sequence.push("supervisor-started");
    return originalStart(handle, input);
  };
  const { runId } = await draftOnly(context);
  const created = await context.plane.provisioning.create.runCreateOnce();
  assert.equal(created?.outcome, "created");
  const grantIndex = sequence.findIndex((item) => item.startsWith("grant-issued:clone:"));
  const startIndex = sequence.indexOf("supervisor-started");
  assert.ok(grantIndex >= 0, "clone grant 已签发");
  assert.ok(startIndex >= 0, "supervisor 已启动");
  assert.ok(grantIndex < startIndex, "TTL 60s：签发必须在启动之前（否则窗口不够）");
  const grant = context.gitGrantStore.records.find(
    (item) => item.runId === runId && item.purpose === "clone",
  );
  assert.equal(grant?.runGeneration, 1);
  assert.equal(grant?.status, "issued");

  // 对账恢复路径同样签发（同一 bootstrap 步骤）。
  const context2 = buildTestPlane();
  context2.driver.createOutcome = "throw-unknown";
  context2.driver.findCreateResultOutcome = "created";
  const second = await draftOnly(context2);
  const restored = await context2.plane.provisioning.create.runCreateOnce();
  assert.equal(restored?.outcome, "created");
  assert.equal(
    context2.gitGrantStore.records.some(
      (item) => item.runId === second.runId && item.purpose === "clone",
    ),
    true,
    "对账恢复出的沙箱也要能 clone",
  );
});

test("supervisor 启动：对账恢复路径（findCreateResult=created）也必须启动一次", async () => {
  const context = buildTestPlane();
  context.driver.createOutcome = "throw-unknown";
  context.driver.findCreateResultOutcome = "created";
  const { runId } = await draftOnly(context);
  const attempt = await context.plane.provisioning.create.runCreateOnce();
  assert.equal(attempt?.outcome, "created", "对账命中既有沙箱");
  assert.equal(context.driver.startSupervisorCalls, 1, "否则沙箱活着但没人连");
  assert.equal(context.driver.lastSupervisorStart?.sandboxId, "sandbox-reconciled");
  assert.equal(context.driver.lastSupervisorStart?.runId, runId);
});

test("supervisor 启动：迟到 handle / 停止意图两条路径都不启动", async () => {
  // ① 迟到 handle（recordProviderHandle 拒绝）：只清理，不启动。
  const late = buildTestPlane({ storage: { failRecordProviderHandle: true } });
  const lateRun = await draftOnly(late);
  const lateAttempt = await late.plane.provisioning.create.runCreateOnce();
  assert.equal(lateAttempt?.outcome, "skipped");
  assert.equal(lateAttempt?.reason, "late-handle");
  assert.equal(late.driver.startSupervisorCalls, 0);
  assert.equal(late.driver.terminateCalls, 0, "清理走 terminate 意图，不在本地直接终止");

  // ② create 与停止并发：不启动 supervisor（08 §8.1：迟到 handle 只能进入清理）。
  const stopped = buildTestPlane();
  const stoppedRun = await draftOnly(stopped);
  const originalCreate = stopped.driver.create.bind(stopped.driver);
  stopped.driver.create = async (input: SandboxCreateInput) => {
    await stopped.storage.runs.requestStop({
      taskId: stoppedRun.taskId,
      operationId: "00000000-0000-4000-8000-000000000c01",
      now: stopped.clock.now(),
    });
    return originalCreate(input);
  };
  const stoppedAttempt = await stopped.plane.provisioning.create.runCreateOnce();
  assert.equal(stoppedAttempt?.outcome, "skipped");
  assert.equal(stoppedAttempt?.reason, "stop-after-create");
  assert.equal(stopped.driver.startSupervisorCalls, 0);
  assert.equal(lateRun.runId.length > 0 && stoppedRun.runId.length > 0, true);
});

test("supervisor 启动失败：operation 落 failed(bootstrap_failed) + 补偿终止 + run 可读收口（01 §9）", async () => {
  const context = buildTestPlane();
  context.driver.startSupervisorError = "supervisor spawn failed";
  const { runId } = await draftOnly(context);
  const attempt = await context.plane.provisioning.create.runCreateOnce();
  assert.equal(attempt?.outcome, "failed");
  assert.equal(attempt?.reason, "bootstrap-failed");
  assert.equal(context.driver.startSupervisorCalls, 1);
  assert.ok(context.driver.terminateCalls >= 1, "失败必须补偿终止沙箱");

  const operation = await context.outbox.findByKey(`create:${runId}`);
  assert.equal(operation?.state, "failed");
  assert.equal(operation?.errorCode, "bootstrap_failed");
  const run = await context.storage.runs.get(runId);
  assert.equal(run?.status, "stopped", "终止已确认 → 补偿路径收口终态，不停在 provisioning");
  assert.notEqual(run?.status, "provisioning");
  assert.equal(run?.endReason, "bootstrap-failed");
  assert.match(run?.lastError ?? "", /supervisor spawn failed/);
  assert.equal(context.storage.quotaReleases.includes(runId), true, "确认终止后释放配额");
});

test("请求寿命：接纳期取部署预算与 provider 上限的较小值，并作为唯一来源下发（01 §4.3）", async () => {
  const context = buildTestPlane();
  // 部署预算 4h（默认），provider 上限 3600s → 必须收敛到 1h。
  context.driver.maxLifetimeSeconds = 3600;
  const { runId } = await draftOnly(context);
  const acceptedRun = await context.storage.runs.get(runId);
  const expectedDeadline = context.clock.now() + 3600_000;
  assert.equal(acceptedRun?.hardDeadlineAt, expectedDeadline, "接纳期即落 provider 上限（收敛）");

  const created = await context.plane.provisioning.create.runCreateOnce();
  assert.equal(created?.outcome, "created");
  assert.equal(
    context.driver.lastCreateInput?.requestedDeadline,
    expectedDeadline,
    "requestedDeadline 与持久化的 hardDeadlineAt 是同一个值（一处计算）",
  );
  const detail = await context.plane.taskDetail.getDetail({
    principalId: PRINCIPAL,
    taskId: (await context.storage.runs.get(runId))?.taskId ?? "",
  });
  assert.equal(
    detail.ok && detail.value.activeRun?.hardDeadlineAt,
    expectedDeadline,
    "详情响应同样反映收敛后的值",
  );
});

test("请求寿命：provider 只给估计值时用 deadlineEstimate + 置信度（不伪装确认）", async () => {
  const context = buildTestPlane();
  context.driver.maxLifetimeSeconds = 3600;
  context.driver.deadlineSource = "estimated";
  const { runId } = await draftOnly(context);
  const run = await context.storage.runs.get(runId);
  assert.equal(run?.hardDeadlineAt, context.clock.now() + 3600_000);
  assert.equal(run?.deadlineEstimate, context.clock.now() + 3600_000);
  assert.equal(run?.deadlineConfidence, "medium", "估计值必须带置信度");
  assert.equal(run?.expiresAt, undefined, "没有 provider 确认期限就不写 expiresAt");
});

test("请求寿命：provider 未声明上限时不虚构收敛（按预算 + 低置信度估计）", async () => {
  const context = buildTestPlane();
  context.driver.maxLifetimeSeconds = undefined;
  const { runId } = await draftOnly(context);
  const run = await context.storage.runs.get(runId);
  const budgetDeadline = context.clock.now() + 4 * 60 * 60 * 1000;
  assert.equal(run?.hardDeadlineAt, budgetDeadline, "未声明上限 → 保持部署预算");
  assert.equal(run?.deadlineEstimate, budgetDeadline);
  assert.equal(run?.deadlineConfidence, "low", "上限未知的事实可见（不虚构 provider 上限）");
});

test("请求寿命：provider 上限大于预算时取预算", async () => {
  const context = buildTestPlane();
  context.driver.maxLifetimeSeconds = 8 * 3600;
  const { runId } = await draftOnly(context);
  const run = await context.storage.runs.get(runId);
  assert.equal(run?.hardDeadlineAt, context.clock.now() + 4 * 60 * 60 * 1000);
  assert.equal(run?.deadlineEstimate, undefined, "provider 会确认期限 → 接纳期不写估计值");
});

test("create 的 labels 不含 driver 保留键（保留键由 driver 从顶层字段自动写入）", async () => {
  const context = buildTestPlane();
  const { run } = await draftWithRun(context);
  const labels = context.driver.lastCreateInput?.labels ?? {};
  assert.deepEqual(labels, {}, "当前没有额外标签就传空对象");
  for (const reserved of ["operationKey", "runId", "runGeneration"]) {
    assert.equal(reserved in labels, false, `labels 不得包含保留键 ${reserved}`);
  }
  // driver 侧的防线仍在：保留键在本地 create 前被拒（W3 reconcile.ts），调用方不再触发它。
  const { buildReconcileLabels } = await import("../src/cloud/adapters/sandbox/reconcile.js");
  assert.throws(
    () =>
      buildReconcileLabels({
        operationKey: "k",
        runId: run.runId,
        runGeneration: run.runGeneration,
        labels: { operationKey: "x" },
      }),
    /reserved/,
  );
  assert.doesNotThrow(() =>
    buildReconcileLabels({
      operationKey: "k",
      runId: run.runId,
      runGeneration: run.runGeneration,
      labels: {},
    }),
  );
});

test("确定失败：operation 落 failed、run 以可读原因收口，不触发对账循环（01 §9、03 §5）", async () => {
  const context = buildTestPlane();
  context.driver.createOutcome = "throw-coded";
  context.driver.createErrorCode = "unsupported_template";
  const { taskId, runId } = await draftOnly(context);
  const attempt = await context.plane.provisioning.create.runCreateOnce();
  assert.equal(attempt?.outcome, "failed");
  assert.equal(attempt?.reason, "template-unsupported");
  assert.equal(context.driver.findCreateResultCalls, 0, "确定失败不进对账");

  const operation = await context.outbox.findByKey(`create:${runId}`);
  assert.equal(operation?.state, "failed");
  assert.equal(operation?.errorCode, "unsupported_template");

  const after = await context.storage.runs.get(runId);
  assert.notEqual(after?.status, "provisioning", "run 不再停在 provisioning");
  assert.equal(after?.status, "failed");
  assert.equal(after?.endReason, "template-unsupported");
  assert.ok((after?.lastError?.length ?? 0) > 0, "失败文本必须可见（可诊断性）");
  assert.match(after?.lastError ?? "", /unsupported_template/);
  assert.equal(taskId.length > 0, true);
});

test("结果未知：operation 保持 ambiguous 并留待对账（不猜、也不丢文本）", async () => {
  const context = buildTestPlane();
  context.driver.createOutcome = "throw-unknown";
  context.driver.findCreateResultOutcome = "unknown";
  const { runId } = await draftOnly(context);
  const attempt = await context.plane.provisioning.create.runCreateOnce();
  assert.equal(attempt?.outcome, "unknown");
  const operation = await context.outbox.findByKey(`create:${runId}`);
  assert.equal(operation?.state, "ambiguous");
  assert.equal(operation?.errorCode, "provider_create_unknown");
  assert.equal(context.driver.findCreateResultCalls, 1, "未知结果按 operationKey 对账一次");
  assert.equal((await context.storage.runs.get(runId))?.status, "provisioning");
});

test("未归类异常：至少保留 error.message（不出现「只有错误码、没有原因」）", async () => {
  const context = buildTestPlane();
  context.driver.createOutcome = "throw-failed"; // 普通 Error，无归一码
  context.driver.findCreateResultOutcome = "notFound";
  const { runId } = await draftOnly(context);
  const attempt = await context.plane.provisioning.create.runCreateOnce();
  assert.equal(attempt?.outcome, "failed");
  const after = await context.storage.runs.get(runId);
  assert.equal(after?.status, "failed");
  assert.match(after?.lastError ?? "", /create rejected/, "兜底也必须留下可读文本");
});

test("bootstrap.config：clone 事实与自有字段来自持久 Task/Run，envelope 来自注入来源", async () => {
  const context = buildTestPlane();
  const { taskId, run } = await draftWithRun(context);
  await context.plane.attachments.markReady({
    runId: run.runId,
    runGeneration: run.runGeneration,
    connectionEpoch: run.connectionEpoch,
    at: context.clock.now(),
  });
  context.plane.attachments.register({
    taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
    connectionEpoch: run.connectionEpoch,
    address: {
      taskId,
      runId: run.runId,
      runGeneration: run.runGeneration,
      workspaceIdentity: `cloud-task:${taskId}`,
      workspacePath: run.workspacePath ?? "/workspace/demo",
      remoteSessionId: `remote-${run.runId}`,
      connectionEpoch: run.connectionEpoch,
    },
    ready: false,
    connectedAt: context.clock.now(),
  });

  const sent = await context.plane.provisioning.bootstrapConfig.send({
    taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
    connectionEpoch: run.connectionEpoch,
  });
  assert.equal(sent.ok, true, sent.ok ? "" : `${sent.code}/${sent.reason}`);
  assert.equal(sent.ok && sent.value.policyVersion, context.plane.config.bootstrapPolicyVersion);
  assert.equal(sent.ok && sent.value.credentialGeneration, 3, "代际来自 host provisioning source");
  assert.equal(context.attachmentPort.bootstrapConfigs.length, 1);
  assert.equal(context.attachmentPort.bootstrapConfigs[0]?.workspacePath, "/workspace/demo");
});

test("ready 门控：未下发 bootstrap.config 不得发布 ready（02 §5.3）", async () => {
  const context = buildTestPlane();
  const { taskId, run } = await draftWithRun(context);
  context.plane.attachments.register({
    taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
    connectionEpoch: run.connectionEpoch,
    address: {
      taskId,
      runId: run.runId,
      runGeneration: run.runGeneration,
      workspaceIdentity: `cloud-task:${taskId}`,
      workspacePath: run.workspacePath ?? "/workspace/demo",
      remoteSessionId: `remote-${run.runId}`,
      connectionEpoch: run.connectionEpoch,
    },
    ready: false,
    connectedAt: context.clock.now(),
  });
  const ready = await context.plane.runs.markReady({
    taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
    connectionEpoch: run.connectionEpoch,
  });
  assert.equal(ready.ok, false);
  assert.equal(ready.ok === false && ready.reason, "bootstrap-config-not-sent");
});

test("bootstrap.config 下发失败：不发布 ready、不重试旧 envelope（02 §8、01 §6.2）", async () => {
  const context = buildTestPlane();
  const { taskId, run } = await draftWithRun(context);
  context.plane.attachments.register({
    taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
    connectionEpoch: run.connectionEpoch,
    address: {
      taskId,
      runId: run.runId,
      runGeneration: run.runGeneration,
      workspaceIdentity: `cloud-task:${taskId}`,
      workspacePath: run.workspacePath ?? "/workspace/demo",
      remoteSessionId: `remote-${run.runId}`,
      connectionEpoch: run.connectionEpoch,
    },
    ready: false,
    connectedAt: context.clock.now(),
  });
  context.attachmentPort.bootstrapResult = { status: "rejected", code: "stale", reason: "closed" };
  const failed = await context.plane.provisioning.bootstrapConfig.send({
    taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
    connectionEpoch: run.connectionEpoch,
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.ok === false && failed.code, "stale");
  const ready = await context.plane.runs.markReady({
    taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
    connectionEpoch: run.connectionEpoch,
  });
  assert.equal(ready.ok === false && ready.reason, "bootstrap-config-not-sent");
});

test("envelope 来源缺失即 fail-closed（不伪造默认模型）", async () => {
  const context = buildTestPlane();
  const { taskId, run } = await draftWithRun(context);
  context.plane.attachments.register({
    taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
    connectionEpoch: run.connectionEpoch,
    address: {
      taskId,
      runId: run.runId,
      runGeneration: run.runGeneration,
      workspaceIdentity: `cloud-task:${taskId}`,
      workspacePath: run.workspacePath ?? "/workspace/demo",
      remoteSessionId: `remote-${run.runId}`,
      connectionEpoch: run.connectionEpoch,
    },
    ready: false,
    connectedAt: context.clock.now(),
  });
  const source = context.provisioningEnvelope;
  source.unavailable = true;
  const failed = await context.plane.provisioning.bootstrapConfig.send({
    taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
    connectionEpoch: run.connectionEpoch,
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.ok === false && failed.code, "not_configured");
  source.unavailable = false;
  // 同一个 run 补上 envelope 后可以重发（新连接重装路径）。
  await context.plane.attachments.markReady({
    runId: run.runId,
    runGeneration: run.runGeneration,
    connectionEpoch: run.connectionEpoch,
    at: context.clock.now(),
  });
  const resent = await context.plane.provisioning.bootstrapConfig.send({
    taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
    connectionEpoch: run.connectionEpoch,
  });
  assert.equal(resent.ok, true);
  assert.equal(context.attachmentPort.bootstrapConfigs.length, 1);
});

test("模板解析：解析不到即 unsupported_template，不猜默认镜像（CR-5、01 §7.3）", async () => {
  const context = buildTestPlane();
  const project = await context.plane.tasks.createProject({
    principalId: PRINCIPAL,
    repositoryId: 101,
  });
  assert.ok(project.ok);
  const task = await context.plane.tasks.createTask({
    principalId: PRINCIPAL,
    projectId: project.value.projectId,
    title: "Template task",
    creationKey: "ck-template",
    draftStartConfig: { baseBranch: "main", provider: "e2b", templateRef: "unknown-template" },
  });
  assert.ok(task.ok);
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.value.taskId,
    source: "http",
    request: {
      intent: "start",
      commandId: "00000000-0000-4000-8000-000000000501",
      prompt: "go",
      expectedTaskRevision: task.value.revision,
      start: { baseBranch: "main", provider: "e2b", templateRef: "unknown-template" },
    },
  });
  assert.equal(submit.ok, false);
  assert.equal(submit.ok === false && submit.code, "unsupported_template");
  assert.equal(context.storage.createOperations.length, 0, "预检失败不产生 create 操作");
});

test("模板解析成功时 recipe 固定 imageRef/templateRevision（03 §6.1）", async () => {
  const context = buildTestPlane();
  const { run } = await draftWithRun(context);
  assert.equal(run.executionRecipe?.imageDigest, "img:e2b:zcode-node24");
  assert.equal(run.executionRecipe?.templateVersion, "rev:zcode-node24");
  assert.equal(run.executionRecipe?.baseSha, "b".repeat(40), "基线在接纳事务冻结");
});

test("attachReadySession 顺序：welcome → bootstrap.config → ready（02 §5.3）", async () => {
  const context = buildTestPlane();
  const { taskId, run } = await draftWithRun(context);
  await attachReadySession(context, {
    taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
    connectionEpoch: run.connectionEpoch,
  });
  assert.equal(context.attachmentPort.bootstrapConfigs.length, 1);
  const ready = await context.plane.runs.markReady({
    taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
    connectionEpoch: run.connectionEpoch,
  });
  assert.equal(ready.ok, true);
  assert.equal(context.plane.attachments.current(run.runId)?.ready, true);
});

test("非秘密自举要素：taskId/workspacePath 唯一计算点，创建期下发并同值落库（01 §6.2）", async () => {
  const context = buildTestPlane();
  const { taskId, run } = await draftWithRun(context);
  assert.equal(run.workspacePath, "/workspace/demo", "由 repo 名确定性算出（repo=demo）");
  const createInput = context.driver.lastCreateInput;
  assert.ok(createInput, "create 应已调用");
  assert.equal(createInput.bootstrapAddress.taskId, taskId, "taskId 直接取已持久 Task id");
  assert.equal(
    createInput.bootstrapAddress.workspacePath,
    run.workspacePath,
    "下发值必须与落库值同一份计算（一处计算，三处使用）",
  );
  assert.equal(createInput.bootstrapAddress.workspacePath.startsWith("/workspace/"), true);
  assert.equal(
    Object.values(createInput.labels).some((value) => value.includes("/workspace")),
    false,
    "控制面数据不得经 provider labels 运输（01 §6.2）",
  );
});

test("仓库名不安全（含路径分隔/穿越）时创建前明确失败，不落临时路径（01 §6.2 步骤 2）", async () => {
  const context = buildTestPlane();
  // 直接改仓库展示名以模拟脏数据（真实路径由 09 §2.2 授权投影给出）。
  const project = await context.plane.tasks.createProject({
    principalId: PRINCIPAL,
    repositoryId: 101,
  });
  assert.ok(project.ok);
  const stored = context.storage.projectsById.get(project.value.projectId);
  assert.ok(stored);
  context.storage.projectsById.set(stored.projectId, { ...stored, repoName: "../etc" });
  const task = await context.plane.tasks.createTask({
    principalId: PRINCIPAL,
    projectId: project.value.projectId,
    title: "Unsafe name",
    creationKey: "ck-unsafe",
    draftStartConfig: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
  });
  assert.ok(task.ok);
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.value.taskId,
    source: "http",
    request: {
      intent: "start",
      commandId: "00000000-0000-4000-8000-000000000701",
      prompt: "go",
      expectedTaskRevision: task.value.revision,
      start: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
    },
  });
  assert.equal(submit.ok, true);
  const attempt = await context.plane.provisioning.create.runCreateOnce();
  assert.equal(attempt?.outcome, "failed");
  assert.equal(attempt?.reason, "workspace-path-unresolved");
  assert.equal(context.driver.createCalls, 0, "不安全的仓库名不得触达 provider");
});
