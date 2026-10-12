/**
 * M8 连接期同步的控制面 RPC 端口测试替身（specs/cloud-agent 14 §4.2/§4.6；W11 §13B）。
 *
 * 记录每次调用的完整形状（run 地址 + channel/method/args），并支持：
 * - 逐方法编程响应（`respond`）与失败（`fail`）；
 * - 缺省编程（`defaultResult`）；
 * - 调用闸门（`gate`）：让某方法的响应挂起，供"在飞期间手动 join"用例确定性地等待。
 *
 * 不模拟沙箱侧语义（判定/落盘是被调服务的事）；用例只断言控制面发出的调用形状与汇总结果。
 */
import type {
  ControlPlaneRpcCallRequest,
  ControlPlaneRpcCallResult,
  ControlPlaneRpcPort,
} from "../src/cloud/app/ports/controlPlaneRpcPort.js";

export interface RecordedControlPlaneCall extends ControlPlaneRpcCallRequest {
  /** `${channel}.${method}`（断言与编程的便捷键）。 */
  readonly key: string;
}

export interface ControlPlaneGate {
  /** 等待闸门放行（未armed 时立即 resolve）。 */
  wait(): Promise<void>;
  release(): void;
}

export interface FakeControlPlaneRpc extends ControlPlaneRpcPort {
  readonly calls: RecordedControlPlaneCall[];
  /** 缺省结论：未编程的方法返回它（缺省 = ok(result: {})）。 */
  defaultResult: ControlPlaneRpcCallResult;
  respond(channel: string, method: string, result: unknown): void;
  /** 按调用动态计算结论（例如逐块回投 `receivedChunks = chunkIndex + 1`）。 */
  handle(
    channel: string,
    method: string,
    handler: (call: RecordedControlPlaneCall) => ControlPlaneRpcCallResult,
  ): void;
  fail(
    channel: string,
    method: string,
    failure?: { reason?: "no-attachment" | "stale" | "not-ready" | "closed"; message?: string },
  ): void;
  /** 编程一个可释放的闸门：命中该方法时响应挂起，直到 release()。 */
  gate(channel: string, method: string): ControlPlaneGate;
  callsOf(channel: string, method: string): RecordedControlPlaneCall[];
}

export function createFakeControlPlaneRpc(): FakeControlPlaneRpc {
  const calls: RecordedControlPlaneCall[] = [];
  const handlers = new Map<string, (call: RecordedControlPlaneCall) => ControlPlaneRpcCallResult>();
  const gates = new Map<string, Promise<void>>();
  const releases = new Map<string, () => void>();
  const fake: FakeControlPlaneRpc = {
    calls,
    defaultResult: { status: "ok", result: {} },
    respond(channel, method, result) {
      handlers.set(`${channel}.${method}`, () => ({ status: "ok", result }));
    },
    handle(channel, method, handler) {
      handlers.set(`${channel}.${method}`, handler);
    },
    fail(channel, method, failure) {
      const reason = failure?.reason ?? "closed";
      handlers.set(`${channel}.${method}`, () => ({
        status: "failed",
        reason,
        message: failure?.message ?? `${method} injected failure`,
      }));
    },
    gate(channel, method) {
      const key = `${channel}.${method}`;
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      gates.set(key, promise);
      releases.set(key, release);
      return {
        wait: () => gates.get(key) ?? Promise.resolve(),
        release: () => releases.get(key)?.(),
      };
    },
    callsOf(channel, method) {
      const key = `${channel}.${method}`;
      return calls.filter((call) => call.key === key);
    },
    async call(request) {
      const key = `${request.channel}.${request.method}`;
      const record: RecordedControlPlaneCall = { ...request, key };
      calls.push(record);
      const gate = gates.get(key);
      if (gate) await gate;
      const handler = handlers.get(key);
      return handler ? handler(record) : fake.defaultResult;
    },
  };
  return fake;
}
