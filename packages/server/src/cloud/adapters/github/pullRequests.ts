/**
 * draft PR 创建/更新/读取与对账（specs/cloud-agent/09 §5.1 无变更任务、
 * §5.2 外部幂等 effect、§5.3 follow-up 与外部修改、§4.1 head/base 语义）。
 *
 * 语义要点：
 * - head=taskBranch、base=baseBranch，两者必须不同；无差异时不建空 PR、不造空 commit。
 * - GitHub 没有通用幂等键：**先查后建**，422「已存在」先关联再复用，绝不删分支重试。
 * - PR body 只在受控标记段内改写，不覆盖用户手写内容；标记只用于对账，不当授权证明。
 * - PR 写操作只由控制面 effect worker 调用；沙箱不持 PR 写 token（09 §5.2 末段）。
 */
import type { PullRequestProjection } from "../../app/ports/gitHubPort.js";
import { CLOUD_ERROR_RETRYABLE, type CloudErrorCode } from "@zcode/shared";
import type { CloudAdapterLogger } from "./logging.js";
import { GitHubApiError, expectOk, type GitHubTransport } from "./http.js";
import type { GitHubRepositoryCatalog } from "./repositories.js";
import type { GitHubRepositoryFacts } from "./appAuth.js";
import { asRecord, readBooleanOr, readNumber, readRecord, readString } from "./parse.js";

/** 任务标记：只用于把 PR 对回 Task，不代表任何权限（09 §5.2 第 5 条）。 */
const TASK_MARKER_PATTERN =
  /<!--\s*zcode:task:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*-->/;
const MANAGED_START = "<!-- zcode:managed:start -->";
const MANAGED_END = "<!-- zcode:managed:end -->";
/** 受控段标记：对账与测试共用；不含 token，也不代表任何授权（09 §5.2 第 5 条）。 */
export const MANAGED_SECTION_MARKERS = { start: MANAGED_START, end: MANAGED_END } as const;
/** GitHub PR body 上限 65536；受控段留足空间，超出时截断而不是拒绝发布（09 §5.2 第 3 条）。 */
const MAX_BODY_CHARS = 60_000;
const MAX_MANAGED_CHARS = 16_000;

export type DraftPullRequestResult =
  | { kind: "created"; pullRequest: PullRequestProjection }
  | { kind: "existing"; pullRequest: PullRequestProjection }
  | { kind: "no-changes" };

export interface ParsedPullRequest {
  projection: PullRequestProjection;
  body: string;
  nodeId: string;
}

export function renderTaskMarker(taskId: string): string {
  return `<!-- zcode:task:${taskId} -->`;
}

/** 只认 UUID 形态 payload，避免把用户正文里的相似文本当成自己的 PR（09 §5.2 第 5 条）。 */
export function readTaskMarker(body: string | undefined): string | null {
  if (!body) return null;
  return TASK_MARKER_PATTERN.exec(body)?.[1] ?? null;
}

/** 受控状态段：任务链接与摘要，不含 prompt、secret、私有日志（09 §5.2 第 3 条）。 */
export function renderManagedSection(request: { taskId: string; managed: string }): string {
  const managed = request.managed.slice(0, MAX_MANAGED_CHARS);
  return [renderTaskMarker(request.taskId), MANAGED_START, managed.trim(), MANAGED_END].join("\n");
}

/**
 * 合并受控段：受控区域 = 任务标记行 + 受控段标记之间的内容，整块替换；
 * 结构被破坏（只有起始标记、没有结束标记）时追加到末尾，绝不删除用户正文
 * （09 §5.2 第 6 条「不覆盖用户手写内容」）。
 */
export function mergeManagedSection(request: { existingBody: string; section: string }): string {
  const existing = request.existingBody;
  const markerIndex = existing.search(TASK_MARKER_PATTERN);
  const sectionStart = existing.indexOf(MANAGED_START);
  const candidates = [markerIndex, sectionStart].filter((index) => index >= 0);
  const startIndex = candidates.length > 0 ? Math.min(...candidates) : -1;
  const endIndex = startIndex < 0 ? -1 : existing.indexOf(MANAGED_END, startIndex);
  let merged: string;
  if (startIndex >= 0 && endIndex > startIndex) {
    merged =
      existing.slice(0, startIndex) +
      request.section +
      existing.slice(endIndex + MANAGED_END.length);
  } else if (existing.trim().length === 0) {
    merged = request.section;
  } else {
    merged = `${existing.trimEnd()}\n\n${request.section}`;
  }
  return merged.length > MAX_BODY_CHARS ? merged.slice(0, MAX_BODY_CHARS) : merged;
}

