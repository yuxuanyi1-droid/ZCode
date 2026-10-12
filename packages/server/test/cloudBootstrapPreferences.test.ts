/**
 * M8 `bootstrap.config.preferences` 偏好快照组装验收（specs/cloud-agent 14 §6/§9.2⑥）。
 *
 * 覆盖五键取值、缺键省略、内容寻址 `configVersion` 稳定性与未接线/读取失败不 fail。
 * 原 `bootstrap.resources` 下发编排用例随自举期安装退役整体删除（14 §4.8/§9.5；
 * 连接期同步的编排用例见 `cloudUserProfileSync.test.ts`）。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { CloudBootstrapPreferences } from "@zcode/shared";
import { buildTestPlane } from "./cloudCoreFakes.js";
import type { TestPlane } from "./cloudCoreFakes.js";
import { createFakeUserPreferences } from "./cloudCoreAdapterFakes.js";
import { sessionFromAddress } from "../src/cloud/app/attachments/registry.js";

const PRINCIPAL = "00000000-0000-4000-8000-0000000000aa";
const DEFAULT_PREFS: CloudBootstrapPreferences["values"] = {
  askUserQuestionAutoResolutionEnabled: false,
  nativeSearchEnhancementsEnabled: true,
  memoryEnabled: true,
  modelContextBudgetStrategy: "preflight-v1",
  integratedTerminalShell: { mode: "auto" },
};

let counter = 0;

function sha256Hex(value: string | Uint8Array): string {
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
    title: "Preferences",
    creationKey: `ck-prefs-${counter}`,
    draftStartConfig: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
  });
  assert.ok(task.ok);
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.value.taskId,
    source: "http",
    request: {
      intent: "start",
      commandId: `00000000-0000-4000-8000-00000000${String(9000 + counter).slice(-4)}`,
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

function attachSession(
  context: TestPlane,
  input: { taskId: string; runId: string; runGeneration: number },
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
        connectionEpoch: 1,
      },
      at: context.clock.now(),
    }),
  );
}

test("偏好快照：五键实值 + 内容寻址 configVersion（同值同 hash）", async () => {
  const preferences = createFakeUserPreferences({ ...DEFAULT_PREFS });
  const context = buildTestPlane({ userPreferences: preferences });
  const first = await draftWithRun(context);
  const second = await draftWithRun(context);
  for (const run of [first, second]) {
    // 配置下发经 attachment 通道寻址：先注册 session（02 §5.3）。
    attachSession(context, run);
    const sent = await context.plane.provisioning.bootstrapConfig.send({
      ...run,
      connectionEpoch: 1,
    });
    assert.equal(sent.ok, true, sent.ok ? "" : `${sent.code}/${sent.reason}`);
  }
  const payloads = context.attachmentPort.bootstrapConfigPayloads;
  assert.equal(payloads.length, 2);
  const expectedVersion =
    "prefs-" +
    sha256Hex(JSON.stringify(DEFAULT_PREFS, Object.keys(DEFAULT_PREFS).sort())).slice(0, 16);
  for (const payload of payloads) {
    assert.deepEqual(payload.preferences?.values, DEFAULT_PREFS, "五键实值逐项透传");
    assert.equal(payload.preferences?.configVersion, expectedVersion, "内容寻址版本");
  }
  assert.equal(
    payloads[0]?.preferences?.configVersion,
    payloads[1]?.preferences?.configVersion,
    "同值同 hash（可核对）",
  );
});

test("偏好快照：缺键省略值、空值/未接线/读取失败都不带 preferences 块（不 fail）", async () => {
  // 只显式设置两键：值对象只含这两键（缺席键由沙箱 responder 用既有默认值收敛）。
  const partial = createFakeUserPreferences({
    memoryEnabled: true,
    nativeSearchEnhancementsEnabled: false,
  });
  const partialContext = buildTestPlane({ userPreferences: partial });
  const run = await draftWithRun(partialContext);
  attachSession(partialContext, run);
  const sent = await partialContext.plane.provisioning.bootstrapConfig.send({
    ...run,
    connectionEpoch: 1,
  });
  assert.equal(sent.ok, true);
  assert.deepEqual(partialContext.attachmentPort.bootstrapConfigPayloads[0]?.preferences?.values, {
    memoryEnabled: true,
    nativeSearchEnhancementsEnabled: false,
  });

  // 未接线：不带块（老 bootstrap.config 语义）。
  const unwired = buildTestPlane();
  const unwiredRun = await draftWithRun(unwired);
  attachSession(unwired, unwiredRun);
  const unwiredSent = await unwired.plane.provisioning.bootstrapConfig.send({
    ...unwiredRun,
    connectionEpoch: 1,
  });
  assert.equal(unwiredSent.ok, true);
  assert.equal(unwired.attachmentPort.bootstrapConfigPayloads[0]?.preferences, undefined);

  // 读取失败：回空对象 → 不带块，但运行配置照常下发（偏好缺失不是 run 失败条件）。
  const failing = createFakeUserPreferences({ ...DEFAULT_PREFS });
  failing.fail = true;
  const failingContext = buildTestPlane({ userPreferences: failing });
  const failingRun = await draftWithRun(failingContext);
  attachSession(failingContext, failingRun);
  const failingSent = await failingContext.plane.provisioning.bootstrapConfig.send({
    ...failingRun,
    connectionEpoch: 1,
  });
  assert.equal(failingSent.ok, true);
  assert.equal(failingContext.attachmentPort.bootstrapConfigPayloads[0]?.preferences, undefined);
  assert.equal(failing.readCount, 1);
});
