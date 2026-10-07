/**
 * W1 × W5 接缝测试（W5 CR-1）：把入口级控制面装配接到 `startCloudServer`，证明生产路径
 * 不再以 `not_implemented` fail-closed，且装配遵守 W5 冻结的三条硬性要求
 * （storageWorkerEntryPath 透传 / readiness 门槛 / 不自建定时器）。
 *
 * 存储用 W2 的 in-process 客户端注入（不落真实 `~/.zcode`、不 spawn worker）。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { ISettingService, ServiceCollection } from "@zcode/services";
import { createServiceLogger } from "@zcode/services/node";
import { createCloudStorage } from "../src/cloud/adapters/storage/cloudStorageClient.js";
import { startCloudServer } from "../src/cloud/adapters/entry-cloud-server.js";
import type { CloudEntryConfig } from "../src/cloud/adapters/entry-cloud-config.js";
import type { CloudDeploymentSecrets } from "../src/cloud/adapters/entry-cloud-secrets.js";
import { assembleCloudControlPlane } from "../src/cloud/adapters/entry-cloud-control-plane.js";
import type { SandboxDriverRegistryPort } from "../src/cloud/app/ports/sandboxDriverRegistryPort.js";

const AUTH_TOKEN = "cloud-core-entry-token";

function testSecrets(): CloudDeploymentSecrets {
  return {
    authToken: AUTH_TOKEN,
    principalId: "deployment-principal",
    describe: () => ({
      principalId: "deployment-principal",
      authToken: "configured",
      credentialSecret: "absent",
      gitHubApp: "absent",
    }),
  };
}

const fakeDrivers: SandboxDriverRegistryPort = {
  resolve: async () => null,
  listProviders: async () => [],
};

function baseConfig(dataDir: string): CloudEntryConfig {
  return {
    mode: "cloud",
    publicOrigin: "http://127.0.0.1:1",
    listenPort: 0,
    dataDir,
    providers: ["e2b"],
    allowUnverifiedProviders: [],
    maxConcurrentRuns: 1,
    secrets: {},
  };
}

function hostServices(): ServiceCollection {
  return new ServiceCollection().register(ISettingService, {
    get: async () => ({ ok: true }),
  } as unknown as ISettingService);
}

async function withTempDir<T>(prefix: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("W5 CR-1：入口装配接到 startCloudServer 后生产路径不再 fail-closed", async () => {
  await withTempDir("cloud-core-entry-", async (dataDir) => {
    const storage = await createCloudStorage({
      dataDir,
      attachmentsDir: path.join(dataDir, "attachments"),
      transportMode: "in-process",
    });
    let handle: Awaited<ReturnType<typeof startCloudServer>> | undefined;
    try {
      handle = await startCloudServer({
        config: baseConfig(dataDir),
        secrets: testSecrets(),
        drivers: fakeDrivers,
        hostServices: hostServices(),
        // W5 冻结的注入缝：工厂由 W1 提供。
        createControlPlane: assembleCloudControlPlane,
        // 注入存储：入口先跑 readiness 门槛，控制面复用同一实例（不再自持）。
        storage,
        listenPort: 0,
        listenHost: "127.0.0.1",
        logger: createServiceLogger("cloud-core-entry-test", {
          sink: { log: () => undefined, warn: () => undefined, error: () => undefined },
          isDebugEnabled: false,
        }),
      });
      assert.equal(handle.principalId, "deployment-principal");
      assert.equal(handle.loops.delivery.name, "delivery");
      assert.equal(handle.loops.lifecycle.name, "lifecycle");

      // 认证由 W5 的 lite-token 中间件负责；控制面路由按其语义作答。
      const unauthorized = await fetch(`http://127.0.0.1:${handle.port}/api/cloud/capabilities`);
      assert.equal(unauthorized.status, 401);
      const capabilities = await fetch(
        `http://127.0.0.1:${handle.port}/api/cloud/capabilities?token=${AUTH_TOKEN}`,
      );
      assert.equal(capabilities.status, 200);
      const body = (await capabilities.json()) as {
        mode: string;
        protocolVersion: number;
        taskOwnedAttachments: boolean;
      };
      assert.equal(body.mode, "cloud");
      assert.equal(body.protocolVersion, 1);
      assert.equal(body.taskOwnedAttachments, false, "首版不开放 task-owned 上传（11 §9）");

      // 分阶段端点如实 501，不伪装成功（03 §6）。
      const events = await fetch(
        `http://127.0.0.1:${handle.port}/api/cloud/events?token=${AUTH_TOKEN}`,
      );
      assert.equal(events.status, 501);
      const projects = await fetch(
        `http://127.0.0.1:${handle.port}/api/cloud/projects?token=${AUTH_TOKEN}`,
      );
      assert.equal(projects.status, 200);
      assert.deepEqual(await projects.json(), { items: [] });
    } finally {
      // 断言失败也必须关停循环与服务器，否则后台 tick 会拖住测试进程。
      await handle?.close().catch(() => undefined);
      // 入口在关闭链里可能已经关过注入的存储（W5 关闭顺序）；重复关闭按幂等处理。
      await storage.close().catch(() => undefined);
    }
  });
});

test("任务 WS 通道：未知 Task 时结构化关闭（不回落本机执行域，CP-11）", async () => {
  await withTempDir("cloud-core-entry-ws-", async (dataDir) => {
    const storage = await createCloudStorage({
      dataDir,
      attachmentsDir: path.join(dataDir, "attachments"),
      transportMode: "in-process",
    });
    let handle: Awaited<ReturnType<typeof startCloudServer>> | undefined;
    try {
      handle = await startCloudServer({
        config: baseConfig(dataDir),
        secrets: testSecrets(),
        drivers: fakeDrivers,
        hostServices: hostServices(),
        createControlPlane: assembleCloudControlPlane,
        storage,
        listenPort: 0,
        listenHost: "127.0.0.1",
        logger: createServiceLogger("cloud-core-entry-ws-test", {
          sink: { log: () => undefined, warn: () => undefined, error: () => undefined },
          isDebugEnabled: false,
        }),
      });
      // 真实 WS 升级：入口把这个通道交给控制面注册（W5 现已透传 upgradeWebSocket）。
      const closeEvent = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
        const socket = new WebSocket(
          `ws://127.0.0.1:${handle?.port ?? 0}/ws/cloud/tasks/00000000-0000-4000-8000-0000000000c1?token=${AUTH_TOKEN}`,
        );
        socket.on("close", (code: number, reason: Buffer) =>
          resolve({ code, reason: reason.toString() }),
        );
        socket.on("error", (error: Error) => reject(error));
        setTimeout(() => reject(new Error("ws close timeout")), 5_000);
      });
      assert.equal(closeEvent.code, 4404, "无有效 attachment：结构化关闭，不执行任何本机操作");
      assert.match(closeEvent.reason, /task-not-found/);

      // bridge 通道：未登记的 run 直接关闭，不建立连接表项（03 §8「不建替代沙箱」）。
      const bridgeClose = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
        const socket = new WebSocket(
          `ws://127.0.0.1:${handle?.port ?? 0}/ws/cloud/bridge/00000000-0000-4000-8000-0000000000c2?token=${AUTH_TOKEN}`,
        );
        socket.on("close", (code: number, reason: Buffer) =>
          resolve({ code, reason: reason.toString() }),
        );
        socket.on("error", (error: Error) => reject(error));
        setTimeout(() => reject(new Error("ws close timeout")), 5_000);
      });
      assert.equal(bridgeClose.code, 1008);
      assert.match(bridgeClose.reason, /run-not-found/);
    } finally {
      await handle?.close().catch(() => undefined);
      // 入口在关闭链里可能已经关过注入的存储（W5 关闭顺序）；重复关闭按幂等处理。
      await storage.close().catch(() => undefined);
    }
  });
});