export interface GitHubPullRequestService {
  getPullRequest(request: {
    repositoryId: number;
    prNumber: number;
    traceId?: string;
  }): Promise<PullRequestProjection | null>;
  /** 按 head/base 查询本 Task 的 PR（创建响应丢失后的对账入口，09 §5.2 第 4 条）。 */
  findTaskPullRequest(request: {
    repositoryId: number;
    taskId: string;
    head: string;
    base: string;
    traceId?: string;
  }): Promise<PullRequestProjection | null>;
  createDraftPullRequest(request: {
    repositoryId: number;
    taskId: string;
    head: string;
    base: string;
    title: string;
    managed: string;
    traceId?: string;
  }): Promise<DraftPullRequestResult>;
  /** 受控段更新（desiredRevision 合并由调用方裁决，本层只保证不覆盖用户内容）。 */
  updateManagedBody(request: {
    repositoryId: number;
    taskId: string;
    prNumber: number;
    managed: string;
    title?: string;
    traceId?: string;
  }): Promise<PullRequestProjection>;
}

function prError(code: CloudErrorCode, message: string, status?: number): GitHubApiError {
  return new GitHubApiError({ code, retryable: CLOUD_ERROR_RETRYABLE[code], status, message });
}

function parsePullRequest(
  raw: unknown,
  repositoryId: number,
  now: number,
): ParsedPullRequest | null {
  const record = asRecord(raw);
  const number = readNumber(record, "number");
  const headRef = readString(readRecord(record, "head"), "ref");
  const baseRef = readString(readRecord(record, "base"), "ref");
  const url = readString(record, "html_url");
  if (!record || number === null || !headRef || !baseRef || !url) return null;
  const merged = readBooleanOr(record, "merged", false);
  const state = readString(record, "state") ?? "open";
  const draft = readBooleanOr(record, "draft", false);
  return {
    projection: {
      repositoryId,
      prNumber: number,
      prUrl: url,
      head: headRef,
      base: baseRef,
      status: merged ? "merged" : state === "closed" ? "closed" : draft ? "draft" : "open",
      // head SHA 是 GitHub 当前事实；不是「已确认 checkpoint」的替代（08 §2 分别投影）。
      publishedSha: readString(readRecord(record, "head"), "sha") ?? undefined,
      lastCheckedAt: now,
    },
    body: readString(record, "body") ?? "",
    nodeId: readString(record, "node_id") ?? "",
  };
}

