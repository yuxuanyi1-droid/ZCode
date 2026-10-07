// Cloud RPC 帧用例（specs/cloud-agent/02 §0、§4 尾段）：round-trip、未知版本拒绝、
// 非 base64/越界尺寸拒绝、反向帧 fail-closed。
import assert from "node:assert/strict";
import test from "node:test";
import {
  CLOUD_RPC_PAYLOAD_MAX_BASE64_CHARS,
  CLOUD_RPC_PAYLOAD_MAX_BYTES,
  CLOUD_RPC_PROTOCOL_VERSION,
  cloudRpcFrameSchema,
  isCloudRpcFrameInboundAllowed,
} from "../src/index.js";
import { RUN_ID, STREAM_ID } from "./cloudFixtures.js";

const address = {
  protocolVersion: CLOUD_RPC_PROTOCOL_VERSION,
  runId: RUN_ID,
  runGeneration: 1,
  connectionEpoch: 2,
  streamId: STREAM_ID,
} as const;

test("rpc frames round-trip for open / request / response / close", () => {
  const payload = Buffer.from("example-channel-frame").toString("base64");
  for (const frame of [
    { ...address, type: "rpc.open" },
    { ...address, type: "rpc.request", payload },
    { ...address, type: "rpc.response", payload },
    { ...address, type: "rpc.close" },
  ] as const) {
    const parsed = cloudRpcFrameSchema.parse(frame);
    assert.deepEqual(cloudRpcFrameSchema.parse(JSON.parse(JSON.stringify(parsed))), parsed);
  }
});

test("rpc frames reject unknown protocol version, unknown type and unknown fields", () => {
  assert.equal(
    cloudRpcFrameSchema.safeParse({ ...address, protocolVersion: 2, type: "rpc.open" }).success,
    false,
  );
  assert.equal(cloudRpcFrameSchema.safeParse({ ...address, type: "rpc.attach" }).success, false);
  assert.equal(
    cloudRpcFrameSchema.safeParse({ ...address, type: "rpc.open", payload: "AA==" }).success,
    false,
  );
  assert.equal(
    cloudRpcFrameSchema.safeParse({ ...address, type: "rpc.open", injected: true }).success,
    false,
  );
});

test("rpc payloads are bounded base64 bytes", () => {
  assert.equal(
    cloudRpcFrameSchema.safeParse({ ...address, type: "rpc.request", payload: "not base64!" })
      .success,
    false,
  );
  // 非 4 的倍数或非法 padding 一律拒绝。
  assert.equal(
    cloudRpcFrameSchema.safeParse({ ...address, type: "rpc.request", payload: "AAA" }).success,
    false,
  );
  assert.equal(
    cloudRpcFrameSchema.safeParse({
      ...address,
      type: "rpc.request",
      payload: "A".repeat(CLOUD_RPC_PAYLOAD_MAX_BASE64_CHARS + 4),
    }).success,
    false,
  );
  assert.equal(
    cloudRpcFrameSchema.safeParse({ ...address, type: "rpc.request", payload: "" }).success,
    false,
  );
});

test("rpc payloads accept a full-size frame without stack overflow", () => {
  // 回归：分组正则在多 MiB payload 上会栈溢出，RPC 必须能承载满额帧。
  const payload = Buffer.alloc(CLOUD_RPC_PAYLOAD_MAX_BYTES, 7).toString("base64");
  assert.ok(payload.length <= CLOUD_RPC_PAYLOAD_MAX_BASE64_CHARS);
  const frame = cloudRpcFrameSchema.parse({ ...address, type: "rpc.request", payload });
  assert.equal(frame.type, "rpc.request");
});

test("rpc frame direction is fail-closed per receiver", () => {
  assert.equal(isCloudRpcFrameInboundAllowed("rpc.request", "bridge"), true);
  assert.equal(isCloudRpcFrameInboundAllowed("rpc.request", "control-plane"), false);
  assert.equal(isCloudRpcFrameInboundAllowed("rpc.response", "control-plane"), true);
  assert.equal(isCloudRpcFrameInboundAllowed("rpc.close", "control-plane"), true);
  assert.equal(isCloudRpcFrameInboundAllowed("rpc.close", "bridge"), true);
});
