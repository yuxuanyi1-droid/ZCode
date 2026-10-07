/**
 * W4 GitHub / secret 用例的公共脚手架。
 *
 * 设计：在最外层注入 fake `fetch`（而不是替换 transport），这样 URL 构造、
 * Authorization 头、JSON 解析与错误归一都被真实执行（09 §8、01 §7.2）。
 * 本文件不是测试文件（不匹配 `*.test.ts`），仅供参考与断言复用。
 */
import { generateKeyPairSync } from "node:crypto";
import type { CloudAdapterLogger } from "../src/cloud/adapters/github/logging.js";
import { createGitHubTransport } from "../src/cloud/adapters/github/http.js";
import type { GitHubEffectStore } from "../src/cloud/app/ports/gitHubEffectPort.js";
import { createGitHubAdapter, type GitHubAdapter } from "../src/cloud/adapters/github/adapter.js";

export const TEST_APP_ID = 987654;
export const TEST_INSTALLATION_ID = 4242;
export const TEST_REPOSITORY_ID = 777;
export const TEST_PRINCIPAL_ID = "principal-1";
export const TEST_OWNER = "acme";
export const TEST_REPO = "repo";
export const TEST_API_BASE = "https://api.github.test";

export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body?: unknown;
}

export interface FakeResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** 触发网络层异常（超时/连接失败），用于 network_unknown 用例。 */
  throws?: Error;
}

export type FakeRouteHandler = (request: RecordedRequest) => FakeResponse;

/** 路由回包包装：手写 `{ body: ... }` 容易漏，统一走它。 */
export function respond(payload: unknown): FakeResponse {
  return { body: payload };
}

export interface FakeGitHub {
  fetchImpl: typeof globalThis.fetch;
  requests: RecordedRequest[];
  /** 注册路由：路径必须与适配层构造的路径完全一致（不含 query）。 */
  on(method: string, path: string, handler: FakeRouteHandler): void;
  /** 命中次数，便于断言「没有重复创建」这类行为。 */
  hits(method: string, path: string): number;
}

