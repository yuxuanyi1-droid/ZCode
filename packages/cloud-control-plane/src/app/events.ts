import type { CloudEvent } from "./orchestrator.js";

export class EventHub {
  private readonly listeners = new Set<(event: CloudEvent) => void>();

  public broadcast = (event: CloudEvent): void => {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 单个订阅者异常不影响其他订阅者。
      }
    }
  };

  public subscribe(listener: (event: CloudEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
