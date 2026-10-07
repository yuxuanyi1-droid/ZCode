/**
 * attachment 订阅契约与恢复判定（specs/cloud-agent/02 §7.3 快照与恢复、07 §9 多端订阅与恢复、
 * 03 §6 events/历史 cursor）。
 *
 * 与 `cloudAttachClient.ts` 的分工：那里管连接、重连与通道代理；这里只放
 * 「一次订阅长什么样」「ack 怎么读」「声明水位能不能续接」三类纯判定，
 * 不持有连接状态。
 */
import { subscribeAckSchema } from "@zcode/shared/zcode-protocol-v4";
import type { SubscribeAck, SubscribeParams } from "@zcode/shared/zcode-protocol-v4";
import type { IDisposable } from "@zcode/rpc";
import { CloudResyncRequiredError, cloudProtocolError } from "./cloudApiError.js";

/** 调用方声明的水位：只由 typed 字段（历史项 logEpoch/seq）得到，不解析不透明 cursor。 */
export interface CloudSubscriptionWatermark {
  readonly logEpoch: string;
  readonly seq: number;
}

/**
 * 订阅规格：通道名/命令名/事件名由服务契约决定（SDK 不发明）；
 * `subscribeParams` 必须是 shared 冻结的 `subscribeParamsSchema` 形状。
 */
export interface CloudAttachSubscriptionSpec {
  readonly channel: string;
  /** 建立订阅的命令：入参为 subscribeParams，返回 ack（`{ack}` 或 ack 本身）。 */
  readonly subscribeCommand: string;
  readonly subscribeParams: SubscribeParams;
  readonly frameEvent: string;
  readonly frameParams?: unknown;
  /** 显式退订命令；不提供时 dispose() 只做本地释放（服务端随连接释放 scope，07 §9）。 */
  readonly unsubscribe?: { readonly command: string; readonly params: unknown };
}

export interface CloudAttachSubscribeOptions<TFrame> {
  readonly onFrame: (frame: TFrame) => void;
}

export type CloudAttachSubscriptionState = "active" | "released" | "closed";

export interface CloudAttachSubscriptionHandle {
  readonly topic: string;
  readonly channel: string;
  readonly frameEvent: string;
  /** active = 已建立；released = 断线待重连；closed = 已释放（含 resync 失败）。 */
  readonly state: CloudAttachSubscriptionState;
  /** 最近一次成功订阅的 ACK（mode=resume 才代表服务端按声明水位续接）。 */
  readonly ack: SubscribeAck | undefined;
  /** 重连时用于 `base` 的声明水位；由调用方在应用帧后回填（SDK 不解析 payload）。 */
  readonly watermark: CloudSubscriptionWatermark | undefined;
  updateWatermark(watermark: CloudSubscriptionWatermark | undefined): void;
  /** 本地释放：不发送任何上行命令，也不影响共享 Run（07 §9）。 */
  dispose(): void;
  /** 显式远端退订（离开任务/关页）；失败原样抛出，不静默降级。 */
  unsubscribe(): Promise<void>;
}

/** SDK 内部记账：一个订阅的规格、水位与当前监听。 */
export interface CloudAttachSubscriptionEntry {
  readonly spec: CloudAttachSubscriptionSpec;
  readonly onFrame: (frame: unknown) => void;
  state: CloudAttachSubscriptionState;
  ack: SubscribeAck | undefined;
  watermark: CloudSubscriptionWatermark | undefined;
  listener: IDisposable | undefined;
}

/** ack 归一：V4 的 `{ack}` 包装与直接 ack 两种形状都接受，其余 fail-closed。 */
export function parseSubscribeAck(raw: unknown): SubscribeAck {
  const candidate =
    typeof raw === "object" && raw !== null && "ack" in raw ? (raw as { ack: unknown }).ack : raw;
  const parsed = subscribeAckSchema.safeParse(candidate);
  if (!parsed.success) {
    throw cloudProtocolError(`cloud attachment subscribe did not return a valid ack`, {
      issues: parsed.error.issues
        .slice(0, 4)
        .map((issue) => `${issue.path.join(".")}:${issue.code}`),
    });
  }
  return parsed.data;
}

/**
 * 声明了水位就必须被服务端按 resume 续接，否则显式要求 resync（02 §7.3、07 §9）：
 * 把「服务端给快照」与「服务端改了 logEpoch」区分成不同 reason，调用方据此决定重读范围。
 */
export function assertResumeHonored(ack: SubscribeAck, params: SubscribeParams): void {
  const base = params.base;
  if (base === undefined) return;
  if (ack.mode === "resume" && ack.logEpoch === base.logEpoch) return;
  throw new CloudResyncRequiredError({
    reason: ack.logEpoch === base.logEpoch ? "gap" : "log-epoch-changed",
    topic: params.topic,
    logEpoch: base.logEpoch,
  });
}

/** 重连/重订阅时把最新水位写回 `base`；无水位的订阅保持 snapshot 语义。 */
export function subscriptionParamsFor(entry: CloudAttachSubscriptionEntry): SubscribeParams {
  const base = entry.watermark;
  if (base === undefined) return { ...entry.spec.subscribeParams };
  return { ...entry.spec.subscribeParams, base: { logEpoch: base.logEpoch, seq: base.seq } };
}

/** 句柄执行远端退订/本地释放所需的客户端上下文（不把连接状态搬进本模块）。 */
export interface CloudAttachSubscriptionHandleContext {
  readonly connected: () => boolean;
  readonly call: (channel: string, command: string, params: unknown) => Promise<unknown>;
  /** 本地释放：关闭监听并把该项移出订阅注册表。 */
  readonly release: () => void;
}

/**
 * 订阅句柄：`dispose()` 只做本地释放（不发上行命令、不影响共享 Run，07 §9）；
 * `unsubscribe()` 走显式远端退订，失败原样抛出，不静默降级。
 */
export function createCloudAttachSubscriptionHandle(
  entry: CloudAttachSubscriptionEntry,
  context: CloudAttachSubscriptionHandleContext,
): CloudAttachSubscriptionHandle {
  return {
    topic: entry.spec.subscribeParams.topic,
    channel: entry.spec.channel,
    frameEvent: entry.spec.frameEvent,
    get state() {
      return entry.state;
    },
    get ack() {
      return entry.ack;
    },
    get watermark() {
      return entry.watermark;
    },
    updateWatermark(watermark) {
      entry.watermark = watermark;
    },
    dispose() {
      context.release();
    },
    async unsubscribe() {
      const unsubscribe = entry.spec.unsubscribe;
      if (unsubscribe !== undefined && context.connected()) {
        await context.call(entry.spec.channel, unsubscribe.command, unsubscribe.params);
      }
      context.release();
    },
  };
}

/** 由已校验的订阅参数构造内部记账项；水位初值取调用方声明的 base。 */
export function createSubscriptionEntry(
  spec: CloudAttachSubscriptionSpec,
  params: SubscribeParams,
  onFrame: (frame: unknown) => void,
): CloudAttachSubscriptionEntry {
  return {
    spec: { ...spec, subscribeParams: params },
    onFrame,
    state: "released",
    ack: undefined,
    watermark:
      params.base === undefined
        ? undefined
        : { logEpoch: params.base.logEpoch, seq: params.base.seq },
    listener: undefined,
  };
}
