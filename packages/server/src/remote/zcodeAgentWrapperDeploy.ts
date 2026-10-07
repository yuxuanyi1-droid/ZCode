import type { IRemoteBackend } from "@zcode/server/remote/backend.js";
import {
  buildRemoteExecutableReplaceCommand,
  waitForClose,
} from "@zcode/server/remote/deployShared.js";
import { buildWriteLiteralFileCommand } from "@zcode/server/remote/posixShell.js";

/**
 * 写入远端 agent wrapper。Docker/WSL 远端目标退役后，原先按 backend kind 分支的
 * 字节上传路径（`wsl.exe -- bash -lc` 会提前展开多行参数）随之删除，
 * SSH 统一走远端 shell 写入路径。
 */
export async function deployRemoteAgentWrapper(params: {
  backend: IRemoteBackend;
  content: string;
  remoteWrapperPath: string;
}): Promise<void> {
  const remoteWrapperTempPath = `${params.remoteWrapperPath}.new`;
  const stream = await params.backend.exec(
    [
      buildWriteLiteralFileCommand(remoteWrapperTempPath, params.content),
      buildRemoteExecutableReplaceCommand(remoteWrapperTempPath, params.remoteWrapperPath),
    ].join(" && "),
  );
  await waitForClose(stream);
}
