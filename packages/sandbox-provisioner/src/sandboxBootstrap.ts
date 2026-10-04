import { SANDBOX_SSH_PORT, isSandboxWorkspacePathWithinRoot } from "@zcode/shared";
import type { ResolvedRepositoryCheckout } from "./gitRef.js";
import { shellQuote, shellWriteFile } from "./shell.js";

/** websocat 静态二进制；E2B 用它把 WS 流量桥到本地 sshd。 */
export const DEFAULT_WEBSOCAT_VERSION = "1.13.0";
export const DEFAULT_WEBSOCAT_ARCH = "x86_64-unknown-linux-musl";

const SSH_AUTHORIZED_KEYS_PATH = "/root/.ssh/authorized_keys";

export interface SandboxBootstrapOptions {
  /** `ssh-ed25519 AAAA... comment` 一行。 */
  publicKey: string;
  checkout: ResolvedRepositoryCheckout;
  /** 绝对路径，且必须严格位于 /workspace 之下（由 resolveSandboxWorkspacePath 保证）。 */
  workspacePath: string;
  sshPort?: number;
  /**
   * 起一个 WS→SSH 的桥并监听这个端口。
   *
   * 只有"端口只能通过 HTTPS/WSS 暴露"的 provider 需要（当前是 E2B）：它的网关不会
   * 透传裸 TCP，所以沙箱自己得把 WS 解回 TCP 再喂给本机 sshd。
   */
  webSocketRelayPort?: number;
  websocatVersion?: string;
  websocatArch?: string;
  /** 镜像是预装好 sshd/git 的时候跳过包安装（也用于测试与离线环境）。 */
  skipPackageInstall?: boolean;
}

/**
 * 沙箱启动脚本。
 *
 * 契约：**幂等 + 失败即抛**。provisioner 会在沙箱创建后立刻执行它，任何一步失败
 * 都意味着 attach 不可能成功，所以脚本用 `set -euo pipefail` 直接中断，让上层
 * 收到非零退出码而不是一个连不上的沙箱。
 */
export function buildSandboxBootstrapScript(options: SandboxBootstrapOptions): string {
  const sshPort = options.sshPort ?? SANDBOX_SSH_PORT;
  const steps: string[] = [
    "set -euo pipefail",
    // 交互式 apt 提示会让脚本永久挂住直到 provisioner 超时。
    "export DEBIAN_FRONTEND=noninteractive",
    installPackagesStep(options),
    prepareSshdStep(sshPort),
    shellWriteFile(SSH_AUTHORIZED_KEYS_PATH, `${options.publicKey}\n`),
    startSshdStep(sshPort),
    ...(options.webSocketRelayPort === undefined
      ? []
      : [webSocketRelayStep(options.webSocketRelayPort, sshPort, options)]),
    cloneRepositoryStep(options),
  ];

  return steps.filter((step) => step.length > 0).join("\n");
}

function installPackagesStep(options: SandboxBootstrapOptions): string {
  if (options.skipPackageInstall) {
    return "";
  }

  // 只在缺东西的时候装：预装镜像（用户自建）不该再花一次 apt 时间，也不该依赖 apt 源可达。
  return [
    "if ! command -v git >/dev/null 2>&1 || [ ! -x /usr/sbin/sshd ]; then",
    "  apt-get update -qq",
    "  apt-get install -y -qq git openssh-server ca-certificates >/dev/null",
    "fi",
  ].join("\n");
}

function prepareSshdStep(sshPort: number): string {
  return [
    "mkdir -p /run/sshd /root/.ssh",
    "chmod 700 /root/.ssh",
    // 每次新建沙箱都是全新的容器，host key 必须现场生成，否则 sshd 拒绝启动。
    "ssh-keygen -A >/dev/null",
    // 只开放公钥认证：一次性私钥是唯一凭据，密码登录在这里没有任何用途。
    `sed -i 's/^#\\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config`,
    `sed -i 's/^#\\?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config`,
    // sshd 默认读 /etc/ssh/sshd_config，但显式传 -p 时还要确保没被 AddressFamily 限制住。
    `echo ${shellQuote(`Port ${sshPort}`)} > /etc/ssh/sshd_config.d/zcode.conf`,
  ].join("\n");
}

