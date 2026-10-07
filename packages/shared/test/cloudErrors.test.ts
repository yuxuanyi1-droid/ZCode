// Cloud 错误码目录用例（specs/cloud-agent/01 §9、09 §8、03 §6 错误信封）：
// round-trip、未知 code 拒绝、retryable 语义完整性。
import assert from "node:assert/strict";
import test from "node:test";
import {
  CLOUD_ERROR_CODES,
  CLOUD_ERROR_RETRYABLE,
  cloudErrorCodeSchema,
  isCloudErrorCode,
} from "../src/index.js";

test("error code round-trip and lookup", () => {
  for (const code of CLOUD_ERROR_CODES) {
    assert.equal(cloudErrorCodeSchema.parse(code), code);
    assert.equal(isCloudErrorCode(code), true);
  }
  assert.equal(isCloudErrorCode("totally_unknown_code"), false);
});

test("error code rejects unknown values and unknown protocol versions", () => {
  assert.equal(cloudErrorCodeSchema.safeParse("unknown_code").success, false);
  assert.equal(cloudErrorCodeSchema.safeParse("").success, false);
  assert.equal(cloudErrorCodeSchema.safeParse(2).success, false);
});

test("retryable directory covers every code and keeps unknown-result codes non-retryable", () => {
  const keys = Object.keys(CLOUD_ERROR_RETRYABLE).sort();
  assert.deepEqual(keys, [...CLOUD_ERROR_CODES].sort());
  // 结果未知的操作必须对账，不能标记为可自动重试（03 §5）。
  for (const code of ["provider_create_unknown", "provider_termination_unknown"] as const) {
    assert.equal(CLOUD_ERROR_RETRYABLE[code], false);
  }
  // 连接类错误只代表连接可恢复，不授权另建 writer（08 §3.2）。
  assert.equal(CLOUD_ERROR_RETRYABLE.bridge_disconnected, true);
  assert.equal(CLOUD_ERROR_RETRYABLE.provider_unreachable, true);
  assert.equal(CLOUD_ERROR_RETRYABLE.recovery_required, false);
});
