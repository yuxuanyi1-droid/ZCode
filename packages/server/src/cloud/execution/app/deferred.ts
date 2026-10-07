/**
 * 会话内部的等待原语（W6 内部工具，无协议语义）。
 *
 * 只解决一件事：在「控制面回帧 / 连接关闭 / 超时」三者中先到者决定结果，
 * 避免用固定 sleep 猜时序（02 §5 的阶段推进必须由事实驱动）。
 */
import type { BridgeConnectionPort, ExecutionClock } from "./ports.js";

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  settled(): boolean;
}

export function deferred<T>(): Deferred<T> {
  let settle!: (value: T) => void;
  let done = false;
  const promise = new Promise<T>((resolve) => {
    settle = (value) => {
      done = true;
      resolve(value);
    };
  });
  return { promise, resolve: settle, settled: () => done };
}

/**
 * 等待一个 Deferred，超时或连接关闭都返回 null（调用方据此走上报阶段/重连，而不是继续假装成功）。
 */
export async function awaitSignal<T>(
  slot: Deferred<T>,
  options: {
    timeoutMs: number;
    clock: ExecutionClock;
    connection: BridgeConnectionPort;
  },
): Promise<T | null> {
  const closed = deferred<null>();
  const disposable = options.connection.onClose(() => closed.resolve(null));
  try {
    return await Promise.race([
      slot.promise,
      closed.promise,
      options.clock.wait(options.timeoutMs).then(() => null),
    ]);
  } finally {
    disposable.dispose();
  }
}
