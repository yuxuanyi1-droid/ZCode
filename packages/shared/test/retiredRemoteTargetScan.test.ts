// R-10：退役目标清理后的静态扫描证据（specs/cloud-agent/06 §5/§7）。
// 只断言「可执行退役 target」不存在；宿主能力与只读 legacy 表示必须保留。
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

const SOURCE_ROOTS = [
  "packages/shared/src",
  "packages/server/src",
  "packages/services/src",
  "packages/client/src",
  "packages/ui/src",
  "packages/web/src",
  "packages/desktop/src",
  "apps/zcode-cli/packages/bootstrap/src",
];

/** 已删除的可执行退役远端 target 符号：任何源码位置都不应再出现。 */
const RETIRED_TARGET_SYMBOLS = [
  "wsl-backend",
  "docker-backend",
  "wsl-detect",
  "wslProxy",
  "WSLConnectOptions",
  "DockerConnectOptions",
  "WSLDistro",
  "DockerContainerInfo",
  "listWSLDistros",
  "listDockerContainers",
  "isDockerAvailable",
  "isWslBackend",
  "desktopWslTargetResolver",
  "PlatformChannels.ListWSLDistros",
  "PlatformChannels.IsDockerAvailable",
  "TID_WSL_DISTRO_SELECT",
  "TID_DOCKER_CONTAINER_SELECT",
  "remoteConnectionDockerOptions",
];

/** 已删除的退役 target 实现文件。 */
const REMOVED_FILES = [
  "packages/server/src/remote/docker-backend.ts",
  "packages/server/src/remote/docker-detect.ts",
  "packages/server/src/remote/wsl-backend.ts",
  "packages/server/src/remote/wsl-detect.ts",
  "packages/server/src/remote/wslProxy.ts",
  "packages/desktop/src/main/desktopWslTargetResolver.ts",
  "packages/ui/src/lib/remoteConnectionDockerOptions.ts",
  "packages/ui/src/lib/wslUncWorkspace.ts",
  "packages/shared/src/wslUserValidation.ts",
];

async function collectSourceFiles(root: string): Promise<string[]> {
  const absolute = join(repoRoot, root);
  const entries = await readdir(absolute, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(ts|tsx)$/.test(entry.name))
    .filter((entry) => !entry.parentPath?.includes("cloud"))
    .map((entry) => join(entry.parentPath ?? absolute, entry.name));
}

test("R-10: 源码中不再存在可执行的 Docker/WSL 远端 target 符号", async () => {
  const hits: string[] = [];
  for (const root of SOURCE_ROOTS) {
    for (const file of await collectSourceFiles(root)) {
      const content = await readFile(file, "utf8");
      for (const symbol of RETIRED_TARGET_SYMBOLS) {
        if (content.includes(symbol)) {
          hits.push(`${relative(repoRoot, file)}: ${symbol}`);
        }
      }
    }
  }
  assert.deepEqual(hits, []);
});

test("R-10: 退役 target 实现文件已删除，共享契约仍保留只读识别能力", async () => {
  for (const file of REMOVED_FILES) {
    await assert.rejects(stat(join(repoRoot, file)), `expected removed: ${file}`);
  }

  // legacy 只读表示与退役识别仍在活跃代码里（不是死引用）。
  const sharedSources = [
    "packages/shared/src/remoteTarget.ts",
    "packages/shared/src/retiredRemoteWorkspace.ts",
    "packages/shared/src/remote-workspace-identity.ts",
    "packages/shared/src/validationAppSettings.ts",
    "packages/shared/src/http-error-contract.ts",
  ];
  const existing: string[] = [];
  for (const file of sharedSources) {
    if (file.endsWith("http-error-contract.ts")) continue;
    const content = await readFile(join(repoRoot, file), "utf8");
    existing.push(content);
  }
  const combined = existing.join("\n");
  assert.match(combined, /retired-remote/);
  assert.match(combined, /target-retired/);
  assert.match(combined, /classifyWorkspaceIdentity/);
});

test("R-10: 宿主能力保留（Windows/WSL 宿主适配、宿主编辑器、Docker 构建/测试工具）", async () => {
  for (const file of [
    // Windows 原生编辑器定位（宿主能力，不依赖任何远端 target）。
    "packages/desktop/src/main/editors.ts",
    // SSH 远程编辑器仍然保留（VS Code Remote-SSH）。
    "packages/desktop/src/main/openInEditor.ts",
    // Docker 作为开发/宿主工具：SSH 测试用容器镜像与说明。
    "harness/remote/Dockerfile",
    "harness/remote/README.md",
  ]) {
    await stat(join(repoRoot, file));
  }

  const editors = await readFile(join(repoRoot, "packages/desktop/src/main/editors.ts"), "utf8");
  assert.match(editors, /win32/);
  const openInEditor = await readFile(
    join(repoRoot, "packages/desktop/src/main/openInEditor.ts"),
    "utf8",
  );
  assert.match(openInEditor, /vscode-remote:\/\/ssh-remote\+/);
  const serverIndex = await readFile(join(repoRoot, "packages/server/src/remote/index.ts"), "utf8");
  assert.match(serverIndex, /createRemoteBackend/);
  assert.equal(serverIndex.includes("WSLBackend"), false);
  assert.equal(serverIndex.includes("DockerBackend"), false);
});
