/**
 * W8 持久输入用例（specs/cloud-agent 04 §3.2/§3.4/§3.4.1、03 §6.2/§7、11 §7、
 * 验收 W-04/W-05/W-09、CT-03/CT-07/CT-08/CT-14/CT-16）。
 *
 * 断言的核心语义：
 * - HTTP 202 只代表控制面已持久接收，**不是** runtime ACK；
 * - 本地冻结失败必须阻止发出 HTTP；
 * - 结果未知时保留原 commandId / 原 payload，刷新后先查询再决定，不自动换 key；
 * - receipt 只清「本次正文版本」，等待期间的新编辑不受迟到响应影响。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { InputReceipt, SubmitTaskInput } from "@zcode/shared";
import {
  reconcileCloudTaskInput,
  submitCloudTaskInput,
  type CloudTaskSubmissionDeps,
} from "../src/cloud/cloudTaskSubmission.js";
import type { CloudControlPlanePort } from "../src/cloud/cloudPorts.js";
import {
  createMemoryCloudDraftLocalStores,
  useCloudDraftStore,
  type CloudDraftLocalStores,
} from "../src/store/cloud/cloudDraftStore.js";

const SCOPE_KEY = "principal-1|https://cloud.example.com|8f14e45f-ceea-467a-9a1e-1f0d3b2a4c51";
const TASK_ID = "8f14e45f-ceea-467a-9a1e-1f0d3b2a4c51";
const COMMAND_ID = "1f0d3b2a-4c51-4d9b-8c1d-2e3f4a5b6c7d";

interface RecordedRequest {
  readonly taskId: string;
  readonly body: SubmitTaskInput;
}

function createInputBody(): SubmitTaskInput {
  return {
    intent: "start",
    commandId: COMMAND_ID,
    prompt: "把 README 的分支说明补齐",
    expectedTaskRevision: 3,
    start: { baseBranch: "main", provider: "e2b" },
  };
}

/**
 * 控制面桩：`submit` 行为按用例注入，用来区分 202 / 明确拒绝 / 结果未知三条路径。
 */
function createPort(options: {
  readonly submit?: (
    request: RecordedRequest,
  ) => Promise<{ httpStatus: number; receipt: InputReceipt }>;
  readonly getInput?: (commandId: string) => Promise<InputReceipt>;
}): { port: CloudControlPlanePort; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const port = {
    origin: "https://cloud.example.com",
    submitInput: async (taskId: string, body: SubmitTaskInput) => {
      requests.push({ taskId, body });
      if (!options.submit) {
        throw new Error("submitInput must not be called in this scenario");
      }
      return options.submit({ taskId, body });
    },
    getInput: async (_taskId: string, commandId: string) => {
      if (!options.getInput) {
        throw new Error("getInput must not be called in this scenario");
      }
      return options.getInput(commandId);
    },
  } as unknown as CloudControlPlanePort;
  return { port, requests };
}

function createDeps(
  port: CloudControlPlanePort,
  stores: CloudDraftLocalStores = createMemoryCloudDraftLocalStores(),
): CloudTaskSubmissionDeps {
  return {
    controlPlane: port,
    scopeKey: SCOPE_KEY,
    taskId: TASK_ID,
    freezeAttempt: (attempt) =>
      useCloudDraftStore.getState().freezeAttempt(SCOPE_KEY, attempt, stores),
    settleAttempt: (commandId, settlement) =>
      useCloudDraftStore.getState().settleAttempt(SCOPE_KEY, commandId, settlement, stores),
    applyReceipt: (commandId, receipt) =>
      useCloudDraftStore.getState().applyReceipt(SCOPE_KEY, commandId, receipt, stores),
  };
}

test("202 is persisted receipt only, and never becomes a runtime admission", async () => {
  useCloudDraftStore.getState().reset();
  const receipt: InputReceipt = {
    taskId: TASK_ID,
    commandId: COMMAND_ID,
    deliveryStatus: "accepted",
  };
  const { port } = createPort({ submit: async () => ({ httpStatus: 202, receipt }) });
  const deps = createDeps(port);

  const outcome = await submitCloudTaskInput({
    commandId: COMMAND_ID,
    request: { kind: "input", body: createInputBody() },
    bodyVersion: 1,
    deps,
  });

  assert.equal(outcome.kind, "persisted");
  if (outcome.kind !== "persisted") {
    return;
  }
  assert.equal(outcome.httpStatus, 202);
  // `accepted` 是控制面持久接收，不带 runtimeAck —— UI 不能把它当准入。
  assert.equal(outcome.receipt.deliveryStatus, "accepted");
  assert.equal(outcome.receipt.runtimeAck, undefined);
  // 2026-10-08 巡检修订（P2）：persisted outcome 携带本次幂等键，供 pane 的
  // pending optimistic overlay 关联权威投影（queue/userInput 的 sourceCommandId）。
  assert.equal(outcome.commandId, COMMAND_ID);

  const attempt = useCloudDraftStore.getState().attempts[SCOPE_KEY]?.[COMMAND_ID];
  assert.equal(attempt?.phase, "persisted");
  assert.equal(attempt?.bodyVersion, 1);
});

