/**
 * refs 读取、baseSha 冻结与 taskBranch 核验（specs/cloud-agent/09 §4.1 不可变基线、
 * §4.2 单活 writer、§5.3 外部修改对账、01 §7.2「clone 以冻结 SHA checkout」）。
 *
 * 语义要点：
 * - baseSha 在首次输入接纳时冻结，之后不再解析 HEAD；对象不可获取时明确失败，
 *   不换新基线、不回落当前默认分支（09 §4.1、01 §7.3）。
 * - taskBranch 被外部改写（force push）时是 non_fast_forward 冲突：暂停发布、
 *   保留 workspace，不通过重试覆盖（09 §4.1）；只能核对事实，不能自动恢复。
 */
import type { BranchHead } from "../../app/ports/gitHubPort.js";
import { CLOUD_ERROR_RETRYABLE, type CloudErrorCode } from "@zcode/shared";
import type { CloudAdapterLogger } from "./logging.js";
import { GitHubApiError, expectOk, type GitHubTransport } from "./http.js";
import type { GitHubRepositoryCatalog } from "./repositories.js";
import type { GitHubRepositoryFacts } from "./appAuth.js";
import { asRecord, readNumber, readRecord, readString } from "./parse.js";

export interface GitHubRefComparison {
  status: "ahead" | "behind" | "diverged" | "identical" | "unknown";
  aheadBy: number;
  behindBy: number;
  mergeBaseSha?: string;
}

/** expectedSha 与远端 taskBranch 的关系；missing/rewound/diverged 都不能自动恢复。 */
export type GitHubBranchRelation = "identical" | "advanced" | "rewound" | "diverged" | "missing";

export interface GitHubBranchVerification {
  relation: GitHubBranchRelation;
  headSha?: string;
  comparison?: GitHubRefComparison;
}

export interface GitHubBranchListItem {
  name: string;
  sha: string;
  /** 由权威仓库事实的 default_branch 比对得出（11 §4.3），不采信请求参数。 */
  isDefault: boolean;
}

/** 与 `cloudBranchPageSchema` 同形：cursor 分页信封，末页不带 nextCursor。 */
export interface GitHubBranchListPage {
  items: GitHubBranchListItem[];
  nextCursor?: string;
}

export interface GitHubBranchService {
  /** 端口语义：null = 仓库不可解析；分支不存在用 exists:false 表达（09 §4.1）。 */
  getBranchHead(request: {
    repositoryId: number;
    branch: string;
    traceId?: string;
  }): Promise<BranchHead | null>;
  /**
   * 分支枚举（03 §6 `GET /api/cloud/repositories/:repoId/branches`）：
   * 按 page 型游标分页，末页如实不返回 nextCursor；空仓库返回空数组而不是错误。
   */
  listBranches(request: {
    repositoryId: number;
    cursor?: string;
    limit: number;
    traceId?: string;
  }): Promise<GitHubBranchListPage>;
  /** 冻结候选：解析 base 分支 HEAD，并按可选校验确认对象可获取（11 §6）。 */
  resolveBaseSha(request: {
    repositoryId: number;
    baseBranch: string;
    traceId?: string;
  }): Promise<{ baseBranch: string; sha: string }>;
  /** 基线对象是否仍可获取；不可获取时调用方必须明确失败而不是换基线（09 §4.1）。 */
  isCommitFetchable(request: {
    repositoryId: number;
    sha: string;
    traceId?: string;
  }): Promise<boolean>;
  compare(request: {
    repositoryId: number;
    base: string;
    head: string;
    traceId?: string;
  }): Promise<GitHubRefComparison>;
  /** from 是否为 to 的祖先（fast-forward 关系）。 */
  isFastForward(request: {
    repositoryId: number;
    from: string;
    to: string;
    traceId?: string;
  }): Promise<boolean>;
  /** 发布前核验 taskBranch 未漂移（09 §5.2 第 1/2 条、§5.3）。 */
  verifyTaskBranch(request: {
    repositoryId: number;
    branch: string;
    expectedSha: string;
    traceId?: string;
  }): Promise<GitHubBranchVerification>;
}

function branchError(code: CloudErrorCode, message: string, status?: number): GitHubApiError {
  return new GitHubApiError({ code, retryable: CLOUD_ERROR_RETRYABLE[code], status, message });
}

