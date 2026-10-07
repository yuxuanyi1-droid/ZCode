/**
 * Cloud 归一错误码目录（specs/cloud-agent/01 §9 错误类别表、09 §8 外部 API 归一、
 * 03 §6 错误信封、02 §2 不变量 5、02 §6.2/§6.3、03 §7）。
 *
 * 跨 HTTP / WS / bridge / adapter 统一归一到该目录：provider 与 GitHub 的原始
 * 错误码/响应不得直接进入用户错误或日志（01 §9 审计段、09 §8）。新增错误码必须
 * 先修订对应 spec 章节，再改本文件。
 */
import { z } from "zod";

export const CLOUD_ERROR_CODES = [
  // 鉴权与主体（01 §9、03 §3）
  "unauthenticated",
  "unauthorized",
  "installation_revoked",
  "permission_revoked",
  // 跨主体资源统一 404，不泄漏存在性（03 §3）
  "not_found",
  // 请求/资源校验：create 前拒绝、不占 quota（01 §9）
  "validation_failed",
  "invalid_ref",
  "unsupported_template",
  "resource_unsupported",
  // 配额与预算（01 §4.3、§9）
  "quota_exceeded",
  "budget_exceeded",
  // provider 创建/终止结果未知：保留 operation/quota 并对账，不盲重试（01 §9、03 §5）
  "provider_create_unknown",
  "provider_termination_unknown",
  // 沙箱引导与协议（01 §5.2、§9）
  "bootstrap_failed",
  "protocol_incompatible",
  // 连接与可达性：离线/未知，不冒充 expired 或开新 writer（01 §9、08 §3.2）
  "bridge_disconnected",
  "provider_unreachable",
  // 保存与 Git（01 §9、08 §8.2）
  "checkpoint_failed",
  "non_fast_forward",
  "data_at_risk",
  // 失联但旧写权处置未决：拒绝自动重开，返回操作入口（02 §2 不变量 5、08 §4.2）
  "recovery_required",
  // 沙箱 attachment 不可用：断线时的在线文件/终端/git 操作返回该码，不改用服务器本地
  // 服务，也不排进输入 outbox（07 §5、03 §2）
  "attachment_unavailable",
  // 同 commandId 不同 payload：返回冲突而非第二份接受（02 §6.2、03 §6.1）
  "idempotency_conflict",
  // 过期代际/交互（02 §6.3、03 §7）
  "stale",
  // run 未 ready 时的文件/终端等操作（03 §7、CP-11）
  "not_ready",
  // 分阶段上线：端点已注册但能力未交付，不得伪装成功（03 §6、00 §11⑤）
  "not_implemented",
  // 部署配置缺失：服务未配置 ≠ 用户未授权（03 §6 repositories 行、04 §3.1）
  "not_configured",
  // GitHub 外部 API 归一（09 §8）
  "repo_not_found",
  "branch_conflict",
  "rate_limited",
  "network_unknown",
] as const;

export const cloudErrorCodeSchema = z.enum(CLOUD_ERROR_CODES);
export type CloudErrorCode = z.infer<typeof cloudErrorCodeSchema>;

/**
 * retryable 语义：=true 表示「可用同一幂等键安全地自动重试同一操作」；=false 表示
 * 重试前必须对账或用户介入。要点：
 * - provider_create_unknown / provider_termination_unknown 不是 retryable：结果
 *   未知时按 operationId/labels 对账，盲目重试会重复创建或重复终止副作用（03 §5）。
 * - bridge_disconnected / provider_unreachable 的 retryable 只指连接类恢复，不代表
 *   可以把 Run 归为 expired 或另建 writer（08 §3.2、02 §2 不变量 4）。
 * - attachment_unavailable 的 retryable 只指 attachment 恢复后可重试同一在线操作；
 *   不得据此回落 host 本机执行域，也不得把在线执行排进输入 outbox（07 §5、03 §2）。
 * - checkpoint_failed 可在剩余租期/预算内有界重试（08 §8.1），不承诺无限保活。
 * - protocol_incompatible 也用于「响应不是合法错误信封/不是 JSON」（网关 HTML 502、
 *   代理截断等）：无法按 code 解析时统一归一到该码，禁止解析文案猜测语义（09 §8）。
 */
export const CLOUD_ERROR_RETRYABLE: Readonly<Record<CloudErrorCode, boolean>> = {
  unauthenticated: false,
  unauthorized: false,
  installation_revoked: false,
  permission_revoked: false,
  not_found: false,
  validation_failed: false,
  invalid_ref: false,
  unsupported_template: false,
  resource_unsupported: false,
  quota_exceeded: false,
  budget_exceeded: false,
  provider_create_unknown: false,
  provider_termination_unknown: false,
  bootstrap_failed: false,
  protocol_incompatible: false,
  bridge_disconnected: true,
  provider_unreachable: true,
  checkpoint_failed: true,
  non_fast_forward: false,
  data_at_risk: false,
  recovery_required: false,
  attachment_unavailable: true,
  idempotency_conflict: false,
  stale: false,
  not_ready: false,
  not_implemented: false,
  not_configured: false,
  repo_not_found: false,
  branch_conflict: false,
  rate_limited: true,
  network_unknown: true,
};

export function isCloudErrorCode(value: string): value is CloudErrorCode {
  return (CLOUD_ERROR_CODES as readonly string[]).includes(value);
}
