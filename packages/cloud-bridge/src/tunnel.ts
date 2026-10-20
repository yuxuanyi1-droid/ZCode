import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { connect, type Socket } from "node:net";
import { dirname } from "node:path";

import { WebSocket } from "ws";

import {
  CLOUD_LIMITS,
  CLOUD_PROTOCOL_VERSION,
  decodeDataFrame,
  encodeControlFrame,
  encodeDataFrame,
  parseControlFrame,
  type ControlFrame,
  type DaemonStatusFrame,
  type StreamOpenFrame,
} from "@zcode/cloud-protocol";
import type { BootstrapConfig } from "@zcode/cloud-protocol";

import type { DaemonStatusInfo, DaemonSupervisor } from "./daemon.js";

interface DaemonStreamState {
  kind: "daemon";
  socket: Socket;
}

interface ExecStreamState {
  kind: "exec";
  child: ChildProcessWithoutNullStreams;
}

type StreamState = DaemonStreamState | ExecStreamState;

export interface TunnelClientOptions {
  onLog?: (message: string) => void;
  onEpoch?: (epoch: number) => void;
}

function buildAttachUrl(config: BootstrapConfig): string {
  const separator = config.controlPlaneUrl.includes("?") ? "&" : "?";
  return `${config.controlPlaneUrl}${separator}runId=${encodeURIComponent(config.runId)}`;
}

export class TunnelClient {
  private socket?: WebSocket;
  private readonly streams = new Map<number, StreamState>();
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private missedHeartbeats = 0;
  private closedByUser = false;
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  public constructor(
    private readonly config: BootstrapConfig,
    private readonly daemon: DaemonSupervisor,
    private readonly options: TunnelClientOptions = {},
  ) {}

  public connect(): void {
    this.closedByUser = false;
    this.open();
  }

