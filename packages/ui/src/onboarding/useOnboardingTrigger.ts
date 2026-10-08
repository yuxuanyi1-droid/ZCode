import { useEffect, useRef, useState } from "react";
import type { AppSettings } from "@zcode/shared";
import type { useOnboardingRecordService } from "@/hooks/useOnboardingRecordService.js";
import { logger } from "@/logger.js";

/**
 * 会话级「本次已关闭」标记（2026-10-07 终验缺陷 F）：Close 的持久化写入
 * （record / settings）失败时，至少当次会话不再弹——组件 state 会随重挂载丢失，
 * 模块级标记不会。Close（含 Esc）必须调用 markOnboardingDismissedThisSession。
 */
let dismissedThisSession = false;

export function markOnboardingDismissedThisSession(): void {
  dismissedThisSession = true;
}

/** 读取会话级关闭标记（触发判定与测试共用）。 */
export function isOnboardingDismissedThisSession(): boolean {
  return dismissedThisSession;
}

/**
 * 会话级「本次已自动弹出」标记（2026-10-07 复核缺陷 3）：自动触发 resolved true 时置位。
 * Root 重挂载会换一套组件 state（dismissed/needsOnboarding 全部复位），没有这个标记时
 * 新实例会再走一遍 record 判定、再次自动弹出——同一页面弹两次的最后一环。只在
 * **自动**触发解析点检查；快捷键/设置页的 `requested` 手动打开不经过这里，不受影响。
 */
let autoShownThisSession = false;

export function markOnboardingAutoShownThisSession(): void {
  autoShownThisSession = true;
}

/** 读取会话级自动弹出标记（触发判定与测试共用）。 */
export function isOnboardingAutoShownThisSession(): boolean {
  return autoShownThisSession;
}

/**
 * 触发判定的**决策步**（纯函数，node:test 直接覆盖；effect 只负责执行）：
 * - `settled`：判定完成，把 needsOnboarding 定为给定值；
 * - `wait`：云模式账号事实未定（探测进行中），保持 null 继续等待（有超时兜底）；
 * - `record-path`：进入 record RPC 判定（认领 → shouldOnboard，含 3s 超时回落）。
 */
export type OnboardingDecisionStep =
  | { readonly kind: "settled"; readonly needsOnboarding: boolean }
  | { readonly kind: "wait" }
  | { readonly kind: "record-path" };

export function resolveOnboardingDecisionStep(input: {
  cloudAccountHasActivity: boolean | null | "pending";
  sessionDismissed: boolean;
  recordServiceAvailable: boolean;
  hasStoredOccupation: boolean;
}): OnboardingDecisionStep {
  // 本次会话已显式关闭（Close 持久化可能失败）：不再触发（缺陷 F「至少当次会话不再弹」）。
  if (input.sessionDismissed) {
    return { kind: "settled", needsOnboarding: false };
  }
  // 云模式账号域已有使用事实（已有任务/项目）：first-run 引导不弹（2026-10-08 巡检
  // 修订 P2）。同步短路，不进入 record RPC 等待窗口，杜绝判定期间的闪弹。
  if (input.cloudAccountHasActivity === true) {
    return { kind: "settled", needsOnboarding: false };
  }
  // 云模式账号事实未定（探测进行中）：保持判定中等待事实，不进入 record RPC——
  // 事实若为「已有活动」会直接短路；探测有超时兜底，不会永久挂起（缺陷 F）。
  if (input.cloudAccountHasActivity === "pending") {
    return { kind: "wait" };
  }
  // 服务不可用（旧测试 double / 未注册的 host）时退回旧 settings 判定，行为不回退。
  if (!input.recordServiceAvailable) {
    return { kind: "settled", needsOnboarding: !input.hasStoredOccupation };
  }
  return { kind: "record-path" };
}