test("a failed local freeze blocks the HTTP request entirely", async () => {
  useCloudDraftStore.getState().reset();
  const failing = createMemoryCloudDraftLocalStores({ failAttemptWrites: true });
  const { port, requests } = createPort({});
  const deps = createDeps(port, failing);

  const outcome = await submitCloudTaskInput({
    commandId: COMMAND_ID,
    request: { kind: "input", body: createInputBody() },
    bodyVersion: 1,
    deps,
  });

  // 04 §3.4.1：本地写入失败阻止 Cloud 提交并解释恢复限制——不能先发再补记。
  assert.equal(outcome.kind, "not-frozen");
  assert.equal(requests.length, 0);
});

test("an unknown result keeps the original commandId and payload for reconciliation", async () => {
  useCloudDraftStore.getState().reset();
  const receipts: InputReceipt[] = [];
  const { port } = createPort({
    submit: async () => {
      // 传输层失败：服务端结果未知。
      throw new Error("socket hang up");
    },
    getInput: async (commandId) => {
      const receipt: InputReceipt = {
        taskId: TASK_ID,
        commandId,
        deliveryStatus: "admitted",
      };
      receipts.push(receipt);
      return receipt;
    },
  });
  const deps = createDeps(port);
  const body = createInputBody();

  const outcome = await submitCloudTaskInput({
    commandId: COMMAND_ID,
    request: { kind: "input", body },
    bodyVersion: 4,
    deps,
  });
  assert.equal(outcome.kind, "unknown");
  if (outcome.kind !== "unknown") {
    return;
  }
  // 不能当成没发，也不能换 key。
  assert.equal(outcome.commandId, COMMAND_ID);

  const pending = useCloudDraftStore.getState().pendingAttempts(SCOPE_KEY);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].commandId, COMMAND_ID);
  // 冻结的 payload 原样保留：恢复时不能重新组装（04 §3.4.1）。
  assert.equal(pending[0].request.kind, "input");
  assert.deepEqual(pending[0].request.kind === "input" ? pending[0].request.body : null, body);

  // 刷新后先按原 commandId 查询，拿到明确 receipt 再决定。
  const receipt = await reconcileCloudTaskInput(deps, COMMAND_ID);
  assert.equal(receipt.deliveryStatus, "admitted");
  assert.deepEqual(
    receipts.map((entry) => entry.commandId),
    [COMMAND_ID],
  );
  assert.equal(useCloudDraftStore.getState().pendingAttempts(SCOPE_KEY).length, 0);
});

test("a definitive server rejection is recorded as rejected, not as unknown", async () => {
  useCloudDraftStore.getState().reset();
  const conflict = Object.assign(new Error("idempotency conflict"), {
    code: "idempotency_conflict",
    retryable: false,
  });
  const { port } = createPort({
    submit: async () => {
      throw conflict;
    },
  });
  const deps = createDeps(port);

  const outcome = await submitCloudTaskInput({
    commandId: COMMAND_ID,
    request: { kind: "input", body: createInputBody() },
    bodyVersion: 2,
    deps,
  });

  assert.equal(outcome.kind, "rejected");
  if (outcome.kind !== "rejected") {
    return;
  }
  // UI 不解析异常文案，只按 code 归类（04 §6）。
  assert.equal(outcome.message, "idempotency_conflict");
  assert.equal(useCloudDraftStore.getState().attempts[SCOPE_KEY]?.[COMMAND_ID]?.phase, "rejected");
});

test("retrying an unknown attempt replays the same key instead of minting a new one", async () => {
  useCloudDraftStore.getState().reset();
  let submittedCommandIds: string[] = [];
  let shouldFail = true;
  const { port } = createPort({
    submit: async ({ body }) => {
      submittedCommandIds = [...submittedCommandIds, body.commandId];
      if (shouldFail) {
        throw new Error("gateway timeout");
      }
      return {
        httpStatus: 202,
        receipt: { taskId: TASK_ID, commandId: body.commandId, deliveryStatus: "accepted" },
      };
    },
  });
  const deps = createDeps(port);

  await submitCloudTaskInput({
    commandId: COMMAND_ID,
    request: { kind: "input", body: createInputBody() },
    bodyVersion: 1,
    deps,
  });
  const [attempt] = useCloudDraftStore.getState().pendingAttempts(SCOPE_KEY);
  assert.ok(attempt);

  shouldFail = false;
  // 恢复时用**冻结时的** payload 与 commandId 重投（11 §7）。
  const retried = await submitCloudTaskInput({
    commandId: attempt.commandId,
    request: attempt.request,
    bodyVersion: attempt.bodyVersion,
    deps,
  });

  assert.equal(retried.kind, "persisted");
  assert.deepEqual(submittedCommandIds, [COMMAND_ID, COMMAND_ID]);
});

