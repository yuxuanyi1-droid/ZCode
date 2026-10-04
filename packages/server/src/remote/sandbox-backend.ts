import type { SandboxConnectOptions, SandboxProvider } from "@zcode/shared";
import type {
  IRemoteBackend,
  RemoteEnvironment,
  RemoteUploadOptions,
  StdioStream,
} from "@zcode/server/remote/backend.js";
import { SSHBackend } from "@zcode/server/remote/ssh-backend.js";

/**
 * 沙箱远端后端（Plan A：外置 provisioner）。
 *
 * 与 WSL/Docker backend 最本质的区别是**生命周期不在这里**：沙箱由外部 provisioner
 * 创建和销毁，ZCode 只 attach 进去执行。因此 `dispose()` 只回收本后端持有的连接，
 * 绝不销毁沙箱本身——销毁由 provisioner 负责。
 *
 * v1 的 attach 传输层是 SSH（由 provisioner 通过 `options.ssh` 给出入口），所以本后端
 * 组合一个 `SSHBackend` 并全量委托。这层组合是刻意的接缝：将来要接 provider 原生 API
 * （Modal/E2B/Daytona SDK）时，只替换内部 transport，`IRemoteBackend` 契约和所有调用方
 * 都不用动。
 */
export class SandboxBackend implements IRemoteBackend {
  readonly provider: SandboxProvider;
  readonly sandboxId: string;

  /** 透传底层 SSH 断连事件，否则上层补偿链路会误判半开连接仍然存活。 */
  readonly onDidDisconnect;

  private readonly ssh: SSHBackend;

  /**
   * `privateKey` 由调用方（createRemoteBackend）预先从 `options.ssh.privateKeyPath`
   * 读取后注入，与 ssh target 的处理保持一致。
   */
  constructor(options: SandboxConnectOptions, privateKey?: string | Buffer) {
    this.provider = options.provider;
    this.sandboxId = options.sandboxId;
    this.ssh = new SSHBackend({
      host: options.ssh.host,
      port: options.ssh.port,
      username: options.ssh.username,
      password: options.ssh.password,
      privateKeyPath: options.ssh.privateKeyPath,
      privateKeyPassphrase: options.ssh.privateKeyPassphrase,
      privateKey,
    });
    this.onDidDisconnect = this.ssh.onDidDisconnect;
  }

  detect(): Promise<RemoteEnvironment> {
    return this.ssh.detect();
  }

  upload(localPath: string, remotePath: string, options?: RemoteUploadOptions): Promise<void> {
    return this.ssh.upload(localPath, remotePath, options);
  }

  exec(command: string): Promise<StdioStream> {
    return this.ssh.exec(command);
  }

  exists(remotePath: string): Promise<boolean> {
    return this.ssh.exists(remotePath);
  }

  readFile(remotePath: string): Promise<string> {
    return this.ssh.readFile(remotePath);
  }

  dispose(): void {
    // 只断开连接，不销毁沙箱——沙箱生命周期归 provisioner。
    this.ssh.dispose();
  }
}
