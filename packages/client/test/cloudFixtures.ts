/**
 * W7 SDK 用例的 fixture（specs/cloud-agent/W7 §6）：一个按冻结端点表路由的假控制面。
 *
 * 只做两件事：按 `CLOUD_HTTP_ENDPOINTS` 的方法/路径分发并记录请求；返回严格合法或
 * 刻意畸形的响应。这里不复制 shared 的字段名——响应体由下面这些 builder 构造，
 * 字段名对齐 shared schema（round-trip 由被测 SDK 的 schema 校验负责证伪）。
 */
import {
  CLOUD_HTTP_ENDPOINTS,
  CLOUD_WIRE_PROTOCOL_VERSION,
  findCloudHttpEndpoint,
} from "@zcode/shared";
import type { CloudFetchLike } from "../src/cloud/cloudHttpTransport.js";
import type { CloudSdkEndpointId } from "../src/cloud/cloudWireSchemas.js";

export const PRINCIPAL_ID = "9a1c2d3e-4f50-4a61-8b72-c3d4e5f60718";
export const PROJECT_ID = "3d9a1b7c-5e42-4a63-8f10-9b2c3d4e5f60";
export const TASK_ID = "8f14e45f-ceea-467a-9a1e-1f0d3b2a4c51";
export const RUN_ID = "1c8e4a02-3b7d-4f61-9a2e-5d7c8b9a0f13";
export const COMMAND_ID = "2b7f5c1a-9d3e-4f8a-b1c2-d3e4f5a6b7c8";
export const COMMAND_ID_2 = "5f2c3d4e-7a96-4c85-8d32-be4f5a6b7c82";
export const OPERATION_ID = "4e1b2c3d-6f85-4b74-9c21-ad3e4f5a6b71";

const EPOCH_MS = 1_700_000_000_000;
const SHA = "b".repeat(40);

/**
 * task detail 的能力投影（04 §3.3）：取值取自契约枚举 `CLOUD_TASK_ACTIONS`。
 * 故意选一组「与 fixture 的 draft 状态不对应」的动作，用来证明 SDK 只做原样透传——
 * 若哪天 SDK/上层开始按状态补全或裁剪，用它写成的用例会失败（见 cloudSdk.test.ts）。
 */
const FIXTURE_TASK_ACTIONS = ["send-input", "stop", "restore"];

// ── 响应 builder ──

export function cloudTaskRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: TASK_ID,
    ownerPrincipalId: PRINCIPAL_ID,
    projectId: PROJECT_ID,
    title: "示例任务",
    status: "draft",
    creationKey: "task-key-1",
    workspaceIdentity: `cloud-task:${TASK_ID}`,
    nextRunGeneration: 1,
    revision: 0,
    createdAt: EPOCH_MS,
    updatedAt: EPOCH_MS,
    ...overrides,
  };
}

export function cloudRunRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: RUN_ID,
    taskId: TASK_ID,
    runGeneration: 1,
    executionKind: "sandbox",
    provider: "e2b",
    workspacePath: "/workspace/task",
    status: "ready",
    connectionEpoch: 1,
    dataAtRisk: false,
    createdAt: EPOCH_MS,
    updatedAt: EPOCH_MS,
    ...overrides,
  };
}

export function cloudProjectRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    projectId: PROJECT_ID,
    ownerPrincipalId: PRINCIPAL_ID,
    kind: "github-repo",
    repositoryId: 42,
    installationId: 7,
    repoOwner: "example",
    repoName: "repo",
    revision: 0,
    createdAt: EPOCH_MS,
    updatedAt: EPOCH_MS,
    ...overrides,
  };
}

export function inputReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: TASK_ID,
    commandId: COMMAND_ID,
    deliveryStatus: "accepted",
    ...overrides,
  };
}

export function errorEnvelope(
  code: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    code,
    message: `fixture code=${code}`,
    retryable: code === "rate_limited" || code === "network_unknown",
    traceId: "trace-fixture-1",
    ...overrides,
  };
}

