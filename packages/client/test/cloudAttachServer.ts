/**
 * W7 attachment 用例的假沙箱通道（specs/cloud-agent/W7 §6、07 §9、02 §7.3）。
 *
 * 用 `createQueuePair` 造一条内存 RPC 管道，对端手工说 Channel 线协议（帧头见
 * `packages/rpc/src/channels.shared.ts`；const enum 不能跨包 import，这里用同名常量镜像）。
 * 目的：让 SDK 真的跑在 ChannelClient 上，从而能观察「断连时不重放请求」这类线上事实。
 */
import {
  BufferReader,
  BufferWriter,
  Emitter,
  createQueuePair,
  deserialize,
  serialize,
} from "@zcode/rpc";
import type { CloudAttachConnector, CloudAttachSocket } from "../src/cloud/cloudAttachClient.js";

// 镜像 channels.shared.ts 的 const enum（isolatedModules 下不能跨包引用 const enum）。
const REQUEST_PROMISE = 100;
const REQUEST_EVENT_LISTEN = 102;
const REQUEST_EVENT_DISPOSE = 103;
const RESPONSE_INITIALIZE = 200;
const RESPONSE_PROMISE_SUCCESS = 201;
const RESPONSE_PROMISE_ERROR = 202;
const RESPONSE_EVENT_FIRE = 204;

export interface FakeAttachCall {
  readonly kind: "call";
  readonly connection: number;
  readonly channel: string;
  readonly command: string;
  readonly arg: unknown;
}

export interface FakeAttachListen {
  readonly kind: "listen";
  readonly connection: number;
  readonly channel: string;
  readonly event: string;
  readonly arg: unknown;
}

export interface FakeAttachEventDispose {
  readonly kind: "event-dispose";
  readonly connection: number;
}

export type FakeAttachFrame = FakeAttachCall | FakeAttachListen | FakeAttachEventDispose;

export type FakeAttachCallResult =
  | { readonly ok: true; readonly data: unknown }
  | {
      readonly ok: false;
      readonly error: {
        readonly message: string;
        readonly code?: string;
        readonly retryable?: boolean;
        readonly traceId?: string;
      };
    };

export interface FakeAttachServer {
  readonly frames: FakeAttachFrame[];
  /** 注册 call 处理器；返回 undefined 表示「不回应」（用于制造在途请求）。 */
  onCall(handler: (call: FakeAttachCall) => FakeAttachCallResult | undefined): void;
  /** 向最近一次匹配的监听推送事件帧。 */
  fire(channel: string, event: string, frame: unknown): boolean;
  readonly listens: () => readonly FakeAttachListen[];
}

export interface FakeAttachConnectionRecord {
  readonly index: number;
  readonly url: string;
  readonly server: FakeAttachServer;
  /** 模拟对端断开：触发 SDK 侧 onDidClose（不是本地 close）。 */
  drop(): void;
}

export interface FakeAttachConnector {
  readonly connector: CloudAttachConnector;
  readonly connections: FakeAttachConnectionRecord[];
  /** 所有连接上的帧合并，便于断言「断连后没有重发任何请求」。 */
  readonly frames: FakeAttachFrame[];
  readonly urls: string[];
  dropLast(): void;
}

export function createFakeAttachConnector(
  options: {
    initialize?: boolean;
    /** 每条新连接的默认 call 处理器（避免测试与 SDK 的首次订阅竞态）。 */
    onCall?: (call: FakeAttachCall) => FakeAttachCallResult | undefined;
  } = {},
): FakeAttachConnector {
  const connections: FakeAttachConnectionRecord[] = [];
  const frames: FakeAttachFrame[] = [];
  const urls: string[] = [];

  const connector: CloudAttachConnector = async (input) => {
    const index = connections.length;
    const [serverProtocol, clientProtocol] = createQueuePair();
    const serverFrames: FakeAttachFrame[] = [];
    const listens = new Map<string, number>();
    let callHandler: ((call: FakeAttachCall) => FakeAttachCallResult | undefined) | undefined =
      options.onCall;
    const closeEmitter = new Emitter<void>();
    let dropped = false;

    function record(frame: FakeAttachFrame): void {
      serverFrames.push(frame);
      frames.push(frame);
    }

    function send(header: readonly unknown[], body?: unknown): void {
      const writer = new BufferWriter();
      serialize(writer, header);
      serialize(writer, body);
      try {
        serverProtocol.send(writer.buffer);
      } catch {
        /* 对端已断开：忽略 */
      }
    }

    function respond(call: FakeAttachCall, id: number): void {
      const result = callHandler?.(call);
      if (result === undefined) return; // 故意不回应：模拟在途请求
      if (result.ok) {
        send([RESPONSE_PROMISE_SUCCESS, id], result.data);
        return;
      }
      send([RESPONSE_PROMISE_ERROR, id], {
        message: result.error.message,
        name: "Error",
        stack: undefined,
        ...(result.error.code === undefined ? {} : { code: result.error.code }),
        ...(result.error.retryable === undefined ? {} : { retryable: result.error.retryable }),
        ...(result.error.traceId === undefined ? {} : { traceId: result.error.traceId }),
      });
    }

    serverProtocol.onMessage((message) => {
      if (dropped) return;
      const reader = new BufferReader(message);
      const header = deserialize(reader) as [number, number, string, string];
      const body = deserialize(reader);
      const type = header[0];
      const id = header[1];
      if (type === REQUEST_PROMISE) {
        const call: FakeAttachCall = {
          kind: "call",
          connection: index,
          channel: header[2],
          command: header[3],
          arg: body,
        };
        record(call);
        respond(call, id);
        return;
      }
      if (type === REQUEST_EVENT_LISTEN) {
        const listen: FakeAttachListen = {
          kind: "listen",
          connection: index,
          channel: header[2],
          event: header[3],
          arg: body,
        };
        record(listen);
        const key = `${listen.channel}\u0000${listen.event}`;
        listens.set(key, [...(listens.get(key) ?? []), id]);
        return;
      }
      if (type === REQUEST_EVENT_DISPOSE) {
        record({ kind: "event-dispose", connection: index });
      }
    });

    const server: FakeAttachServer = {
      frames: serverFrames,
      onCall(handler) {
        callHandler = handler;
      },
      fire(channel, event, frame) {
        const ids = listens.get(`${channel}\u0000${event}`);
        if (ids === undefined || ids.length === 0) return false;
        for (const id of ids) send([RESPONSE_EVENT_FIRE, id], frame);
        return true;
      },
      listens: () =>
        serverFrames.filter((frame): frame is FakeAttachListen => frame.kind === "listen"),
    };

    if (options.initialize !== false) {
      setTimeout(() => send([RESPONSE_INITIALIZE]), 0);
    }

    urls.push(input.url);
    const connectionRecord: FakeAttachConnectionRecord = {
      index,
      url: input.url,
      server,
      drop() {
        dropped = true;
        closeEmitter.fire();
      },
    };
    connections.push(connectionRecord);

    const socket: CloudAttachSocket = {
      protocol: clientProtocol,
      onDidClose: closeEmitter.event,
      dispose() {
        closeEmitter.dispose();
      },
    };
    return socket;
  };

  return {
    connector,
    connections,
    frames,
    urls,
    dropLast() {
      connections[connections.length - 1]?.drop();
    },
  };
}
