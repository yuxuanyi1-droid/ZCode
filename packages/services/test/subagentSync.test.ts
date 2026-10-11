import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  createFsFaultInjector,
  resetProcessFsFaultInjectorForTests,
  setFsFaultInjectorForTests,
} from "../src/fs/fsFaultInjection.js";
import { createSubagentSyncService } from "../src/subagent-sync/subagentSyncService.js";

const GENERAL_PURPOSE_SELECTION = {
  providerId: "opencode-go-messages",
  modelId: "deepseek-flash",
  options: { reasoningLevel: "max" },
};

const ALPHA_MARKDOWN = [
  "---",
  "name: alpha",
  "description: Alpha agent",
  "---",
  "",
  "Alpha body",
  "",
].join("\n");

const BETA_MARKDOWN = [
  "---",
  "name: beta",
  "description: Beta agent",
  "---",
  "",
  "Beta body",
  "",
].join("\n");

async function createHome(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function writeStateFile(
  home: string,
  state: Record<string, unknown>,
  options: { raw?: string } = {},
): Promise<void> {
  const stateDir = join(home, ".zcode", "v2");
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, "agents-state.json"),
    options.raw ?? JSON.stringify(state, null, 2),
    "utf-8",
  );
}

async function writeAgentMarkdown(
  home: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const target = join(home, ".zcode", "agents", relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf-8");
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

function stateFilePath(home: string): string {
  return join(home, ".zcode", "v2", "agents-state.json");
}

function agentFilePath(home: string, relativePath: string): string {
  return join(home, ".zcode", "agents", relativePath);
}

test("local candidates cover built-in overrides and user agents with hashes", async () => {
  const home = await createHome("zcode-subagent-sync-candidates-");
  try {
    await writeAgentMarkdown(home, "alpha.md", ALPHA_MARKDOWN);
    await writeAgentMarkdown(home, join("nested", "beta.md"), BETA_MARKDOWN);
    await writeStateFile(home, {
      builtInModelSelectionOverrides: { "general-purpose": GENERAL_PURPOSE_SELECTION },
      pluginAgentModelSelectionOverrides: {},
      disabledAgentIds: ["user:user:beta"],
    });

    const service = createSubagentSyncService({ homeDir: home });
    const result = await service.listLocalUserSubagentCandidates();

    assert.deepEqual(
      result.candidates.map((candidate) => candidate.id),
      ["builtin:general-purpose", "user:alpha.md", "user:nested/beta.md"],
    );
    assert.equal(result.localRoot, join(home, ".zcode"));

    const generalPurpose = result.candidates[0]!;
    assert.equal(generalPurpose.kind, "builtInModelOverride");
    assert.equal(generalPurpose.agentName, "general-purpose");
    assert.deepEqual(generalPurpose.modelSelection, GENERAL_PURPOSE_SELECTION);

    const alpha = result.candidates[1]!;
    assert.equal(alpha.kind, "userAgent");
    assert.equal(alpha.name, "alpha");
    assert.equal(alpha.relativePath, "alpha.md");
    assert.equal(alpha.enabled, true);
    assert.equal(alpha.contentHash, sha256(ALPHA_MARKDOWN));

    const beta = result.candidates[2]!;
    assert.equal(beta.name, "beta");
    assert.equal(beta.relativePath, "nested/beta.md");
    assert.equal(beta.enabled, false);
    assert.equal(beta.contentHash, sha256(BETA_MARKDOWN));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("remote status distinguishes missing, same and different", async () => {
  const localHome = await createHome("zcode-subagent-sync-local-");
  const remoteHome = await createHome("zcode-subagent-sync-remote-");
  try {
    await writeAgentMarkdown(localHome, "alpha.md", ALPHA_MARKDOWN);
    await writeAgentMarkdown(localHome, "beta.md", BETA_MARKDOWN);
    await writeStateFile(localHome, {
      builtInModelSelectionOverrides: { "general-purpose": GENERAL_PURPOSE_SELECTION },
      pluginAgentModelSelectionOverrides: {},
      disabledAgentIds: [],
    });
    // 远端：alpha 内容一致、beta 内容不同、内置覆盖同值、Explore 覆盖缺失。
    await writeAgentMarkdown(remoteHome, "alpha.md", ALPHA_MARKDOWN);
    await writeAgentMarkdown(remoteHome, "beta.md", `${BETA_MARKDOWN}\nremote drift\n`);
    await writeStateFile(remoteHome, {
      builtInModelSelectionOverrides: { "general-purpose": GENERAL_PURPOSE_SELECTION },
      pluginAgentModelSelectionOverrides: {},
      disabledAgentIds: [],
    });

    const local = createSubagentSyncService({ homeDir: localHome });
    const remote = createSubagentSyncService({ homeDir: remoteHome });
    const candidates = (await local.listLocalUserSubagentCandidates()).candidates;
    const statuses = await remote.listRemoteUserSubagentStatuses({
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        kind: candidate.kind,
        ...(candidate.agentName ? { agentName: candidate.agentName } : {}),
        ...(candidate.modelSelection ? { modelSelection: candidate.modelSelection } : {}),
        ...(candidate.relativePath ? { relativePath: candidate.relativePath } : {}),
        ...(candidate.contentHash ? { contentHash: candidate.contentHash } : {}),
      })),
    });

    assert.equal(statuses.remoteRoot, join(remoteHome, ".zcode"));
    const stateById = new Map(statuses.statuses.map((status) => [status.id, status.state]));
    assert.equal(stateById.get("builtin:general-purpose"), "same");
    assert.equal(stateById.get("user:alpha.md"), "same");
    assert.equal(stateById.get("user:beta.md"), "different");
  } finally {
    await rm(localHome, { recursive: true, force: true });
    await rm(remoteHome, { recursive: true, force: true });
  }
});

test("import writes files and merges state without touching other remote fields", async () => {
  const localHome = await createHome("zcode-subagent-sync-export-");
  const remoteHome = await createHome("zcode-subagent-sync-import-");
  try {
    await writeAgentMarkdown(localHome, "alpha.md", ALPHA_MARKDOWN);
    await writeAgentMarkdown(localHome, join("nested", "beta.md"), BETA_MARKDOWN);
    await writeStateFile(localHome, {
      builtInModelSelectionOverrides: { "general-purpose": GENERAL_PURPOSE_SELECTION },
      pluginAgentModelSelectionOverrides: {},
      disabledAgentIds: ["user:user:beta"],
    });
    // 远端已有插件覆盖与旧字段，导入必须保留它们；同时 beta 处于启用态。
    await writeStateFile(remoteHome, {
      builtInModelSelectionOverrides: {},
      pluginAgentModelSelectionOverrides: {
        "plugin:demo@market:Docs": { providerId: "p", modelId: "m" },
      },
      disabledAgentIds: [],
      builtInModelOverrides: { legacy: true },
    });

    const local = createSubagentSyncService({ homeDir: localHome });
    const remote = createSubagentSyncService({ homeDir: remoteHome });
    const exported = await local.exportSubagentConfig({
      ids: ["builtin:general-purpose", "user:alpha.md", "user:nested/beta.md"],
    });
    assert.deepEqual(
      exported.entries.map((entry) => entry.id),
      ["builtin:general-purpose", "user:alpha.md", "user:nested/beta.md"],
    );
    assert.equal(exported.entries[1]!.content, ALPHA_MARKDOWN);
    assert.equal(exported.entries[2]!.enabled, false);

    const first = await remote.importSubagentConfig({ entries: exported.entries });
    assert.deepEqual(
      first.results.map((result) => [result.id, result.status]),
      [
        ["builtin:general-purpose", "synced"],
        ["user:alpha.md", "synced"],
        ["user:nested/beta.md", "synced"],
      ],
    );
    assert.equal(first.rolledBack, false);

    const remoteState = JSON.parse(await readFile(stateFilePath(remoteHome), "utf-8")) as {
      builtInModelSelectionOverrides: Record<string, unknown>;
      pluginAgentModelSelectionOverrides: Record<string, unknown>;
      disabledAgentIds: string[];
      builtInModelOverrides?: unknown;
    };
    assert.deepEqual(remoteState.builtInModelSelectionOverrides["general-purpose"], {
      ...GENERAL_PURPOSE_SELECTION,
    });
    assert.deepEqual(remoteState.pluginAgentModelSelectionOverrides, {
      "plugin:demo@market:Docs": { providerId: "p", modelId: "m" },
    });
    assert.deepEqual(remoteState.disabledAgentIds, ["user:user:beta"]);
    assert.deepEqual(remoteState.builtInModelOverrides, { legacy: true });
    assert.equal(await readFile(agentFilePath(remoteHome, "alpha.md"), "utf-8"), ALPHA_MARKDOWN);
    assert.equal(
      await readFile(agentFilePath(remoteHome, join("nested", "beta.md")), "utf-8"),
      BETA_MARKDOWN,
    );

    // 幂等：同内容重复导入不产生写入，状态一致时报 skipped。
    const alphaBefore = await stat(agentFilePath(remoteHome, "alpha.md"));
    const stateBefore = await stat(stateFilePath(remoteHome));
    await new Promise((resolve) => setTimeout(resolve, 25));
    const second = await remote.importSubagentConfig({ entries: exported.entries });
    assert.deepEqual(
      second.results.map((result) => result.status),
      ["skipped", "skipped", "skipped"],
    );
    assert.equal((await stat(agentFilePath(remoteHome, "alpha.md"))).mtimeMs, alphaBefore.mtimeMs);
    assert.equal((await stat(stateFilePath(remoteHome))).mtimeMs, stateBefore.mtimeMs);
  } finally {
    await rm(localHome, { recursive: true, force: true });
    await rm(remoteHome, { recursive: true, force: true });
  }
});

test("import rolls back written files when a later write fails", async () => {
  const localHome = await createHome("zcode-subagent-sync-rollback-local-");
  const remoteHome = await createHome("zcode-subagent-sync-rollback-remote-");
  try {
    await writeAgentMarkdown(localHome, "alpha.md", ALPHA_MARKDOWN);
    await writeAgentMarkdown(localHome, "beta.md", BETA_MARKDOWN);
    await writeStateFile(localHome, {
      builtInModelSelectionOverrides: { "general-purpose": GENERAL_PURPOSE_SELECTION },
      pluginAgentModelSelectionOverrides: {},
      disabledAgentIds: [],
    });
    const remoteAlphaBefore = `${ALPHA_MARKDOWN}\nold remote content\n`;
    await writeAgentMarkdown(remoteHome, "alpha.md", remoteAlphaBefore);
    const remoteStateRaw = JSON.stringify(
      {
        builtInModelSelectionOverrides: {},
        pluginAgentModelSelectionOverrides: {},
        disabledAgentIds: ["user:user:keep"],
      },
      null,
      2,
    );
    await writeStateFile(remoteHome, {}, { raw: remoteStateRaw });

    const local = createSubagentSyncService({ homeDir: localHome });
    const remote = createSubagentSyncService({ homeDir: remoteHome });
    const exported = await local.exportSubagentConfig({ ids: ["user:alpha.md", "user:beta.md"] });

    setFsFaultInjectorForTests(
      createFsFaultInjector([
        {
          id: "beta-write-failed",
          code: "EACCES",
          operations: ["writeFile"],
          pathIncludes: "beta.md",
          maxMatches: 1,
        },
      ]),
    );
    try {
      const result = await remote.importSubagentConfig({ entries: exported.entries });
      assert.equal(result.rolledBack, true);
      assert.deepEqual(
        result.results.map((entry) => [entry.id, entry.status]),
        [
          ["user:alpha.md", "failed"],
          ["user:beta.md", "failed"],
        ],
      );
      assert.match(result.results[1]!.error ?? "", /Injected fs fault/);
    } finally {
      resetProcessFsFaultInjectorForTests();
    }

    // alpha 恢复为覆盖前内容，beta 未创建，state 文件未被触碰。
    assert.equal(await readFile(agentFilePath(remoteHome, "alpha.md"), "utf-8"), remoteAlphaBefore);
    assert.deepEqual(await readdir(agentFilePath(remoteHome, "")), ["alpha.md"]);
    assert.equal(await readFile(stateFilePath(remoteHome), "utf-8"), remoteStateRaw);
  } finally {
    await rm(localHome, { recursive: true, force: true });
    await rm(remoteHome, { recursive: true, force: true });
  }
});

test("import rejects unsafe relative paths and invalid built-in selections", async () => {
  const remoteHome = await createHome("zcode-subagent-sync-unsafe-");
  try {
    const remote = createSubagentSyncService({ homeDir: remoteHome });
    const content = ALPHA_MARKDOWN;
    for (const relativePath of ["../escape.md", "/etc/escape.md", "C:\\escape.md", ""]) {
      await assert.rejects(
        () =>
          remote.importSubagentConfig({
            entries: [
              {
                id: `user:${relativePath}`,
                kind: "userAgent",
                name: "escape",
                relativePath,
                content,
              },
            ],
          }),
        /unsafe subagent sync path/u,
      );
    }
    await assert.rejects(
      () =>
        remote.importSubagentConfig({
          entries: [
            {
              id: "builtin:general-purpose",
              kind: "builtInModelOverride",
              name: "general-purpose",
              agentName: "general-purpose",
              modelSelection: { providerId: "", modelId: "deepseek-flash" } as never,
            },
          ],
        }),
      /invalid model selection/u,
    );
  } finally {
    await rm(remoteHome, { recursive: true, force: true });
  }
});
