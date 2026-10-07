import type { IZCodeAgentService } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

export function useZCodeAgentService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeAgentService {
  // 修复：与 useZCodeTaskService / useZCodeSessionService 同因——hook 调用必须恒定。
  // 云任务 ready 前 workspacePath 为空、ready 后才有真实 checkout 路径，条件分支会让同一个
  // 已挂载组件在两次渲染间增减十来个 hook slot，后续 hook 错位并抛 TypeError。
  // 条件只决定取哪份 services。
  const contextServices = useServices();
  const workspaceServices = useWorkspaceServices(
    workspacePath ?? null,
    preferredRemoteSessionId,
    workspaceIdentity,
  );
  return (workspacePath ? workspaceServices : contextServices).zcodeAgentService;
}
