/**
 * `UserPreferencesPort` 的 host 本体实现（M8；specs/cloud-agent 14 §6/§9.2⑥）。
 *
 * 值来源 = host 本体 `ISettingService.get()` 的账号设置（[12 §2]：账号设置权威在 host
 * 本体），语义口径对齐 `packages/services/src/node.ts` 的 `resolveSessionRuntimePreferences`
 * （`user-execution` scope）：
 * - 三个 boolean 取值原样（`!== false` / `=== true` 是**沙箱侧应答**的默认值规则，
 *   控制面只做快照，不在此层补默认值——缺席键由 responder 的既有默认值收敛）；
 * - `modelContextBudgetStrategy` 在源码里就是常量 `DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY`
 *   （不是设置项），快照按同一常量取值，保证与节点本机行为一致；
 * - `integratedTerminalShell` 只在显式设置过时随快照下发。
 *
 * 失败语义：设置读取失败只回空对象（warn），不抛错——偏好缺失不是 run 失败条件
 * （14 §9.2⑥）；不记任何设置值到日志。
 */
import { ISettingService, type ServiceCollection } from "@zcode/services";
import { DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY } from "@zcode/shared";
import type {
  CloudUserPreferencesValues,
  UserPreferencesPort,
} from "../../app/ports/userPreferencesPort.js";
import type { CloudAdapterLogger } from "./adapterError.js";

export interface HostUserPreferencesOptions {
  /** host 服务图的惰性取用：入口在 host 本体启动后才接上（03 §8 顺序）。 */
  readonly getServices: () => ServiceCollection | undefined;
  readonly logger: CloudAdapterLogger;
}

export function createHostUserPreferences(
  options: HostUserPreferencesOptions,
): UserPreferencesPort {
  return {
    async readUserPreferences(): Promise<CloudUserPreferencesValues> {
      const services = options.getServices();
      const settings = services?.getOptional(ISettingService);
      if (!settings) return {};
      let current;
      try {
        current = await settings.get();
      } catch (error) {
        options.logger.warn(undefined, "[cloud-user-preferences] settings read failed", {
          reason: error instanceof Error ? error.message : String(error),
        });
        return {};
      }
      const values: CloudUserPreferencesValues = {
        // 预算策略与节点本机同源（源码常量），不是设置项但属于"已应用配置"事实。
        modelContextBudgetStrategy: DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
      };
      if (typeof current.askUserQuestionAutoResolutionEnabled === "boolean") {
        values.askUserQuestionAutoResolutionEnabled = current.askUserQuestionAutoResolutionEnabled;
      }
      if (typeof current.nativeSearchEnhancementsEnabled === "boolean") {
        values.nativeSearchEnhancementsEnabled = current.nativeSearchEnhancementsEnabled;
      }
      if (typeof current.memoryEnabled === "boolean") {
        values.memoryEnabled = current.memoryEnabled;
      }
      if (current.integratedTerminalShell) {
        values.integratedTerminalShell = current.integratedTerminalShell;
      }
      return values;
    },
  };
}
