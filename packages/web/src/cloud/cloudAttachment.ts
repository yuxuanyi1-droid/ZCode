/**
 * 当前 Run attachment 的提供方（specs/cloud-agent/modules/W9 §3；W8 `cloudAttachmentProvider.ts`；
 * 04 §3.0.1/§5、07 §9、03 §7.1）。
 *
 * UI 与 attachment 传输之间的唯一接缝由 W9 实现：每个 task 一个 SDK 客户端，`open` 建立
 * `/ws/cloud/tasks/:taskId` 连接并把 `attach`（`IChannelClient`）交给 UI。三条边界：
 * - 浏览器只 attach，不 autoSend（打开订阅不等于投递输入）；
 * - `close` 只做本地释放，不断言沙箱内 stdio owner 已停止；
 * - 连接失败 / 没有 ready run 一律返回 null（执行域回落 unavailable），**不回落本机**。
 */
import { createCloudClient, type CloudClient, type CreateCloudClientOptions } from "@zcode/client";
import type { CloudAttachmentAccessorLike, CloudAttachmentProviderLike } from "./cloudUi.js";

export interface CloudAttachmentProviderOptions {
  readonly origin: string;
  /** 测试注入点；生产用 SDK 的 `createCloudClient`。 */
  readonly createClient?: ((options: CreateCloudClientOptions) => CloudClient) | undefined;
}

export function createCloudAttachmentProvider(
  options: CloudAttachmentProviderOptions,
): CloudAttachmentProviderLike {
  const createClient = options.createClient ?? createCloudClient;
  const openClients = new Map<string, CloudClient>();
  const stateListeners = new Set<() => void>();
  const stateDisposers = new Map<string, () => void>();

  const notify = () => {
    for (const listener of stateListeners) {
      listener();
    }
  };

  const release = (taskId: string) => {
    const disposer = stateDisposers.get(taskId);
    disposer?.();
    stateDisposers.delete(taskId);
    const client = openClients.get(taskId);
    openClients.delete(taskId);
    // 只释放本地连接：不发送任何停止沙箱或取消输入的指令（04 §3.0.1）。
    client?.attach.close();
  };

  return {
    async open(taskId) {
      // 同一 task 重复 open：先释放上一代，避免两条连接同时挂在同一个 run 上。
      release(taskId);
      const client = createClient({
        origin: options.origin,
        // 与入口一致：浏览器只用同源 cookie 主体认证，不持有 token 正文（03 §3、12 §5）。
        auth: { mode: "cookie" },
        taskId,
      });
      try {
        await client.attach.connect();
      } catch {
        // 连不上（无 ready run / 断连）由 UI 表现为执行域 unavailable，不猜测原因。
        client.attach.close();
        return null;
      }
      openClients.set(taskId, client);
      stateDisposers.set(
        taskId,
        client.attach.onDidChangeState(() => {
          notify();
        }).dispose,
      );
      return {
        taskId,
        channelClient: client.attach,
      } satisfies CloudAttachmentAccessorLike;
    },

    close(taskId) {
      release(taskId);
    },

    onDidChange(listener) {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
  };
}
