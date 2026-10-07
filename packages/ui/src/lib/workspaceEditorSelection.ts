import type { EditorInfo, OpenInEditorRemoteTarget, RemoteTarget } from "@zcode/shared";
import { sortInstalledEditorsForOpenWith } from "@/lib/openWithEditors.js";

const REMOTE_SSH_EDITOR_IDS = ["vscode", "vscode-insiders"];

type WorkspaceEditorSelectionKind = "preferred" | "fallback" | "empty" | "explicit";

interface WorkspaceEditorSelectionState {
  availableEditors: EditorInfo[];
  selectedEditor: EditorInfo | null;
  selectionKind: Exclude<WorkspaceEditorSelectionKind, "explicit">;
}

function filterEditorsByIdOrder(
  installedEditors: EditorInfo[],
  orderedIds: string[],
): EditorInfo[] {
  return orderedIds
    .map((id) => installedEditors.find((editor) => editor.id === id) ?? null)
    .filter((editor): editor is EditorInfo => editor !== null);
}

export function resolveWorkspaceEditorSelection({
  installedEditors,
  selectedEditorId,
  remoteTarget,
}: {
  installedEditors: EditorInfo[];
  selectedEditorId: string | null;
  remoteTarget?: RemoteTarget | OpenInEditorRemoteTarget;
}): WorkspaceEditorSelectionState {
  let availableEditors: EditorInfo[];

  if (remoteTarget) {
    // 远端（SSH）工作区路径只在远端存在，Finder/Explorer/Terminal 这类本地 App
    // 不能直接打开 `/root/...`，否则会落到本机不存在或错误的目录。
    // Docker/WSL 目标退役后不再有其它远端 kind 需要单独的能力收敛。
    availableEditors = filterEditorsByIdOrder(installedEditors, REMOTE_SSH_EDITOR_IDS);
  } else {
    availableEditors = sortInstalledEditorsForOpenWith(installedEditors);
  }
  const preferredEditor =
    selectedEditorId === null
      ? null
      : (availableEditors.find((editor) => editor.id === selectedEditorId) ?? null);
  const fallbackEditor = availableEditors[0] ?? null;

  if (preferredEditor) {
    return {
      availableEditors,
      selectedEditor: preferredEditor,
      selectionKind: "preferred",
    };
  }

  return {
    availableEditors,
    selectedEditor: fallbackEditor,
    selectionKind: fallbackEditor ? "fallback" : "empty",
  };
}

export function shouldPersistWorkspaceEditorSelection(
  selectionKind: WorkspaceEditorSelectionKind,
): boolean {
  // SSH 工作区可能因为过滤本地 App 自动 fallback 到 VS Code。
  // 这种 fallback 不是用户显式选择，不能覆盖本地工作区继续使用的全局编辑器偏好。
  return selectionKind === "explicit";
}
