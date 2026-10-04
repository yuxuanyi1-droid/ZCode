import {
  ZCODE_SANDBOX_PROVISIONER_TOKEN_ENV_KEY,
  ZCODE_SANDBOX_PROVISIONER_URL_ENV_KEY,
  formatZodError,
  sandboxProvisionResultSchema,
  type SandboxProvisionRequest,
  type SandboxProvisionResult,
} from "@zcode/shared";

/** provisioner 侧创建沙箱的固定路径；这是 ZCode 与 provisioner 之间唯一的写契约。 */
export const SANDBOX_PROVISION_PATH = "/sandboxes";

/**
 * 创建沙箱包含拉镜像 + clone，慢是常态；这个超时是**整个请求**的上限，
 * 给得比普通 HTTP 调用宽松得多。沙箱自身的存活上限走 request.timeoutSeconds。
 */
export const DEFAULT_SANDBOX_PROVISION_TIMEOUT_MS = 10 * 60 * 1000;

export interface SandboxProvisionerOptions {
  /** provisioner 基址，例如 `http://127.0.0.1:8788`。 */
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  /** 仅用于测试注入；默认用全局 fetch。 */
  fetchImpl?: typeof fetch;
}

export class SandboxProvisionerError extends Error {
  readonly status?: number;

  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SandboxProvisionerError";
    this.status = options?.status;
  }
}

/**
 * Plan A 的 provisioner 客户端：**只有创建，没有销毁**。
 *
 * 销毁刻意不进这个契约——沙箱归 provisioner 所有，ZCode 进程崩了、切 workspace、
 * 重连都不该波及它。要回收由 provisioner 自己按 timeoutSeconds / expiresAt 处理。
 */
export class SandboxProvisionerClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SandboxProvisionerOptions) {
    const baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
    if (!baseUrl) {
      throw new SandboxProvisionerError("Sandbox provisioner base URL must not be empty.");
    }

    this.baseUrl = baseUrl;
    this.token = options.token?.trim() || undefined;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SANDBOX_PROVISION_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async create(request: SandboxProvisionRequest): Promise<SandboxProvisionResult> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${SANDBOX_PROVISION_PATH}`, {
        method: "POST",
        headers,
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // 网络错误和超时都收敛成同一个类型，上层才能只按一种失败处理。
      throw new SandboxProvisionerError(
        `Sandbox provisioner request failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    if (!response.ok) {
      const detail = await readErrorDetail(response);
      throw new SandboxProvisionerError(
        `Sandbox provisioner returned ${response.status}${detail ? `: ${detail}` : ""}`,
        { status: response.status },
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new SandboxProvisionerError("Sandbox provisioner returned a non-JSON response.", {
        status: response.status,
        cause: error,
      });
    }

    // 外部服务的响应必须过 schema：sandboxId 会进 identity，ssh 入口会直接拿去做连接。
    const parsed = sandboxProvisionResultSchema.safeParse(payload);
    if (!parsed.success) {
      throw new SandboxProvisionerError(
        `Sandbox provisioner returned an invalid result: ${formatZodError(parsed.error)}`,
        { status: response.status },
      );
    }

    return parsed.data;
  }
}

/** 只回一小段错误正文，避免把 provisioner 的整页 HTML 错误页塞进日志/响应。 */
const MAX_ERROR_DETAIL_LENGTH = 500;

async function readErrorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }

  return trimmed.length > MAX_ERROR_DETAIL_LENGTH
    ? `${trimmed.slice(0, MAX_ERROR_DETAIL_LENGTH)}…`
    : trimmed;
}

/**
 * 从环境变量装配客户端；未配置 URL 时返回 null，
 * 调用方据此回 503，而不是静默降级。
 */
export function createSandboxProvisionerFromEnv(
  env: Record<string, string | undefined> = process.env,
): SandboxProvisionerClient | null {
  const baseUrl = env[ZCODE_SANDBOX_PROVISIONER_URL_ENV_KEY]?.trim();
  if (!baseUrl) {
    return null;
  }

  return new SandboxProvisionerClient({
    baseUrl,
    token: env[ZCODE_SANDBOX_PROVISIONER_TOKEN_ENV_KEY],
  });
}