export function createGitHubPullRequestService(deps: {
  transport: GitHubTransport;
  catalog: GitHubRepositoryCatalog;
  now?: () => number;
  logger?: CloudAdapterLogger;
}): GitHubPullRequestService {
  const now = deps.now ?? Date.now;

  async function requireFacts(
    repositoryId: number,
    traceId?: string,
  ): Promise<GitHubRepositoryFacts> {
    const facts = await deps.catalog.locate(repositoryId, traceId);
    if (!facts) throw prError("repo_not_found", "repository is not accessible through this app");
    return facts;
  }

  async function writeToken(
    repositoryId: number,
    facts: GitHubRepositoryFacts,
    traceId?: string,
  ): Promise<string> {
    const token = await deps.catalog.mintForPurpose({
      repositoryId,
      installationId: facts.installationId,
      purpose: "pull-request",
      traceId,
    });
    return token.token;
  }

  function repoBase(facts: GitHubRepositoryFacts): string {
    return `/repos/${encodeURIComponent(facts.owner)}/${encodeURIComponent(facts.name)}`;
  }

  async function readPullRequest(
    repositoryId: number,
    prNumber: number,
    traceId?: string,
  ): Promise<ParsedPullRequest | null> {
    const facts = await requireFacts(repositoryId, traceId);
    const token = await writeToken(repositoryId, facts, traceId);
    const response = await deps.transport.send<unknown>({
      method: "GET",
      path: `${repoBase(facts)}/pulls/${prNumber}`,
      credential: { kind: "installation-token", token },
      traceId,
    });
    if (response.status === 404) return null;
    const parsed = parsePullRequest(expectOk(response, "read pull request"), repositoryId, now());
    if (!parsed) throw prError("validation_failed", "pull request response is malformed");
    return parsed;
  }

  /**
   * 按 head/base 查询候选，再按受控标记过滤：第三方 PR / fork PR 不借用 Task 身份
   * （09 §5.3）。找不到标记匹配时返回 null，绝不复用别人的 PR。
   */
  async function findTaskPullRequest(request: {
    repositoryId: number;
    taskId: string;
    head: string;
    base: string;
    traceId?: string;
  }): Promise<ParsedPullRequest | null> {
    const facts = await requireFacts(request.repositoryId, request.traceId);
    const token = await writeToken(request.repositoryId, facts, request.traceId);
    const response = await deps.transport.send<unknown>({
      method: "GET",
      path: `${repoBase(facts)}/pulls`,
      credential: { kind: "installation-token", token },
      query: {
        state: "all",
        head: `${facts.owner}:${request.head}`,
        base: request.base,
        per_page: 50,
      },
      traceId: request.traceId,
    });
    // `/pulls` 返回数组而不是对象：直接按数组解析，畸形元素逐条跳过。
    const payload = expectOk(response, "list pull requests");
    if (!Array.isArray(payload)) {
      throw prError("validation_failed", "pull request list response is not an array");
    }
    for (const raw of payload) {
      const parsed = parsePullRequest(raw, request.repositoryId, now());
      if (!parsed) continue;
      if (parsed.projection.head !== request.head) continue;
      if (readTaskMarker(parsed.body) !== request.taskId) continue;
      return parsed;
    }
    return null;
  }

  async function create(request: {
    repositoryId: number;
    taskId: string;
    head: string;
    base: string;
    title: string;
    managed: string;
    traceId?: string;
  }): Promise<DraftPullRequestResult> {
    if (request.head === request.base) {
      // head/base 必须不同：任务分支不是 PR base（09 §4.1）。
      throw prError("branch_conflict", "pull request head and base must differ");
    }
    const facts = await requireFacts(request.repositoryId, request.traceId);
    const token = await writeToken(request.repositoryId, facts, request.traceId);
    const response = await deps.transport.send<unknown>({
      method: "POST",
      path: `${repoBase(facts)}/pulls`,
      credential: { kind: "installation-token", token },
      body: {
        title: request.title,
        head: request.head,
        base: request.base,
        draft: true,
        body: renderManagedSection({ taskId: request.taskId, managed: request.managed }),
      },
      traceId: request.traceId,
    });

    if (response.ok) {
      const parsed = parsePullRequest(response.body, request.repositoryId, now());
      if (!parsed) throw prError("validation_failed", "created pull request response is malformed");
      return { kind: "created", pullRequest: parsed.projection };
    }

    const failure = response.failure!;
    if (response.status === 422) {
      const message = failure.message.toLowerCase();
      if (message.includes("no commits between")) {
        // 无差异：结束为 noChanges，不建空 PR、不造空 commit（09 §5.1）。
        return { kind: "no-changes" };
      }
      // 422「已存在」必须先查再关联，不允许删分支或改 head 重试（09 §8 末段）。
      const existing = await findTaskPullRequest(request);
      if (existing) return { kind: "existing", pullRequest: existing.projection };
      throw prError("branch_conflict", `pull request was rejected: ${failure.message}`, 422);
    }

    if (failure.code === "network_unknown") {
      // 创建结果未知：先按 head+marker 对账；查到就关联，查不到才把「未知」上抛给 outbox
      // （09 §5.2 第 4 条：不直接重复创建）。
      const existing = await findTaskPullRequest(request);
      if (existing) return { kind: "existing", pullRequest: existing.projection };
    }
    throw new GitHubApiError(failure);
  }

  return {
    async getPullRequest({ repositoryId, prNumber, traceId }) {
      const parsed = await readPullRequest(repositoryId, prNumber, traceId);
      return parsed?.projection ?? null;
    },

    async findTaskPullRequest(request) {
      const parsed = await findTaskPullRequest(request);
      return parsed?.projection ?? null;
    },

    createDraftPullRequest: create,

    async updateManagedBody({ repositoryId, taskId, prNumber, managed, title, traceId }) {
      const current = await readPullRequest(repositoryId, prNumber, traceId);
      if (!current) throw prError("not_found", "pull request not found");
      const owner = readTaskMarker(current.body);
      if (owner !== null && owner !== taskId) {
        throw prError("validation_failed", "pull request belongs to a different task");
      }
      const merged = mergeManagedSection({
        existingBody: current.body,
        section: renderManagedSection({ taskId, managed }),
      });
      if (merged === current.body && title === undefined) return current.projection;
      const facts = await requireFacts(repositoryId, traceId);
      const token = await writeToken(repositoryId, facts, traceId);
      const response = await deps.transport.send<unknown>({
        method: "PATCH",
        path: `${repoBase(facts)}/pulls/${prNumber}`,
        credential: { kind: "installation-token", token },
        body: { body: merged, ...(title === undefined ? {} : { title }) },
        traceId,
      });
      const parsed = parsePullRequest(
        expectOk(response, "update pull request"),
        repositoryId,
        now(),
      );
      if (!parsed) throw prError("validation_failed", "updated pull request response is malformed");
      return parsed.projection;
    },
  };
}