function startSshdStep(sshPort: number): string {
  return [
    // 沙箱可能被复用（用户手动重启 sshd）——先清掉同名进程，避免 "Address already in use"。
    "pkill -x sshd >/dev/null 2>&1 || true",
    `nohup /usr/sbin/sshd -p ${sshPort} >/var/log/zcode-sshd.log 2>&1 &`,
    // 等到端口真的在监听再返回：隧道/网关可能比 sshd 先就绪，早返回会让首次 attach 失败。
    waitForPortStep(sshPort),
  ].join("\n");
}

function waitForPortStep(port: number): string {
  return [
    "for _ in $(seq 1 30); do",
    `  if (exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null; then exec 3>&-; break; fi`,
    "  sleep 1",
    "done",
  ].join("\n");
}

function webSocketRelayStep(
  relayPort: number,
  sshPort: number,
  options: SandboxBootstrapOptions,
): string {
  const version = options.websocatVersion ?? DEFAULT_WEBSOCAT_VERSION;
  const arch = options.websocatArch ?? DEFAULT_WEBSOCAT_ARCH;
  const downloadUrl = `https://github.com/vi/websocat/releases/download/v${version}/websocat.${arch}`;

  return [
    `if [ ! -x /usr/local/bin/websocat ]; then`,
    `  curl -fsSL -o /usr/local/bin/websocat ${shellQuote(downloadUrl)}`,
    "  chmod +x /usr/local/bin/websocat",
    "fi",
    "pkill -x websocat >/dev/null 2>&1 || true",
    // ws-l 是 ws 的 listen 模式（服务端）；--binary 保证字节流不被当文本重编码。
    `nohup /usr/local/bin/websocat --binary ws-l:0.0.0.0:${relayPort} tcp:127.0.0.1:${sshPort} >/var/log/zcode-websocat.log 2>&1 &`,
    waitForPortStep(relayPort),
  ].join("\n");
}

function cloneRepositoryStep(options: SandboxBootstrapOptions): string {
  const { workspacePath, checkout } = options;
  // workspacePath 由 shared 的 resolveSandboxWorkspacePath 保证在 /workspace 之下；
  // 这里再挡一次是因为下一行是 rm -rf——拼错了就是删宿主机目录。用 shared 的同一条
  // 规则而不是前缀判断：`/workspace/../etc` 能过前缀判断，展开后却在根目录外面。
  if (!isSandboxWorkspacePathWithinRoot(workspacePath)) {
    throw new Error(`Refusing to bootstrap outside /workspace: ${workspacePath}`);
  }

  return [
    `rm -rf ${shellQuote(workspacePath)}`,
    "mkdir -p /workspace",
    checkout.detached
      ? `git clone --depth 1 ${shellQuote(checkout.cloneUrl)} ${shellQuote(workspacePath)}`
      : `git clone --depth 1 --branch ${shellQuote(checkout.checkoutRef)} ${shellQuote(checkout.cloneUrl)} ${shellQuote(workspacePath)}`,
    // detached checkout 的 ref 不在浅克隆的 history 里，得单独 fetch 一次。
    ...(checkout.detached
      ? [
          `git -C ${shellQuote(workspacePath)} fetch --depth 1 origin ${shellQuote(checkout.checkoutRef)}`,
          `git -C ${shellQuote(workspacePath)} checkout --detach FETCH_HEAD`,
        ]
      : []),
    `git -C ${shellQuote(workspacePath)} rev-parse HEAD > /workspace/.zcode-checkout-revision`,
  ].join("\n");
}
