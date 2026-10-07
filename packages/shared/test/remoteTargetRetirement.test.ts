// Docker/WSL 远端目标退役（specs/cloud-agent/06）的契约测试：
// R-02 settings 迁移保护整份配置、R-03 幂等/严格校验、R-04 旧 kind 稳定拒绝、
// R-05/R-06 退役与非法远端 identity 不得回落本地路径。
import assert from "node:assert/strict";
import test from "node:test";
import {
  RETIRED_REMOTE_TARGET_KINDS,
  classifyWorkspaceIdentity,
  detectRetiredRemoteTargetKind,
  hasLegacyRetiredRemoteTargets,
  parseRemoteWorkspaceIdentity,
  remoteTargetSchema,
  retiredRemoteWorkspaceEntrySchema,
} from "../src/index.js";
import { appSettingsSchema } from "../src/validationAppSettings.js";
import { buildRemoteWorkspaceIdentity } from "../src/remote-workspace-identity.js";

const LOCAL_ENTRY = { kind: "local", workspacePath: "/home/me/project" };
const SSH_ENTRY = {
  kind: "remote",
  workspacePath: "/srv/app",
  workspaceIdentity: "remote:ssh:host.example:22:deploy:/srv/app",
  target: { kind: "ssh", host: "host.example", port: 22, username: "deploy" },
  lastOpenedAt: 1_700_000_000_000,
  lastConnectionStatus: "connected",
};
const WSL_ENTRY = {
  kind: "remote",
  workspacePath: "/home/dev/app",
  workspaceIdentity: "remote:wsl:Ubuntu:dev:/home/dev/app",
  target: { kind: "wsl", distro: "Ubuntu", user: "dev" },
  lastOpenedAt: 1_700_000_000_100,
  lastConnectionStatus: "connected",
};
const DOCKER_ENTRY = {
  kind: "remote",
  workspacePath: "/workspace",
  target: { kind: "docker", container: "zcode-dev" },
  lastOpenedAt: 1_700_000_000_200,
  lastConnectionStatus: "failed",
  lastConnectionError: "container exited",
};

function mixedSettings(): Record<string, unknown> {
  return {
    locale: "en-US",
    localePreference: "en-US",
    theme: "dark",
    terminalFontFamily: "JetBrains Mono",
    httpProxy: "http://127.0.0.1:7890",
    lastActiveTabIndex: 1,
    recentProjects: ["/home/me/project"],
    providerFamilyDomain: "zai",
    lastWorkspaceSession: [LOCAL_ENTRY, SSH_ENTRY, WSL_ENTRY, DOCKER_ENTRY],
  };
}

test("R-02: 混合记录升级后退役项只读失效，其他设置不落回默认值", () => {
  const parsed = appSettingsSchema.parse(mixedSettings());

  const retired = parsed.lastWorkspaceSession.filter((entry) => entry.kind === "retired-remote");
  assert.equal(retired.length, 2);
  const wsl = retired.find((entry) => entry.retiredKind === "wsl");
  assert.deepEqual(wsl, {
    kind: "retired-remote",
    retiredKind: "wsl",
    workspacePath: "/home/dev/app",
    workspaceIdentity: "remote:wsl:Ubuntu:dev:/home/dev/app",
    lastOpenedAt: 1_700_000_000_100,
    invalidReason: "target-retired",
    originalAuthority: { distro: "Ubuntu", user: "dev" },
  });
  const docker = retired.find((entry) => entry.retiredKind === "docker");
  assert.deepEqual(docker, {
    kind: "retired-remote",
    retiredKind: "docker",
    workspacePath: "/workspace",
    invalidReason: "target-retired",
    lastOpenedAt: 1_700_000_000_200,
    originalAuthority: { container: "zcode-dev" },
  });
  // 退役记录不得携带可执行 target / 凭据 / 连接状态。
  for (const entry of retired) {
    assert.equal("target" in entry, false);
    assert.equal("lastConnectionStatus" in entry, false);
    assert.equal("lastConnectionError" in entry, false);
  }

  // 本地/SSH 项按原语义保留，其他字段完全保留。
  assert.deepEqual(
    parsed.lastWorkspaceSession.filter((entry) => entry.kind === "local"),
    [{ kind: "local", workspacePath: "/home/me/project", workspacePurpose: "project" }],
  );
  const ssh = parsed.lastWorkspaceSession.find(
    (entry) => entry.kind === "remote" && entry.target.kind === "ssh",
  );
  assert.ok(ssh && ssh.kind === "remote");
  assert.equal(ssh.workspaceIdentity, SSH_ENTRY.workspaceIdentity);
  assert.equal(parsed.locale, "en-US");
  assert.equal(parsed.localePreference, "en-US");
  assert.equal(parsed.terminalFontFamily, "JetBrains Mono");
  assert.equal(parsed.httpProxy, "http://127.0.0.1:7890");
  assert.equal(parsed.providerFamilyDomain, "zai");
  assert.equal(parsed.lastActiveTabIndex, 1);
  assert.deepEqual(parsed.recentProjects, ["/home/me/project"]);
});

