import type { SandboxProvider } from "@zcode/shared";
import type { ProvisionerConfig } from "../config.js";
import { DaytonaSandboxDriver } from "./daytona.js";
import { E2BSandboxDriver } from "./e2b.js";
import { ModalSandboxDriver } from "./modal.js";
import type { SandboxProviderDriver } from "./types.js";

export type DriverRegistry = ReadonlyMap<SandboxProvider, SandboxProviderDriver>;

/**
 * 按配置装配三个驱动。
 *
 * 三个都装上、由 `/healthz` 暴露各自 `isConfigured()`：这样"这个部署支持哪些 provider"
 * 是运行时事实，而不是启动时猜的。缺凭据的驱动在真正被请求时才会给出明确错误。
 */
export function createDriverRegistry(config: ProvisionerConfig): DriverRegistry {
  const drivers: SandboxProviderDriver[] = [
    new ModalSandboxDriver({
      appName: config.modal.appName,
      baseImage: config.modal.baseImage,
      packagesPreinstalled: config.packagesPreinstalled,
    }),
    new DaytonaSandboxDriver({
      image: config.daytona.image,
      sshHost: config.daytona.sshHost,
      packagesPreinstalled: config.daytona.packagesPreinstalled,
      ...(config.daytona.apiKey ? { apiKey: config.daytona.apiKey } : {}),
      ...(config.daytona.apiUrl ? { apiUrl: config.daytona.apiUrl } : {}),
      ...(config.daytona.target ? { target: config.daytona.target } : {}),
    }),
    new E2BSandboxDriver({
      template: config.e2b.template,
      relayPort: config.e2b.relayPort,
      packagesPreinstalled: config.packagesPreinstalled,
    }),
  ];

  return new Map(drivers.map((driver) => [driver.provider, driver]));
}

export { ModalSandboxDriver, DaytonaSandboxDriver, E2BSandboxDriver };
export type {
  ProvisionContext,
  ProvisionedSandbox,
  ProvisionerLogger,
  SandboxDriverContext,
  SandboxProviderDriver,
  ShellResult,
} from "./types.js";
