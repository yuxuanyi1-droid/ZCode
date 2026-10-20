import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer, type WebSocket } from "ws";

import {
  CLOUD_LIMITS,
  decodeDataFrame,
  encodeControlFrame,
  encodeDataFrame,
  parseControlFrame,
  type ControlFrame,
  type DaemonState,
  type StreamKind,
} from "@zcode/cloud-protocol";

import type { RunRecord } from "../../domain/types.js";
import { TunnelDuplex } from "./duplex.js";

export interface AttachmentDaemonInfo {
  state: DaemonState;
  port?: number;
  ingressToken?: string;
  version?: string;
}

export interface RunAttachment {
  readonly runId: string;
  readonly generation: number;
  readonly epoch: number;
  readonly daemon: AttachmentDaemonInfo;
  openStream(kind: StreamKind, argv?: string[]): Promise<Duplex>;
  close(reason?: string): void;
}

export interface BridgeUpgradeTarget {
  run: RunRecord;
}

export interface BridgeServerOptions {
  /** 校验 attach token；返回 run 表示通过。 */
  verifyAttach(runId: string, token: string): RunRecord | null;
  onAttached(attachment: RunAttachment): void;
  onDetached(runId: string, epoch: number): void;
  onDaemonStatus(attachment: RunAttachment): void;
}

interface PendingStream {
  duplex: TunnelDuplex;
  resolve: (duplex: Duplex) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class Attachment implements RunAttachment {
  private readonly streams = new Map<number, TunnelDuplex>();
  private readonly pending = new Map<number, PendingStream>();
  private nextStreamId = 1;
  private closed = false;
  private status: AttachmentDaemonInfo = { state: "starting" };

  public constructor(
    public readonly runId: string,
    public readonly generation: number,
    public readonly epoch: number,
    private readonly socket: WebSocket,
    private readonly options: BridgeServerOptions,
    private readonly onClose: (attachment: Attachment) => void,
  ) {
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.handleData(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
        return;
      }
      this.handleControl(data.toString());
    });
    socket.on("close", () => this.dispose(undefined));
    socket.on("error", () => this.dispose(undefined));
  }

  public get daemon(): AttachmentDaemonInfo {
    return { ...this.status };
  }

  public openStream(kind: StreamKind, argv?: string[]): Promise<Duplex> {
    if (this.closed) {
      return Promise.reject(new Error("attachment closed"));
    }
    if (this.streams.size + this.pending.size >= CLOUD_LIMITS.maxStreamsPerAttachment) {
      return Promise.reject(new Error("stream limit reached"));
    }
    const streamId = this.nextStreamId++;
    let resolveFn: (duplex: Duplex) => void = () => undefined;
    let rejectFn: (error: Error) => void = () => undefined;
    const opened = new Promise<Duplex>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    const duplex = new TunnelDuplex(streamId, {
      send: (id, chunk) => this.sendData(id, chunk),
      close: (id, reason) =>
        this.sendControl({
          type: "stream_close",
          streamId: id,
          ...(reason ? { message: reason } : {}),
        }),
    });
    const timer = setTimeout(() => {
      this.pending.delete(streamId);
      rejectFn(new Error("stream open timeout"));
    }, 10_000);
    this.pending.set(streamId, { duplex, resolve: resolveFn, reject: rejectFn, timer });
    this.sendControl({
      type: "stream_open",
      streamId,
      kind,
      ...(argv ? { argv } : {}),
    });
    return opened;
  }

  public close(reason?: string): void {
    if (this.closed) {
      return;
    }
    this.sendControl({ type: "shutdown", reason: reason ?? "control-plane shutdown" });
    this.socket.close(1000, reason ?? "shutdown");
    this.dispose(reason);
  }

  private handleControl(raw: string): void {
    const frame = parseControlFrame(raw);
    if (!frame) {
      return;
    }
    switch (frame.type) {
      case "hello": {
        if (frame.generation !== this.generation) {
          this.socket.close(4409, "generation mismatch");
          this.dispose("generation mismatch");
          return;
        }
        this.status = {
          state: frame.daemon.state,
          ...(frame.daemon.port ? { port: frame.daemon.port } : {}),
          ...(frame.daemon.ingressToken ? { ingressToken: frame.daemon.ingressToken } : {}),
          ...(frame.daemon.version ? { version: frame.daemon.version } : {}),
        };
        this.sendControl({
          type: "hello_ack",
          epoch: this.epoch,
          heartbeatIntervalMs: CLOUD_LIMITS.heartbeatIntervalMs,
        });
        this.options.onDaemonStatus(this);
        return;
      }
      case "daemon_status":
        this.status = {
          state: frame.state,
          ...(frame.port ? { port: frame.port } : {}),
          ...(frame.ingressToken ? { ingressToken: frame.ingressToken } : {}),
          ...(frame.version ? { version: frame.version } : {}),
        };
        this.options.onDaemonStatus(this);
        return;
      case "stream_opened": {
        const pending = this.pending.get(frame.streamId);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timer);
        this.pending.delete(frame.streamId);
        this.streams.set(frame.streamId, pending.duplex);
        pending.resolve(pending.duplex);
        return;
      }
      case "stream_error": {
        const pending = this.pending.get(frame.streamId);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timer);
        this.pending.delete(frame.streamId);
        pending.reject(new Error(`${frame.code}: ${frame.message}`));
        return;
      }
      case "stream_close": {
        const duplex = this.streams.get(frame.streamId);
        if (duplex) {
          this.streams.delete(frame.streamId);
          if (frame.code && frame.code !== "0") {
            duplex.endFromTunnel(frame.message ?? `stream failed (${frame.code})`);
          } else {
            duplex.endFromTunnel();
          }
        }
        const pending = this.pending.get(frame.streamId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(frame.streamId);
          pending.reject(new Error(frame.message ?? "stream closed before open"));
        }
        return;
      }
      case "heartbeat":
        this.sendControl({ type: "heartbeat_ack", atMs: frame.atMs });
        return;
      case "heartbeat_ack":
        return;
      default:
        return;
    }
  }

  private handleData(frame: Buffer): void {
    const decoded = decodeDataFrame(frame);
    if (!decoded) {
      return;
    }
    const duplex = this.streams.get(decoded.streamId);
    duplex?.pushFromTunnel(decoded.payload);
  }

  private sendControl(frame: ControlFrame): void {
    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.send(encodeControlFrame(frame));
    }
  }

  private sendData(streamId: number, chunk: Uint8Array): void {
    if (this.socket.readyState !== this.socket.OPEN) {
      return;
    }
    if (chunk.byteLength > CLOUD_LIMITS.maxDataFrameBytes) {
      for (let offset = 0; offset < chunk.byteLength; offset += CLOUD_LIMITS.maxDataFrameBytes) {
        this.socket.send(
          encodeDataFrame(
            streamId,
            chunk.subarray(offset, offset + CLOUD_LIMITS.maxDataFrameBytes),
          ),
          { binary: true },
        );
      }
      return;
    }
    this.socket.send(encodeDataFrame(streamId, chunk), { binary: true });
  }

  private dispose(reason?: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason ?? "attachment closed"));
    }
    this.pending.clear();
    for (const duplex of this.streams.values()) {
      duplex.endFromTunnel(reason);
    }
    this.streams.clear();
    this.onClose(this);
  }
}

