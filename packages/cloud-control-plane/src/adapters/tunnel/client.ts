import http from "node:http";
import type { Duplex } from "node:stream";

import { WebSocket } from "ws";

export interface DuplexRequestOptions {
  path: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs?: number;
}

export interface DuplexResponse {
  status: number;
  body: Buffer;
}

function createSingleUseAgent(duplex: Duplex): http.Agent {
  const agent = new http.Agent({ keepAlive: false });
  let used = false;
  agent.createConnection = (() => {
    if (used) {
      throw new Error("duplex already consumed");
    }
    used = true;
    return duplex;
  }) as http.Agent["createConnection"];
  return agent;
}

export async function requestOverDuplex(
  duplex: Duplex,
  options: DuplexRequestOptions,
): Promise<DuplexResponse> {
  const agent = createSingleUseAgent(duplex);
  const timeoutMs = options.timeoutMs ?? 10_000;
  return await new Promise<DuplexResponse>((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port: 80,
        method: options.method ?? "GET",
        path: options.path,
        headers: options.headers,
        agent,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          agent.destroy();
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) });
        });
      },
    );
    const timer = setTimeout(() => {
      request.destroy(new Error("duplex request timeout"));
      agent.destroy();
    }, timeoutMs);
    request.on("error", (error) => {
      clearTimeout(timer);
      agent.destroy();
      reject(error);
    });
    request.on("close", () => clearTimeout(timer));
    if (options.body) {
      request.write(options.body);
    }
    request.end();
  });
}

export async function connectWebSocketOverDuplex(
  duplex: Duplex,
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 10_000,
): Promise<WebSocket> {
  const agent = createSingleUseAgent(duplex);
  return await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, { agent, headers });
    const timer = setTimeout(() => {
      socket.terminate();
      agent.destroy();
      reject(new Error("websocket upgrade timeout"));
    }, timeoutMs);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      agent.destroy();
      reject(error);
    });
  });
}