test("R-02: 更老 remoteWorkspaceHistory 格式中的退役记录同样投影且不被删除", () => {
  const parsed = appSettingsSchema.parse({
    locale: "zh-CN",
    lastWorkspaceSession: [{ kind: "remote", historyId: "hist-1" }],
    remoteWorkspaceHistory: [
      {
        id: "hist-1",
        workspacePath: "/home/dev/legacy",
        workspaceIdentity: "remote:wsl:Debian:/home/dev/legacy",
        target: { kind: "wsl", distro: "Debian" },
        lastOpenedAt: 1_600_000_000_000,
        lastConnectionStatus: "connected",
      },
    ],
  });

  assert.equal(parsed.locale, "zh-CN");
  assert.deepEqual(parsed.lastWorkspaceSession, [
    {
      kind: "retired-remote",
      retiredKind: "wsl",
      workspacePath: "/home/dev/legacy",
      workspaceIdentity: "remote:wsl:Debian:/home/dev/legacy",
      lastOpenedAt: 1_600_000_000_000,
      invalidReason: "target-retired",
      originalAuthority: { distro: "Debian" },
    },
  ]);
});

test("R-03: 迁移幂等，写回后不再判定为待迁移", () => {
  const raw = mixedSettings();
  assert.equal(hasLegacyRetiredRemoteTargets(raw), true);

  const first = appSettingsSchema.parse(raw);
  // 重复解析同一份落盘结果必须稳定（幂等），且不再触发迁移写回。
  const second = appSettingsSchema.parse(first);
  assert.deepEqual(second.lastWorkspaceSession, first.lastWorkspaceSession);
  assert.deepEqual(second, first);
  assert.equal(hasLegacyRetiredRemoteTargets(first), false);
});

test("R-03: 退役记录走严格 schema；非法已投影记录只丢弃该条，不影响其他字段", () => {
  assert.equal(
    retiredRemoteWorkspaceEntrySchema.safeParse({
      kind: "retired-remote",
      retiredKind: "wsl",
      workspacePath: "/x",
      invalidReason: "target-retired",
    }).success,
    true,
  );
  for (const invalid of [
    {
      kind: "retired-remote",
      retiredKind: "ssh",
      workspacePath: "/x",
      invalidReason: "target-retired",
    },
    { kind: "retired-remote", retiredKind: "wsl", workspacePath: "/x", invalidReason: "other" },
    {
      kind: "retired-remote",
      retiredKind: "wsl",
      workspacePath: "/x",
      invalidReason: "target-retired",
      lastOpenedAt: -1,
    },
    {
      kind: "retired-remote",
      retiredKind: "wsl",
      workspacePath: "/x",
      invalidReason: "target-retired",
      originalAuthority: { secret: "x" },
    },
    {
      kind: "retired-remote",
      retiredKind: "docker",
      workspacePath: "",
      invalidReason: "target-retired",
    },
    // 退役记录不接受可执行 target / 连接状态等活跃字段。
    {
      kind: "retired-remote",
      retiredKind: "docker",
      workspacePath: "/x",
      invalidReason: "target-retired",
      target: { kind: "docker", container: "c" },
    },
  ]) {
    assert.equal(
      retiredRemoteWorkspaceEntrySchema.safeParse(invalid).success,
      false,
      JSON.stringify(invalid),
    );
  }

  const parsed = appSettingsSchema.parse({
    locale: "en-US",
    lastWorkspaceSession: [
      {
        kind: "retired-remote",
        retiredKind: "wsl",
        workspacePath: "/broken",
        invalidReason: "nope",
      },
      {
        kind: "remote",
        workspacePath: "/srv/app",
        target: { kind: "future-target" },
        lastOpenedAt: 1,
        lastConnectionStatus: "connected",
      },
      LOCAL_ENTRY,
    ],
  });
  assert.deepEqual(parsed.lastWorkspaceSession, [
    { kind: "local", workspacePath: "/home/me/project", workspacePurpose: "project" },
  ]);
  assert.equal(parsed.locale, "en-US");
});

