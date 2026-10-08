/**
 * 云模式 first-run 引导的账号域事实（2026-10-08 巡检修订 P2）。
 *
 * 背景：云模式下 onboarding record 按 deviceMid 记录，浏览器「首跑」判定与账号实际
 * 使用事实可能脱节（实测：已有任务+run 的账号 reload 后仍弹 Welcome，关闭也不持久）。
 * 账号已有任务/项目 → 不是 first-run，引导不触发。
 */
import type { AppSettings } from "@zcode/shared";
import { logger } from "@/logger.js";
import { useCloudWorkspaceContext } from "@/cloud/cloudWorkspaceContext.js";
import { useCloudTasksStore } from "@/store/cloud/cloudTasksStore.js";

/**
 * 云模式下账号是否已有使用事实（任务详情缓存或项目任务列表任一非空）；
 * 非云模式返回 null（引导判定保持原语义）。
 */
export function useCloudAccountHasActivity(): boolean | null {
  const cloudContext = useCloudWorkspaceContext();
  const hasActivity = useCloudTasksStore(
    (state) =>
      Object.keys(state.detailByTask).length > 0 ||
      Object.values(state.itemsByProject).some((items) => items.length > 0),
  );
  return cloudContext ? hasActivity : null;
}

/**
 * 关闭持久化兜底（2026-10-08 巡检修订 P2）：record 服务不可用时关闭只改本地 state，
 * reload 后引导再次弹出。回落 settings 的「跳过」保守默认（与 save(skip=true) 同一组
 * 值），仅在该用户从未作答时写入，不覆盖既有答案。
 */
export function persistOnboardingDismissalFallback(options: {
  update: (patch: Partial<AppSettings>) => Promise<void>;
  hasStoredOccupation: boolean;
}): void {
  if (options.hasStoredOccupation) {
    return;
  }
  void options.update({ onboardingOccupation: "other" }).catch((cause: unknown) => {
    logger.warn("[occupation-onboarding] 关闭决策回落 settings 写入失败", {
      error: String(cause),
    });
  });
}
