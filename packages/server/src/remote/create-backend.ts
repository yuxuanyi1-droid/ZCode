import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { RemoteTarget } from "@zcode/shared";
import type { IRemoteBackend } from "./backend.js";

export async function createRemoteBackend(target: RemoteTarget): Promise<IRemoteBackend> {
  switch (target.kind) {
    case "ssh": {
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
    case "wsl": {
      const { WSLBackend } = await import("./wsl-backend.js");
      return new WSLBackend(target);
    }
    case "docker": {
      const { DockerBackend } = await import("./docker-backend.js");
      return new DockerBackend(target);
    }
    case "sandbox": {
      const { SandboxBackend } = await import("./sandbox-backend.js");
      // provisioner 为每个沙箱生成一次性密钥，只能内联下发——它没法往用户机器上写文件。
      // 本机自建、私钥已落盘的沙箱才会走 privateKeyPath。
      let privateKey: string | Buffer | undefined = target.ssh.privateKey;
      if (!privateKey && target.ssh.privateKeyPath) {
        const keyPath = target.ssh.privateKeyPath.replace(/^~/, homedir());
        privateKey = await readFile(keyPath);
      }

      return new SandboxBackend(target, privateKey);
    }
  }
}
