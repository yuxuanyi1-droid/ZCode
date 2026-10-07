/**
 * 沙箱 provider 真实账号联调（specs/cloud-agent/01 §4.2、W3 §6 验收第二项）。
 *
 * **默认全部 skip**：没有真实凭据时不伪造通过结果。解禁某个 provider 前必须跑通本文件
 * 并记录证据（能力、期限、停止语义、启动开销），然后把日期写进 capabilities.ts 的
 * SANDBOX_PROVIDER_GATES。启用方式与环境变量见模块 README「provider 解禁」一节：
 *
 *   E2B_API_KEY=…                 (E2B)
 *   DAYTONA_API_KEY=…             (Daytona)
 *   MODAL_TOKEN_ID / MODAL_TOKEN_SECRET / ZCODE_CLOUD_MODAL_PYTHON / ZCODE_CLOUD_MODAL_DOCKERFILE (Modal)
 *   ZCODE_CLOUD_SANDBOX_TEMPLATE_REF=e2b:zcode-sandbox-template,daytona:zcode-sandbox-template
 *                                                          (部署同一键：`provider:ref`，逗号分隔；
 *                                                           先按 templates/README.md 建模板)
 *   E2B_BASE_URL / DAYTONA_BASE_URL                        (可选：自托管 REST base)
 *
 * 每条用例自建资源，**finally 里终止**；终止结果未知时打印 sandboxId 供人工清理
 * （provider 计费以真实账单为准）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createDaytonaSandboxDriver } from "../src/cloud/adapters/sandbox/daytonaDriver.js";
import { createE2bSandboxDriver } from "../src/cloud/adapters/sandbox/e2bDriver.js";
import { createModalSandboxDriver } from "../src/cloud/adapters/sandbox/modalDriver.js";
import { createModalSdkBridge } from "../src/cloud/adapters/sandbox/modalSdkBridge.js";
import type {
  SandboxCreateInput,
  SandboxDriverPort,
  ProviderSandboxHandle,
} from "../src/cloud/app/ports/sandboxDriverPort.js";

const TEMPLATE_REF_CONFIG = process.env["ZCODE_CLOUD_SANDBOX_TEMPLATE_REF"]?.trim() ?? "";
const E2B_API_KEY = process.env["E2B_API_KEY"]?.trim() ?? "";
const DAYTONA_API_KEY = process.env["DAYTONA_API_KEY"]?.trim() ?? "";
const MODAL_TOKEN_ID = process.env["MODAL_TOKEN_ID"]?.trim() ?? "";
const MODAL_TOKEN_SECRET = process.env["MODAL_TOKEN_SECRET"]?.trim() ?? "";
const MODAL_PYTHON = process.env["ZCODE_CLOUD_MODAL_PYTHON"]?.trim() ?? "";
const MODAL_DOCKERFILE = process.env["ZCODE_CLOUD_MODAL_DOCKERFILE"]?.trim() ?? "";

const NO_TEMPLATE = (provider: string) =>
  `ZCODE_CLOUD_SANDBOX_TEMPLATE_REF 未配置 ${provider} 的模板（形式 provider:ref）：先按 templates/README.md 构建模板再联调`;

/**
 * 部署键 `provider:ref`（多家逗号分隔；ref 自身可含 `:`，只按第一个 `:` 切分）
 * → 指定 provider 的模板 ref。未配置/未命中返回 ""（不猜默认模板）。
 */
function templateRefFor(provider: "e2b" | "modal" | "daytona"): string {
  for (const entry of TEMPLATE_REF_CONFIG.split(",")) {
    const separator = entry.indexOf(":");
    if (separator <= 0) continue;
    if (entry.slice(0, separator).trim() === provider) {
      return entry.slice(separator + 1).trim();
    }
  }
  return "";
}

function liveInput(provider: "e2b" | "modal" | "daytona"): SandboxCreateInput {
  const now = Date.now();
  return {
    operationKey: `live-${provider}-${now}`,
    runId: `live-run-${now}`,
    runGeneration: 1,
    // 非秘密 run 地址：taskId 必须是合法 id（cloudTaskIdSchema），路径必须绝对。
    bootstrapAddress: {
      taskId: "8f1b0f9e-3b1a-4c2d-9e6f-0a1b2c3d4e5f",
      workspacePath: `/workspace/${provider}-live-repo`,
    },
    imageRef: templateRefFor(provider),
    resources: { cpu: 2, memoryMiB: 4096, diskGiB: 10 },
    // 10 分钟：足够完成 create→inspect→terminate，且不长期占用账号配额。
    requestedDeadline: now + 10 * 60_000,
    publicControlPlaneUrl: "https://control.invalid.test",
    bootstrapTicket: `live-ticket-${now}`,
    labels: { purpose: "w3-live-verification" },
    signal: new AbortController().signal,
  };
}

/**
 * 联调共用流程：create → 句柄 → inspect 存活 → 对账命中 → terminate 确认 → notFound。
 * 自举失败的沙箱在真实部署里会被补偿终止；联调时若 bootstrap 通道未就绪（模板未含
 * start-supervisor.sh / 无法回连），adapter 会明确报错并终止资源——这本身也是证据。
 */
