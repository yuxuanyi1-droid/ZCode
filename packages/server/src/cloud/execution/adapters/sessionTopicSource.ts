/**
 * V4 topic 订阅源（specs/cloud-agent/02 §7.4 实施决议：bridge 在 runtime 就绪后调用
 * `subscribeConversationV4` 拿已提交话题记录）。
 *
 * 复用既有 V4 面，不新增业务协议：
 * - 订阅：`subscribeConversationV4` / `subscribeSessionsIndexV4`（按 topic 前缀分流）；
 * - 下行：`onDynamicConversationFrame` / `onDynamicSessionsIndexFrame` 的 wire 帧，
 *   先经 shared 的 `TopicWireFrameAssembler` 重组（有界、带 fault 事件），再交给 exporter；
 * - 取消：按 subscriptionId 调对应 unsubscribe，不退订其他消费者的订阅。
 */
import type { Event, IChannel } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import {
  TopicWireFrameAssembler,
  conversationTopicFrameSchema,
  sessionsIndexTopicFrameSchema,
} from "@zcode/shared/zcode-protocol-v4";
import type { ConversationTopicSource, TopicDeliveryFrame } from "../app/projectionExporter.js";
import type { ExecutionLogger } from "../app/ports.js";

/** 订阅入参（workspace 由 bootstrap 的 clone 事实提供；identity 不作 cwd）。 */
export interface TopicWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface SessionTopicSourceOptions {
  /** 本地常驻 stdio client 的 zcode-agent 通道（未连接时返回 null）。 */
  channel(): IChannel | null;
  workspace(): TopicWorkspaceTarget;
  logger: ExecutionLogger;
  now?(): number;
}

export interface SessionTopicSource extends ConversationTopicSource {
  dispose(): void;
}

const CONVERSATION_SUBSCRIBE = "subscribeConversationV4";
const CONVERSATION_UNSUBSCRIBE = "unsubscribeConversationV4";
const SESSIONS_INDEX_SUBSCRIBE = "subscribeSessionsIndexV4";
const SESSIONS_INDEX_UNSUBSCRIBE = "unsubscribeSessionsIndexV4";
const CONVERSATION_FRAME_EVENT = "onDynamicConversationFrame";
const SESSIONS_INDEX_FRAME_EVENT = "onDynamicSessionsIndexFrame";

function isSessionsIndexTopic(topic: string): boolean {
  return topic.startsWith("sessions-index/");
}

function sessionIdOf(topic: string): string | null {
  const prefix = "conversation/";
  if (!topic.startsWith(prefix)) return null;
  const sessionId = topic.slice(prefix.length);
  return sessionId.length > 0 ? sessionId : null;
}

export function createSessionTopicSource(options: SessionTopicSourceOptions): SessionTopicSource {
  const assembler = new TopicWireFrameAssembler<unknown>(
    conversationTopicFrameSchema.or(sessionsIndexTopicFrameSchema),
  );
  const listeners = new Set<(frame: TopicDeliveryFrame) => void>();
  /** subscriptionId → topic：取消时据此选对应 unsubscribe（不误退别人的订阅）。 */
  const topicBySubscription = new Map<string, string>();
  const disposables: Array<{ dispose(): void }> = [];
  let attached = false;

  function emit(frame: TopicDeliveryFrame): void {
    // 快照后遍历：监听器可能在回调里增删自己，遍历中不能直接改集合。
    for (const listener of Array.from(listeners)) listener(frame);
  }

  function handleWire(wire: unknown): void {
    const events = assembler.accept(wire as never, options.now?.() ?? Date.now());
    for (const event of events) {
      if (event.kind !== "complete") {
        // 重组 fault 只记录（重组失败不产生半帧，也不进入投影）。
        options.logger.warn(undefined, "v4 wire frame assembly fault", {
          reasonCode: event.fault.reasonCode,
        });
        continue;
      }
      emit(event.frame as TopicDeliveryFrame);
    }
  }

  function attach(): void {
    if (attached) return;
    const channel = options.channel();
    if (!channel) return;
    const target = options.workspace();
    const conversationFrames: Event<unknown> = channel.listen(CONVERSATION_FRAME_EVENT, target);
    const sessionsIndexFrames: Event<unknown> = channel.listen(SESSIONS_INDEX_FRAME_EVENT, target);
    disposables.push(conversationFrames(handleWire));
    disposables.push(sessionsIndexFrames(handleWire));
    attached = true;
  }

  return {
    async subscribe(params) {
      attach();
      const channel = options.channel();
      if (!channel) throw new Error("local runtime channel is not connected");
      const workspace = options.workspace();
      const common = {
        workspacePath: workspace.workspacePath,
        ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
        ...(workspace.remoteSessionId ? { remoteSessionId: workspace.remoteSessionId } : {}),
      };
      if (isSessionsIndexTopic(params.topic)) {
        const result = (await channel.call(SESSIONS_INDEX_SUBSCRIBE, [
          {
            ...common,
            ...(params.base ? { base: params.base } : {}),
            subscriberScope: "cloud-bridge",
          },
        ])) as { ack: { subscriptionId: string; mode: "snapshot" | "resume"; logEpoch: string } };
        topicBySubscription.set(result.ack.subscriptionId, params.topic);
        return result.ack;
      }
      const sessionId = sessionIdOf(params.topic);
      if (!sessionId) throw new Error(`unsupported topic: ${params.topic}`);
      const result = (await channel.call(CONVERSATION_SUBSCRIBE, [
        {
          ...common,
          sessionId,
          ...(params.base ? { base: params.base } : {}),
        },
      ])) as { ack: { subscriptionId: string; mode: "snapshot" | "resume"; logEpoch: string } };
      topicBySubscription.set(result.ack.subscriptionId, params.topic);
      return result.ack;
    },

    async unsubscribe(subscriptionId) {
      const topic = topicBySubscription.get(subscriptionId);
      topicBySubscription.delete(subscriptionId);
      const channel = options.channel();
      if (!channel || !topic) return;
      const workspace = options.workspace();
      const params = {
        workspacePath: workspace.workspacePath,
        ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
        subscriptionId,
      };
      await channel.call(
        isSessionsIndexTopic(topic) ? SESSIONS_INDEX_UNSUBSCRIBE : CONVERSATION_UNSUBSCRIBE,
        [params],
      );
    },

    onFrame(listener) {
      attach();
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },

    dispose() {
      for (const disposable of disposables.splice(0)) disposable.dispose();
      listeners.clear();
      topicBySubscription.clear();
      attached = false;
    },
  };
}

/** 服务通道名取自冻结常量，避免本模块硬编码字符串（02 §0）。 */
export const CLOUD_EXECUTION_AGENT_CHANNEL = ServiceChannels.ZCodeAgent;
