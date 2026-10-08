/**
 * 云 attachment 重连感知包装用例（specs/cloud-agent/07 §9、04 §3.3；2026-10-09 终验缺陷 C）。
 *
 * 回归背景：bridge 周期性 `frame-rejected:invalid-frame`（4001）断连后控制面自动重连
 * 成功（epoch 3→4），但存活页面的会话订阅死亡——`attach.getChannel().listen` 的裸事件
 * 注册绑定在当次连接上，ChannelClient 销毁后帧流（onDynamicConversationFrame）不重挂，
 * SDK 自动重连只重建 `attach.subscribe()` 登记的订阅。表现为已提交输入停留
 * 「Submitted, waiting for the run environment…」、新回复不渲染、页内 Reconnect 无效。
 *
 * 修复：`createCloudBrowserServices` 的 agent 通道包装在重连边沿统一重挂受管事件，
 * 并经 `onAgentRuntimeLifecycle` 合成断连/重连边沿（携带 workspaceKey），驱动
 * ConversationProjectionStore 的既有 runtime 状态机携原水位重订阅。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createCloudBrowserServices } from "../src/cloud/cloudBrowserServices.js";
import type { CloudAttachmentAccessor } from "../src/cloud/cloudBrowserServices.js";

const TASK_ID = "4d090058-54c0-43a9-a470-b5b058a95808";
const WORKSPACE_KEY = `cloud-task:${TASK_ID}`;

/**
 * attach 通道测试替身（结构对齐 CloudAttachClient 的使用面）：
 * `listen` 只在「当前连接」上登记；断连即整连接失效，重连是新连接。
 */
function createFakeAttachmentChannel() {
  interface FakeConnection {
    readonly generation: number;
    readonly listenerCount: (event: string) => number;
  }
  let current: FakeConnectionImpl | null = null;
  let generation = 0;
  const stateListeners = new Set<(change: { state: string }) => void>();

  class FakeConnectionImpl {
    readonly generation: number;
    private readonly registrations = new Map<string, Set<(event: unknown) => void>>();

    constructor() {
      generation += 1;
      this.generation = generation;
    }

    listen(event: string, listener: (event: unknown) => void): { dispose(): void } {
      let set = this.registrations.get(event);
      if (set === undefined) {
        set = new Set();
        this.registrations.set(event, set);
      }
      set.add(listener);
      return {
        dispose: () => {
          set?.delete(listener);
        },
      };
    }

    listenerCount(event: string): number {
      return this.registrations.get(event)?.size ?? 0;
    }

    emit(event: string, payload: unknown): void {
      for (const listener of this.registrations.get(event) ?? []) {
        listener(payload);
      }
    }
  }

  return {
    get current(): FakeConnection | null {
      return current;
    },
    getChannel(name: string) {
      void name;
      return {
        async call(command: string, args: unknown[]) {
          if (current === null) {
            // 与 CloudAttachClient.requireChannelClient 同文案：store 把它识别为瞬态。
            throw new Error("cloud attachment is not connected (reconnecting)");
          }
          return { command, args, generation: current.generation };
        },
        listen(event: string, arg: unknown) {
          void arg;
          const connection = current;
          if (connection === null) {
            // 与 CloudAttachClient.getChannel().listen 同语义：未连接返回空事件。
            return (listener: (e: unknown) => void) => ({
              dispose: () => {
                void listener;
              },
            });
          }
          return (listener: (e: unknown) => void) => connection.listen(event, listener);
        },
      };
    },
    onDidChangeState(listener: (change: { state: string }) => void) {
      stateListeners.add(listener);
      return { dispose: () => stateListeners.delete(listener) };
    },
    drop() {
      current = null;
      for (const listener of stateListeners) listener({ state: "reconnecting" });
    },
    reconnect(): FakeConnectionImpl {
      current = new FakeConnectionImpl();
      for (const listener of stateListeners) listener({ state: "connected" });
      return current;
    },
  };
}

function createServices(channelClient: unknown) {
  const attachment: CloudAttachmentAccessor = {
    taskId: TASK_ID,
    channelClient: channelClient as CloudAttachmentAccessor["channelClient"],
  };
  return createCloudBrowserServices({ hostAccessor: {} as never, attachment }).services;
}

interface DynamicEventHost {
  onDynamicConversationFrame: (
    workspace: unknown,
  ) => (listener: (frame: unknown) => void) => { dispose(): void };
}

