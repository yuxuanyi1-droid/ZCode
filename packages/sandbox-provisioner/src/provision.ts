import {
  formatZodError,
  resolveSandboxTimeoutSeconds,
  resolveSandboxWorkspacePath,
  sandboxProvisionResultSchema,
  type SandboxProvider,
  type SandboxProvisionRequest,
  type SandboxProvisionResult,
} from "@zcode/shared";
import { badRequest, ProvisionerError, upstreamFailure } from "./errors.js";
import { resolveRepositoryCheckout } from "./gitRef.js";
import { generateSandboxKeyPair } from "./keypair.js";
import type { DriverRegistry } from "./providers/index.js";
import type { ProvisionerLogger } from "./providers/types.js";

/**
 * 每个 provider 的硬上限（秒）。
 *
 * 请求方写的时长不可信：超过 provider 上限时它会被 provider 侧静默截断，
 * 让 expiresAt 变成一句谎话。这里先收敛，超时上限就是双方都认的值。
 */
export const PROVIDER_MAX_TIMEOUT_SECONDS: Record<SandboxProvider, number> = {
  // Modal 的 timeoutMs 上限没有文档化硬值；两周足够覆盖任何真实会话。
  modal: 14 * 24 * 60 * 60,
  // E2B 文档：Pro 24 小时，Hobby 1 小时。取 Pro 上限，Hobby 账号会在 provider 侧被拒。
  e2b: 24 * 60 * 60,
  daytona: 7 * 24 * 60 * 60,
};

export interface ProvisionSandboxDependencies {
  drivers: DriverRegistry;
  gitBaseUrl: string;
  log: ProvisionerLogger;
}

/**
 * 创建沙箱。
 *
 * 编排顺序刻意是"先把所有本地能失败的检查做完，再碰 provider"：
 * 请求非法、provider 未启用、路径逃逸都在开沙箱之前失败，不留下要清理的半成品。
 */
export async function provisionSandbox(
  request: SandboxProvisionRequest,
  deps: ProvisionSandboxDependencies,
): Promise<SandboxProvisionResult> {
  const driver = deps.drivers.get(request.provider);
  if (!driver) {
    throw badRequest(`Unsupported sandbox provider: ${request.provider}`);
  }
  if (!driver.isConfigured()) {
    throw new ProvisionerError(
      `Provider ${request.provider} is not configured on this provisioner (missing credentials or SDK).`,
      { status: 503 },
    );
  }

  const checkout = resolveRepositoryCheckout(
    deps.gitBaseUrl,
    request.repository,
    request.branch,
    request.ref,
  );
  const workspacePath = resolve(() => resolveSandboxWorkspacePath(request));
  const timeoutSeconds = resolveSandboxTimeoutSeconds(
    request,
    PROVIDER_MAX_TIMEOUT_SECONDS[request.provider],
  );
  // 一次性密钥：与沙箱同生命周期，泄漏面只限这一个沙箱。
  const keyPair = generateSandboxKeyPair();

  const provisioned = await driver.create({
    request,
    log: deps.log,
    timeoutSeconds,
    publicKey: keyPair.publicKey,
    checkout,
    workspacePath,
  });

  const result: SandboxProvisionResult = {
    sandboxId: provisioned.sandboxId,
    ssh: {
      transport: provisioned.transport,
      username: provisioned.username,
      privateKey: keyPair.privateKey,
    },
    workspacePath,
    ...(provisioned.expiresAt === undefined ? {} : { expiresAt: provisioned.expiresAt }),
  };

  // 自检一遍再发出去：客户端一定会校验，早一步失败能给出"哪个字段坏了"而不是
  // 一个 400 invalid result。典型触发是 provider 返回了带 ':' 的 sandboxId。
  const parsed = sandboxProvisionResultSchema.safeParse(result);
  if (!parsed.success) {
    throw upstreamFailure(
      request.provider,
      `returned an unusable sandbox descriptor: ${formatZodError(parsed.error)}`,
    );
  }

  return parsed.data;
}

function resolve<T>(compute: () => T): T {
  try {
    return compute();
  } catch (error) {
    // resolveSandboxWorkspacePath 抛的是普通 Error（shared 层不依赖 HTTP），
    // 在这里折成 400，免得变成 500。
    throw badRequest(error instanceof Error ? error.message : String(error), error);
  }
}
