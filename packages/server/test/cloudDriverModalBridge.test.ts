/**
 * Modal 桥子进程契约测试（specs/cloud-agent/01 §6.2 实施决议）。
 *
 * 桥是控制面与官方 Modal Python SDK 之间唯一的受控调用面，因此这里用真实的子进程
 * （伪造的「解释器 + 脚本」）验证行协议与失败分类，而不是 mock：
 * - 哨兵行协议在后（SDK 噪声不得破坏协议）；
 * - 请求只经 **stdin**、凭据只经 **子进程 env**（argv 里都不许出现）；
 * - 超时/中止/无响应/协议不符都归「结果未知」（definite=false），只有进程从未运行
 *   （解释器缺失）与桥报告的确定失败才是 definite=true（01 §4.1 三分支）。
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildModalChildEnv,
  MODAL_BRIDGE_PROTOCOL,
  MODAL_BRIDGE_RESPONSE_SENTINEL,
  parseBridgeResponse,
  runModalBridgeProcess,
} from "../src/cloud/adapters/sandbox/modalBridgeProcess.js";

async function scriptFile(name: string, content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "zcode-modal-bridge-"));
  const path = join(directory, name);
  await writeFile(path, content, "utf8");
  return path;
}

test("桥协议：SDK 噪声在前，哨兵行在后；请求只经 stdin，不满 argv", async () => {
  const script = await scriptFile(
    "good.mjs",
    `
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  // 模拟官方 SDK 往 stdout 打进度/警告。
  process.stdout.write("progress 0%\\nwarning: something\\n");
  const request = JSON.parse(raw);
  process.stdout.write(${JSON.stringify(MODAL_BRIDGE_RESPONSE_SENTINEL)} + JSON.stringify({
    protocol: request.protocol,
    ok: true,
    result: { op: request.op, argv: process.argv, received: raw.includes("ticket-value") },
  }) + "\\n");
});
`,
  );

  const outcome = await runModalBridgeProcess({
    command: process.execPath,
    scriptPath: script,
    request: JSON.stringify({
      protocol: MODAL_BRIDGE_PROTOCOL,
      op: "create",
      ticket: "ticket-value",
    }),
    timeoutMs: 10_000,
    env: { PATH: process.env["PATH"] ?? "/usr/bin", HOME: tmpdir() },
  });

  assert.equal(outcome.ok, true);
  assert.ok(outcome.ok);
  assert.equal(outcome.result["op"], "create");
  assert.equal(outcome.result["received"], true, "请求体必须经 stdin 到达桥");
  const argv = outcome.result["argv"] as string[];
  assert.equal(argv.length, 2, "argv 只允许 [解释器, 脚本路径]");
  assert.equal(argv[1], script);
  assert.ok(!JSON.stringify(argv).includes("ticket-value"));
});

test("桥协议：错误信封 → 归一失败，definite 由桥报告决定", async () => {
  const script = await scriptFile(
    "fail.mjs",
    `
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(${JSON.stringify(MODAL_BRIDGE_RESPONSE_SENTINEL)} + JSON.stringify({
    protocol: ${MODAL_BRIDGE_PROTOCOL},
    ok: false,
    error: {
      code: "unsupported_template",
      reason: "image-build-failed",
      detail: "modal.Image.from_dockerfile: build error",
      definite: true,
      stage: "image",
    },
  }) + "\\n");
});
`,
  );

  const outcome = await runModalBridgeProcess({
    command: process.execPath,
    scriptPath: script,
    request: JSON.stringify({ protocol: MODAL_BRIDGE_PROTOCOL, op: "create" }),
    timeoutMs: 10_000,
    env: { PATH: process.env["PATH"] ?? "/usr/bin", HOME: tmpdir() },
  });

  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok);
  assert.equal(outcome.failure.kind, "bridge");
  assert.equal(outcome.failure.code, "unsupported_template");
  assert.equal(outcome.failure.definite, true);
  assert.equal(outcome.failure.stage, "image");
  assert.ok((outcome.failure.detail ?? "").length <= 200);
});

test("桥协议：结果未知的失败（网络/服务）definite=false，交由控制面对账", async () => {
  const script = await scriptFile(
    "unreachable.mjs",
    `
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(${JSON.stringify(MODAL_BRIDGE_RESPONSE_SENTINEL)} + JSON.stringify({
    protocol: ${MODAL_BRIDGE_PROTOCOL},
    ok: false,
    error: { code: "provider_unreachable", reason: "unreachable", definite: false, stage: "sandbox_create" },
  }) + "\\n");
});
`,
  );
  const outcome = await runModalBridgeProcess({
    command: process.execPath,
    scriptPath: script,
    request: JSON.stringify({ protocol: MODAL_BRIDGE_PROTOCOL, op: "create" }),
    timeoutMs: 10_000,
    env: { PATH: process.env["PATH"] ?? "/usr/bin", HOME: tmpdir() },
  });
  assert.ok(!outcome.ok);
  assert.equal(outcome.failure.definite, false);
  assert.equal(outcome.failure.code, "provider_unreachable");
});

test("桥进程失败分类：无响应行/超时/中止/解释器缺失", async () => {
  const silent = await scriptFile("silent.mjs", "process.stdin.resume();\n");
  const noResponse = await runModalBridgeProcess({
    command: process.execPath,
    scriptPath: silent,
    request: JSON.stringify({ protocol: MODAL_BRIDGE_PROTOCOL, op: "create" }),
    timeoutMs: 10_000,
    env: { PATH: process.env["PATH"] ?? "/usr/bin", HOME: tmpdir() },
  });
  assert.ok(!noResponse.ok);
  assert.equal(noResponse.failure.kind, "protocol");
  assert.equal(noResponse.failure.reason, "no-response-line");
  assert.equal(noResponse.failure.definite, false);

  const hanging = await scriptFile(
    "hanging.mjs",
    "process.stdin.resume(); setInterval(() => {}, 1000);\n",
  );
  const timedOut = await runModalBridgeProcess({
    command: process.execPath,
    scriptPath: hanging,
    request: JSON.stringify({ protocol: MODAL_BRIDGE_PROTOCOL, op: "create" }),
    timeoutMs: 300,
    env: { PATH: process.env["PATH"] ?? "/usr/bin", HOME: tmpdir() },
  });
  assert.ok(!timedOut.ok);
  assert.equal(timedOut.failure.kind, "timeout");
  assert.equal(timedOut.failure.definite, false);

  const controller = new AbortController();
  const abortedPromise = runModalBridgeProcess({
    command: process.execPath,
    scriptPath: hanging,
    request: JSON.stringify({ protocol: MODAL_BRIDGE_PROTOCOL, op: "create" }),
    timeoutMs: 10_000,
    signal: controller.signal,
    env: { PATH: process.env["PATH"] ?? "/usr/bin", HOME: tmpdir() },
  });
  controller.abort();
  const aborted = await abortedPromise;
  assert.ok(!aborted.ok);
  assert.equal(aborted.failure.kind, "aborted");
  assert.equal(aborted.failure.definite, false);

  // 解释器不存在：进程从未运行 → 不可能有 provider 副作用 → 明确失败。
  const missing = await runModalBridgeProcess({
    command: join(tmpdir(), "definitely-not-a-python-binary"),
    scriptPath: silent,
    request: JSON.stringify({ protocol: MODAL_BRIDGE_PROTOCOL, op: "create" }),
    timeoutMs: 10_000,
    env: { PATH: process.env["PATH"] ?? "/usr/bin", HOME: tmpdir() },
  });
  assert.ok(!missing.ok);
  assert.equal(missing.failure.kind, "spawn");
  assert.equal(missing.failure.definite, true);
  assert.equal(missing.failure.code, "resource_unsupported");
});

test("桥协议解析：协议不符/非 JSON/信封缺字段都判协议失败（不猜测）", () => {
  const mismatch = parseBridgeResponse(
    JSON.stringify({ protocol: MODAL_BRIDGE_PROTOCOL + 1, ok: true, result: {} }),
    MODAL_BRIDGE_PROTOCOL,
  );
  assert.ok(!mismatch.ok);
  assert.equal(mismatch.failure.reason, "protocol-mismatch");

  const invalid = parseBridgeResponse("{not json", MODAL_BRIDGE_PROTOCOL);
  assert.ok(!invalid.ok);
  assert.equal(invalid.failure.reason, "invalid-json");

  const malformed = parseBridgeResponse(
    JSON.stringify({ protocol: MODAL_BRIDGE_PROTOCOL, ok: false }),
    MODAL_BRIDGE_PROTOCOL,
  );
  assert.ok(!malformed.ok);
  assert.equal(malformed.failure.reason, "malformed-envelope");

  // 未知错误码不得进入归一目录：退化为 provider_unreachable（结果未知）。
  const unknownCode = parseBridgeResponse(
    sentinelBody("some-brand-new-code"),
    MODAL_BRIDGE_PROTOCOL,
  );
  assert.ok(!unknownCode.ok);
  assert.equal(unknownCode.failure.code, "provider_unreachable");
  assert.equal(unknownCode.failure.definite, false);
});

function sentinelBody(code: string): string {
  return JSON.stringify({
    protocol: MODAL_BRIDGE_PROTOCOL,
    ok: false,
    error: { code, reason: "x", definite: false },
  });
}

test("子进程 env：只带最小集 + TokenPair，不透传控制面其它环境变量", () => {
  process.env["ZCODE_TEST_LEAK_CANARY"] = "must-not-leak";
  try {
    const env = buildModalChildEnv("ak-token-id", "as-token-secret");
    assert.equal(env["MODAL_TOKEN_ID"], "ak-token-id");
    assert.equal(env["MODAL_TOKEN_SECRET"], "as-token-secret");
    // 固定私有空配置：避免操作者 home 下的 ~/.modal.toml 影响账号。
    assert.match(String(env["MODAL_CONFIG_PATH"]), /modal\.toml$/);
    assert.equal(env["ZCODE_TEST_LEAK_CANARY"], undefined);
    assert.equal(env["PYTHONUNBUFFERED"], "1");
    assert.equal(env["PATH"], process.env["PATH"]);
  } finally {
    delete process.env["ZCODE_TEST_LEAK_CANARY"];
  }
});
