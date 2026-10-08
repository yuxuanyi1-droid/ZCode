/**
 * 云入口配置的**纯值解析函数**（specs/cloud-agent/03 §2/§3/§8、W5 §3/§4）。
 *
 * 自 `entry-cloud-config-contract.ts` 迁入（无行为变更的纯结构拆分）：只承载
 * 「原始字符串值 → 解析结果/结构化 issue」的纯函数，不做任何 IO、不读 env；
 * 键名常量、issue/配置类型与启动错误结构仍由 contract 文件持有（本文件单向
 * import，不回环）。跨字段校验与装配在 `entry-cloud-config.ts`，外部继续
 * import `entry-cloud-config.js`，不直接引用本文件。
 */
import { cloudUuidSchema, type CloudUuid } from "@zcode/shared";
import {
  ZCODE_CLOUD_SANDBOX_MAX_LIFETIME_SECONDS_ENV,
  ZCODE_CLOUD_SANDBOX_TEMPLATE_REF_ENV,
  type CloudAuthMode,
  type CloudEntryConfigIssue,
  type CloudStaticModelFallback,
} from "./entry-cloud-config-contract.js";
import { isSandboxProviderId } from "./sandbox/capabilities.js";

export function readTrimmed(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

/**
 * 解析 `ZCODE_CLOUD_AUTH_MODE`：`undefined` = 未设置（调用方补默认 `token`）；
 * `"invalid"` = 拼错的取值，必须报 `auth_mode_invalid`——静默当默认值等于把调试逃生门
 * 或生产门槛开/关在部署方不知情的情况下（fail-closed，03 §3 修订）。
 */
export function parseCloudAuthMode(
  value: string | undefined,
): CloudAuthMode | "invalid" | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed === "token" || trimmed === "anonymous" ? trimmed : "invalid";
}

/**
 * 解析 `ZCODE_CLOUD_PRINCIPAL_ID` 的形状（2026-10-08 真实事故引入）：
 * 部署者把该键配成 `local-debug` 这类非 UUID 值时，云入口曾照常启动并把它透传进
 * capabilities 响应；客户端 shared 的 `capabilitiesResponseSchema` 要求 principalId
 * 是 UUID（`cloudUuidSchema`），safeParse 失败被 boot 归一为 incompatible-bundle，
 * 用户看到「客户端与云入口版本不兼容」——与真实原因（部署配置非法）完全无关。
 * 因此形状校验必须前移到启动期 fail-closed：`undefined` = 未设置（调用方报
 * `principal_id_required`）；`"invalid"` = 非空但非 UUID（调用方报 `principal_id_invalid`）。
 *
 * 形状直接复用 capabilities 契约同一份 `cloudUuidSchema`（`identity.ts`），不重写第二份
 * pattern：两处口径必须同宽同严，否则启动放行的值客户端仍会在 capabilities 处拒绝。
 */
export function parsePrincipalId(value: string | undefined): CloudUuid | "invalid" | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return cloudUuidSchema.safeParse(trimmed).success ? trimmed : "invalid";
}

export function splitList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export function parsePositiveInt(value: string | undefined, fallback: number): number | null {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * 可选非负整数（0 合法 = 显式禁用，如 `ZCODE_CLOUD_SANDBOX_IDLE_PAUSE_SECONDS=0`）。
 * `undefined`（含空串/空白，readTrimmed 已收敛）= 未设置，调用方按缺省处理；`null` =
 * 配了但形状非法——全串必须是十进制数字（`parseInt` 会把 "1.5" 截成 1、"-1" 截断符号，
 * 静默接受截断值等于改写部署意图，与 parseSandboxLifetimeLimits 同一严格口径）。
 */
export function parseOptionalNonNegativeInt(value: string | undefined): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    return null;
  }
  return Number.parseInt(value, 10);
}

