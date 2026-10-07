// UI 侧退役目标只读化回归（specs/cloud-agent/06 §3.2/§4/§5）：
// 退役记录只读展示、不恢复 tab、不重连、不打开本地同路径，写回时不被删除。
import assert from "node:assert/strict";
import test from "node:test";
import type { AppSettings, RetiredRemoteWorkspaceEntry } from "@zcode/shared";
import {
  buildPersistedWorkspaceSessionEntries,
  formatRetiredRemoteWorkspaceEntryLabel,
  readRetiredRemoteWorkspaceEntries,
} from "../src/lib/remoteWorkspaceHistory.js";
import { restorePersistedRemoteWorkspaceSessions } from "../src/root/remoteWorkspaceSessionPersistence.js";

const WSL_RETIRED: RetiredRemoteWorkspaceEntry = {
  kind: "retired-remote",
  retiredKind: "wsl",
  workspacePath: "/home/dev/app",
  workspaceIdentity: "remote:wsl:Ubuntu:dev:/home/dev/app",
  lastOpenedAt: 1_700_000_000_100,
  invalidReason: "target-retired",
  originalAuthority: { distro: "Ubuntu", user: "dev" },
};

const DOCKER_RETIRED: RetiredRemoteWorkspaceEntry = {
  kind: "retired-remote",
  retiredKind: "docker",
  workspacePath: "/workspace",
  invalidReason: "target-retired",
  originalAuthority: { container: "zcode-dev" },
};

function settingsWith(entries: AppSettings["lastWorkspaceSession"]): AppSettings {
  return {
    recentProjects: [],
    locale: "zh-CN",
    lastWorkspaceSession: entries,
  } as AppSettings;
}

test("退役记录只读展示：读取、标签与身份归属", () => {
  const settings = settingsWith([
    { kind: "local", workspacePath: "/home/me/project" },
    WSL_RETIRED,
    DOCKER_RETIRED,
  ]);
  assert.deepEqual(readRetiredRemoteWorkspaceEntries(settings), [WSL_RETIRED, DOCKER_RETIRED]);
  assert.equal(formatRetiredRemoteWorkspaceEntryLabel(WSL_RETIRED), "WSL · Ubuntu · dev");
  assert.equal(formatRetiredRemoteWorkspaceEntryLabel(DOCKER_RETIRED), "Docker · zcode-dev");
  assert.equal(
    formatRetiredRemoteWorkspaceEntryLabel({ ...WSL_RETIRED, originalAuthority: undefined }),
    "WSL",
  );
});

test("退役记录不对应 tab：启动恢复只产出本地/SSH tab，绝不补建本地同路径", () => {
  const restored: unknown[] = [];
  const tabStoreApi = {
    getState: () => ({
      restoreTabs: (tabs: unknown[]) => {
        restored.push(...tabs);
      },
      completeTabRestore: () => undefined,
    }),
  };
  const settings = settingsWith([
    { kind: "local", workspacePath: "/home/me/project" },
    WSL_RETIRED,
    {
      kind: "remote",
      workspacePath: "/srv/app",
      workspaceIdentity: "remote:ssh:host.example:22:deploy:/srv/app",
      target: { kind: "ssh", host: "host.example", port: 22, username: "deploy" },
      lastOpenedAt: 1_700_000_000_000,
      lastConnectionStatus: "disconnected",
    },
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试用最小 TabStore 替身。
  restorePersistedRemoteWorkspaceSessions({ settings, tabStoreApi: tabStoreApi as any });

  assert.equal(restored.length, 2);
  assert.deepEqual(restored[0], "/home/me/project");
  const remoteTab = restored[1] as { workspacePath: string; remoteTarget?: { kind: string } };
  assert.equal(remoteTab.workspacePath, "/srv/app");
  assert.equal(remoteTab.remoteTarget?.kind, "ssh");
  // 退役记录（含无 identity 的 Docker 项）不产生任何 tab，也不会被当作本地路径打开。
  assert.equal(
    restored.some((tab) => JSON.stringify(tab).includes("/workspace")),
    false,
  );
  assert.equal(
    restored.some((tab) => JSON.stringify(tab).includes("remote:wsl:")),
    false,
  );
});

test("写回会话时保留退役投影，且不被同路径活跃项顶掉", () => {
  const entries = buildPersistedWorkspaceSessionEntries(
    [{ id: "tab-1", kind: "workspace", workspacePath: "/home/dev/app", label: "app" }],
    new Map(),
    [WSL_RETIRED, DOCKER_RETIRED, WSL_RETIRED],
  );

  assert.deepEqual(entries, [
    { kind: "local", workspacePath: "/home/dev/app" },
    WSL_RETIRED,
    DOCKER_RETIRED,
  ]);
});

test("写回时同名 workspace 的活跃远端项优先，退役投影不覆盖连接入口", () => {
  const remoteEntry = {
    kind: "remote" as const,
    workspacePath: "/home/dev/app",
    workspaceIdentity: "remote:ssh:host.example:22:dev:/home/dev/app",
    target: { kind: "ssh" as const, host: "host.example", port: 22, username: "dev" },
    lastOpenedAt: 1_700_000_000_500,
    lastConnectionStatus: "connected" as const,
  };
  const entries = buildPersistedWorkspaceSessionEntries(
    [
      {
        id: "tab-1",
        kind: "workspace",
        workspacePath: "/home/dev/app",
        label: "app",
        workspaceIdentity: remoteEntry.workspaceIdentity,
        remoteSessionId: "session-1",
      },
    ],
    new Map([[remoteEntry.workspaceIdentity, remoteEntry]]),
    [WSL_RETIRED],
  );

  assert.deepEqual(entries, [remoteEntry, WSL_RETIRED]);
});
