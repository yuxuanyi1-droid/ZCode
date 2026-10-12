/**
 * `ISettingsSyncService.writeUserAgentsFile` 用例（specs/cloud-agent 14 §4.5）。
 *
 * 覆盖：整文件覆盖写（不合并/不追加）、落点 `~/.zcode/AGENTS.md`、自动创建父目录、
 * UTF-8 字节数与 sha256 口径、0600 权限、原子写（无临时文件残留）、超限拒绝且不破坏既有文件、
 * 返回值路径为绝对路径。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SETTINGS_SYNC_USER_AGENTS_FILE_MAX_BYTES } from "@zcode/shared";
import { createSettingsSyncService } from "../src/settings-sync/settingsSyncService.js";
import type { ISettingService } from "../src/setting/setting.js";

// writeUserAgentsFile 不读账号设置；settingService 只在 importSelected 迁移路径使用，
// 这里给出占位实现，避免为无关依赖构造完整 settings 环境。
const SETTING_SERVICE_STUB = {} as ISettingService;

function createService() {
  return createSettingsSyncService({ settingService: SETTING_SERVICE_STUB });
}

async function withHome(
  run: (home: string) => Promise<void>,
  options?: { precreateHome?: boolean },
) {
  const home = await mkdtemp(join(tmpdir(), "zcode-user-agents-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  delete process.env.USERPROFILE;
  try {
    if (options?.precreateHome === false) {
      // 需要"父目录不存在"的场景：把 home 自身换成不存在的路径下的目录名。
      const missingHome = join(home, "missing-home");
      process.env.HOME = missingHome;
      await run(missingHome);
      return;
    }
    await run(home);
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

test("writeUserAgentsFile overwrites the whole file with 0600 at ~/.zcode/AGENTS.md", async () => {
  await withHome(async (home) => {
    const service = createService();
    const first = "# 用户指令\n\n第一版\n";
    const result = await service.writeUserAgentsFile({ content: first });

    const expectedPath = join(home, ".zcode", "AGENTS.md");
    assert.equal(result.path, expectedPath);
    assert.equal(result.bytes, Buffer.byteLength(first, "utf8"));
    assert.equal(
      result.sha256,
      createHash("sha256").update(Buffer.from(first, "utf8")).digest("hex"),
    );
    assert.equal(await readFile(expectedPath, "utf-8"), first);
    // 非凭据文本也一样落 0600（14 §4.5 冻结值）。
    assert.equal((await stat(expectedPath)).mode & 0o777, 0o600);

    // 覆盖语义：整文件替换（不追加、不合并），旧内容不残留。
    const second = "# 用户指令\n\n第二版\n（旧行必须消失）\n";
    const overwritten = await service.writeUserAgentsFile({ content: second });
    assert.equal(await readFile(expectedPath, "utf-8"), second);
    assert.equal(overwritten.bytes, Buffer.byteLength(second, "utf8"));
    assert.notEqual(overwritten.sha256, result.sha256);
    assert.equal((await stat(expectedPath)).mode & 0o777, 0o600);

    // 原子写不留临时文件（temp + rename 的可见产物只有目标文件本身）。
    assert.deepEqual(await readdir(join(home, ".zcode")), ["AGENTS.md"]);
  });
});

test("writeUserAgentsFile creates missing parent directories", async () => {
  await withHome(
    async (home) => {
      const service = createService();
      const content = "# 自动建目录\n";
      const result = await service.writeUserAgentsFile({ content });
      assert.equal(result.path, join(home, ".zcode", "AGENTS.md"));
      assert.equal(await readFile(result.path, "utf-8"), content);
      assert.equal((await stat(result.path)).mode & 0o777, 0o600);
    },
    { precreateHome: false },
  );
});

test("writeUserAgentsFile counts UTF-8 bytes and rejects over-limit content without touching the target", async () => {
  await withHome(async (home) => {
    const service = createService();
    const path = join(home, ".zcode", "AGENTS.md");

    // 三字节字符：bytes 必须按 UTF-8 口径（不是 UTF-16 码元数）。
    const multibyte = "中".repeat(1000);
    const multibyteResult = await service.writeUserAgentsFile({ content: multibyte });
    assert.equal(multibyteResult.bytes, 3000);

    // 恰好上限合法（纯 ASCII 字符数 = 字节数）。
    const atLimit = "a".repeat(SETTINGS_SYNC_USER_AGENTS_FILE_MAX_BYTES);
    const atLimitResult = await service.writeUserAgentsFile({ content: atLimit });
    assert.equal(atLimitResult.bytes, SETTINGS_SYNC_USER_AGENTS_FILE_MAX_BYTES);

    // 上限 +1 拒绝：fail-closed，且既有文件保持上一次内容（不截断、不半写）。
    await assert.rejects(
      () => service.writeUserAgentsFile({ content: `${atLimit}a` }),
      new RegExp(`${SETTINGS_SYNC_USER_AGENTS_FILE_MAX_BYTES}`, "u"),
    );
    assert.equal((await readFile(path, "utf-8")).length, SETTINGS_SYNC_USER_AGENTS_FILE_MAX_BYTES);
    // 多字节超限同样按字节判定（字符数未过闸也可能超限）。
    await assert.rejects(
      () =>
        service.writeUserAgentsFile({
          content: "中".repeat(SETTINGS_SYNC_USER_AGENTS_FILE_MAX_BYTES / 3 + 1),
        }),
      /exceeds/u,
    );
    assert.equal((await readFile(path, "utf-8")).length, SETTINGS_SYNC_USER_AGENTS_FILE_MAX_BYTES);
  });
});

test("writeUserAgentsFile keeps concurrent writes whole (atomic rename)", async () => {
  await withHome(async (home) => {
    const service = createService();
    const path = join(home, ".zcode", "AGENTS.md");
    await mkdir(join(home, ".zcode"), { recursive: true });
    await writeFile(path, "seed", { mode: 0o600 });

    const contents = Array.from({ length: 6 }, (_unused, index) => `# 版本 ${index}\n`.repeat(50));
    await Promise.all(contents.map((content) => service.writeUserAgentsFile({ content })));
    const finalContent = await readFile(path, "utf-8");
    // 结果必须是某一次的完整正文，不能是两次写入的交错结果。
    assert.ok(contents.includes(finalContent), "final file must equal one whole write");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(join(home, ".zcode")), ["AGENTS.md"]);
  });
});
