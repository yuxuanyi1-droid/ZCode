import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { RemoteTarget } from "@zcode/shared";
import type { IRemoteBackend } from "./backend.js";

/**
 * 远端 backend factory。SSH 是唯一保留的手动远端目标
 * （Docker/WSL 已退役，specs/cloud-agent/06 §3.1）；出站 cloud bridge 走独立的云 attachment 路径，
 * 不复用这里的 switch。
 */
export async function createRemoteBackend(target: RemoteTarget): Promise<IRemoteBackend> {
  const { SSHBackend } = await import("./ssh-backend.js");
  let privateKey: string | Buffer | undefined;
  if (target.privateKeyPath) {
    const keyPath = target.privateKeyPath.replace(/^~/, homedir());
    privateKey = await readFile(keyPath);
  }

  return new SSHBackend({
    host: target.host,
    port: target.port,
    username: target.username,
    password: target.password,
    privateKeyPath: target.privateKeyPath,
    privateKeyPassphrase: target.privateKeyPassphrase,
    privateKey,
  });
}
