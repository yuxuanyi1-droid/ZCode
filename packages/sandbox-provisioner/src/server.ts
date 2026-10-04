import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import {
  SANDBOX_HEALTH_PATH,
  SANDBOX_PROVISION_PATH,
  formatZodError,
  sandboxProvisionRequestSchema,
  type SandboxProvider,
  type SandboxProvisionResult,
} from "@zcode/shared";
import { ProvisionerError } from "./errors.js";
import { provisionSandbox } from "./provision.js";
import type { DriverRegistry } from "./providers/index.js";
import type { ProvisionerLogger } from "./providers/types.js";

/** 只回一小段错误正文：详情里可能有上游 URL、token 片段。 */
const MAX_ERROR_DETAIL_LENGTH = 500;

export interface ProvisionerAppOptions {
  drivers: DriverRegistry;
  gitBaseUrl: string;
  /** 共享 bearer token；未配置时不校验（只适用于绑定回环地址的本地部署）。 */
  token?: string;
  log: ProvisionerLogger;
}

export interface ProviderHealth {
  provider: SandboxProvider;
  configured: boolean;
}

export function createProvisionerApp(options: ProvisionerAppOptions): Hono {
  const app = new Hono();

  app.get(SANDBOX_HEALTH_PATH, (c) =>
    c.json({
      ok: true,
      providers: [...options.drivers.values()].map<ProviderHealth>((driver) => ({
        provider: driver.provider,
        configured: driver.isConfigured(),
      })),
    }),
  );

  app.post(SANDBOX_PROVISION_PATH, async (c) => {
    if (!isAuthorized(c.req.header("authorization"), options.token)) {
      return c.json({ error: "unauthorized" }, 401);
    }

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: "request body must be JSON" }, 400);
    }

    // 外部输入一律先过 schema：这个请求会直接决定开哪个云上的沙箱。
    const parsed = sandboxProvisionRequestSchema.safeParse(payload);
    if (!parsed.success) {
      return c.json({ error: `invalid request: ${formatZodError(parsed.error)}` }, 400);
    }

    const result: SandboxProvisionResult = await provisionSandbox(parsed.data, {
      drivers: options.drivers,
      gitBaseUrl: options.gitBaseUrl,
      log: options.log,
    });

    return c.json(result, 201);
  });

  app.notFound((c) => c.json({ error: "not found" }, 404));

  app.onError((error, c) => {
    const status = error instanceof ProvisionerError ? error.status : 500;
    // 非预期错误的正文只留在 provisioner 日志里：对外只给一个不透明的 500，
    // 免得把内部路径/堆栈回给调用方。
    options.log.warn("provision request failed", {
      status,
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof ProvisionerError
        ? {}
        : { stack: error instanceof Error ? error.stack : undefined }),
    });

    return c.json({ error: describeError(error) }, status as 400 | 401 | 404 | 500 | 502 | 503);
  });

  return app;
}

/**
 * 恒定时间比较 bearer token。
 *
 * 普通的 `===` 会在第一个不同字节处提前返回，理论上可被用来逐字节猜 token。
 * 长度不同直接判否（长度本身不是秘密）。
 */
function isAuthorized(header: string | undefined, expected: string | undefined): boolean {
  if (!expected) {
    return true;
  }
  const prefix = "Bearer ";
  if (!header?.startsWith(prefix)) {
    return false;
  }

  const provided = Buffer.from(header.slice(prefix.length).trim(), "utf8");
  const want = Buffer.from(expected, "utf8");
  if (provided.length !== want.length) {
    return false;
  }

  return timingSafeEqual(provided, want);
}

/**
 * 对外错误正文。
 *
 * 只有 `ProvisionerError` 的 message 是**为调用方写的**（provider 未启用、请求非法），
 * 原样返回。其余错误是没预料到的内部故障，message 里可能带文件路径、上游 URL 或 token
 * 片段——那些只进日志，对外统一给一句不透明的话。这与 onError 里"非 ProvisionerError
 * 才记 stack"用的是同一个判据。
 */
function describeError(error: unknown): string {
  if (!(error instanceof ProvisionerError)) {
    return "provisioner error";
  }

  const trimmed = error.message.trim();
  if (!trimmed) {
    return "provisioner error";
  }

  return trimmed.length > MAX_ERROR_DETAIL_LENGTH
    ? `${trimmed.slice(0, MAX_ERROR_DETAIL_LENGTH)}…`
    : trimmed;
}