test("重连边沿重挂会话帧流：新连接的帧继续送达原监听（缺陷 C 主断言）", () => {
  const fake = createFakeAttachmentChannel();
  const first = fake.reconnect();
  const services = createServices(fake);

  const received: unknown[] = [];
  const workspace = { workspacePath: "/workspace/repo", workspaceIdentity: WORKSPACE_KEY };
  const dynamicEvent = (
    services.zcodeAgentService as unknown as DynamicEventHost
  ).onDynamicConversationFrame(workspace);
  // 与 agentConversationTransport.onFrame 相同的两步订阅形态：事件先取、监听后挂。
  const subscription = dynamicEvent((frame) => received.push(frame));

  assert.equal(first.listenerCount("onDynamicConversationFrame"), 1, "首连在当前连接登记监听");
  first.emit("onDynamicConversationFrame", { topic: "conversation/s1", seq: 1 });
  assert.equal(received.length, 1, "断连前帧可达");

  fake.drop();
  assert.equal(fake.current, null);

  // 重连：包装必须把原监听重挂到新连接，新帧继续送达。
  const second = fake.reconnect();
  assert.equal(
    second.listenerCount("onDynamicConversationFrame"),
    1,
    "重连边沿在新连接上重挂（修复点：无此重挂即订阅静默死亡）",
  );
  second.emit("onDynamicConversationFrame", { topic: "conversation/s1", seq: 3 });
  assert.equal(received.length, 2, "重连后新连接的帧送达同一个监听");
  assert.deepEqual(received[1], { topic: "conversation/s1", seq: 3 });

  subscription.dispose();
  second.emit("onDynamicConversationFrame", { topic: "conversation/s1", seq: 4 });
  assert.equal(received.length, 2, "dispose 后不再送达");
  assert.equal(second.listenerCount("onDynamicConversationFrame"), 0, "dispose 注销重挂登记");
});

test("合成 runtime 生命周期边沿：断连 unavailable、重连 available（携 workspaceKey）", () => {
  const fake = createFakeAttachmentChannel();
  fake.reconnect();
  const services = createServices(fake);

  const events: unknown[] = [];
  const dispose = (
    services.zcodeAgentService as unknown as {
      onAgentRuntimeLifecycle: (l: (e: unknown) => void) => { dispose(): void };
    }
  ).onAgentRuntimeLifecycle((event) => events.push(event));

  fake.drop();
  fake.reconnect();

  assert.deepEqual(
    events,
    [
      { workspaceKey: WORKSPACE_KEY, state: "unavailable" },
      { workspaceKey: WORKSPACE_KEY, state: "available" },
    ],
    "合成生命周期边沿按序到达且携带 transport 过滤所需的 workspaceKey",
  );

  dispose.dispose();
  fake.drop();
  fake.reconnect();
  assert.equal(events.length, 2, "dispose 后不再接收合成边沿");
});

test("onAgentRuntimeRestarted 同样跨重连存活（真实 runtime 换代事件不丢）", () => {
  const fake = createFakeAttachmentChannel();
  fake.reconnect();
  const services = createServices(fake);

  const events: unknown[] = [];
  (
    services.zcodeAgentService as unknown as {
      onAgentRuntimeRestarted: (l: (e: unknown) => void) => { dispose(): void };
    }
  ).onAgentRuntimeRestarted((event) => events.push(event));

  const second = fake.reconnect();
  fake.drop();
  const third = fake.reconnect();
  assert.ok(second && third);
  // 真实事件需由当前连接发布；重挂后监听在最新连接上。
  assert.equal(
    (fake.current as unknown as { listenerCount(e: string): number }).listenerCount(
      "onAgentRuntimeRestarted",
    ),
    1,
  );
});

test("无 onDidChangeState 面的通道实现退化为原行为（不抛错）", () => {
  const services = createServices({
    getChannel: () => ({
      call: async () => ({}),
      // listen 返回 Event（可调用）；这里给空事件即可。
      listen: () => (listener: (e: unknown) => void) => ({
        dispose: () => {
          void listener;
        },
      }),
    }),
  });
  const received: unknown[] = [];
  const dynamicEvent = (
    services.zcodeAgentService as unknown as DynamicEventHost
  ).onDynamicConversationFrame({ workspacePath: "/w" });
  const subscription = dynamicEvent((frame) => received.push(frame));
  subscription.dispose();
  assert.equal(received.length, 0);
});