export function createFakeGitHub(): FakeGitHub {
  const routes = new Map<string, FakeRouteHandler>();
  const requests: RecordedRequest[] = [];
  const counts = new Map<string, number>();

  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const rawUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(init?.headers ?? {})) {
      headers[key.toLowerCase()] = String(value);
    }
    const recorded: RecordedRequest = {
      method,
      url: url.toString(),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers,
      body:
        typeof init?.body === "string" && init.body.length > 0
          ? (JSON.parse(init.body) as unknown)
          : undefined,
    };
    requests.push(recorded);
    const key = `${method} ${url.pathname}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const handler = routes.get(key);
    if (!handler) {
      return new Response(JSON.stringify({ message: `unexpected route: ${key}` }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    const result = handler(recorded);
    if (result.throws) throw result.throws;
    const status = result.status ?? 200;
    // 204/304 不允许带 body，Response 构造会抛错（会被误判成网络失败）。
    const body = status === 204 || status === 304 ? null : JSON.stringify(result.body ?? {});
    return new Response(body, {
      status,
      headers: { "content-type": "application/json", ...result.headers },
    });
  };

  return {
    fetchImpl,
    requests,
    on(method, path, handler) {
      routes.set(`${method.toUpperCase()} ${path}`, handler);
    },
    hits(method, path) {
      return counts.get(`${method.toUpperCase()} ${path}`) ?? 0;
    },
  };
}

/** 记录全部日志行；用于断言 token/私钥从不进日志（01 §7.2）。 */
export function createCapturingLogger(): { logger: CloudAdapterLogger; lines: string[] } {
  const lines: string[] = [];
  const push =
    (level: string) =>
    (traceId: string | undefined, ...args: unknown[]) => {
      lines.push(
        `${level} ${traceId ?? "-"} ${args
          .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
          .join(" ")}`,
      );
    };
  return {
    logger: {
      debug: push("debug"),
      info: push("info"),
      warn: push("warn"),
      error: push("error"),
    },
    lines,
  };
}

let cachedKeyPair: { privateKey: string; publicKey: string } | null = null;

/** 测试用 RSA 密钥对：运行时生成，避免把任何私钥材料提交进仓库。 */
export function testAppKeys(): { privateKey: string; publicKey: string } {
  if (!cachedKeyPair) {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2_048 });
    cachedKeyPair = {
      privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
      publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
  }
  return cachedKeyPair;
}

export function createTestTransport(fake: FakeGitHub, logger?: CloudAdapterLogger) {
  return createGitHubTransport({ fetchImpl: fake.fetchImpl, apiBaseUrl: TEST_API_BASE, logger });
}

/** 走真实组合（transport/appAuth/tokens/catalog/branches/pullRequests）的适配器。 */
export function createTestAdapter(options: {
  fake: FakeGitHub;
  logger?: CloudAdapterLogger;
  principalId?: string;
  allowedInstallationIds?: number[];
  allowedRepositoryIds?: number[];
  cacheTtlMs?: number;
  now?: () => number;
  effectStore?: GitHubEffectStore;
}): GitHubAdapter {
  return createGitHubAdapter({
    config: {
      principalId: options.principalId ?? TEST_PRINCIPAL_ID,
      appId: TEST_APP_ID,
      privateKeyPem: testAppKeys().privateKey,
      apiBaseUrl: TEST_API_BASE,
      allowedInstallationIds: options.allowedInstallationIds ?? [TEST_INSTALLATION_ID],
      allowedRepositoryIds: options.allowedRepositoryIds,
      cacheTtlMs: options.cacheTtlMs,
    },
    fetchImpl: options.fake.fetchImpl,
    logger: options.logger,
    now: options.now,
    effectStore: options.effectStore,
  });
}

// ── GitHub 响应构造 ──

export function installationTokenBody(request: {
  token: string;
  repositoryId: number;
  owner?: string;
  name?: string;
  permissions: Record<string, string>;
  expiresAt?: string;
}): unknown {
  return {
    token: request.token,
    expires_at: request.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString(),
    permissions: request.permissions,
    repository_selection: "selected",
    repositories: [
      {
        id: request.repositoryId,
        node_id: "R_node",
        name: request.name ?? "repo",
        full_name: `${request.owner ?? "acme"}/${request.name ?? "repo"}`,
        private: true,
        default_branch: "main",
        owner: { login: request.owner ?? "acme", id: 1, type: "Organization" },
      },
    ],
  };
}

export function repositoryBody(request: {
  id: number;
  owner?: string;
  name?: string;
  defaultBranch?: string;
}): unknown {
  return {
    id: request.id,
    node_id: `R_${request.id}`,
    name: request.name ?? "repo",
    full_name: `${request.owner ?? "acme"}/${request.name ?? "repo"}`,
    private: true,
    archived: false,
    default_branch: request.defaultBranch ?? "main",
    owner: { login: request.owner ?? "acme", id: 1, type: "Organization" },
  };
}

const MINT_PATH = `/app/installations/${TEST_INSTALLATION_ID}/access_tokens`;

/**
 * 装一个与 GitHub 行为一致的 mint 路由：按请求回显 repository_ids 与 permissions。
 * 需要模拟「GitHub 少给/多给权限」的用例再单独覆盖同一路由。
 */
export function installEchoMintRoute(fake: FakeGitHub, options?: { token?: string }): void {
  fake.on("POST", MINT_PATH, (request) => {
    const body = (request.body ?? {}) as {
      repository_ids?: number[];
      permissions?: Record<string, string>;
    };
    const ids = body.repository_ids ?? [TEST_REPOSITORY_ID];
    return respond({
      token: options?.token ?? "ghs_installation_token",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      permissions: body.permissions ?? {},
      repository_selection: "selected",
      repositories: ids.map((id) => repositoryBody({ id, name: `repo-${id}` })),
    });
  });
}

/** `GET /repositories/:id` 的权威事实路由（locate 用）。 */
export function installRepositoryRoute(
  fake: FakeGitHub,
  options?: { id?: number; name?: string; defaultBranch?: string },
): void {
  const id = options?.id ?? TEST_REPOSITORY_ID;
  fake.on("GET", `/repositories/${id}`, () =>
    respond(repositoryBody({ id, name: options?.name, defaultBranch: options?.defaultBranch })),
  );
}

export function branchBody(name: string, sha: string): unknown {
  return { name, commit: { sha }, protected: false };
}

export function compareBody(request: {
  status: "ahead" | "behind" | "diverged" | "identical";
  aheadBy?: number;
  behindBy?: number;
  mergeBaseSha?: string;
}): unknown {
  return {
    status: request.status,
    ahead_by: request.aheadBy ?? 0,
    behind_by: request.behindBy ?? 0,
    merge_base_commit: { sha: request.mergeBaseSha ?? "0".repeat(40) },
  };
}

export function pullRequestBody(request: {
  number: number;
  head: string;
  base: string;
  headSha?: string;
  state?: "open" | "closed";
  draft?: boolean;
  merged?: boolean;
  body?: string;
  url?: string;
}): unknown {
  return {
    number: request.number,
    node_id: `PR_${request.number}`,
    html_url: request.url ?? `https://github.com/acme/repo/pull/${request.number}`,
    state: request.state ?? "open",
    draft: request.draft ?? true,
    merged: request.merged ?? false,
    body: request.body ?? "",
    head: { ref: request.head, sha: request.headSha ?? "a".repeat(40) },
    base: { ref: request.base, sha: "b".repeat(40) },
  };
}

/** 便于构造带 Task 标记的 PR body（与生产 marker 格式一致）。 */
export function markerBody(taskId: string, managed = "status"): string {
  return [
    `<!-- zcode:task:${taskId} -->`,
    "<!-- zcode:managed:start -->",
    managed,
    "<!-- zcode:managed:end -->",
  ].join("\n");
}

export const TEST_TASK_ID = "11111111-2222-3333-4444-555555555555";
