import { useCallback } from "react";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getContainingDirectoryPath } from "@/lib/path.js";
import { logger } from "@/logger.js";

interface FileContextActionOptions {
  canOpenLocalFileManager?: boolean;
  isRemoteWorkspace?: boolean;
  openFailedMessage?: string;
}

interface FileContextActionTarget {
  path: string;
  relativePath?: string;
  deleted?: boolean;
  kind?: "file" | "directory";
}

function resolveFileManagerOpenPath(target: FileContextActionTarget): string {
  if (target.kind === "directory") {
    return target.path;
  }

  // 交互语义：审查面板里的“在文件管理器中打开”用于回到文件所在目录，
  // 不能把文件路径直接交给系统，否则部分平台会打开默认应用而不是文件夹。
  return getContainingDirectoryPath(target.path) ?? target.path;
}

export function useFileContextActions(options: FileContextActionOptions = {}) {
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const canOpenLocalFileManager = Boolean(options.canOpenLocalFileManager);
  const isRemoteWorkspace = Boolean(options.isRemoteWorkspace);
  const openFailedMessage =
    options.openFailedMessage ?? intl.formatMessage({ id: "appHeader.openInFileManagerFailed" });

  // 远端工作区路径只在远端存在，本机文件管理器不能消费（WSL 的 UNC 入口已随目标退役删除）。
  const canRevealInFileManager = useCallback(
    (target: FileContextActionTarget) =>
      canOpenLocalFileManager && !target.deleted && !isRemoteWorkspace,
    [canOpenLocalFileManager, isRemoteWorkspace],
  );

  const copyPathText = useCallback(async (path: string) => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      logger.warn("[FileContextActions] 复制文件路径失败", {
        path,
        error: "clipboard-unavailable",
      });
      return;
    }
    try {
      await navigator.clipboard.writeText(path);
      logger.info("[FileContextActions] 文件路径已复制", { path });
    } catch (error) {
      logger.warn("[FileContextActions] 复制文件路径失败", {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);
  const copyPath = useCallback(
    (target: FileContextActionTarget) => copyPathText(target.path),
    [copyPathText],
  );
  const copyAbsolutePath = copyPath;
  const copyRelativePath = useCallback(
    (target: FileContextActionTarget) => copyPathText(target.relativePath ?? target.path),
    [copyPathText],
  );

  const revealInFileManager = useCallback(
    async (target: FileContextActionTarget) => {
      if (!canRevealInFileManager(target)) {
        return;
      }

      const openPath = resolveFileManagerOpenPath(target);
      // canRevealInFileManager 已排除远端工作区：远端 Linux 路径不会落到本机文件管理器。
      const result = await platform.openInFileManager(openPath);
      if (result.success) {
        return;
      }
      logger.warn("[FileContextActions] 在文件管理器中显示条目失败", {
        path: target.path,
        openPath,
        error: result.error ?? "unknown-error",
      });
      toast(openFailedMessage);
    },
    [canRevealInFileManager, openFailedMessage, platform],
  );

  return {
    canRevealInFileManager,
    copyAbsolutePath,
    copyPath,
    copyRelativePath,
    revealInFileManager,
  };
}