test("a late receipt clears only the body version that was frozen", () => {
  useCloudDraftStore.getState().reset();
  const store = createMemoryCloudDraftLocalStores();
  const draft = useCloudDraftStore.getState();

  draft.setBody(SCOPE_KEY, "第一版正文", store);
  const frozenVersion = useCloudDraftStore.getState().drafts[SCOPE_KEY]?.bodyVersion ?? 0;
  assert.equal(
    draft.freezeAttempt(
      SCOPE_KEY,
      {
        commandId: COMMAND_ID,
        request: { kind: "input", body: createInputBody() },
        bodyVersion: frozenVersion,
      },
      store,
    ),
    true,
  );

  // 等待期间用户继续写：这是新的一版正文，不能被迟到回执清掉（04 §3.2.6）。
  draft.setBody(SCOPE_KEY, "第一版正文\n第二版补充", store);

  useCloudDraftStore
    .getState()
    .applyReceipt(
      SCOPE_KEY,
      COMMAND_ID,
      { taskId: TASK_ID, commandId: COMMAND_ID, deliveryStatus: "admitted" },
      store,
    );

  assert.equal(useCloudDraftStore.getState().drafts[SCOPE_KEY]?.body, "第一版正文\n第二版补充");
});

test("a receipt clears the frozen body version exactly once", () => {
  useCloudDraftStore.getState().reset();
  const store = createMemoryCloudDraftLocalStores();
  useCloudDraftStore.getState().setBody(SCOPE_KEY, "待发送正文", store);
  const version = useCloudDraftStore.getState().drafts[SCOPE_KEY]?.bodyVersion ?? 0;
  useCloudDraftStore.getState().freezeAttempt(
    SCOPE_KEY,
    {
      commandId: COMMAND_ID,
      request: { kind: "input", body: createInputBody() },
      bodyVersion: version,
    },
    store,
  );

  useCloudDraftStore
    .getState()
    .applyReceipt(
      SCOPE_KEY,
      COMMAND_ID,
      { taskId: TASK_ID, commandId: COMMAND_ID, deliveryStatus: "admitted" },
      store,
    );

  const record = useCloudDraftStore.getState().drafts[SCOPE_KEY];
  assert.equal(record?.body, "");
  // 版本继续前进：下一次 attempt 冻结的是新版本，旧回执不会重复清。
  assert.ok((record?.bodyVersion ?? 0) > version);
});

test("restarting the client restores the frozen attempt instead of losing it", () => {
  useCloudDraftStore.getState().reset();
  const store = createMemoryCloudDraftLocalStores();
  useCloudDraftStore.getState().setBody(SCOPE_KEY, "关页前写的正文", store);
  useCloudDraftStore.getState().freezeAttempt(
    SCOPE_KEY,
    {
      commandId: COMMAND_ID,
      request: { kind: "input", body: createInputBody() },
      bodyVersion: 1,
    },
    store,
  );

  // 模拟刷新：清掉内存投影后重新 hydrate，未决 attempt 必须能恢复。
  useCloudDraftStore.setState({ drafts: {}, attempts: {}, hydratedScopes: {} });
  useCloudDraftStore.getState().hydrate(SCOPE_KEY, store);

  const pending = useCloudDraftStore.getState().pendingAttempts(SCOPE_KEY);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].commandId, COMMAND_ID);
  assert.equal(pending[0].phase, "frozen");
  assert.equal(useCloudDraftStore.getState().drafts[SCOPE_KEY]?.body, "关页前写的正文");
});

test("destroyed or malformed local records are dropped rather than guessed", () => {
  useCloudDraftStore.getState().reset();
  const store = createMemoryCloudDraftLocalStores();
  store.draft.write(SCOPE_KEY, "{not json");
  useCloudDraftStore.getState().hydrate(SCOPE_KEY, store);
  assert.equal(useCloudDraftStore.getState().drafts[SCOPE_KEY], undefined);
  assert.deepEqual(useCloudDraftStore.getState().pendingAttempts(SCOPE_KEY), []);
});
