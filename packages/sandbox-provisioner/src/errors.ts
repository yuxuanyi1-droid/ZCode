/**
 * provisioner 侧的错误类型。
 *
 * 带 `status` 的错误会被 HTTP 层原样映射成状态码——客户端（SandboxProvisionerClient）
 * 只按状态码和正文分派，所以这里的 message 是给用户看的，不要塞堆栈。
 */
export class ProvisionerError extends Error {
  readonly status: number;

  constructor(message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProvisionerError";
    this.status = options.status ?? 500;
  }
}

/** 请求本身有问题（provider 不支持、字段非法）。 */
export function badRequest(message: string, cause?: unknown): ProvisionerError {
  return new ProvisionerError(message, { status: 400, cause });
}

/**
 * 宿主环境缺配置（没装 SDK、没给 token）。
 *
 * 用 503 而不是 500：这不是"服务崩了"，而是"这个部署没启用该 provider"，
 * 客户端可以据此提示用户换 provider 或去配环境。
 */
export function unavailable(message: string, cause?: unknown): ProvisionerError {
  return new ProvisionerError(message, { status: 503, cause });
}

/**
 * 上游 provider 失败（配额、区域、超时）。
 *
 * 一律折成 502：ZCode 侧只关心"provisioner 没能给我一个沙箱"，
 * 不需要知道是 Modal 还是 Daytona 的错。
 */
export function upstreamFailure(
  provider: string,
  detail: string,
  cause?: unknown,
): ProvisionerError {
  return new ProvisionerError(`${provider} failed to provision a sandbox: ${detail}`, {
    status: 502,
    cause,
  });
}
