/* eslint-disable max-lines -- 设置同步流程聚合了发现、选择与导入状态机，集中维护更利于问题定位 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  SettingsSyncCategory,
  SettingsSyncDiscoveryResult,
  SettingsSyncImportResult,
  SettingsSyncSelection,
} from "@zcode/shared";
import { logger } from "@/logger.js";
import { useServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeSessionService } from "@/hooks/useZCodeSessionService.js";
import { invalidateDeferredDraftSessionForSkillChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import { useCloudAccountHasActivity } from "@/onboarding/useCloudOnboardingFacts.js";
import type { SettingsSyncUiState, SettingsSyncUiTask } from "@/settings-sync/types.js";

const IMPORTING_TASK_DELAY_MS = 320;
const FORCE_SHOW_ONBOARDING_ON_EVERY_REFRESH = false;

/**
 * 首启提示的自动弹出决策步（纯函数，node:test 直接覆盖；effect 只负责执行，
 * 与 useOnboardingTrigger 的 resolveOnboardingDecisionStep 同一模式）：
 * - `skip`：已处理（handled），或云模式账号已有任务/项目（不是 first-run）——不弹；
 * - `wait`：云模式账号事实未定（探测进行中）——保持关闭等待事实，不在事实到达前闪弹
 *   （探测有 5s 超时兜底，事实落地后 effect 重跑）；
 * - `detect`：未处理且无相反事实——进入 detect / 展示。
 */
export type SettingsSyncFirstRunDecision =
  | { readonly kind: "skip"; readonly reason: "handled" | "account-active" }
  | { readonly kind: "wait" }
  | { readonly kind: "detect" };

export function resolveSettingsSyncFirstRunDecision(input: {
  promptHandled: boolean;
  cloudAccountHasActivity: boolean | null | "pending";
}): SettingsSyncFirstRunDecision {
  if (input.promptHandled) {
    return { kind: "skip", reason: "handled" };
  }
  if (input.cloudAccountHasActivity === true) {
    return { kind: "skip", reason: "account-active" };
  }
  if (input.cloudAccountHasActivity === "pending") {
    return { kind: "wait" };
  }
  return { kind: "detect" };
}

/**
 * 首启提示挂载引导（纯异步，node:test 直接覆盖；effect 只负责以真实服务调用它）。
 *
 * 2026-10-09 修订（用户实测复发：欢迎/迁移向导每次刷新必弹且关闭不持久）：
 * - fail-closed：`getFirstRunPromptState` 读取失败（云模式 settings-sync 频道不在
 *   host 暴露面等）时按「不可判定」收敛到关闭态，不得按「未处理」自动弹向导——
 *   读不到的键在关闭路径上同样写不进，fail-open 必然形成每次刷新必弹、关闭无效的
 *   死循环（实测 server.log 连续出现 Unknown channel: settings-sync）；
 * - 账号事实短路：云模式账号已有任务/项目即不是 first-run，挂载即不弹；事实 pending
 *   （探测进行中）期间保持关闭等待，不在事实到达前闪弹。
 */
export async function runSettingsSyncFirstRunPromptBootstrap(input: {
  cloudAccountHasActivity: boolean | null | "pending";
  getFirstRunPromptState: () => Promise<{ readonly handled: boolean }>;
  loadDiscovery: () => Promise<void>;
  /** 决策为不弹（handled / 账号已有活动）或读取失败（fail-closed）时收敛到关闭态。 */
  settleClosed: () => void;
  /** fail-closed 命中时的诊断日志（带 workspacePath 等上下文，由 effect 注入）。 */
  logUnavailable: (error: unknown) => void;
}): Promise<void> {
  let promptState: { readonly handled: boolean };
  try {
    promptState = await input.getFirstRunPromptState();
  } catch (error) {
    input.logUnavailable(error);
    input.settleClosed();
    return;
  }
  const step = resolveSettingsSyncFirstRunDecision({
    promptHandled: promptState.handled,
    cloudAccountHasActivity: input.cloudAccountHasActivity,
  });
  if (step.kind === "skip") {
    input.settleClosed();
    return;
  }
  if (step.kind === "wait") {
    // 云模式账号事实未定（探测进行中）：保持关闭等待事实；事实若为「已有活动」
    // 直接不弹。事实落地（true/false）会重跑调用方 effect，不永久挂起。
    return;
  }
  await input.loadDiscovery();
}