async function verifyLifecycle(
  provider: string,
  driver: SandboxDriverPort,
  options?: { expectBootstrapFailure?: boolean },
): Promise<string[]> {
  const evidence: string[] = [];
  let handle: ProviderSandboxHandle | undefined;
  const input = liveInput(provider);
  try {
    const capabilities = await driver.describeCapabilities();
    evidence.push(`capabilities=${JSON.stringify(capabilities)}`);

    const createStartedAt = Date.now();
    try {
      handle = await driver.create(input);
      evidence.push(`create=${Date.now() - createStartedAt}ms sandboxId=${handle.sandboxId}`);
      evidence.push(
        `deadline providerDeadline=${handle.providerDeadline ?? "-"} estimate=${handle.deadlineEstimate ?? "-"}`,
      );
    } catch (error) {
      if (options?.expectBootstrapFailure) {
        // 自举通道未接入（例如 Modal 未配置桥）时，create 必须明确失败且不留孤儿。
        evidence.push(`create=definite-failure ${(error as { code?: string }).code ?? ""}`);
        return evidence;
      }
      throw error;
    }

    const inspected = await driver.inspect(handle);
    evidence.push(`inspect=${inspected.status}(${inspected.evidenceSource})`);
    assert.notEqual(inspected.status, "unknown", "真实账号联调不得返回 unknown");

    const reconciled = await driver.findCreateResult(input.operationKey);
    evidence.push(`findCreateResult=${JSON.stringify(reconciled)}`);

    const terminateStartedAt = Date.now();
    const terminated = await driver.terminate(handle);
    evidence.push(`terminate=${terminated.status} ${Date.now() - terminateStartedAt}ms`);
    assert.equal(terminated.status, "terminated", "provider 必须确认终止（否则保留计费槽）");

    const afterTerminate = await driver.inspect(handle);
    evidence.push(`inspect-after-terminate=${afterTerminate.status}`);
    assert.notEqual(afterTerminate.status, "running", "终止后不得仍报告运行中");
    return evidence;
  } finally {
    if (handle && !evidence.some((line) => line.startsWith("terminate="))) {
      const cleanup = await driver.terminate(handle).catch(() => ({ status: "unknown" as const }));
      if (cleanup.status !== "terminated") {
        process.stderr.write(
          `[live] 需人工清理：${provider} sandboxId=${handle.sandboxId}（终止结果未确认）\n`,
        );
      }
    }
    for (const line of evidence) {
      process.stdout.write(`[live:${provider}] ${line}\n`);
    }
  }
}

test("live e2b：create → inspect → 对账 → terminate 确认", { skip: liveSkip("e2b") }, async () => {
  const driver = createE2bSandboxDriver({
    apiKey: () => E2B_API_KEY,
    ...(process.env["E2B_BASE_URL"] ? { baseUrl: process.env["E2B_BASE_URL"] } : {}),
  });
  await verifyLifecycle("e2b", driver);
});

test(
  "live daytona：create → inspect → 对账 → terminate 确认（TTL 语义）",
  { skip: liveSkip("daytona") },
  async () => {
    const driver = createDaytonaSandboxDriver({
      apiKey: () => DAYTONA_API_KEY,
      ...(process.env["DAYTONA_BASE_URL"] ? { baseUrl: process.env["DAYTONA_BASE_URL"] } : {}),
    });
    await verifyLifecycle("daytona", driver);
  },
);

test(
  "live modal：经官方 Python SDK 桥 create → inspect → terminate 确认",
  { skip: liveSkip("modal") },
  async () => {
    const bridge = createModalSdkBridge({
      tokenId: () => MODAL_TOKEN_ID,
      tokenSecret: () => MODAL_TOKEN_SECRET,
      ...(MODAL_PYTHON ? { pythonPath: MODAL_PYTHON } : {}),
    });
    const driver = createModalSandboxDriver({
      bridge,
      imageDockerfile: MODAL_DOCKERFILE,
      ...(process.env["ZCODE_CLOUD_MODAL_APP"]
        ? { appName: process.env["ZCODE_CLOUD_MODAL_APP"] }
        : {}),
    });

    // 桥可用性先单独取证：缺 Python 解释器 / 缺 modal 包时给出可操作结论，
    // 而不是把它混进 create 结果里。
    const probe = await bridge.call("probe", {});
    assert.equal(
      probe.ok,
      true,
      `Modal SDK 桥不可用：${probe.ok ? "" : `${probe.failure.kind}/${probe.failure.reason}`}（检查 ZCODE_CLOUD_MODAL_PYTHON 与 modal 包）`,
    );

    await verifyLifecycle("modal", driver);
  },
);

function liveSkip(provider: "e2b" | "modal" | "daytona"): string | false {
  if (!templateRefFor(provider)) return NO_TEMPLATE(provider);
  if (provider === "e2b" && !E2B_API_KEY) return "E2B_API_KEY 未设置";
  if (provider === "daytona" && !DAYTONA_API_KEY) return "DAYTONA_API_KEY 未设置";
  if (provider === "modal") {
    if (!MODAL_TOKEN_ID || !MODAL_TOKEN_SECRET) return "MODAL_TOKEN_ID/SECRET 未设置";
    if (!MODAL_PYTHON) return "ZCODE_CLOUD_MODAL_PYTHON 未设置（venv 部署必须显式指定解释器）";
    if (!MODAL_DOCKERFILE) return "ZCODE_CLOUD_MODAL_DOCKERFILE 未设置（Modal 端镜像来源）";
  }
  return false;
}
