// 默认导入而不是 `{ utils }`：ssh2 是 CJS，Node 的 ESM 互操作探测不出 `utils`
// 这个具名导出，具名写法能过类型检查却在运行时抛 "does not provide an export named"。
import ssh2 from "ssh2";

/**
 * 每个沙箱一把一次性密钥。
 *
 * 为什么不是共享一把 provisioner 私钥：attach 入口（Modal 的未加密隧道、Daytona 的
 * SSH 网关）在公网上是可路由的，一把长期密钥泄漏等于所有历史沙箱同时失守。一次性密钥
 * 的生命周期与沙箱一致，泄漏面就只有那一个沙箱。
 *
 * 为什么是 ed25519：密钥短、生成快（每次建连都要生成一把），且 ssh2 客户端原生支持。
 */
export interface SandboxKeyPair {
  /** OpenSSH 格式私钥，随建连响应内联下发；不落盘。 */
  privateKey: string;
  /** `ssh-ed25519 AAAA... comment` 形式的一行，直接写进沙箱的 authorized_keys。 */
  publicKey: string;
}

export function generateSandboxKeyPair(comment = "zcode-sandbox"): SandboxKeyPair {
  const { private: privateKey, public: publicKey } = ssh2.utils.generateKeyPairSync("ed25519");

  return {
    privateKey: privateKey.trim(),
    publicKey: `${publicKey.trim()} ${comment}`,
  };
}