/** origin 只接受 scheme + authority：带 path/query/fragment 会让 attachment 地址拼错。 */
export function parsePublicOrigin(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback =
    host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
  if (url.protocol === "http:" && !loopback) {
    // 明文 origin 只允许本机开发；公网部署必须 https（01 §7.2 凭据边界）。
    return null;
  }
  return url.origin;
}

export function parseSandboxTemplateRefs(value: string | undefined): {
  value?: Readonly<Record<string, string>>;
  issues: CloudEntryConfigIssue[];
} {
  if (!value) {
    return { issues: [] };
  }
  const issues: CloudEntryConfigIssue[] = [];
  const refs: Record<string, string> = {};
  for (const entry of value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)) {
    const separator = entry.indexOf(":");
    const provider = separator > 0 ? entry.slice(0, separator).trim() : "";
    const ref = separator > 0 ? entry.slice(separator + 1).trim() : "";
    const invalid = (message: string): void => {
      issues.push({
        code: "sandbox_template_invalid",
        field: ZCODE_CLOUD_SANDBOX_TEMPLATE_REF_ENV,
        message: `${message}（收到: ${entry}）`,
      });
    };
    if (!provider || !ref) {
      invalid("模板引用必须是 provider:ref 形式");
      continue;
    }
    if (!isSandboxProviderId(provider)) {
      invalid(`未知的沙箱 provider`);
      continue;
    }
    if (/(^|[:@])latest$/i.test(ref)) {
      invalid("镜像引用禁止 latest（版本/digest 必须固定）");
      continue;
    }
    if (refs[provider]) {
      invalid(`provider ${provider} 重复声明模板引用`);
      continue;
    }
    refs[provider] = ref;
  }
  if (issues.length > 0) {
    return { issues };
  }
  return { value: refs, issues };
}

export function parseIdList(value: string | undefined): number[] | undefined {
  if (!value) {
    return undefined;
  }
  const ids = value
    .split(",")
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((id) => Number.isInteger(id) && id > 0);
  return ids.length > 0 ? ids : undefined;
}

/**
 * `provider:seconds` 列表。fail-closed：缺 `:`、provider 未知、seconds 非正整数、
 * 同 provider 重复声明一律报 issue（01 §4.3 的上限必须是核实过的正整数秒）。
 */
export function parseSandboxLifetimeLimits(value: string | undefined): {
  value?: Readonly<Record<string, number>>;
  issues: CloudEntryConfigIssue[];
} {
  if (!value) {
    return { issues: [] };
  }
  const issues: CloudEntryConfigIssue[] = [];
  const limits: Record<string, number> = {};
  for (const entry of value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)) {
    const separator = entry.indexOf(":");
    const provider = separator > 0 ? entry.slice(0, separator).trim() : "";
    const rawSeconds = separator > 0 ? entry.slice(separator + 1).trim() : "";
    const invalid = (message: string): void => {
      issues.push({
        code: "sandbox_lifetime_invalid",
        field: ZCODE_CLOUD_SANDBOX_MAX_LIFETIME_SECONDS_ENV,
        message: `${message}（收到: ${entry}）`,
      });
    };
    if (!provider || !rawSeconds) {
      invalid("可用期上限必须是 provider:seconds 形式");
      continue;
    }
    if (!isSandboxProviderId(provider)) {
      invalid("未知的沙箱 provider");
      continue;
    }
    if (!/^\d+$/.test(rawSeconds) || Number.parseInt(rawSeconds, 10) <= 0) {
      invalid("可用期上限必须是正整数秒");
      continue;
    }
    if (limits[provider] !== undefined) {
      invalid(`provider ${provider} 重复声明可用期上限`);
      continue;
    }
    limits[provider] = Number.parseInt(rawSeconds, 10);
  }
  if (issues.length > 0) {
    return { issues };
  }
  return { value: limits, issues };
}

export function parseStaticModelFallback(
  value: string | undefined,
): CloudStaticModelFallback | null {
  if (!value) {
    return null;
  }
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    return null;
  }
  const provider = value.slice(0, separator).trim();
  const model = value.slice(separator + 1).trim();
  return provider && model ? { provider, model } : null;
}