/** GitHub `per_page` 上限 100：请求更大批量没有意义，会静默截断成两页语义。 */
const BRANCH_PAGE_SIZE_MAX = 100;
/** `cloudBranchRecordSchema` 的 name 上限；超出的条目无法进入冻结 wire schema，跳过。 */
const BRANCH_NAME_MAX = 256;
const GIT_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function encodeBranchCursor(page: number): string {
  return Buffer.from(JSON.stringify({ v: 1, p: page }), "utf8").toString("base64url");
}

function decodeBranchCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 1;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      v?: unknown;
      p?: unknown;
    };
    const page = parsed.p;
    if (parsed.v !== 1 || typeof page !== "number" || !Number.isInteger(page) || page < 1) {
      throw new Error("bad cursor shape");
    }
    return page;
  } catch {
    throw branchError("validation_failed", "invalid branch cursor");
  }
}

/** 有下一页才算：GitHub 的 Link rel="next" 是权威依据，不按「取满一页」猜（否则末页会回假游标）。 */
function hasNextPage(link: string | undefined): boolean {
  return link !== undefined && /rel="next"/.test(link);
}

function parseBranchListItem(raw: unknown, defaultBranch: string): GitHubBranchListItem | null {
  const record = asRecord(raw);
  const name = readString(record, "name");
  const sha = readString(readRecord(record, "commit"), "sha");
  // 畸形条目跳过：宁可少列一条，也不把进不了冻结 wire schema 的数据抛给上层。
  if (!name || name.length > BRANCH_NAME_MAX || !sha || !GIT_OBJECT_ID.test(sha)) return null;
  return { name, sha, isDefault: defaultBranch.length > 0 && name === defaultBranch };
}

