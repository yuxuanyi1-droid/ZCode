/**
 * SDK 侧 wire schema 索引（消费 shared，不复制字段名）。
 *
 * 端点矩阵、请求/响应形状、错误信封的唯一事实源是 `@zcode/shared` 的 cloud 契约
 * （W0：`packages/shared/src/cloud/*` + `CONTRACT.md`）。本文件只做三件事：
 * 1) 把 SDK 真正调用的端点 id 映射到 shared 已冻结的 request/response schema；
 * 2) 给出 SDK 侧的类型推导入口（响应/请求体类型只能由 shared schema 推导）；
 * 3) 声明 SDK 支持的 cloud wire 协议版本，并按 fail-closed 校验（00 §8）。
 *
 * `packages/client/test/cloudSdk.test.ts` 逐条断言本索引与 `CLOUD_HTTP_ENDPOINTS`
 * 的 schema 名一致，因此 SDK 无法在本地悄悄复制或漂移字段名。
 */
import {
  CLOUD_WIRE_PROTOCOL_SUPPORTED_VERSIONS,
  capabilitiesResponseSchema,
  cloudAttachmentUploadResponseSchema,
  cloudBranchPageSchema,
  cloudDeletedResponseSchema,
  cloudEmptyBodySchema,
  cloudExtensionResponseSchema,
  cloudHistoryPageSchema,
  cloudProjectionSnapshotSchema,
  cloudProjectPageSchema,
  cloudProjectRecordSchema,
  cloudRepositoryPageSchema,
  cloudTaskEventsResponseSchema,
  cloudTaskPageSchema,
  cloudTaskRecordSchema,
  createCloudProjectRequestSchema,
  createCloudTaskRequestSchema,
  forceStopCloudTaskRequestSchema,
  inputReceiptSchema,
  inputRecordPageSchema,
  isSupportedCloudWireProtocolVersion,
  patchCloudProjectRequestSchema,
  patchCloudTaskRequestSchema,
  reopenCloudTaskRequestSchema,
  submitTaskInputSchema,
  taskDetailResponseSchema,
  cloudHistoryQuerySchema,
  cloudListQuerySchema,
  cloudRepositoriesQuerySchema,
  cloudSnapshotQuerySchema,
  cloudTaskEventsQuerySchema,
  type CloudHistoryQuery,
  type CloudListQuery,
  type CloudRepositoriesQuery,
  type CloudSnapshotQuery,
  type CloudTaskEventsQuery,
} from "@zcode/shared";
import { cloudProtocolError, cloudValidationError } from "./cloudApiError.js";

/**
 * 端点 → 冻结 schema。id 必须能在 `CLOUD_HTTP_ENDPOINTS` 里反查到（测试断言），
 * `request: null` 表示该端点没有请求体（GET / DELETE）。
 */
export const CLOUD_SDK_ENDPOINT_SCHEMAS = {
  capabilities: { request: null, response: capabilitiesResponseSchema },
  repositories: { request: null, response: cloudRepositoryPageSchema },
  repositoryBranches: { request: null, response: cloudBranchPageSchema },
  listProjects: { request: null, response: cloudProjectPageSchema },
  createProject: { request: createCloudProjectRequestSchema, response: cloudProjectRecordSchema },
  patchProject: { request: patchCloudProjectRequestSchema, response: cloudProjectRecordSchema },
  deleteProject: { request: null, response: cloudDeletedResponseSchema },
  projectTasks: { request: null, response: cloudTaskPageSchema },
  createTask: { request: createCloudTaskRequestSchema, response: cloudTaskRecordSchema },
  taskDetail: { request: null, response: taskDetailResponseSchema },
  patchTask: { request: patchCloudTaskRequestSchema, response: cloudTaskRecordSchema },
  submitInput: { request: submitTaskInputSchema, response: inputReceiptSchema },
  listInputs: { request: null, response: inputRecordPageSchema },
  getInput: { request: null, response: inputReceiptSchema },
  cancelInput: { request: cloudEmptyBodySchema, response: inputReceiptSchema },
  reopenTask: { request: reopenCloudTaskRequestSchema, response: taskDetailResponseSchema },
  stopTask: { request: cloudEmptyBodySchema, response: taskDetailResponseSchema },
  forceStopTask: { request: forceStopCloudTaskRequestSchema, response: taskDetailResponseSchema },
  extendTask: { request: cloudEmptyBodySchema, response: cloudExtensionResponseSchema },
  completeTask: { request: cloudEmptyBodySchema, response: taskDetailResponseSchema },
  archiveTask: { request: cloudEmptyBodySchema, response: taskDetailResponseSchema },
  reactivateTask: { request: cloudEmptyBodySchema, response: taskDetailResponseSchema },
  restoreTask: { request: cloudEmptyBodySchema, response: taskDetailResponseSchema },
  taskHistory: { request: null, response: cloudHistoryPageSchema },
  taskEvents: { request: null, response: cloudTaskEventsResponseSchema },
  taskSnapshot: { request: null, response: cloudProjectionSnapshotSchema },
  uploadAttachment: { request: null, response: cloudAttachmentUploadResponseSchema },
} as const;

export type CloudSdkEndpointId = keyof typeof CLOUD_SDK_ENDPOINT_SCHEMAS;

/** 有请求体的端点（写操作）：请求体类型只能来自 shared 的冻结 request schema。 */
export type CloudWriteEndpointId = {
  [K in CloudSdkEndpointId]: (typeof CLOUD_SDK_ENDPOINT_SCHEMAS)[K]["request"] extends null
    ? never
    : K;
}[CloudSdkEndpointId];