export class BridgeServer {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly attachments = new Map<string, Attachment>();
  private readonly epochs = new Map<string, number>();

  public constructor(private readonly options: BridgeServerOptions) {}

  public handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/cloud/bridge/attach") {
      return false;
    }
    const runId = url.searchParams.get("runId");
    const authorization = req.headers.authorization ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (!runId || !token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return true;
    }
    const run = this.options.verifyAttach(runId, token);
    if (!run) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return true;
    }
    if (run.status === "stopped" || run.status === "expired" || run.status === "failed") {
      socket.write("HTTP/1.1 409 Conflict\r\n\r\n");
      socket.destroy();
      return true;
    }
    const existing = this.attachments.get(runId);
    if (existing) {
      existing.close("superseded");
      this.attachments.delete(runId);
    }
    const epoch = (this.epochs.get(runId) ?? 0) + 1;
    this.epochs.set(runId, epoch);
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const attachment = new Attachment(
        runId,
        run.generation,
        epoch,
        ws,
        this.options,
        (closed) => {
          if (this.attachments.get(runId) === closed) {
            this.attachments.delete(runId);
          }
          this.options.onDetached(runId, closed.epoch);
        },
      );
      this.attachments.set(runId, attachment);
      this.options.onAttached(attachment);
    });
    return true;
  }

  public get(runId: string): RunAttachment | undefined {
    return this.attachments.get(runId);
  }

  public closeAll(reason: string): void {
    for (const attachment of this.attachments.values()) {
      attachment.close(reason);
    }
    this.attachments.clear();
  }
}