/**
 * 每个 SDK 端点 id 对应的标准成功响应（正常路径 round-trip 用）。
 * 返回值按冻结 schema 手工维护：字段增删只能在这里发生，由
 * `cloudSdk.test.ts` 的「fixture 必须满足冻结 schema」用例逐个端点把关。
 */
export function cloudEndpointPayload(endpointId: CloudSdkEndpointId): Record<string, unknown> {
  switch (endpointId) {
    case "capabilities":
      return {
        mode: "cloud",
        // 主体 id 已由 W0 冻结进 capabilitiesResponseSchema（客户端 scope 隔离键，非凭据）。
        principalId: PRINCIPAL_ID,
        providers: [],
        features: ["durable-input", "replayable-history"],
        protocolVersion: CLOUD_WIRE_PROTOCOL_VERSION,
        taskOwnedAttachments: false,
      };
    case "repositories":
      return {
        items: [
          {
            repositoryId: 42,
            installationId: 7,
            owner: "example",
            name: "repo",
            availability: "available",
          },
        ],
      };
    case "repositoryBranches":
      return { items: [{ name: "main", sha: SHA, isDefault: true }] };
    case "listProjects":
      return { items: [cloudProjectRecord()] };
    case "createProject":
    case "patchProject":
      return cloudProjectRecord();
    case "deleteProject":
      return { deleted: true };
    case "projectTasks":
      return { items: [cloudTaskRecord()] };
    case "createTask":
    case "patchTask":
      return cloudTaskRecord();
    case "taskDetail":
    case "reopenTask":
    case "stopTask":
    case "forceStopTask":
    case "completeTask":
    case "archiveTask":
    case "reactivateTask":
    case "restoreTask":
      // actions 是 taskDetailResponseSchema 的必填项（04 §3.3 服务端裁决的能力投影）。
      return {
        task: cloudTaskRecord(),
        activeRun: cloudRunRecord(),
        actions: FIXTURE_TASK_ACTIONS,
      };
    case "submitInput":
    case "getInput":
    case "cancelInput":
      return inputReceipt();
    case "listInputs":
      return { items: [] };
    case "extendTask":
      return { extended: true, expiresAt: EPOCH_MS + 60_000, deadlineConfidence: "high" };
    case "taskHistory":
      return {
        items: [
          {
            topic: "conversation",
            logEpoch: "epoch-1",
            seq: 0,
            kind: "snapshot",
            payload: { summary: "fixture" },
            ts: EPOCH_MS,
          },
        ],
        nextCursor: "epoch-1:0",
      };
    case "taskEvents":
      return { items: [], timedOut: true };
    case "taskSnapshot":
      return {
        taskId: TASK_ID,
        topic: "conversation",
        logEpoch: "epoch-1",
        coveredSourceSeq: 0,
        snapshot: {},
        createdAt: EPOCH_MS,
      };
    case "uploadAttachment":
      return {
        attachmentId: "att-1",
        fileName: "note.txt",
        mime: "text/plain",
        bytes: 12,
        createdAt: EPOCH_MS,
      };
  }
}

/** 在标准 fixture 上改写字段（畸形/边界用例）；合并只发生在 fixture 内部。 */
export function cloudEndpointPayloadWith(
  endpointId: CloudSdkEndpointId,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return { ...cloudEndpointPayload(endpointId), ...overrides };
}

/** 给任意响应对象加一个未知字段（用于「未知字段必须被拒绝」用例）。 */
export function withUnknownField(payload: unknown): unknown {
  return typeof payload === "object" && payload !== null
    ? { ...(payload as Record<string, unknown>), unexpectedField: "x" }
    : payload;
}

// ── 假控制面 ──

export interface RecordedCloudRequest {
  readonly method: string;
  readonly url: string;
  readonly pathname: string;
  readonly search: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly credentials: string | undefined;
  readonly aborted: boolean;
}