/**
 * 关闭持久化（2026-10-09 修订，node:test 直接覆盖）：优先 settings-sync RPC；
 * 频道不可用（云模式不在 host 暴露面）时回落 settingService 直写**同一个**
 * AppSettings 字段（`settingsSyncFirstRunPromptHandled`——读取端
 * `getFirstRunPromptState` 判定的就是它，读键=写键），保证 X /「开始使用 ZCode」/
 * 完成任一关闭路径跨刷新、跨会话持久。两条路径都失败时向上抛出由调用方记日志。
 */
export const FIRST_RUN_PROMPT_HANDLED_SETTING_PATCH: { settingsSyncFirstRunPromptHandled: true } = {
  settingsSyncFirstRunPromptHandled: true,
};

export async function persistSettingsSyncFirstRunHandled(options: {
  markHandledViaRpc: () => Promise<void>;
  writeSettingFallback: () => Promise<void>;
}): Promise<"rpc" | "fallback"> {
  try {
    await options.markHandledViaRpc();
    return "rpc";
  } catch {
    await options.writeSettingFallback();
    return "fallback";
  }
}

/** 首启自动检测与设置页手动重开对“空 discovery”的处理不同。 */
type LoadDiscoveryIntent = "firstRun" | "manual";

function createInitialState(): SettingsSyncUiState {
  return {
    open: false,
    loading: false,
    importing: false,
    step: "selection",
    discovery: null,
    selectedKeys: [],
    tasks: [],
    result: null,
    error: null,
  };
}

function getSelectionKey(agent: string, category: string): string {
  return `${agent}:${category}`;
}

/**
 * 首启 Onboarding 代理设置：仅模型供应商（providers），不展示、不迁移技能与插件。
 */
function visibleCategoriesForOnboarding(): SettingsSyncCategory[] {
  return ["providers"];
}

function normalizeDiscovery(discovery: SettingsSyncDiscoveryResult): SettingsSyncDiscoveryResult {
  return {
    agents: discovery.agents.map((agent) => {
      const categoryMap = new Map(
        agent.categories.map((category) => [category.category, category]),
      );
      const categories = visibleCategoriesForOnboarding().map((category) => {
        const existing = categoryMap.get(category);
        if (existing) {
          return existing;
        }
        return {
          category,
          discoveredCount: 0,
          importableCount: 0,
          selectedByDefault: false,
        };
      });
      return {
        ...agent,
        categories,
      };
    }),
  };
}

function buildDefaultSelectedKeys(discovery: SettingsSyncDiscoveryResult): string[] {
  return discovery.agents.flatMap((agent) =>
    agent.categories
      .filter((category) => category.selectedByDefault && category.discoveredCount > 0)
      .map((category) => getSelectionKey(agent.agent, category.category)),
  );
}

function buildTasks(
  discovery: SettingsSyncDiscoveryResult,
  selectedKeys: string[],
): SettingsSyncUiTask[] {
  const selected = new Set(selectedKeys);
  return discovery.agents.flatMap((agent) =>
    agent.categories
      .filter((category) => selected.has(getSelectionKey(agent.agent, category.category)))
      .map((category) => ({
        id: getSelectionKey(agent.agent, category.category),
        agent: agent.agent,
        category: category.category,
        discoveredCount: category.discoveredCount,
        status: "pending" as const,
      })),
  );
}

function buildStateSelections(selectedKeys: string[]): SettingsSyncSelection[] {
  return selectedKeys.map((key) => {
    const [agent, category] = key.split(":");
    return {
      agent: agent as SettingsSyncSelection["agent"],
      category: category as SettingsSyncSelection["category"],
    };
  });
}

