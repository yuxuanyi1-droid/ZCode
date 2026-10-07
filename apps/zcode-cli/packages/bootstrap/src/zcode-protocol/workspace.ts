import { classifyWorkspaceIdentity, type ZCodeWorkspaceRef } from "@zcode/shared";

export function buildWorkspaceRef(input: {
  workspaceIdentity?: string;
  workspacePath: string;
}): ZCodeWorkspaceRef {
  const workspaceIdentity = input.workspaceIdentity?.trim() || undefined;
  return {
    workspaceIdentity,
    workspaceKey: workspaceIdentity ?? input.workspacePath,
    workspacePath: input.workspacePath,
  };
}

/**
 * 将 V4 workspaceId 的本地路径/远程 identity 双形态统一还原为 workspace ref。
 *
 * 远端命名空间 fail-closed（specs/cloud-agent/06 §4）：
 * - `remote:ssh:...` 还原真实 workspacePath（CLI 本就跑在远端机器上，path 即本机路径）；
 * - `remote:wsl:/docker:` 是已退役远端身份，不能按本地 workspacePath 执行，直接拒绝；
 * - 其余带 `remote:` 标记但无法解析的 identity 同样拒绝，不落回本地路径。
 */
export function resolveWorkspaceRefFromId(workspaceId: string): ZCodeWorkspaceRef {
  const classification = classifyWorkspaceIdentity(workspaceId);

  if (classification.kind === "retired-remote") {
    // 退役目标不启动 Agent / 不打开本地同路径；身份原样带出便于调用方记录。
    throw new Error(
      `Remote target retired: ${classification.identity.kind} workspace identity is no longer supported`,
    );
  }

  if (classification.kind === "remote") {
    // 带显式 user 的旧 identity 以前解析失败后会落入本地路径分支，
    // 使完整 identity 被当成 workingDirectory。这里统一通过 shared parser 拆分身份与路径。
    return buildWorkspaceRef({
      workspaceIdentity: workspaceId,
      workspacePath: classification.identity.workspacePath,
    });
  }

  if (workspaceId.startsWith("remote:")) {
    // 非法 remote identity 若继续按本地路径处理，会再次把 identity 写入
    // directory/path。remote 命名空间必须 fail-closed，本地路径仍保留原 fallback。
    throw new Error(`Invalid remote workspace identity: ${workspaceId}`);
  }

  // local（含 cloud-task 等不透明 identity）：保持原路径 fallback 语义。
  return buildWorkspaceRef({ workspacePath: workspaceId });
}
