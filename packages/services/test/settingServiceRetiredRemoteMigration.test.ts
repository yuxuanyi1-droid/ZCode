// settings 退役记录迁移的真实文件级回归（specs/cloud-agent/06 §3.3）：
// - 旧 Docker/WSL 记录迁移成只读失效投影，其他字段与本地/SSH 项保留；
// - 迁移成功后异步原子写回，重复启动幂等；
// - 解析/校验失败保留原文件，不写默认配置、不删用户数据。
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSettingService } from "../src/setting/settingService.js";

async function withSettingsHome(
  run: (paths: { home: string; settingsFile: string }) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "zcode-retired-remote-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  delete process.env.USERPROFILE;
  try {
    const settingsDir = join(home, ".zcode", "v2");
    await mkdir(settingsDir, { recursive: true });
    await run({ home, settingsFile: join(settingsDir, "setting.json") });
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousUserProfile !== undefined) {
      process.env.USERPROFILE = previousUserProfile;
    }
    await rm(home, { recursive: true, force: true });
  }
}

const WSL_ENTRY = {
  kind: "remote",
  workspacePath: "/home/dev/app",
  workspaceIdentity: "remote:wsl:Ubuntu:dev:/home/dev/app",
  target: { kind: "wsl", distro: "Ubuntu", user: "dev" },
  lastOpenedAt: 1_700_000_000_100,
  lastConnectionStatus: "connected",
};

test("R-02/R-03: 混合 settings 升级写入退役只读投影并保留其他字段", async () => {
  await withSettingsHome(async ({ settingsFile }) => {
    await writeFile(
      settingsFile,
      JSON.stringify(
        {
          locale: "en-US",
          localePreference: "en-US",
          httpProxy: "http://127.0.0.1:7890",
          recentProjects: ["/home/me/project"],
          lastWorkspaceSession: [
            { kind: "local", workspacePath: "/home/me/project" },
            {
              kind: "remote",
              workspacePath: "/srv/app",
              workspaceIdentity: "remote:ssh:host.example:22:deploy:/srv/app",
              target: { kind: "ssh", host: "host.example", port: 22, username: "deploy" },
              lastOpenedAt: 1_700_000_000_000,
              lastConnectionStatus: "connected",
            },
            WSL_ENTRY,
            {
              kind: "remote",
              workspacePath: "/workspace",
              target: { kind: "docker", container: "zcode-dev" },
              lastOpenedAt: 1_700_000_000_200,
              lastConnectionStatus: "connected",
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const service = createSettingService();
    const settings = await service.get();

    const retired = settings.lastWorkspaceSession.filter(
      (entry) => entry.kind === "retired-remote",
    );
    assert.equal(retired.length, 2);
    assert.deepEqual(
      retired.map((entry) => [entry.retiredKind, entry.workspacePath, entry.invalidReason]),
      [
        ["wsl", "/home/dev/app", "target-retired"],
        ["docker", "/workspace", "target-retired"],
      ],
    );
    // 其他字段与原条目保留，绝不因退役记录回退整份默认值。
    assert.equal(settings.locale, "en-US");
    assert.equal(settings.localePreference, "en-US");
    assert.equal(settings.httpProxy, "http://127.0.0.1:7890");
    assert.deepEqual(settings.recentProjects, ["/home/me/project"]);
    assert.equal(
      settings.lastWorkspaceSession.filter((entry) => entry.kind === "remote").length,
      1,
    );
    assert.equal(settings.lastWorkspaceSession.filter((entry) => entry.kind === "local").length, 1);

    // 迁移成功必须异步原子写回：文件里不再有旧 kind（写回是 fire-and-forget，这里等一次事件循环）。
    await new Promise((resolve) => setTimeout(resolve, 200));
    const persisted = JSON.parse(await readFile(settingsFile, "utf-8"));
    assert.equal(
      (persisted.lastWorkspaceSession as Array<{ kind: string }>).some(
        (entry) => entry.kind === "remote" && entry.target?.kind !== undefined,
      ),
      true,
    );
    assert.equal(
      (persisted.lastWorkspaceSession as Array<{ kind: string }>).filter(
        (entry) => entry.kind === "retired-remote",
      ).length,
      2,
    );
    assert.equal(JSON.stringify(persisted).includes('"kind":"wsl"'), false);
    assert.equal(persisted.locale, "en-US");
    assert.equal(persisted.localePreference, "en-US");
    assert.equal(persisted.httpProxy, "http://127.0.0.1:7890");

    // 重复启动幂等：解析结果与文件内容稳定，不再触发新的写回。
    const firstStat = await stat(settingsFile);
    const second = await service.get();
    assert.deepEqual(second.lastWorkspaceSession, settings.lastWorkspaceSession);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const secondStat = await stat(settingsFile);
    assert.equal(secondStat.mtimeMs, firstStat.mtimeMs);
  });
});

test("R-03: 单条坏记录只丢弃该条，其他设置与文件内容保持", async () => {
  await withSettingsHome(async ({ settingsFile }) => {
    const raw = {
      locale: "en-US",
      terminalFontFamily: "JetBrains Mono",
      lastWorkspaceSession: [
        {
          kind: "retired-remote",
          retiredKind: "wsl",
          workspacePath: "/broken",
          invalidReason: "nope",
        },
        { kind: "remote", workspacePath: "/srv/app", target: { kind: "future-target" } },
        { kind: "local", workspacePath: "/home/me/project" },
      ],
    };
    await writeFile(settingsFile, JSON.stringify(raw, null, 2), "utf-8");

    const service = createSettingService();
    const settings = await service.get();
    assert.equal(settings.locale, "en-US");
    assert.equal(settings.terminalFontFamily, "JetBrains Mono");
    assert.deepEqual(settings.lastWorkspaceSession, [
      { kind: "local", workspacePath: "/home/me/project", workspacePurpose: "project" },
    ]);
    // 无法表示的坏记录不会让整份设置落回默认值（locale 未被重置为默认 zh-CN）。
    assert.notEqual(settings.locale, "zh-CN");
  });
});