export function createGitHubBranchService(deps: {
  transport: GitHubTransport;
  catalog: GitHubRepositoryCatalog;
  logger?: CloudAdapterLogger;
}): GitHubBranchService {
  async function requireFacts(
    repositoryId: number,
    traceId?: string,
  ): Promise<GitHubRepositoryFacts> {
    const facts = await deps.catalog.locate(repositoryId, traceId);
    if (!facts) {
      // 不区分「不存在」与「无权限」（09 §8）。
      throw branchError("repo_not_found", "repository is not accessible through this app");
    }
    return facts;
  }

  async function contentsToken(
    repositoryId: number,
    facts: GitHubRepositoryFacts,
    traceId?: string,
  ): Promise<string> {
    const token = await deps.catalog.mintForPurpose({
      repositoryId,
      installationId: facts.installationId,
      purpose: "clone",
      traceId,
    });
    return token.token;
  }

  function repoBase(facts: GitHubRepositoryFacts): string {
    return `/repos/${encodeURIComponent(facts.owner)}/${encodeURIComponent(facts.name)}`;
  }

  async function readBranch(
    repositoryId: number,
    branch: string,
    traceId?: string,
  ): Promise<{ facts: GitHubRepositoryFacts; head: BranchHead } | null> {
    const facts = await requireFacts(repositoryId, traceId);
    const token = await contentsToken(repositoryId, facts, traceId);
    const response = await deps.transport.send<unknown>({
      method: "GET",
      path: `${repoBase(facts)}/branches/${encodeURIComponent(branch)}`,
      credential: { kind: "installation-token", token },
      traceId,
    });
    if (response.status === 404) {
      return { facts, head: { name: branch, sha: "", exists: false } };
    }
    const body = expectOk(response, "read branch");
    const sha = readString(readRecord(asRecord(body), "commit"), "sha");
    if (!sha) throw branchError("validation_failed", "branch response missing commit sha");
    return { facts, head: { name: branch, sha, exists: true } };
  }

  async function compareRefs(
    repositoryId: number,
    base: string,
    head: string,
    traceId?: string,
  ): Promise<GitHubRefComparison> {
    const facts = await requireFacts(repositoryId, traceId);
    const token = await contentsToken(repositoryId, facts, traceId);
    const response = await deps.transport.send<unknown>({
      method: "GET",
      path: `${repoBase(facts)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
      credential: { kind: "installation-token", token },
      traceId,
    });
    const body = expectOk(response, "compare refs");
    const status = readString(asRecord(body), "status");
    return {
      status:
        status === "ahead" || status === "behind" || status === "diverged" || status === "identical"
          ? status
          : "unknown",
      aheadBy: readNumber(asRecord(body), "ahead_by") ?? 0,
      behindBy: readNumber(asRecord(body), "behind_by") ?? 0,
      mergeBaseSha: readString(readRecord(asRecord(body), "merge_base_commit"), "sha") ?? undefined,
    };
  }

  return {
    async getBranchHead({ repositoryId, branch, traceId }) {
      const result = await readBranch(repositoryId, branch, traceId);
      return result?.head ?? null;
    },

    async listBranches({ repositoryId, cursor, limit, traceId }) {
      const facts = await requireFacts(repositoryId, traceId);
      const page = decodeBranchCursor(cursor);
      const perPage = Math.max(1, Math.min(Math.trunc(limit), BRANCH_PAGE_SIZE_MAX));
      const token = await contentsToken(repositoryId, facts, traceId);
      const response = await deps.transport.send<unknown>({
        method: "GET",
        path: `${repoBase(facts)}/branches`,
        credential: { kind: "installation-token", token },
        query: { per_page: perPage, page },
        traceId,
      });
      // 空仓库：GitHub 对无提交仓库回 409「Git Repository is empty」——是空列表不是错误。
      if (response.status === 409) return { items: [] };
      const payload = expectOk(response, "list branches");
      if (!Array.isArray(payload)) {
        throw branchError("validation_failed", "branch list response is not an array");
      }
      const items: GitHubBranchListItem[] = [];
      for (const raw of payload) {
        const parsed = parseBranchListItem(raw, facts.defaultBranch);
        if (parsed) items.push(parsed);
      }
      return hasNextPage(response.link)
        ? { items, nextCursor: encodeBranchCursor(page + 1) }
        : { items };
    },

    async resolveBaseSha({ repositoryId, baseBranch, traceId }) {
      const result = await readBranch(repositoryId, baseBranch, traceId);
      if (!result)
        throw branchError("repo_not_found", "repository is not accessible through this app");
      if (!result.head.exists) {
        // base 改名/删除必须显式失败，不能默默换基线（09 §4.1）。
        throw branchError("branch_conflict", `base branch ${baseBranch} does not exist`);
      }
      return { baseBranch, sha: result.head.sha };
    },

    async isCommitFetchable({ repositoryId, sha, traceId }) {
      const facts = await requireFacts(repositoryId, traceId);
      const token = await contentsToken(repositoryId, facts, traceId);
      const response = await deps.transport.send<unknown>({
        method: "GET",
        path: `${repoBase(facts)}/commits/${encodeURIComponent(sha)}`,
        credential: { kind: "installation-token", token },
        traceId,
      });
      if (response.status === 404 || response.status === 422) return false;
      expectOk(response, "read commit");
      return true;
    },

    compare: ({ repositoryId, base, head, traceId }) =>
      compareRefs(repositoryId, base, head, traceId),

    async isFastForward({ repositoryId, from, to, traceId }) {
      if (from === to) return true;
      const comparison = await compareRefs(repositoryId, from, to, traceId);
      // compare(from...to)=ahead 表示 to 在 from 之上追加；behind/diverged 都不是快进。
      return comparison.status === "ahead" || comparison.status === "identical";
    },

    async verifyTaskBranch({ repositoryId, branch, expectedSha, traceId }) {
      const result = await readBranch(repositoryId, branch, traceId);
      if (!result || !result.head.exists) return { relation: "missing" };
      const headSha = result.head.sha;
      if (headSha === expectedSha) {
        return { relation: "identical", headSha };
      }
      // expectedSha 是 head 的祖先 → 远端在其上追加（外部 push 对账）；
      // head 是 expectedSha 的祖先（behind）/ 分叉（diverged）→ 分支被改写。
      const comparison = await compareRefs(repositoryId, expectedSha, headSha, traceId);
      const relation: GitHubBranchRelation | null =
        comparison.status === "ahead"
          ? "advanced"
          : comparison.status === "behind"
            ? "rewound"
            : comparison.status === "diverged"
              ? "diverged"
              : null;
      if (!relation) {
        // status 未知时不能当成「未漂移」：发布门必须 fail-closed（09 §5.2）。
        throw branchError("validation_failed", "compare response status was not recognized");
      }
      return { relation, headSha, comparison };
    },
  };
}
