import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BridgeServer,
  CloudHttpServer,
  CloudStore,
  EventHub,
  FAKE_DAEMON_ENTRY,
  Orchestrator,
  ProcessSandboxDriver,
  SecretBox,
} from "../src/index.js";
import type { CloudTaskDto, CloudHistoryPageDto } from "@zcode/cloud-protocol";

const TOKEN = "test-token";

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), "cloud-e2e-"));
  const store = new CloudStore(join(dataDir, "cloud.db"));
  const secrets = await SecretBox.fromDataDir(dataDir);
  const events = new EventHub();
  const drivers = new Map([
    [
      "fake",
      new ProcessSandboxDriver({
        id: "fake",
        label: "Fake sandbox",
        sandboxRoot: join(dataDir, "sandboxes"),
        capabilities: { pause: false, maxLifetimeSeconds: 86_400, verified: true },
        serverCommand: [process.execPath, "--import", "tsx", FAKE_DAEMON_ENTRY],
        skipCheckout: true,
      }),
    ],
  ]);
  let port = 0;
  const orchestrator = new Orchestrator({
    store,
    secrets,
    drivers,
    defaultProvider: "fake",
    publicUrl: () => `ws://127.0.0.1:${port}/api/cloud/bridge/attach`,
    broadcast: events.broadcast,
  });
  const bridgeServer = new BridgeServer({
    verifyAttach: (runId, token) => orchestrator.verifyAttach(runId, token),
    onAttached: (attachment) => orchestrator.onAttached(attachment),
    onDetached: (runId, epoch) => orchestrator.onDetached(runId, epoch),
    onDaemonStatus: (attachment) => orchestrator.onDaemonStatus(attachment),
  });
  const httpServer = new CloudHttpServer({
    host: "127.0.0.1",
    port: 0,
    accessToken: TOKEN,
    webDistDir: null,
    orchestrator,
    bridgeServer,
    events,
    accountLink: null,
    providers: [
      {
        id: "fake",
        label: "Fake sandbox",
        pause: false,
        maxLifetimeSeconds: 86_400,
        verified: true,
      },
    ],
  });
  await httpServer.start();
  port = httpServer.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      httpServer.close();
      orchestrator.dispose();
      store.close();
      await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

async function api<T>(baseUrl: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  return body as T;
}

async function waitFor<T>(
  probe: () => Promise<T | null | undefined>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timeout waiting for ${label}${last ? `: ${String(last)}` : ""}`);
}

describe("cloud agent e2e (fake provider + real bridge/tunnel)", () => {
  it("runs the full task lifecycle and survives restart of the task", async () => {
    const harness = await createHarness();
    try {
      const project = await api<{ id: string }>(harness.baseUrl, "/api/cloud/projects", {
        method: "POST",
        body: JSON.stringify({
          name: "Demo",
          repoUrl: "https://github.com/example/demo.git",
          defaultBranch: "main",
        }),
      });

      const task = await api<CloudTaskDto>(harness.baseUrl, "/api/cloud/tasks", {
        method: "POST",
        body: JSON.stringify({ projectId: project.id, title: "First task" }),
      });
      expect(task.status).toBe("draft");
      expect(task.workspaceIdentity).toContain("remote:server:");

      await api(harness.baseUrl, `/api/cloud/tasks/${task.id}/inputs`, {
        method: "POST",
        body: JSON.stringify({ commandId: "cmd-1", intent: "start", prompt: "hello cloud" }),
      });

      const ready = await waitFor(
        async () => {
          const current = await api<CloudTaskDto>(harness.baseUrl, `/api/cloud/tasks/${task.id}`);
          return current.run?.status === "ready" ? current : null;
        },
        90_000,
        "run ready",
      );
      expect(ready.run?.generation).toBe(1);
      expect(ready.status).toBe("active");

      const history = await waitFor(
        async () => {
          const page = await api<CloudHistoryPageDto>(
            harness.baseUrl,
            `/api/cloud/tasks/${task.id}/history`,
          );
          return page.events.length >= 2 ? page : null;
        },
        30_000,
        "projection events",
      );
      const texts = history.events.map((event) => JSON.stringify(event.payload));
      expect(texts.some((text) => text.includes("hello cloud"))).toBe(true);
      expect(texts.some((text) => text.includes("echo: hello cloud"))).toBe(true);

      // commandId 幂等：重复提交不新增输入
      const repeated = await api<{ commandId: string; status: string }>(
        harness.baseUrl,
        `/api/cloud/tasks/${task.id}/inputs`,
        {
          method: "POST",
          body: JSON.stringify({ commandId: "cmd-1", intent: "start", prompt: "hello cloud" }),
        },
      );
      expect(repeated.commandId).toBe("cmd-1");

      const stopped = await api<CloudTaskDto>(harness.baseUrl, `/api/cloud/tasks/${task.id}/stop`, {
        method: "POST",
        body: "{}",
      });
      expect(stopped.status).toBe("completed");
      expect(stopped.run?.status).toBe("stopped");

      const reopened = await api<CloudTaskDto>(
        harness.baseUrl,
        `/api/cloud/tasks/${task.id}/reopen`,
        { method: "POST", body: "{}" },
      );
      expect(reopened.activeRunId).toBeNull();

      await api(harness.baseUrl, `/api/cloud/tasks/${task.id}/inputs`, {
        method: "POST",
        body: JSON.stringify({ commandId: "cmd-2", intent: "start", prompt: "second round" }),
      });

      const secondRun = await waitFor(
        async () => {
          const current = await api<CloudTaskDto>(harness.baseUrl, `/api/cloud/tasks/${task.id}`);
          return current.run?.status === "ready" && current.run.generation === 2 ? current : null;
        },
        90_000,
        "second run ready",
      );
      expect(secondRun.run?.generation).toBe(2);

      const merged = await waitFor(
        async () => {
          const page = await api<CloudHistoryPageDto>(
            harness.baseUrl,
            `/api/cloud/tasks/${task.id}/history`,
          );
          const joined = page.events.map((event) => JSON.stringify(event.payload)).join("\n");
          return joined.includes("second round") && joined.includes("echo: second round")
            ? page
            : null;
        },
        30_000,
        "second round projection",
      );
      // 历史跨 Run 累积
      expect(merged.events.length).toBeGreaterThanOrEqual(4);
    } finally {
      await harness.close();
    }
  }, 180_000);
});