  public close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.stopHeartbeat();
    this.closeAllStreams();
    this.socket?.close(1000, "bridge shutdown");
    this.socket = undefined;
  }

  private open(): void {
    const url = buildAttachUrl(this.config);
    const socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${this.config.attachToken}` },
    });
    this.socket = socket;
    socket.on("open", () => {
      this.reconnectAttempt = 0;
      this.missedHeartbeats = 0;
      this.sendHello();
      this.startHeartbeat();
      this.options.onLog?.("tunnel connected");
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.handleData(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
        return;
      }
      this.handleControl(data.toString());
    });
    socket.on("error", (error) => {
      this.options.onLog?.(`tunnel error: ${error.message}`);
    });
    socket.on("close", (code, reason) => {
      this.stopHeartbeat();
      this.closeAllStreams();
      if (this.socket === socket) {
        this.socket = undefined;
      }
      if (this.closedByUser) {
        return;
      }
      this.options.onLog?.(`tunnel closed (${code} ${reason.toString()})`);
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closedByUser) {
      return;
    }
    const exponential = Math.min(
      CLOUD_LIMITS.reconnectMaxMs,
      CLOUD_LIMITS.reconnectBaseMs * 2 ** this.reconnectAttempt,
    );
    const jitter = exponential * (0.8 + Math.random() * 0.4);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.closedByUser) {
        this.open();
      }
    }, jitter);
    this.reconnectTimer.unref?.();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        return;
      }
      this.missedHeartbeats += 1;
      if (this.missedHeartbeats > CLOUD_LIMITS.heartbeatMissLimit) {
        this.options.onLog?.("heartbeat timeout; reconnecting");
        this.socket.terminate();
        return;
      }
      this.sendControl({ type: "heartbeat", atMs: Date.now() });
    }, CLOUD_LIMITS.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private sendHello(): void {
    const status = this.daemon.current();
    this.sendControl({
      type: "hello",
      v: CLOUD_PROTOCOL_VERSION,
      runId: this.config.runId,
      taskId: this.config.taskId,
      generation: this.config.generation,
      bridgeVersion: "1.0.0",
      daemon: {
        state: status.state,
        ...(status.port ? { port: status.port } : {}),
        ...(status.ingressToken ? { ingressToken: status.ingressToken } : {}),
        ...(status.version ? { version: status.version } : {}),
      },
    });
  }

  public notifyDaemonStatus(status: DaemonStatusInfo): void {
    const frame: DaemonStatusFrame = {
      type: "daemon_status",
      state: status.state,
      ...(status.port ? { port: status.port } : {}),
      ...(status.ingressToken ? { ingressToken: status.ingressToken } : {}),
      ...(status.version ? { version: status.version } : {}),
    };
    this.sendControl(frame);
  }

  private sendControl(frame: ControlFrame): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    this.socket.send(encodeControlFrame(frame));
  }

  private handleControl(raw: string): void {
    const frame = parseControlFrame(raw);
    if (!frame) {
      this.options.onLog?.("dropped malformed control frame");
      return;
    }
    switch (frame.type) {
      case "hello_ack":
        this.missedHeartbeats = 0;
        this.options.onEpoch?.(frame.epoch);
        return;
      case "heartbeat":
        this.sendControl({ type: "heartbeat_ack", atMs: frame.atMs });
        return;
      case "heartbeat_ack":
        this.missedHeartbeats = 0;
        return;
      case "stream_open":
        void this.openStream(frame);
        return;
      case "stream_close":
        this.closeStream(frame.streamId);
        return;
      case "restart_daemon":
        void this.restartDaemon();
        return;
      case "shutdown":
        this.close();
        void this.daemon.stop().finally(() => process.exit(0));
        return;
      default:
        return;
    }
  }

  private async restartDaemon(): Promise<void> {
    try {
      const status = await this.daemon.restart();
      this.notifyDaemonStatus(status);
    } catch (error) {
      this.options.onLog?.(
        `daemon restart failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.notifyDaemonStatus({ state: "stopped" });
    }
  }

  private async openStream(frame: StreamOpenFrame): Promise<void> {
    if (this.streams.size >= CLOUD_LIMITS.maxStreamsPerAttachment) {
      this.sendControl({
        type: "stream_error",
        streamId: frame.streamId,
        code: "stream.limit",
        message: "too many concurrent streams",
      });
      return;
    }
    if (frame.kind === "daemon") {
      this.openDaemonStream(frame.streamId);
      return;
    }
    this.openExecStream(frame.streamId, frame.argv ?? []);
  }

  private openDaemonStream(streamId: number): void {
    const status = this.daemon.current();
    if (status.state !== "ready" || !status.port) {
      this.sendControl({
        type: "stream_error",
        streamId,
        code: "daemon.not_ready",
        message: "daemon ingress is not ready",
      });
      return;
    }
    const socket = connect({ host: "127.0.0.1", port: status.port });
    const state: DaemonStreamState = { kind: "daemon", socket };
    this.streams.set(streamId, state);
    socket.once("connect", () => {
      this.sendControl({ type: "stream_opened", streamId });
    });
    socket.on("data", (chunk) => {
      this.sendData(streamId, typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    const finish = (): void => {
      if (this.streams.delete(streamId)) {
        this.sendControl({ type: "stream_close", streamId });
      }
    };
    socket.once("close", finish);
    socket.once("error", finish);
  }

  private openExecStream(streamId: number, argv: string[]): void {
    if (argv.length === 0) {
      this.sendControl({
        type: "stream_error",
        streamId,
        code: "stream.spawn_failed",
        message: "exec requires argv",
      });
      return;
    }
    const [command, ...args] = argv;
    if (!command) {
      this.sendControl({
        type: "stream_error",
        streamId,
        code: "stream.spawn_failed",
        message: "exec requires a command",
      });
      return;
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, {
        cwd: dirname(this.config.workspacePath),
        env: { ...process.env, ZCODE_DATA_BASE_DIR: this.config.dataDir },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      this.sendControl({
        type: "stream_error",
        streamId,
        code: "stream.spawn_failed",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    this.streams.set(streamId, { kind: "exec", child });
    this.sendControl({ type: "stream_opened", streamId });
    child.stdout.on("data", (chunk: Buffer) => this.sendData(streamId, chunk));
    child.stderr.on("data", (chunk: Buffer) => this.sendData(streamId, chunk));
    const finish = (code: number | null): void => {
      if (this.streams.delete(streamId)) {
        this.sendControl({ type: "stream_close", streamId, code: String(code ?? 1) });
      }
    };
    child.once("exit", finish);
    child.once("error", () => finish(1));
  }

  private handleData(frame: Buffer): void {
    const decoded = decodeDataFrame(frame);
    if (!decoded) {
      return;
    }
    const stream = this.streams.get(decoded.streamId);
    if (!stream) {
      return;
    }
    if (stream.kind === "daemon") {
      stream.socket.write(Buffer.from(decoded.payload));
      return;
    }
    stream.child.stdin.write(decoded.payload);
  }

  private sendData(streamId: number, payload: Uint8Array): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    if (payload.byteLength > CLOUD_LIMITS.maxDataFrameBytes) {
      for (let offset = 0; offset < payload.byteLength; offset += CLOUD_LIMITS.maxDataFrameBytes) {
        const chunk = payload.subarray(offset, offset + CLOUD_LIMITS.maxDataFrameBytes);
        this.socket.send(encodeDataFrame(streamId, chunk), { binary: true });
      }
      return;
    }
    this.socket.send(encodeDataFrame(streamId, payload), { binary: true });
  }

  private closeStream(streamId: number): void {
    const stream = this.streams.get(streamId);
    if (!stream) {
      return;
    }
    this.streams.delete(streamId);
    if (stream.kind === "daemon") {
      stream.socket.destroy();
      return;
    }
    stream.child.kill("SIGTERM");
  }

  private closeAllStreams(): void {
    const streamIds = Array.from(this.streams.keys());
    for (const streamId of streamIds) {
      this.closeStream(streamId);
    }
  }
}
