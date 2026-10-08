/**
 * 云模式 first-run 引导的账号域事实（2026-10-08 巡检修订 P2、2026-10-07 终验缺陷 F 修订）。
 *
 * 背景：云模式下 onboarding record 按 deviceMid 记录，浏览器「首跑」判定与账号实际
 * 使用事实可能脱节（实测：已有任务+run 的账号 reload 后仍弹 Welcome，关闭也不持久）。
 * 账号已有任务/项目 → 不是 first-run，引导不触发。
 *
 * 缺陷 F 根因（实测复发 3 次）：原实现只读 cloudTasksStore 缓存，而该缓存由侧栏
 * （RootWorkspaceContent 子树）写入——OccupationOnboarding 在引导可见时**不渲染
 * children**，缓存永远没有被写入的机会，「缓存即用」短路永不命中。修订：云模式下
 * 缓存未命中时**主动经控制面探测一次**账号事实（listProjects → 逐项目 listProjectTasks
 * 首页，每次挂载至多一轮）；触发评估在事实未定（pending）期间保持判定中，不定为
 * 「需要引导」。探测有超时兜底，失败按「无账号事实」回落 record 判定路径（不猜）。
 *
 * 复发修订（2026-10-07 复核缺陷 3，页面加载后偶发弹 2 次）：
 * - 探测失败不再单次定死：页面加载早期控制面 RPC 通道可能未就绪，失败按 1s 重试
 *   （至多 3 次），重试期间保持 pending（pending 期间判定为 null，绝不渲染向导）；
 * - 探测缓存提升为会话级（模块级 promise）：Root 重挂载不再各自重探、不再把「通道
 *   未就绪的失败」分别缓存成 false；配合 useOnboardingTrigger 的会话级 auto-shown
 *   标记，同一页面至多自动弹出一次向导。
 */
import { useEffect, useState } from "react";
import type { AppSettings } from "@zcode/shared";
import { logger } from "@/logger.js";
import { useCloudWorkspaceContext } from "@/cloud/cloudWorkspaceContext.js";
import { useCloudTasksStore } from "@/store/cloud/cloudTasksStore.js";
import type { CloudControlPlanePort } from "@/cloud/cloudPorts.js";

/** 账号活动事实：null=非云模式（判定语义不变）；"pending"=云模式事实未定（触发器等待）。 */
export type CloudAccountActivityFact = boolean | null | "pending";

/** store 里已有账号使用事实（任务详情缓存或任一项目任务列表非空）。 */
function selectStoreHasActivity(state: {
  detailByTask: Record<string, unknown>;
  itemsByProject: Record<string, readonly unknown[]>;
}): boolean {
  return (
    Object.keys(state.detailByTask).length > 0 ||
    Object.values(state.itemsByProject).some((items) => items.length > 0)
  );
}

/**
 * 探测超时（毫秒）：账号事实探测超过该时限按「无事实」回落 record 判定路径，
 * 不让 first-run 判定无限等待（与 record RPC 的 3s 超时兜底同一思路）。
 */
export const CLOUD_ACCOUNT_ACTIVITY_PROBE_TIMEOUT_MS = 5_000;

/** 单页项目/任务列表跟进 cursor 的上限：探测只为回答「有没有」，不遍历全量。 */
const PROBE_MAX_PAGES = 5;

/**
 * 账号事实探测（纯异步，node:test 可注入 fake port 覆盖）：任一项目有任务即 true。
 * 只读第一页（探测语义是「存在」，不需要全量）；失败向上抛出，由调用方回落。
 */
export async function probeCloudAccountHasActivity(port: CloudControlPlanePort): Promise<boolean> {
  let projectCursor: string | undefined;
  for (let page = 0; page < PROBE_MAX_PAGES; page += 1) {
    const projects = await port.listProjects(projectCursor ? { cursor: projectCursor } : undefined);
    for (const project of projects.items) {
      const tasks = await port.listProjectTasks(project.projectId);
      if (tasks.items.length > 0) {
        return true;
      }
    }
    projectCursor = projects.nextCursor;
    if (!projectCursor) {
      return false;
    }
  }
  return false;
}

