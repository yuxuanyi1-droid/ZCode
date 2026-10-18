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
 * - 其余带 `remote:` 标记但无法解析的 identity 同样拒绝，不落回本地路径；
 * - `cloud-task:<taskId>` 是不透明身份（不含路径），必须由 createSession payload 显式
 *   携带可信 `workspacePath`；缺失即拒绝，绝不把 identity 当本地目录（02 §2）。
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

  if (classification.kind === "cloud-task") {
    // 修复依据（2026-10-13 V4r 真机联调）：cloud-task 曾落入本地路径 fallback，
    // workingDirectory 被解析成 `<cwd>/cloud-task:<taskId>`（不存在），沙箱内 bash
    // spawn ENOENT / Read 失败。cloud-task 不含路径，必须显式携带 workspacePath。
    throw new Error(
      `Cloud task workspace identity requires an explicit workspacePath: ${workspaceId}`,
    );
  }

  if (classification.kind === "invalid-remote") {
    // 非法 remote / cloud-task identity 若继续按本地路径处理，会再次把 identity 写入
    // directory/path。两类不透明命名空间都必须 fail-closed，本地路径仍保留原 fallback。
    throw new Error(
      workspaceId.startsWith("cloud-task:")
        ? `Invalid cloud-task workspace identity: ${workspaceId}`
        : `Invalid remote workspace identity: ${workspaceId}`,
    );
  }

  return buildWorkspaceRef({ workspacePath: workspaceId });
}

/**
 * createSession payload → workspace ref（specs/cloud-agent/02 §2）。
 *
 * 控制面/可信发送端携带 `workspacePath`（绝对路径）时：identity 原样保留
 * （workspaceKey / 隔离语义不变），workingDirectory 使用可信路径；缺省时回落
 * `resolveWorkspaceRefFromId`（本地路径/remote 身份语义不变，旧发送端 additive 兼容）。
 */
export function resolveWorkspaceRefFromCreateSession(input: {
  workspaceId: string;
  workspacePath?: string;
}): ZCodeWorkspaceRef {
  if (input.workspacePath) {
    return buildWorkspaceRef({
      workspaceIdentity: input.workspaceId,
      workspacePath: input.workspacePath,
    });
  }
  return resolveWorkspaceRefFromId(input.workspaceId);
}