export interface CloudFixtureResponse {
  readonly status?: number;
  readonly body?: unknown;
  /** 延迟返回（配合短超时验证传输超时）。 */
  readonly delayMs?: number;
}

export interface CloudFixtureRouteContext {
  readonly url: URL;
  readonly request: RecordedCloudRequest;
}

export type CloudFixtureRoute = (
  context: CloudFixtureRouteContext,
) => CloudFixtureResponse | undefined;

export interface CloudFixtureServerOptions {
  /** 端点 id → 处理器；未命中的端点按缺口返回 not_found。 */
  readonly handlers?: Partial<Record<CloudSdkEndpointId, CloudFixtureRoute>>;
  /** 全局响应改写（用于注入未知字段等畸形态）。 */
  readonly transform?: (payload: unknown, endpointId: string) => unknown;
  /** 把每次成功响应替换成该错误信封（用于逐端点错误路径）。 */
  readonly errorOverride?: Record<string, unknown>;
  readonly errorStatus?: number;
}

export interface CloudFixtureServer {
  readonly fetch: CloudFetchLike;
  readonly requests: RecordedCloudRequest[];
  /** 记录到的端点 id（按请求顺序）。 */
  readonly endpointIds: string[];
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (headers === undefined) return result;
  new Headers(headers).forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });
  return result;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function delay(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort);
  });
}

function endpointIdForPath(pathname: string, method: string): string | undefined {
  // 只按冻结矩阵反查：把 :param 段归一成模板再比较，方法也必须一致（GET/POST 同路径）。
  const segments = pathname.split("/");
  for (const descriptor of CLOUD_HTTP_ENDPOINTS) {
    if (descriptor.method !== method) continue;
    const templateSegments = descriptor.path.split("/");
    if (templateSegments.length !== segments.length) continue;
    if (
      templateSegments.every(
        (segment, index) => segment.startsWith(":") || segment === segments[index],
      )
    ) {
      return descriptor.id;
    }
  }
  return undefined;
}

export function createCloudFixtureServer(
  options: CloudFixtureServerOptions = {},
): CloudFixtureServer {
  const requests: RecordedCloudRequest[] = [];
  const endpointIds: string[] = [];

  const fetchImpl: CloudFetchLike = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
    );
    const method = init?.method ?? "GET";
    const headers = normalizeHeaders(init?.headers);
    const rawBody = init?.body;
    const endpointId = endpointIdForPath(url.pathname, method);
    let body: unknown;
    if (typeof rawBody === "string") {
      try {
        body = JSON.parse(rawBody) as unknown;
      } catch {
        body = rawBody;
      }
    } else {
      body = rawBody;
    }
    const recorded: RecordedCloudRequest = {
      method,
      url: url.toString(),
      pathname: url.pathname,
      search: url.search,
      headers,
      body,
      credentials: init?.credentials,
      aborted: init?.signal?.aborted ?? false,
    };
    requests.push(recorded);
    if (endpointId !== undefined) endpointIds.push(endpointId);

    if (endpointId === undefined) {
      return jsonResponse(errorEnvelope("not_found"), 404);
    }
    const descriptor = findCloudHttpEndpoint(endpointId);
    if (descriptor !== undefined && descriptor.method !== method) {
      return jsonResponse(errorEnvelope("not_found", { message: "method mismatch" }), 404);
    }

    const handler = options.handlers?.[endpointId as CloudSdkEndpointId];
    let response = handler?.({ url, request: recorded }) ?? {
      status: 200,
      body: cloudEndpointPayload(endpointId as CloudSdkEndpointId),
    };

    if (response.delayMs !== undefined) {
      await delay(response.delayMs, init?.signal);
    }
    if (options.errorOverride !== undefined) {
      response = { status: options.errorStatus ?? 409, body: options.errorOverride };
    }
    const payload =
      options.transform === undefined
        ? response.body
        : options.transform(response.body, endpointId);
    return jsonResponse(payload, response.status ?? 200);
  };

  return { fetch: fetchImpl, requests, endpointIds };
}