test("R-04: 旧 kind 在活跃 schema 与 HTTP/IPC 入口被稳定识别为退役", () => {
  assert.deepEqual([...RETIRED_REMOTE_TARGET_KINDS], ["wsl", "docker"]);
  assert.equal(remoteTargetSchema.safeParse({ kind: "wsl", distro: "Ubuntu" }).success, false);
  assert.equal(remoteTargetSchema.safeParse({ kind: "docker", container: "c" }).success, false);
  assert.equal(
    remoteTargetSchema.safeParse({ kind: "ssh", host: "h", username: "u" }).success,
    true,
  );

  assert.equal(detectRetiredRemoteTargetKind({ kind: "wsl", distro: "Ubuntu" }), "wsl");
  assert.equal(detectRetiredRemoteTargetKind({ kind: "docker", container: "c" }), "docker");
  assert.equal(detectRetiredRemoteTargetKind({ kind: "ssh", host: "h", username: "u" }), null);
  assert.equal(detectRetiredRemoteTargetKind({ kind: "wsl" }.kind), null);
  assert.equal(detectRetiredRemoteTargetKind(null), null);
  assert.equal(detectRetiredRemoteTargetKind("wsl"), null);
});

test("R-05: 退役 identity 仍被识别为远端身份，不返回 null、不落本地路径", () => {
  const wslIdentity = "remote:wsl:Ubuntu:dev:/home/dev/app";
  const dockerIdentity = "remote:docker:zcode-dev:/workspace";
  for (const identity of [wslIdentity, dockerIdentity]) {
    assert.notEqual(parseRemoteWorkspaceIdentity(identity), null);
    const classification = classifyWorkspaceIdentity(identity);
    assert.equal(classification.kind, "retired-remote");
    assert.equal(
      classification.kind === "retired-remote" ? classification.identity.workspacePath : null,
      identity.endsWith("/workspace") ? "/workspace" : "/home/dev/app",
    );
  }

  // 活跃构造只支持 SSH：同 path 的本地数据不会被当成退役远端，也不会反推退役 identity。
  assert.equal(
    buildRemoteWorkspaceIdentity("/srv/app", { kind: "ssh", host: "Host", username: "deploy" }),
    "remote:ssh:host:22:deploy:/srv/app",
  );
});

test("R-06: unknown/malformed 远端 identity 明确错误，无 path fallback", () => {
  for (const identity of [
    "remote:",
    "remote:unknown:x:/p",
    "remote:ssh:::/p",
    "remote:wsl:Ubuntu",
  ]) {
    const classification = classifyWorkspaceIdentity(identity);
    assert.equal(classification.kind, "invalid-remote", identity);
  }
  assert.deepEqual(classifyWorkspaceIdentity("/home/me/project"), { kind: "local" });
  const cloudTaskId = "11111111-2222-4333-8444-555555555555";
  assert.deepEqual(classifyWorkspaceIdentity(`cloud-task:${cloudTaskId}`), {
    kind: "cloud-task",
    taskId: cloudTaskId,
  });
  // 非法 cloud-task（不可从字符串还原路径）同样按 invalid-remote 处理，不落本地。
  assert.deepEqual(classifyWorkspaceIdentity("cloud-task:task-1"), { kind: "invalid-remote" });
});