/** 从 schema 的 `safeParse` 结果反推输出类型：SDK 不重新声明任何字段。 */
type SchemaOutput<S> = S extends { safeParse(input: unknown): infer R }
  ? R extends { success: true; data: infer D }
    ? D
    : never
  : never;

export type CloudEndpointResponse<K extends CloudSdkEndpointId> = SchemaOutput<
  (typeof CLOUD_SDK_ENDPOINT_SCHEMAS)[K]["response"]
>;

export type CloudEndpointRequestBody<K extends CloudWriteEndpointId> = SchemaOutput<
  (typeof CLOUD_SDK_ENDPOINT_SCHEMAS)[K]["request"]
>;

// ── 协议版本（00 §8：独立版本化，未知版本整帧拒绝）──

/**
 * SDK 支持的 cloud wire 协议版本集合，与 shared 的 `CLOUD_WIRE_PROTOCOL_SUPPORTED_VERSIONS`
 * 同源（W7 CR-1 已冻结）：不在集合内必须拒绝，不能按旧字段猜解析。
 */
export const CLOUD_SDK_SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [
  ...CLOUD_WIRE_PROTOCOL_SUPPORTED_VERSIONS,
];

export function assertSupportedCloudProtocolVersion(protocolVersion: number): void {
  if (isSupportedCloudWireProtocolVersion(protocolVersion)) return;
  throw cloudProtocolError(`cloud wire protocol version is not supported by this SDK`, {
    supportedProtocolVersions: [...CLOUD_WIRE_PROTOCOL_SUPPORTED_VERSIONS],
    receivedProtocolVersion: protocolVersion,
  });
}

// ── 校验入口 ──

interface CloudSchemaIssue {
  readonly path: readonly PropertyKey[];
  readonly code: string;
}

interface CloudSchemaIssueSource {
  readonly issues: readonly CloudSchemaIssue[];
}

type CloudParseResult =
  | { readonly success: true; readonly data: unknown }
  | { readonly success: false; readonly error: CloudSchemaIssueSource };

/** 每个 schema 最多上报的问题条数：details 有界（8 KiB，shared `responses.ts`）。 */
const MAX_REPORTED_ISSUES = 8;

/**
 * 只上报 issue 的 path/code，绝不上报收到的值：错误信封禁止携带正文或 secret
 * （03 §6 尾段、shared `CLOUD_ERROR_DETAILS_MAX_JSON_CHARS`）。
 */
function describeCloudSchemaIssues(error: CloudSchemaIssueSource): string[] {
  return error.issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => `${issue.path.map(String).join(".") || "<root>"}:${issue.code}`);
}

function safeParseAny(schema: { safeParse(input: unknown): unknown }, input: unknown) {
  return schema.safeParse(input) as CloudParseResult;
}

/** 端点响应校验：未知字段、缺字段、尺寸超限一律拒绝（shared 全部 `.strict()`）。 */
export function parseCloudResponse<K extends CloudSdkEndpointId>(
  endpointId: K,
  payload: unknown,
): CloudEndpointResponse<K> {
  const result = safeParseAny(CLOUD_SDK_ENDPOINT_SCHEMAS[endpointId].response, payload);
  if (!result.success) {
    throw cloudProtocolError(`cloud response for ${endpointId} does not match the frozen schema`, {
      endpointId,
      issues: describeCloudSchemaIssues(result.error),
    });
  }
  return result.data as CloudEndpointResponse<K>;
}

/**
 * 写请求体校验：在发出请求前拒绝非法字段，不把本地拼装的形状送到线上。
 * 请求形状违约算调用方校验失败（`validation_failed`，与服务端同类校验同码），
 * 响应违约才算 wire 协议不兼容（见 `parseCloudResponse`）。
 */
export function parseCloudRequestBody<K extends CloudWriteEndpointId>(
  endpointId: K,
  body: unknown,
): CloudEndpointRequestBody<K> {
  const result = safeParseAny(CLOUD_SDK_ENDPOINT_SCHEMAS[endpointId].request, body);
  if (!result.success) {
    throw cloudValidationError(
      `cloud request body for ${endpointId} does not match the frozen schema`,
      { endpointId, issues: describeCloudSchemaIssues(result.error) },
    );
  }
  return result.data as CloudEndpointRequestBody<K>;
}

/**
 * 任意冻结 schema 的解析入口（查询参数、订阅参数等）：调用方传入的值不合法时
 * 一律按调用方违约处理（`validation_failed`），不构造半合法形状。
 */
export function parseCloudValue<S extends { safeParse(input: unknown): unknown }>(
  schema: S,
  value: unknown,
  context: string,
): SchemaOutput<S> {
  const result = safeParseAny(schema, value);
  if (!result.success) {
    throw cloudValidationError(`cloud ${context} does not match the frozen schema`, {
      context,
      issues: describeCloudSchemaIssues(result.error),
    });
  }
  return result.data as SchemaOutput<S>;
}

// ── SDK 使用的冻结 query schema（GET 端点）──

export const CLOUD_SDK_QUERY_SCHEMAS = {
  list: cloudListQuerySchema,
  repositories: cloudRepositoriesQuerySchema,
  history: cloudHistoryQuerySchema,
  events: cloudTaskEventsQuerySchema,
  snapshot: cloudSnapshotQuerySchema,
} as const;

export type CloudSdkQuery = {
  readonly list: CloudListQuery;
  readonly repositories: CloudRepositoriesQuery;
  readonly history: CloudHistoryQuery;
  readonly events: CloudTaskEventsQuery;
  readonly snapshot: CloudSnapshotQuery;
};
