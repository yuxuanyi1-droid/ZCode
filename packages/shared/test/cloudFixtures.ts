/**
 * Cloud wire 契约测试 fixture（W0；specs/cloud-agent/12 §11 附件/正文边界、
 * 03 §6 输入契约）。仅测试使用的合法样本，不含任何真实用户数据、仓库内容或凭据。
 */
export const TASK_ID = "8f14e45f-ceea-467a-9a1e-1f0d3b2a4c51";
export const RUN_ID = "1c9d0b3a-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
export const COMMAND_ID = "2b7f5c1a-9d3e-4f8a-b1c2-d3e4f5a6b7c8";
export const PRINCIPAL_ID = "3c8a6d2b-0e4f-4a9b-8c1d-2e3f4a5b6c7d";
export const PROJECT_ID = "4d9b7e3c-1f5a-4b0c-9d2e-3f4a5b6c7d8e";
export const OPERATION_ID = "5eac8f4d-2a6b-4c1d-8e3f-4a5b6c7d8e9f";
export const STREAM_ID = "6fbd90ae-3b7c-4d2e-9f4a-5b6c7d8e9f01";

export const SHA1_HEX = "0123456789abcdef0123456789abcdef01234567";
export const SHA256_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

export const TASK_WORKSPACE_IDENTITY = `cloud-task:${TASK_ID}`;
export const WORKSPACE_PATH = "/home/sandbox/workspace/task";

export const taskRecordFixture = {
  taskId: TASK_ID,
  ownerPrincipalId: PRINCIPAL_ID,
  projectId: PROJECT_ID,
  title: "示例任务",
  status: "draft",
  creationKey: "creation-key-1",
  draftStartConfig: { baseBranch: "main", provider: "e2b", templateRef: "template-v1" },
  workspaceIdentity: TASK_WORKSPACE_IDENTITY,
  nextRunGeneration: 1,
  revision: 3,
  createdAt: 1_760_000_000_000,
  updatedAt: 1_760_000_060_000,
} as const;

export const runRecordFixture = {
  runId: RUN_ID,
  taskId: TASK_ID,
  runGeneration: 1,
  executionKind: "sandbox",
  firstInputCommandId: COMMAND_ID,
  executionRecipe: {
    provider: "e2b",
    templateRef: "template-v1",
    imageDigest: "sha256:example",
    resources: { cpu: 2, memoryMiB: 4096, diskGiB: 20 },
    baseSha: SHA1_HEX,
    firstCommandConfig: { mode: "build", planEnabled: false },
  },
  provider: "e2b",
  providerHandle: "sandbox-handle-1",
  workspacePath: WORKSPACE_PATH,
  status: "ready",
  connectionEpoch: 2,
  runtimeSessionId: "session-1",
  dataAtRisk: false,
  createdAt: 1_760_000_000_000,
  updatedAt: 1_760_000_060_000,
} as const;

export const inputRecordFixture = {
  taskId: TASK_ID,
  commandId: COMMAND_ID,
  intent: "start",
  payloadHash: SHA256_HEX,
  acceptanceSeq: 1,
  acceptedAt: 1_760_000_000_000,
  targetRunId: RUN_ID,
  deliveryStatus: "accepted",
} as const;

export const checkpointFixture = {
  operationId: OPERATION_ID,
  taskId: TASK_ID,
  runId: RUN_ID,
  runGeneration: 1,
  state: "saved",
  includedFiles: ["src/index.ts"],
  localSha: SHA1_HEX,
  confirmedRemoteSha: SHA1_HEX,
  createdAt: 1_760_000_000_000,
  updatedAt: 1_760_000_060_000,
} as const;

export const artifactFixture = {
  taskId: TASK_ID,
  kind: "code",
  taskBranch: `cloud/${TASK_ID}`,
  prHead: `cloud/${TASK_ID}`,
  prBase: "main",
  prStatus: "draft",
} as const;

export const runAddressFixture = {
  taskId: TASK_ID,
  runId: RUN_ID,
  runGeneration: 1,
  workspaceIdentity: TASK_WORKSPACE_IDENTITY,
  workspacePath: WORKSPACE_PATH,
  remoteSessionId: "remote-session-1",
} as const;

export const attachmentAddressFixture = { ...runAddressFixture, connectionEpoch: 2 } as const;

export const projectionRecordFixture = {
  schemaVersion: 1,
  taskId: TASK_ID,
  runId: RUN_ID,
  runGeneration: 1,
  runtimeIncarnation: "incarnation-1",
  topic: "conversation",
  logEpoch: "epoch-1",
  sourceSeq: 7,
  kind: "delta",
  payload: { text: "示例输出" },
  contentHash: SHA256_HEX,
} as const;

/** 历史回放行：与 projection.batch 记录同源，但只带客户端需要的读面字段（02 §7.3）。 */
export const historyItemFixture = {
  topic: "conversation",
  logEpoch: "epoch-1",
  seq: 7,
  kind: "delta",
  payload: { text: "示例输出" },
  ts: 1_760_000_000_000,
} as const;
