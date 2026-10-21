import { Duplex } from "node:stream";

export interface DuplexSink {
  send(streamId: number, chunk: Uint8Array): void;
  close(streamId: number, reason?: string): void;
}

/** 把一条 tunnel stream 包装成 Node Duplex，供 HTTP/WS 客户端直接使用。 */
export class TunnelDuplex extends Duplex {
  private ended = false;

  public constructor(
    private readonly streamId: number,
    private readonly sink: DuplexSink,
  ) {
    super();
    // tunnel 关闭会为所有 stream 注入 error；未被消费者接管的 stream（如刚打开
    // 就随 attachment 断开）没有 error 监听器时会升级成进程级 uncaughtException。
    // 保留默认监听器只兜底生命周期，消费者仍会收到同一个 error 事件。
    this.on("error", () => undefined);
  }

  public override _read(): void {
    // 数据由 tunnel 主动 push；无需额外拉取。
  }

  public override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.ended) {
      callback(new Error("tunnel stream closed"));
      return;
    }
    this.sink.send(this.streamId, chunk);
    callback();
  }

  public override _final(callback: (error?: Error | null) => void): void {
    this.sink.close(this.streamId, "local-end");
    this.ended = true;
    callback();
  }

  public override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.ended) {
      this.ended = true;
      this.sink.close(this.streamId, "destroyed");
    }
    callback(error);
  }

  public pushFromTunnel(chunk: Buffer): void {
    if (!this.ended && !this.destroyed) {
      this.push(chunk);
    }
  }

  public endFromTunnel(reason?: string): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    if (this.destroyed) {
      return;
    }
    if (reason) {
      this.destroy(new Error(reason));
      return;
    }
    this.push(null);
  }
}
