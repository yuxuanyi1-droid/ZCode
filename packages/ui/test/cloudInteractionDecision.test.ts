/**
 * 云模式交互决定纯逻辑用例（specs/cloud-agent 03 §7.2、spec 15 §R6）。
 *
 * 不依赖 React/DOM：验证云/非云路由判定、请求形状，以及 202/delivering 与 admitted
 * 的语义区分（只有 admitted 才算成功，绝不合成 CommandAck）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { CloudInteractionDecisionReceipt } from "@zcode/shared";
import {
  buildCloudInteractionDecisionRequest,
  resolveCloudInteractionRoute,
  submitCloudInteractionDecision,
  type CloudInteractionContext,
} from "../src/cloud/cloudInteractionDecision.js";
import type { CloudControlPlanePort } from "../src/cloud/cloudPorts.js";

const TASK_ID = "8f14e45f-ceea-467a-9a1e-1f0d3b2a4c51";
const RUN_ID = "1c8e4a02-3b7d-4f61-9a2e-5d7c8b9a0f13";
const COMMAND_ID = "2b7f5c1a-9d3e-4f8a-b1c2-d3e4f5a6b7c8";
const interactionId = "interaction-1";

const request = buildCloudInteractionDecisionRequest({
  commandId: COMMAND_ID,
  runId: RUN_ID,
  runGeneration: 1,
  kind: "permission",
  answer: { optionId: "allow" },
});

function contextWith(
  overrides: Partial<Pick<CloudInteractionContext & object, "controlPlane" | "taskDetail">> & {
    taskId?: string | null;
  } = {},
): CloudInteractionContext {
  return {
    controlPlane: ("controlPlane" in overrides
      ? overrides.controlPlane
      : {}) as CloudControlPlanePort,
    selection: { taskId: overrides.taskId === undefined ? TASK_ID : overrides.taskId },
    taskDetail:
      "taskDetail" in overrides
        ? overrides.taskDetail
        : ({
            activeRun: { runId: RUN_ID, runGeneration: 1 },
          } as never),
  } as unknown as CloudInteractionContext;
}

function portWith(
  submit: (
    taskId: string,
    interactionId: string,
    body: unknown,
  ) => Promise<{ httpStatus: number; receipt: CloudInteractionDecisionReceipt }>,
): { port: CloudControlPlanePort; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const port = {
    origin: "https://cloud.example.test",
    submitCloudInteractionDecision: async (taskId: string, id: string, body: unknown) => {
      calls.push([taskId, id, body]);
      return submit(taskId, id, body);
    },
  } as unknown as CloudControlPlanePort;
  return { port, calls };
}

test("非云上下文走 local；云上下文要求 controlPlane + taskId + activeRun，否则 fail-closed", () => {
  assert.deepEqual(resolveCloudInteractionRoute(null), { mode: "local" });

  const route = resolveCloudInteractionRoute(contextWith());
  assert.equal(route.mode, "cloud");
  if (route.mode !== "cloud") return;
  assert.equal(route.taskId, TASK_ID);
  assert.equal(route.runId, RUN_ID);
  assert.equal(route.runGeneration, 1);

  assert.deepEqual(resolveCloudInteractionRoute(contextWith({ controlPlane: null })), {
    mode: "cloud-unavailable",
    reason: "control-plane-unavailable",
  });
  assert.deepEqual(resolveCloudInteractionRoute(contextWith({ taskId: null })), {
    mode: "cloud-unavailable",
    reason: "task-not-selected",
  });
  assert.deepEqual(resolveCloudInteractionRoute(contextWith({ taskDetail: null })), {
    mode: "cloud-unavailable",
    reason: "run-not-active",
  });
});

test("请求形状只含冻结字段，答案原样透传", () => {
  assert.deepEqual(request, {
    commandId: COMMAND_ID,
    runId: RUN_ID,
    runGeneration: 1,
    kind: "permission",
    answer: { optionId: "allow" },
  });
});

test("202/accepted 与 delivering 都只算提交中；只有 admitted 成功", async () => {
  for (const deliveryStatus of ["accepted", "delivering", "uncertain"] as const) {
    const { port, calls } = portWith(async () => ({
      httpStatus: 202,
      receipt: { taskId: TASK_ID, interactionId, deliveryStatus },
    }));
    const outcome = await submitCloudInteractionDecision({
      controlPlane: port,
      taskId: TASK_ID,
      interactionId,
      request,
    });
    assert.equal(outcome.status, "pending", `${deliveryStatus} 不是 runtime 裁决`);
    assert.equal(outcome.status === "pending" && outcome.httpStatus, 202);
    // 提交参数逐字交给端口；不生成第二个 key、不改写 answer。
    assert.deepEqual(calls, [[TASK_ID, interactionId, request]]);
  }

  const admitted = portWith(async () => ({
    httpStatus: 200,
    receipt: { taskId: TASK_ID, interactionId, deliveryStatus: "admitted" },
  }));
  const outcome = await submitCloudInteractionDecision({
    controlPlane: admitted.port,
    taskId: TASK_ID,
    interactionId,
    request,
  });
  assert.equal(outcome.status, "admitted");
  if (outcome.status !== "admitted") return;
  assert.equal(outcome.receipt.deliveryStatus, "admitted");
  // 回执类型没有 runtimeAck：UI 不伪造 CommandAck。
  assert.equal("runtimeAck" in outcome.receipt, false);
});

test("终态 rejected/cancelled 与传输错误走失败路径（不显示成功）", async () => {
  for (const deliveryStatus of ["rejected", "cancelled"] as const) {
    const { port } = portWith(async () => ({
      httpStatus: 200,
      receipt: { taskId: TASK_ID, interactionId, deliveryStatus },
    }));
    const outcome = await submitCloudInteractionDecision({
      controlPlane: port,
      taskId: TASK_ID,
      interactionId,
      request,
    });
    assert.equal(outcome.status, "failed");
  }

  const throwing = portWith(async () => {
    throw Object.assign(new Error("conflict"), {
      code: "idempotency_conflict",
      details: { reason: "interaction-payload-mismatch" },
    });
  });
  const outcome = await submitCloudInteractionDecision({
    controlPlane: throwing.port,
    taskId: TASK_ID,
    interactionId,
    request,
  });
  assert.equal(outcome.status, "failed");
  if (outcome.status !== "failed") return;
  assert.equal(outcome.message, "idempotency_conflict/interaction-payload-mismatch");
});
