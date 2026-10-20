import { z } from "zod";

import { CLOUD_PROTOCOL_VERSION } from "./constants.js";

export const daemonStateSchema = z.enum(["starting", "ready", "stopped"]);
export type DaemonState = z.infer<typeof daemonStateSchema>;

export const streamKindSchema = z.enum(["daemon", "exec"]);
export type StreamKind = z.infer<typeof streamKindSchema>;

const helloFrameSchema = z
  .object({
    type: z.literal("hello"),
    v: z.literal(CLOUD_PROTOCOL_VERSION),
    runId: z.string().min(1),
    taskId: z.string().min(1),
    generation: z.number().int().positive(),
    bridgeVersion: z.string().min(1),
    daemon: z
      .object({
        state: daemonStateSchema,
        port: z.number().int().positive().optional(),
        ingressToken: z.string().min(1).optional(),
        version: z.string().optional(),
        compatibility: z.unknown().optional(),
      })
      .strict(),
  })
  .strict();

const helloAckFrameSchema = z
  .object({
    type: z.literal("hello_ack"),
    epoch: z.number().int().positive(),
    heartbeatIntervalMs: z.number().int().positive(),
  })
  .strict();

const daemonStatusFrameSchema = z
  .object({
    type: z.literal("daemon_status"),
    state: daemonStateSchema,
    port: z.number().int().positive().optional(),
    ingressToken: z.string().min(1).optional(),
    version: z.string().optional(),
  })
  .strict();

const streamOpenFrameSchema = z
  .object({
    type: z.literal("stream_open"),
    streamId: z.number().int().positive(),
    kind: streamKindSchema,
    argv: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

const streamOpenedFrameSchema = z
  .object({
    type: z.literal("stream_opened"),
    streamId: z.number().int().positive(),
  })
  .strict();

const streamErrorFrameSchema = z
  .object({
    type: z.literal("stream_error"),
    streamId: z.number().int().positive(),
    code: z.string().min(1),
    message: z.string(),
  })
  .strict();

const streamCloseFrameSchema = z
  .object({
    type: z.literal("stream_close"),
    streamId: z.number().int().positive(),
    code: z.string().optional(),
    message: z.string().optional(),
  })
  .strict();

const heartbeatFrameSchema = z
  .object({
    type: z.literal("heartbeat"),
    atMs: z.number().int().nonnegative(),
  })
  .strict();

const heartbeatAckFrameSchema = z
  .object({
    type: z.literal("heartbeat_ack"),
    atMs: z.number().int().nonnegative(),
  })
  .strict();

const restartDaemonFrameSchema = z
  .object({
    type: z.literal("restart_daemon"),
    reason: z.string().min(1),
  })
  .strict();

const shutdownFrameSchema = z
  .object({
    type: z.literal("shutdown"),
    reason: z.string().min(1),
  })
  .strict();

export const controlFrameSchema = z.discriminatedUnion("type", [
  helloFrameSchema,
  helloAckFrameSchema,
  daemonStatusFrameSchema,
  streamOpenFrameSchema,
  streamOpenedFrameSchema,
  streamErrorFrameSchema,
  streamCloseFrameSchema,
  heartbeatFrameSchema,
  heartbeatAckFrameSchema,
  restartDaemonFrameSchema,
  shutdownFrameSchema,
]);

export type ControlFrame = z.infer<typeof controlFrameSchema>;
export type HelloFrame = z.infer<typeof helloFrameSchema>;
export type HelloAckFrame = z.infer<typeof helloAckFrameSchema>;
export type DaemonStatusFrame = z.infer<typeof daemonStatusFrameSchema>;
export type StreamOpenFrame = z.infer<typeof streamOpenFrameSchema>;
export type StreamOpenedFrame = z.infer<typeof streamOpenedFrameSchema>;
export type StreamErrorFrame = z.infer<typeof streamErrorFrameSchema>;
export type StreamCloseFrame = z.infer<typeof streamCloseFrameSchema>;
export type HeartbeatFrame = z.infer<typeof heartbeatFrameSchema>;
export type HeartbeatAckFrame = z.infer<typeof heartbeatAckFrameSchema>;
export type RestartDaemonFrame = z.infer<typeof restartDaemonFrameSchema>;
export type ShutdownFrame = z.infer<typeof shutdownFrameSchema>;

export function parseControlFrame(raw: string): ControlFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = controlFrameSchema.safeParse(value);
  return result.success ? result.data : null;
}

export const DATA_FRAME_HEADER_BYTES = 4;

export function encodeDataFrame(streamId: number, payload: Uint8Array): Buffer {
  const frame = Buffer.allocUnsafe(DATA_FRAME_HEADER_BYTES + payload.byteLength);
  frame.writeUInt32BE(streamId, 0);
  frame.set(payload, DATA_FRAME_HEADER_BYTES);
  return frame;
}

export interface DecodedDataFrame {
  streamId: number;
  payload: Buffer;
}

export function decodeDataFrame(frame: Uint8Array): DecodedDataFrame | null {
  const buffer = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
  if (buffer.byteLength <= DATA_FRAME_HEADER_BYTES) {
    return null;
  }
  const streamId = buffer.readUInt32BE(0);
  if (streamId <= 0) {
    return null;
  }
  return { streamId, payload: buffer.subarray(DATA_FRAME_HEADER_BYTES) };
}

export function encodeControlFrame(frame: ControlFrame): string {
  return JSON.stringify(frame);
}
