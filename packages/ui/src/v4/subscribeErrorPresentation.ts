/**
 * v4 订阅错误的人类呈现分类（2026-10-08 巡检修订，P1）。
 *
 * 背景（实测缺陷）：云任务首条消息 attach 时 pane 以空串 `workspace.workspacePath`
 * 发起订阅，runtime 侧 zod 校验失败后把 issues 数组 JSON 原样带回；`SessionPane` 的
 * 错误分支把 `state.lastError` 当正文渲染，右侧时间线区出现
 * `[{"origin":"string","code":"too_small",...,"path":["workspace","workspacePath"],...}]`。
 * 服务端 run 实际成功（刷新 replay 完整）——错误呈现与事实相反。
 *
 * 规则（纯函数，node:test 直接覆盖）：
 * - 结构化校验错误（zod issues 形状的 JSON 数组，或带 issues 的 `Invalid params` 文案）
 *   → 专门的「连接被服务端校验拒绝」标题，原始串降级为次要诊断细节；
 * - 云执行域不可用（`… has no ready run attachment`）→「运行环境暂不可用」标题
 *   （2026-10-09 paused 呈现修订：裸 reason 不得作为用户可读标题）；
 * - 其它错误保持原文案语义，但同样不允许作为对话正文的一部分渲染。
 */

/** zod issue 的最小形状识别：对象 + code 字符串 +（可选）path 数组。 */
function looksLikeZodIssue(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const issue = value as { code?: unknown; path?: unknown; message?: unknown };
  return (
    typeof issue.code === "string" &&
    issue.code.length > 0 &&
    (issue.path === undefined || Array.isArray(issue.path)) &&
    (issue.message === undefined || typeof issue.message === "string")
  );
}

/** 串是否是 zod issues 数组的 JSON 文本（CLI 的 -32602 `data.message` 就是这个形态）。 */
export function isStructuredValidationIssuesText(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) && parsed.length > 0 && parsed.every(looksLikeZodIssue);
  } catch {
    return false;
  }
}

export type SubscribeErrorPresentation =
  | { readonly kind: "structured-validation"; readonly detail: string }
  | { readonly kind: "cloud-unavailable"; readonly detail: string }
  | { readonly kind: "generic"; readonly detail: string | null };

/**
 * 云执行域不可用的稳定标记（2026-10-09 paused 呈现修订）：云任务没有 ready attachment 时，
 * 执行域 accessor 以 `cloud task <taskId> has no ready run attachment` 的稳定句式拒绝
 * （`useCloudWorkspaceServices` / `getCloudAttachmentUnavailableServices` 唯一产地）。
 * 这类失败不是「与代理的连接已断开」——按状态归一成「运行环境暂不可用」，原始串仍进
 * 技术细节区（排障可用，不直达标题）。
 */
export function isCloudAttachmentUnavailableErrorText(raw: string): boolean {
  return raw.includes("has no ready run attachment");
}

/**
 * 把 `state.lastError` 分类成专门呈现：
 * - zod issues JSON / `Invalid params` → structured-validation（用专门标题，原始串进细节区）；
 * - 云执行域不可用（无 ready attachment）→ cloud-unavailable（「运行环境暂不可用」标题）；
 * - 其它 → generic（原文进细节区，标题走连接失败文案）。
 */
export function classifySubscribeError(raw: string | null | undefined): SubscribeErrorPresentation {
  const text = raw?.trim() ?? "";
  if (text.length === 0) {
    return { kind: "generic", detail: null };
  }
  if (isStructuredValidationIssuesText(text)) {
    return { kind: "structured-validation", detail: text };
  }
  if (text.startsWith("Invalid params")) {
    // 新版 Agent 会把 zod 摘要附加到 message，正文可能是 `Invalid params — [...]`。
    const embedded = text.slice(text.indexOf("["));
    if (embedded && isStructuredValidationIssuesText(embedded)) {
      return { kind: "structured-validation", detail: text };
    }
  }
  if (isCloudAttachmentUnavailableErrorText(text)) {
    return { kind: "cloud-unavailable", detail: text };
  }
  return { kind: "generic", detail: text };
}
