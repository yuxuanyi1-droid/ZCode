import { badRequest } from "./errors.js";

/**
 * 仓库坐标的安全闸。
 *
 * shared 的 schema 只要求"非空、name 是单段"——那是给客户端表单用的宽松校验。
 * provisioner 要把这些值拼进 shell 命令和 clone URL，所以这里必须再收紧一次：
 * 一个带 `;` 或 `$()` 的 owner 就能在沙箱启动阶段执行任意命令。
 */
const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const PATH_PATTERN = /^[A-Za-z0-9._/-]+$/;

function assertNoTraversal(value: string, label: string): void {
  if (value.split("/").some((segment) => segment === ".." || segment === "")) {
    throw badRequest(`${label} must not contain empty or ".." path segments: ${value}`);
  }
}

function assertSafePath(value: string, label: string): void {
  if (!PATH_PATTERN.test(value)) {
    throw badRequest(`${label} contains unsupported characters: ${value}`);
  }
  assertNoTraversal(value, label);
}

/** owner 允许嵌套（GitLab 子组），但每段都必须是普通字符。 */
export function assertSafeOwner(owner: string): string {
  const trimmed = owner.trim();
  if (!trimmed) {
    throw badRequest("Repository owner must not be empty.");
  }
  assertSafePath(trimmed, "Repository owner");
  return trimmed;
}

/** name 是 checkout 目录名，必须是单段。 */
export function assertSafeRepositoryName(name: string): string {
  const trimmed = name.trim();
  if (!SEGMENT_PATTERN.test(trimmed) || trimmed === "." || trimmed === "..") {
    throw badRequest(`Repository name must be a single safe path segment: ${name}`);
  }
  return trimmed;
}

/**
 * git ref（分支或 revision）。
 *
 * 除了字符集，还要挡住 `-` 开头：`git checkout -b foo` 会被解析成选项而不是 ref。
 */
export function assertSafeGitRef(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw badRequest(`${label} must not be empty.`);
  }
  if (trimmed.startsWith("-")) {
    throw badRequest(`${label} must not start with "-": ${value}`);
  }
  if (!PATH_PATTERN.test(trimmed) || trimmed.includes("..")) {
    throw badRequest(`${label} contains unsupported characters: ${value}`);
  }
  return trimmed;
}

export interface ResolvedRepositoryCheckout {
  /** 用于 `git clone` 的远端 URL。 */
  cloneUrl: string;
  /** checkout 到的 ref：给了 `ref` 就用它（detached），否则用分支。 */
  checkoutRef: string;
  /** 是否 detached checkout。 */
  detached: boolean;
}

/**
 * 组装 clone 参数。
 *
 * `baseUrl` 由部署方配置（GitHub / 自建 GitLab / GHE），因为请求契约里只有 owner/name
 * ——不同组织的仓库可能不在同一个 host 上。
 */
export function resolveRepositoryCheckout(
  baseUrl: string,
  repository: { owner: string; name: string },
  branch: string,
  ref?: string,
): ResolvedRepositoryCheckout {
  const owner = assertSafeOwner(repository.owner);
  const name = assertSafeRepositoryName(repository.name);
  const safeBranch = assertSafeGitRef(branch, "Branch");
  const trimmedBase = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmedBase) {
    throw badRequest("Git base URL must not be empty.");
  }

  const cloneUrl = `${trimmedBase}/${owner}/${name}.git`;
  if (ref === undefined) {
    return { cloneUrl, checkoutRef: safeBranch, detached: false };
  }

  return { cloneUrl, checkoutRef: assertSafeGitRef(ref, "Ref"), detached: true };
}