function buildTasksFromSelections(selections: SettingsSyncSelection[]): SettingsSyncUiTask[] {
  return selections.map((selection, index) => ({
    id: `${selection.agent}:${selection.category}:${selection.sourceScope ?? "all"}:${selection.targetScope ?? "auto"}:${index}`,
    agent: selection.agent,
    category: selection.category,
    discoveredCount:
      selection.skillPaths?.length ??
      selection.commandPaths?.length ??
      selection.pluginPaths?.length ??
      selection.mcpServerPaths?.length ??
      1,
    status: "pending" as const,
  }));
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function applyTaskResults(
  tasks: SettingsSyncUiTask[],
  result: SettingsSyncImportResult,
): SettingsSyncUiTask[] {
  const taskResultQueues = new Map<string, SettingsSyncImportResult["taskResults"]>();
  for (const task of result.taskResults) {
    const key = `${task.agent}:${task.category}`;
    taskResultQueues.set(key, [...(taskResultQueues.get(key) ?? []), task]);
  }
  return tasks.map((task) => {
    const matched = taskResultQueues.get(`${task.agent}:${task.category}`)?.shift();
    return matched ? { ...task, status: matched.status } : { ...task, status: "skipped" };
  });
}

export function useSettingsSync(params: { workspacePath?: string; workspaceIdentity?: string }) {
  const { settingsSyncService } = useServices();
  const zcodeSessionService = useZCodeSessionService(
    params.workspacePath,
    undefined,
    params.workspaceIdentity,
  );
  const runningImportRef = useRef(0);
  const [state, setState] = useState<SettingsSyncUiState>(createInitialState);
  // 云模式账号域事实（2026-10-09 修订）：已有任务/项目即不是 first-run——迁移向导
  // （本 hook 的唯一消费方 OnboardingDialog）的自动弹出必须与 OccupationOnboarding
  // 触发器服从同一短路（此前探测只接了后者，向导挂载时机上短路不生效）。非云模式
  // 返回 null 判定不变；探测有会话级缓存与超时兜底，不新增常驻 RPC。
  const cloudAccountHasActivity = useCloudAccountHasActivity();
  // 关闭持久化的回落写入通道（2026-10-09 修订）：settingService 直写与
  // settingsSyncService.markFirstRunPromptHandled 同一个 AppSettings 字段。
  const { update: updateAppSettings } = useSettings();

  const loadDiscovery = useCallback(
    async (intent: LoadDiscoveryIntent = "firstRun") => {
      if (!params.workspacePath) {
        return;
      }

      setState((current) => ({
        ...current,
        loading: true,
        error: null,
      }));

      try {
        const rawDiscovery = await settingsSyncService.detect({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        });
        const discovery = normalizeDiscovery(rawDiscovery);
        if (discovery.agents.length === 0) {
          if (intent === "manual") {
            // 设置页点「引导」会 reopen 并补跑 detect；空结果沿用首启逻辑会把 open 重置为 false，
            // 用户会看到弹窗一闪即关。手动打开应保留欢迎页，让用户仍可走会话迁移等流程。
            setState((current) => ({
              ...current,
              open: true,
              loading: false,
              step: "selection",
              discovery,
              selectedKeys: [],
              tasks: [],
              result: null,
              error: null,
            }));
            logger.info("[settings-sync] discovery empty, keep onboarding open (manual)", {
              workspacePath: params.workspacePath,
            });
            return;
          }
          // 去掉三方 agent 迁移后，首启检测会返回空结果。
          // 空结果不应打开一个没有可操作项的 onboarding 弹窗，应直接标记为已处理。
          await settingsSyncService.markFirstRunPromptHandled();
          setState(createInitialState());
          logger.info("[settings-sync] discovery empty, prompt handled", {
            workspacePath: params.workspacePath,
          });
          return;
        }
        const selectedKeys = buildDefaultSelectedKeys(discovery);
        setState((current) => ({
          ...current,
          open: true,
          loading: false,
          step: "selection",
          discovery,
          selectedKeys,
          tasks: [],
          result: null,
          error: null,
        }));
        logger.info("[settings-sync] discovery loaded", {
          workspacePath: params.workspacePath,
          agentCount: discovery.agents.length,
          selectedCount: selectedKeys.length,
        });
      } catch (error) {
        const message = normalizeError(error);
        logger.error("[settings-sync] discovery failed", {
          workspacePath: params.workspacePath,
          error: message,
        });
        if (intent === "manual") {
          // 设置页显式打开时保留弹窗呈现错误，用户需要看到失败原因。
          setState((current) => ({
            ...current,
            open: true,
            loading: false,
            error: message,
          }));
          return;
        }
        // firstRun 意图的 detect 失败按 fail-closed 收敛（2026-10-09 修订）：自动弹出
        // 首启向导的每个失败路径都必须落为「不弹」——否则与关闭持久化失败组合成
        // 「每次刷新必弹、关闭无效」死循环。保持关闭，等下一次显式入口。
        setState(createInitialState());
      }
    },
    [params.workspaceIdentity, params.workspacePath, settingsSyncService],
  );

  useEffect(() => {
    if (!params.workspacePath) {
      setState(createInitialState());
      return;
    }

    if (FORCE_SHOW_ONBOARDING_ON_EVERY_REFRESH) {
      void loadDiscovery();
      return;
    }

    let cancelled = false;

    // 决策与失败语义集中在 runSettingsSyncFirstRunPromptBootstrap（可单测）：
    // handled / 账号事实短路 / pending 等待 / 读取失败 fail-closed。
    void runSettingsSyncFirstRunPromptBootstrap({
      cloudAccountHasActivity,
      getFirstRunPromptState: () => settingsSyncService.getFirstRunPromptState(),
      loadDiscovery,
      settleClosed: () => {
        if (!cancelled) {
          setState(createInitialState());
        }
      },
      logUnavailable: (error) => {
        logger.warn("[settings-sync] first run prompt state unavailable, keep prompt closed", {
          workspacePath: params.workspacePath,
          error: normalizeError(error),
        });
      },
    }).catch((error) => {
      // loadDiscovery 自身已内置错误处理（manual 保留弹窗 / firstRun 收敛关闭），
      // 这里只是防御未预期异常，避免 unhandled rejection。
      logger.warn("[settings-sync] first run prompt bootstrap failed unexpectedly", {
        workspacePath: params.workspacePath,
        error: normalizeError(error),
      });
    });

    return () => {
      cancelled = true;
    };
  }, [cloudAccountHasActivity, loadDiscovery, params.workspacePath, settingsSyncService]);

  const selectedCount = state.selectedKeys.length;
  const taskProgress = useMemo(() => {
    if (state.tasks.length === 0) return 0;
    const completedCount = state.tasks.filter(
      (task) => task.status !== "pending" && task.status !== "running",
    ).length;
    return Math.round((completedCount / state.tasks.length) * 100);
  }, [state.tasks]);

  const close = useCallback(() => {
    runningImportRef.current += 1;
    setState((current) => ({ ...current, open: false, importing: false }));
    if (FORCE_SHOW_ONBOARDING_ON_EVERY_REFRESH) {
      return;
    }
    // “关闭 onboarding”本身就表示用户已经处理过这次首启提示，
    // 无论是直接开始还是跳过迁移，都应该立刻落库，避免下次启动再次重复弹出。
    // 持久化语义（2026-10-09 修订）集中在 persistSettingsSyncFirstRunHandled：
    // RPC 失败回落 settingService 直写同一键，云模式下关闭也跨刷新持久。
    void persistSettingsSyncFirstRunHandled({
      markHandledViaRpc: () => settingsSyncService.markFirstRunPromptHandled(),
      writeSettingFallback: () => updateAppSettings(FIRST_RUN_PROMPT_HANDLED_SETTING_PATCH),
    }).catch((error) => {
      logger.error("[settings-sync] mark first run prompt handled failed", {
        workspacePath: params.workspacePath,
        error: normalizeError(error),
      });
    });
  }, [params.workspacePath, settingsSyncService, updateAppSettings]);

  const reopen = useCallback(() => {
    setState((current) => {
      if (!current.discovery && !current.loading && params.workspacePath) {
        // 设置页里的“重新打开 onboarding”可能发生在首启提示已处理之后。
        // 这时本地状态已经回到初始态；如果只把 open 设成 true，用户会看到一个没有 discovery 数据的空弹窗。
        // 这里在缺少数据时主动补一次检测，保证从设置页进入仍然能拿到完整可迁移内容。
        void loadDiscovery("manual");
      }
      return { ...current, open: true };
    });
  }, [loadDiscovery, params.workspacePath]);

  const toggleSelection = useCallback((key: string) => {
    setState((current) => {
      const set = new Set(current.selectedKeys);
      if (set.has(key)) {
        set.delete(key);
      } else {
        set.add(key);
      }
      return {
        ...current,
        selectedKeys: [...set],
      };
    });
  }, []);

  const setAgentSelection = useCallback((agent: string, checked: boolean) => {
    setState((current) => {
      if (!current.discovery) {
        return current;
      }
      const next = new Set(current.selectedKeys);
      const targetAgent = current.discovery.agents.find((item) => item.agent === agent);
      if (!targetAgent) {
        return current;
      }
      for (const category of targetAgent.categories) {
        const key = getSelectionKey(agent, category.category);
        if (checked) {
          next.add(key);
        } else {
          next.delete(key);
        }
      }
      return {
        ...current,
        selectedKeys: [...next],
      };
    });
  }, []);

  const setCategorySelectionAllAgents = useCallback(
    (category: SettingsSyncCategory, checked: boolean) => {
      setState((current) => {
        if (!current.discovery) {
          return current;
        }
        const next = new Set(current.selectedKeys);
        for (const agentSummary of current.discovery.agents) {
          if (!agentSummary.categories.some((c) => c.category === category)) {
            continue;
          }
          const key = getSelectionKey(agentSummary.agent, category);
          if (checked) {
            next.add(key);
          } else {
            next.delete(key);
          }
        }
        return {
          ...current,
          selectedKeys: [...next],
        };
      });
    },
    [],
  );

  const startImportWithAdditionalSelections = useCallback(
    async (
      additionalSelections: SettingsSyncSelection[] = [],
      options: { includeCurrentSelections?: boolean } = {},
    ) => {
      if (!params.workspacePath) {
        return;
      }

      const includeCurrentSelections = options.includeCurrentSelections ?? true;
      // 数据迁移向导可临时隐藏代理设置步骤；隐藏时不能把默认选中的 providers 暗中导入。
      const stateSelections =
        includeCurrentSelections && state.discovery ? buildStateSelections(state.selectedKeys) : [];
      const selections: SettingsSyncSelection[] = [...stateSelections, ...additionalSelections];
      if (selections.length === 0) {
        return;
      }
      const runId = runningImportRef.current + 1;
      runningImportRef.current = runId;
      const initialTasks =
        state.discovery && includeCurrentSelections
          ? [
              ...buildTasks(state.discovery, state.selectedKeys),
              ...buildTasksFromSelections(additionalSelections),
            ]
          : buildTasksFromSelections(selections);

      setState((current) => ({
        ...current,
        importing: true,
        step: "importing",
        tasks: initialTasks,
        result: null,
        error: null,
      }));

      logger.info("[settings-sync] import started", {
        workspacePath: params.workspacePath,
        selections,
      });

      const importPromise = settingsSyncService.importSelected({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        selections,
      });

      for (let index = 0; index < initialTasks.length; index += 1) {
        if (runningImportRef.current !== runId) {
          return;
        }
        const task = initialTasks[index];
        if (!task) {
          continue;
        }
        setState((current) => ({
          ...current,
          tasks: current.tasks.map((item) =>
            item.id === task.id ? { ...item, status: "running" } : item,
          ),
        }));
        await new Promise((resolve) => setTimeout(resolve, IMPORTING_TASK_DELAY_MS));
      }

      try {
        const result = await importPromise;
        if (runningImportRef.current !== runId) {
          return;
        }

        if (selections.some((selection) => selection.category === "skills")) {
          await invalidateDeferredDraftSessionForSkillChange({
            zcodeSessionService,
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
            reason: "settings-sync-skill-import",
          });
        }

        setState((current) => ({
          ...current,
          importing: false,
          step: "complete",
          result,
          tasks: applyTaskResults(current.tasks, result),
        }));
        logger.info("[settings-sync] import completed", {
          workspacePath: params.workspacePath,
          result,
        });
      } catch (error) {
        const message = normalizeError(error);
        if (runningImportRef.current !== runId) {
          return;
        }
        logger.error("[settings-sync] import failed", {
          workspacePath: params.workspacePath,
          error: message,
        });
        setState((current) => ({
          ...current,
          importing: false,
          step: "complete",
          error: message,
          tasks: current.tasks.map((task) => ({ ...task, status: "failed" })),
          result: {
            successCount: 0,
            skippedCount: 0,
            failedCount: current.tasks.length,
            taskResults: current.tasks.map((task) => ({
              agent: task.agent,
              category: task.category,
              status: "failed" as const,
              importedCount: 0,
              skippedCount: 0,
              failedCount: 1,
            })),
          },
        }));
      }
    },
    [
      params.workspaceIdentity,
      params.workspacePath,
      settingsSyncService,
      zcodeSessionService,
      state.discovery,
      state.selectedKeys,
    ],
  );

  const startImport = useCallback(async () => {
    await startImportWithAdditionalSelections();
  }, [startImportWithAdditionalSelections]);

  const finish = useCallback(() => {
    close();
  }, [close]);

  return {
    state,
    selectedCount,
    taskProgress,
    actions: {
      close,
      reopen,
      reloadDiscovery: loadDiscovery,
      toggleSelection,
      setAgentSelection,
      setCategorySelectionAllAgents,
      startImport,
      startImportWithAdditionalSelections,
      finish,
    },
  };
}
