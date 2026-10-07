/**
 * W6 云执行节点 authority 用例（specs/cloud-agent 07 §2.7 交互同构、§8 执行节点 authority、
 * 12 §6 沙箱注入）。
 *
 * 断言三件事：
 * 1. `cloud-execution-node` 下 runtime preferences/policy 由**节点自身**应答（不依赖浏览器/
 *    外部 Host）、provider provisioning target 开启、桌面本机专属执行能力不可用；
 * 2. 既有三种 authority 的结论逐项回归（语义一行未改）；
 * 3. 沙箱 runtime 的启动 env 真的带上该模式，且显式 `desktop-local` 被拒绝。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  CLOUD_EXECUTION_NODE_AUTHORITY_MODE,
  isCloudExecutionNodeMode,
  resolveServiceAuthorityPolicy,
} from "@zcode/services/node";
import { resolveZCodeAgentPresentationSurface } from "@zcode/services/node";
import {
  parseExecutionAuthority,
  runtimeEnv,
} from "../src/cloud/execution/adapters/runtimeOwner.js";
import { SERVICE_AUTHORITY_MODE_ENV } from "@zcode/shared";

const CLOUD_MODE = CLOUD_EXECUTION_NODE_AUTHORITY_MODE;

test("云执行节点：prefs 由节点应答、provisioning target 开启、本机执行能力不可用", () => {
  const policy = resolveServiceAuthorityPolicy(CLOUD_MODE);
  assert.equal(policy.isCloudExecutionNode, true);
  assert.equal(isCloudExecutionNodeMode(CLOUD_MODE), true);
  // 无浏览器/外部 Host 也能建会话：设置与策略由节点自己应答（07 §8 表首行）。
  assert.equal(policy.answersRuntimePreferencesLocally, true);
  // envelope 只能经认证 bridge 通道下发并由节点本地安装（12 §6 A-08）。
  assert.equal(policy.exposesProviderProvisioningTarget, true);
  // 远端裁剪：不含本机（桌面）workspace 执行能力与 host 绑定工具面。
  assert.equal(policy.exposesDesktopLocalExecution, false);
  assert.equal(policy.exposesHostBoundTooling, false);
  assert.equal(policy.isDesktopLocal, false);
  assert.equal(policy.isDesktopAttachedRemote, false);
});

test("云执行节点：桌面呈现面不落地（与 desktop-attached-remote 的既有行为区分）", () => {
  assert.equal(
    resolveZCodeAgentPresentationSurface({ serviceAuthorityMode: CLOUD_MODE }),
    undefined,
    "云节点不得把远端 workspace 投影成桌面呈现面",
  );
  assert.equal(
    resolveZCodeAgentPresentationSurface({ serviceAuthorityMode: "desktop-attached-remote" }),
    "desktop",
    "既有远端 attachment 语义保持不变",
  );
  // 桌面呈现面还需要 runtimeSurface=desktop_local_host 这一可信装配事实；
  // 只给 authority 模式时保持 undefined（既有行为，不变）。
  assert.equal(
    resolveZCodeAgentPresentationSurface({ serviceAuthorityMode: "desktop-local" }),
    undefined,
    "缺少 runtimeSurface 事实时不推出桌面呈现面（既有行为）",
  );
  assert.equal(
    resolveZCodeAgentPresentationSurface({
      serviceAuthorityMode: "desktop-local",
      runtimeSurface: "desktop_local_host",
    }),
    "desktop",
  );
});

test("回归：既有三种 authority 的结论逐项未变", () => {
  // 未设置（历史 host 装配语义）：本地应答、不开 target、保留本机工具面。
  const unset = resolveServiceAuthorityPolicy(undefined);
  assert.deepEqual(
    [
      unset.answersRuntimePreferencesLocally,
      unset.exposesProviderProvisioningTarget,
      unset.exposesHostBoundTooling,
      unset.exposesDesktopLocalExecution,
    ],
    [true, false, true, false],
  );
  const desktopLocal = resolveServiceAuthorityPolicy("desktop-local");
  assert.deepEqual(
    [
      desktopLocal.answersRuntimePreferencesLocally,
      desktopLocal.exposesProviderProvisioningTarget,
      desktopLocal.exposesHostBoundTooling,
      desktopLocal.exposesDesktopLocalExecution,
    ],
    [true, false, true, true],
  );
  // desktop-attached-remote：唯一交给外部 Host 应答 prefs 的模式（07 §8）。
  const attached = resolveServiceAuthorityPolicy("desktop-attached-remote");
  assert.deepEqual(
    [
      attached.answersRuntimePreferencesLocally,
      attached.exposesProviderProvisioningTarget,
      attached.exposesHostBoundTooling,
      attached.exposesDesktopLocalExecution,
    ],
    [false, true, false, false],
  );
  const standalone = resolveServiceAuthorityPolicy("standalone-server");
  assert.deepEqual(
    [
      standalone.answersRuntimePreferencesLocally,
      standalone.exposesProviderProvisioningTarget,
      standalone.exposesHostBoundTooling,
      standalone.exposesDesktopLocalExecution,
    ],
    [true, false, true, false],
  );
  // 未知模式不误开云分支（fail-safe）。
  assert.equal(resolveServiceAuthorityPolicy(undefined).isCloudExecutionNode, false);
});

test("沙箱 runtime 启动 env：默认即云执行节点模式，显式 desktop-local 被拒绝并覆盖", () => {
  const env = runtimeEnv("/home/user/.zcode/server");
  assert.equal(env[SERVICE_AUTHORITY_MODE_ENV], CLOUD_EXECUTION_NODE_AUTHORITY_MODE);
  assert.equal(parseExecutionAuthority(undefined), CLOUD_EXECUTION_NODE_AUTHORITY_MODE);
  assert.equal(parseExecutionAuthority("desktop-local"), CLOUD_EXECUTION_NODE_AUTHORITY_MODE);
  assert.equal(parseExecutionAuthority("desktop-attached-remote"), "desktop-attached-remote");
  const overridden = runtimeEnv("/root", { [SERVICE_AUTHORITY_MODE_ENV]: "desktop-local" });
  assert.equal(overridden[SERVICE_AUTHORITY_MODE_ENV], CLOUD_EXECUTION_NODE_AUTHORITY_MODE);
});

test("装配接线守卫：services/node.ts 消费 authority 策略结论（不是摆设）", async () => {
  const nodeSource = await readFile(
    fileURLToPath(new URL("../../services/src/node.ts", import.meta.url)),
    "utf8",
  );
  assert.match(nodeSource, /resolveServiceAuthorityPolicy\(/);
  for (const field of [
    "answersRuntimePreferencesLocally",
    "exposesProviderProvisioningTarget",
    "exposesHostBoundTooling",
    "exposesDesktopLocalExecution",
  ]) {
    assert.ok(nodeSource.includes(`authority.${field}`), `node.ts 必须消费 ${field}`);
  }
});
