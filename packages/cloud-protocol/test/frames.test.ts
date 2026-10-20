import { describe, expect, it } from "vitest";

import {
  decodeDataFrame,
  encodeDataFrame,
  parseControlFrame,
  parseBootstrapConfig,
} from "../src/index.js";

describe("control frames", () => {
  it("parses hello with daemon ingress", () => {
    const frame = parseControlFrame(
      JSON.stringify({
        type: "hello",
        v: 1,
        runId: "run-1",
        taskId: "task-1",
        generation: 2,
        bridgeVersion: "1.0.0",
        daemon: { state: "ready", port: 4100, ingressToken: "secret", version: "3.16.2" },
      }),
    );
    expect(frame?.type).toBe("hello");
    if (frame?.type === "hello") {
      expect(frame.daemon.port).toBe(4100);
      expect(frame.generation).toBe(2);
    }
  });

  it("parses stream_open and heartbeat", () => {
    expect(
      parseControlFrame(JSON.stringify({ type: "stream_open", streamId: 3, kind: "daemon" }))?.type,
    ).toBe("stream_open");
    expect(parseControlFrame(JSON.stringify({ type: "heartbeat", atMs: 1 }))?.type).toBe(
      "heartbeat",
    );
  });

  it("rejects malformed and unknown frames", () => {
    expect(parseControlFrame("not-json")).toBeNull();
    expect(parseControlFrame(JSON.stringify({ type: "unknown" }))).toBeNull();
    expect(
      parseControlFrame(
        JSON.stringify({ type: "hello", v: 2, runId: "r", taskId: "t", generation: 1 }),
      ),
    ).toBeNull();
  });

  it("rejects extra fields in strict frames", () => {
    expect(
      parseControlFrame(JSON.stringify({ type: "heartbeat", atMs: 1, surprise: true })),
    ).toBeNull();
  });
});

describe("data frames", () => {
  it("round-trips stream id and payload", () => {
    const payload = Buffer.from("hello world");
    const decoded = decodeDataFrame(encodeDataFrame(42, payload));
    expect(decoded?.streamId).toBe(42);
    expect(decoded?.payload.toString("utf8")).toBe("hello world");
  });

  it("rejects empty or header-only frames", () => {
    expect(decodeDataFrame(Buffer.alloc(0))).toBeNull();
    expect(decodeDataFrame(Buffer.alloc(4))).toBeNull();
  });

  it("rejects zero stream id", () => {
    const frame = encodeDataFrame(1, Buffer.from("x"));
    frame.writeUInt32BE(0, 0);
    expect(decodeDataFrame(frame)).toBeNull();
  });
});

describe("bootstrap config", () => {
  const valid = {
    v: 1,
    controlPlaneUrl: "ws://127.0.0.1:4040/api/cloud/bridge/attach",
    attachToken: "0123456789abcdef",
    runId: "run-1",
    taskId: "task-1",
    taskStableId: "t-abc123",
    generation: 1,
    serverRoot: "/tmp/server",
    dataDir: "/tmp/data",
    workspacePath: "/tmp/workspace",
  };

  it("accepts a valid config", () => {
    expect(parseBootstrapConfig(valid).taskStableId).toBe("t-abc123");
  });

  it("rejects unsafe taskStableId", () => {
    expect(() => parseBootstrapConfig({ ...valid, taskStableId: "Bad/Id" })).toThrow();
  });

  it("rejects a short attach token", () => {
    expect(() => parseBootstrapConfig({ ...valid, attachToken: "short" })).toThrow();
  });
});