export function useOnboardingTrigger(options: {
  onboardingRecord: ReturnType<typeof useOnboardingRecordService>;
  userId: string | null;
  hasStoredOccupation: boolean;
  /**
   * 云模式下「账号已有使用事实」（已有任务/项目）；非云模式传 null（判定不变）。
   * true 时直接跳过 first-run 引导，不等待 record RPC。
   * "pending"（2026-10-07 终验缺陷 F 修订）：云模式账号事实未定（探测进行中）——
   * 保持判定中，不提前定为「需要引导」，避免事实（已有任务）到达前闪弹引导。
   */
  cloudAccountHasActivity: boolean | null | "pending";
  loadDeviceMid: () => string;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}): [boolean | null, () => void] {
  const {
    onboardingRecord,
    userId,
    hasStoredOccupation,
    cloudAccountHasActivity,
    loadDeviceMid,
    update,
  } = options;
  // null 表示异步判定中（按本地使用记录判断是否触发）。
  const [needsOnboarding, setNeedsOnboarding] = useState<boolean | null>(null);
  // 记录上一次判定时的 userId，回填只在身份实际变化后发生（见下方回填条件）。
  const lastSyncedUserIdRef = useRef<string | null | undefined>(undefined);
  /**
   * 复核缺陷 3：自动触发的去重闸门统一放在解析点（状态函数式更新）——
   * - 本实例已在展示（prev=true）：保持展示，登录态/事实变化重判不把向导收走；
   * - 本会话已有实例自动弹出过（Root 重挂载后的新实例 state 全部复位）：不再自动弹；
   * - 首次解析且结果为 true：置会话级标记并展示。
   * 手动打开（requested / 快捷键 / 设置页）不经过 needsOnboarding，不受影响。
   */
  const settleAutoDecision = (value: boolean): void => {
    setNeedsOnboarding((prev) => {
      if (prev === true) return true;
      if (isOnboardingAutoShownThisSession()) return false;
      if (value) markOnboardingAutoShownThisSession();
      return value;
    });
  };
  useEffect(() => {
    let cancelled = false;
    const fallback = () => !hasStoredOccupation;
    // 决策步纯函数化（缺陷 F 修订）：会话关闭标记 / 账号事实短路 / pending 等待 /
    // record 判定路径的先后与条件集中在 resolveOnboardingDecisionStep（可单测），
    // effect 只负责执行。
    const step = resolveOnboardingDecisionStep({
      cloudAccountHasActivity,
      sessionDismissed: isOnboardingDismissedThisSession(),
      recordServiceAvailable: onboardingRecord != null,
      hasStoredOccupation,
    });
    if (step.kind === "settled") {
      settleAutoDecision(step.needsOnboarding);
      return;
    }
    if (step.kind === "wait") {
      return;
    }
    // record-path：决策步已按 recordServiceAvailable 判定服务可用；TS 无法从纯函数
    // 参数收窄外层变量，用局部值 + 显式 guard 保持同一事实（不可能分支按 settings 回落）。
    const recordService = onboardingRecord;
    if (!recordService) {
      settleAutoDecision(fallback());
      return;
    }
    // shouldOnboard 走 RPC，host 未带上 onboarding-record channel 时调用会挂起，
    // 之前判定期间渲染 null 会把整个主界面拦成永久黑屏。加超时兜底退回 settings 判定，
    // 保证任何情况下主界面最多等 3 秒。
    const timeout = setTimeout(() => {
      if (!cancelled) {
        logger.warn("[occupation-onboarding] shouldOnboard 超时，退回 settings 判定");
        settleAutoDecision(fallback());
      }
    }, 3000);
    // 登录认领先行：未登录时答的引导（null 条目）移交给当前登录用户，同一人不重复引导。
    // 必须 await 完成后再判定，否则 shouldOnboard 读到认领前的文件会误判需要引导。
    recordService
      .claimAnonymousRecord()
      .catch((cause: unknown) => {
        logger.warn("[occupation-onboarding] 认领匿名引导记录失败", { error: String(cause) });
      })
      .then(() => recordService.shouldOnboard(loadDeviceMid()))
      .then(
        (result) => {
          if (!cancelled) {
            settleAutoDecision(result);
          }
          // 换账号恢复该用户偏好：settings 不分用户，A 答完后 B 触发引导会把 settings 顶成
          // B 的答案；再切回 A 时按 record 最近作答回填。同步失败只留日志。
          // 仅"上次是非空的另一身份"时回填（A→B 直切、B→登出）。null→id 不回填：启动 OAuth
          // 恢复与运行中登录共用该序列且无法区分，宁可少回填——手动修改已由各入口回写
          // record（record=最新偏好），缺失回填只影响"apikey 态后登录旧账号"这类边缘场景。
          const previousUserId = lastSyncedUserIdRef.current;
          lastSyncedUserIdRef.current = userId;
          if (!cancelled && !result && previousUserId != null && previousUserId !== userId) {
            void recordService
              .syncSettingsFromRecord()
              .then((patch) => {
                if (cancelled || !patch) return;
                return update(patch);
              })
              .catch((cause: unknown) => {
                logger.warn("[occupation-onboarding] 按记录同步偏好失败", {
                  error: String(cause),
                });
              });
          }
        },
        (cause) => {
          logger.warn("[occupation-onboarding] shouldOnboard 检查失败", { error: String(cause) });
          if (!cancelled) settleAutoDecision(fallback());
        },
      )
      .finally(() => clearTimeout(timeout));
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
    // 不依赖 hasStoredOccupation（对应 settings?.onboardingOccupation）：保存成功会改写该字段，
    // 若记录写入失败会在当场重开引导；记录缺失导致的再次触发按约定留给下次启动。
  }, [cloudAccountHasActivity, onboardingRecord, userId, loadDeviceMid]);
  return [needsOnboarding, () => setNeedsOnboarding(false)];
}
