/**
 * pane 数据面 services 选择用例（specs/cloud-agent/W8 §3、04 §3.0/§4）。
 *
 * 回归背景：`V4PaneConversationProvider` 原来只认通用 workspace 解析 —— 云任务工作区
 * （identity = `cloud-task:<taskId>`）的 `isRemoteTarget` 恒为 true，而 remote session 注册表里
 * 没有、也不会有对应会话，于是永远停在 `remote-waiting`（`rpcReady=false`），pane 直接
 * `return null`：点开云任务后右侧工作区整块空白、控制台无报错。
 *
 * 规则本体在 `src/v4/paneConversationServices.ts`（纯函数，无 `@/` 别名 import，
 * 测试运行器可直接加载）。这里固定两条语义：
 * - 云作用域：由 CloudWorkspaceProvider 合成，**不看** `rpcReady`；
 * - 非云作用域：保持原判据，`remote-waiting` 时不挂数据层、不回落 base services。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { resolveV4PaneConversationServices } from "../src/v4/paneConversationServices.js";

const CLOUD_SERVICES = { zcodeAgentService: { origin: "cloud-attachment" } };
const REMOTE_SERVICES = { zcodeAgentService: { origin: "ssh-host" } };
const BASE_SERVICES = { zcodeAgentService: { origin: "base-host" } };

test("cloud pane scope uses the cloud-composed services even when the remote resolution is waiting", () => {
  // 云任务：通用解析必然是 remote-waiting（identity 非空 + 没有 remote session 登记）。
  const services = resolveV4PaneConversationServices({
    cloudServices: CLOUD_SERVICES,
    resolution: { rpcReady: false, services: BASE_SERVICES, connectionKind: "remote-waiting" },
  });

  // 必须拿到云合成作用域；不能因为 rpcReady=false 返回 null（那正是空白工作区的成因）。
  assert.equal(services, CLOUD_SERVICES);
});

test("cloud pane scope stays authoritative when the resolution also reports ready", () => {
  const services = resolveV4PaneConversationServices({
    cloudServices: CLOUD_SERVICES,
    resolution: { rpcReady: true, services: REMOTE_SERVICES, connectionKind: "remote-ready" },
  });

  assert.equal(services, CLOUD_SERVICES);
});

test("non-cloud pane scope keeps the fail-closed remote-waiting behaviour", () => {
  // 远端 SSH / 已配对远控：services 尚未注册时不挂数据层，也不回落 base services。
  const services = resolveV4PaneConversationServices({
    cloudServices: null,
    resolution: { rpcReady: false, services: BASE_SERVICES, connectionKind: "remote-waiting" },
  });

  assert.equal(services, null);
});

test("non-cloud pane scope uses the resolved workspace services when ready", () => {
  const services = resolveV4PaneConversationServices({
    cloudServices: null,
    resolution: { rpcReady: true, services: REMOTE_SERVICES, connectionKind: "remote-ready" },
  });

  assert.equal(services, REMOTE_SERVICES);
});
