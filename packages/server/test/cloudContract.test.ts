/**
 * cloud 模块登记与测试入口用例（specs/cloud-agent/W0 §3/§4、13 §3）。
 * 断言：两条新模块在 architecture-policy.yaml 登记生效、四件套齐备、
 * module.ts 的依赖声明与策略一致、测试 runner 入口真实存在。
 */
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { cloudExecutionModule } from "../src/cloud/execution/module.js";
import { cloudControlPlaneModule } from "../src/cloud/module.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

interface PolicyModule {
  id: string;
  roots: string[];
  managed?: boolean;
  requires?: string[];
  publicEntrypoints?: string[];
  layers?: Record<string, string>;
  layerOrder?: string[];
}

async function policyModules(): Promise<PolicyModule[]> {
  const raw = await readFile(path.join(repoRoot, "architecture-policy.yaml"), "utf8");
  return (parseYaml(raw) as { modules: PolicyModule[] }).modules;
}

test("architecture policy registers both cloud modules with expected shape", async () => {
  const modules = await policyModules();
  const controlPlane = modules.find((module) => module.id === "cloud-control-plane");
  const execution = modules.find((module) => module.id === "cloud-execution");

  assert.ok(controlPlane, "cloud-control-plane must be registered");
  assert.deepEqual(controlPlane.roots, ["packages/server/src/cloud"]);
  assert.equal(controlPlane.managed, true);
  assert.deepEqual(controlPlane.layers, { domain: "domain", app: "app", adapters: "adapters" });
  assert.deepEqual(controlPlane.layerOrder, ["domain", "app", "adapters"]);
  assert.deepEqual(controlPlane.publicEntrypoints, ["packages/server/src/cloud/contract.ts"]);

  assert.ok(execution, "cloud-execution must be registered");
  assert.deepEqual(execution.roots, ["packages/server/src/cloud/execution"]);
  assert.equal(execution.managed, true);
  assert.deepEqual(execution.layerOrder, ["domain", "app", "adapters"]);
  assert.deepEqual(execution.publicEntrypoints, [
    "packages/server/src/cloud/execution/contract.ts",
  ]);
});

test("module manifests stay consistent with the policy entries", async () => {
  const modules = await policyModules();
  for (const manifest of [cloudControlPlaneModule, cloudExecutionModule]) {
    const entry = modules.find((module) => module.id === manifest.id);
    assert.ok(entry, `${manifest.id} must exist in the policy`);
    assert.deepEqual([...manifest.requires], [...(entry.requires ?? [])]);
    // 策略里的 publicEntrypoints 可以是仓库相对路径，模块清单用模块内相对路径。
    const declared = entry.publicEntrypoints ?? [];
    for (const relative of manifest.publicEntrypoints) {
      assert.ok(
        declared.some((item) => item === relative || item.endsWith(`/${relative}`)),
        `${manifest.id} public entrypoint ${relative} must be declared in the policy`,
      );
    }
  }
  // 子模块按最深 root 归属：execution 的清单不能与父模块共用 root。
  assert.notDeepEqual(cloudExecutionModule.id, cloudControlPlaneModule.id);
  assert.equal(cloudExecutionModule.publicEntrypoints[0], "contract.ts");
});

test("both modules ship the four-piece contract skeleton", async () => {
  for (const root of ["packages/server/src/cloud", "packages/server/src/cloud/execution"]) {
    for (const artifact of ["module.ts", "contract.ts", "contract.example.ts", "CONTRACT.md"]) {
      await access(path.join(repoRoot, root, artifact));
    }
  }
});

test("test runner entry is registered and not a fabricated pnpm test/e2e script", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(repoRoot, "packages/server/package.json"), "utf8"),
  ) as { scripts?: Record<string, string> };
  const testScript = manifest.scripts?.test;
  assert.equal(testScript, 'node --import tsx --test "test/cloud*.test.ts"');
  assert.equal(manifest.scripts?.e2e, undefined);
  assert.equal(manifest.scripts?.["test:e2e"], undefined);
});