/** 探测失败重试参数：页面加载早期控制面 RPC 通道可能未就绪，单次失败不该定死「无事实」。 */
export const CLOUD_ACTIVITY_PROBE_MAX_ATTEMPTS = 3;
export const CLOUD_ACTIVITY_PROBE_RETRY_DELAY_MS = 1_000;

/**
 * 带重试的账号事实探测（缺陷 F 复发修订）：失败按 1s 间隔重试，最多 3 次尝试；
 * 重试期间调用方保持 pending（不渲染向导）。全部失败才向上抛出回落。
 */
export async function probeCloudAccountHasActivityWithRetry(
  port: CloudControlPlanePort,
  options?: {
    readonly maxAttempts?: number;
    readonly delayMs?: number;
    readonly sleep?: (ms: number) => Promise<void>;
  },
): Promise<boolean> {
  const maxAttempts = options?.maxAttempts ?? CLOUD_ACTIVITY_PROBE_MAX_ATTEMPTS;
  const delayMs = options?.delayMs ?? CLOUD_ACTIVITY_PROBE_RETRY_DELAY_MS;
  const sleep = options?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await probeCloudAccountHasActivity(port);
    } catch (cause) {
      if (attempt >= maxAttempts) {
        throw cause;
      }
      await sleep(delayMs);
    }
  }
}

/**
 * 会话级探测缓存（缺陷 F 复发修订）：同一页面生命周期只探测一轮（含内部重试），
 * 重挂载/换入口复用同一事实——此前 per-instance ref 在 Root 重挂载时会重复探测，
 * 通道未就绪的失败还会被各自缓存成 false，让同一页面先后弹出两次向导。
 * 探测失败（重试耗尽）按 false 收敛并缓存——回落 record 判定路径，不让每次渲染重发。
 */
let sessionProbe: Promise<boolean> | null = null;

export function useCloudAccountHasActivity(options?: {
  /** 引导判定不需要账号事实时（已作答过）不发起探测，省两条控制面 RPC。 */
  readonly enabled?: boolean;
}): CloudAccountActivityFact {
  const enabled = options?.enabled !== false;
  const cloudContext = useCloudWorkspaceContext();
  const storeHasActivity = useCloudTasksStore(selectStoreHasActivity);
  // null=未探测（缓存已命中 / 非云 / 未启用）；true/false=探测已定。
  const [probed, setProbed] = useState<boolean | null>(null);
  const controlPlane = cloudContext?.controlPlane ?? null;
  const shouldProbe = cloudContext !== null && enabled && !storeHasActivity && probed === null;

  useEffect(() => {
    if (!shouldProbe || !controlPlane) {
      return;
    }
    sessionProbe ??= probeCloudAccountHasActivityWithRetry(controlPlane).catch((cause: unknown) => {
      logger.warn("[occupation-onboarding] 账号事实探测失败（含重试），回落 record 判定", {
        error: String(cause),
      });
      return false;
    });
    const probe = sessionProbe;
    let cancelled = false;
    const timeout = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), CLOUD_ACCOUNT_ACTIVITY_PROBE_TIMEOUT_MS);
    });
    void Promise.race([
      probe.then((hasActivity): "has-activity" | "no-activity" =>
        hasActivity ? "has-activity" : "no-activity",
      ),
      timeout,
    ]).then((outcome) => {
      if (cancelled) {
        return;
      }
      if (outcome === "timeout") {
        // 超时兜底：先按「无事实」放行 record 判定路径（有界等待）；真实结果稍后
        // 到达时仍回写——账号确有活动则把已误弹的引导判定收回（needsOnboarding→false）。
        setProbed(false);
        void probe.then((hasActivity) => {
          if (!cancelled && hasActivity) {
            setProbed(true);
          }
        });
        return;
      }
      setProbed(outcome === "has-activity");
    });
    return () => {
      cancelled = true;
    };
  }, [controlPlane, shouldProbe]);

  if (cloudContext === null) {
    return null;
  }
  if (storeHasActivity) {
    return true;
  }
  return probed === null ? "pending" : probed;
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
