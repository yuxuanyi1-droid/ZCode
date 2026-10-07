import type { IZCodeSessionService } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

export function useZCodeSessionService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeSessionService {
  // 修复：这里原来按 `workspacePath ? useWorkspaceServices(...) : useServices()` 条件调用 hook。
  // 两条分支的 hook 数量并不相等：`useWorkspaceServices` 会读 tab store 与 remote session
  // store（十来个 hook slot），`useServices` 只是读 context（0 个 slot）。
  // 云任务是同一个已挂载的 App 先以 `workspaceShellPath=""`（run ready 前没有 checkout 路径，
  // 见 `rootWorkspaceShellTarget.ts`）渲染，ready 后同一 tab 的 workspacePath 变成真实路径，
  // 于是 App 在两次渲染间从「0 个 slot」切到「十来个 slot」，后续 hook 全部错位。
  // 错位后的 zustand `useStore`（内部的 useCallback）会拿到上一轮落在该 slot 上的
  // `useState(null)` / `useEffect` 状态，直接抛 TypeError，App 整块渲染失败 → 右侧工作区空白
  // （桌面/本地 web 的工作区外壳挂载时路径已是真值，所以只有云路径稳定复现）。
  // 修法：hook 调用本身必须恒定，条件只作用在「取哪份 services」这个渲染结果上。
  const contextServices = useServices();
  const workspaceServices = useWorkspaceServices(
    workspacePath ?? null,
    preferredRemoteSessionId,
    workspaceIdentity,
  );
  // 无 workspacePath 时保持旧语义：不按 workspace 目标解析，直接用当前 context 的 services。
  return (workspacePath ? workspaceServices : contextServices).zcodeSessionService;
}
