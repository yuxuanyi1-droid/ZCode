import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_WEBSOCAT_VERSION, buildSandboxBootstrapScript } from "../src/sandboxBootstrap.js";
import type { ResolvedRepositoryCheckout } from "../src/gitRef.js";

const checkout: ResolvedRepositoryCheckout = {
  cloneUrl: "https://github.com/octocat/ZCode.git",
  checkoutRef: "main",
  detached: false,
};

function build(overrides: Partial<Parameters<typeof buildSandboxBootstrapScript>[0]> = {}): string {
  return buildSandboxBootstrapScript({
    publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAtest zcode",
    checkout,
    workspacePath: "/workspace/ZCode",
    skipPackageInstall: true,
    ...overrides,
  });
}

test("bootstrap fails fast and never prompts apt interactively", () => {
  const script = build();

  // 首行必须是 set -euo pipefail：否则中途某步失败仍会以 0 退出，
  // 上层会拿到一个"创建成功但连不上"的沙箱。
  assert.equal(script.split("\n")[0], "set -euo pipefail");
  assert.match(script, /DEBIAN_FRONTEND=noninteractive/);
});

test("bootstrap installs packages only when a prebaked image is not assumed", () => {
  assert.doesNotMatch(build(), /apt-get install/);
  const withInstall = build({ skipPackageInstall: false });
  assert.match(withInstall, /command -v git/);
  assert.match(withInstall, /apt-get install -y -qq git openssh-server/);
});

test("bootstrap installs the public key with 600 perms and starts a fresh sshd", () => {
  const script = build();

  assert.match(script, /> '\/root\/\.ssh\/authorized_keys'/);
  assert.match(script, /chmod 600 '\/root\/\.ssh\/authorized_keys'/);
  // 每次都是新容器，host key 不现场生成 sshd 会拒绝启动。
  assert.match(script, /ssh-keygen -A/);
  assert.match(script, /PermitRootLogin prohibit-password/);
  // 只开公钥认证：密码登录在这里没有用途，只是额外的攻击面。
  assert.match(script, /PubkeyAuthentication yes/);
  // 先杀同名进程再起，避免复用的沙箱撞 "Address already in use"。
  assert.match(script, /pkill -x sshd/);
  assert.match(script, /nohup \/usr\/sbin\/sshd -p 22/);
});

test("bootstrap clones the requested branch into the workspace", () => {
  const script = build();

  assert.match(script, /rm -rf '\/workspace\/ZCode'/);
  assert.match(
    script,
    /git clone --depth 1 --branch 'main' 'https:\/\/github\.com\/octocat\/ZCode\.git' '\/workspace\/ZCode'/,
  );
  // 记下实际 revision，attach 之后才能核对 workspace 是不是期望的那次 checkout。
  assert.match(script, /rev-parse HEAD > \/workspace\/\.zcode-checkout-revision/);
});

test("bootstrap fetches the revision separately for a detached checkout", () => {
  const script = build({
    checkout: { ...checkout, checkoutRef: "v1.2.3", detached: true },
  });

  // 浅克隆里没有这个 ref，得单独 fetch 再 checkout 到 FETCH_HEAD。
  assert.doesNotMatch(script, /--branch/);
  assert.match(script, /fetch --depth 1 origin 'v1\.2\.3'/);
  assert.match(script, /checkout --detach FETCH_HEAD/);
});

test("bootstrap refuses a workspace path outside /workspace", () => {
  // 下一行就是 rm -rf；拼错路径等于删沙箱自己的系统目录。
  for (const workspacePath of ["/workspace", "/etc", "/workspace/../etc"]) {
    assert.throws(() => build({ workspacePath }), /outside \/workspace/, workspacePath);
  }
});

test("bootstrap adds a WS relay only when a relay port is requested", () => {
  assert.doesNotMatch(build(), /websocat/);

  const relayed = build({ webSocketRelayPort: 8081 });

  assert.match(relayed, new RegExp(`v${DEFAULT_WEBSOCAT_VERSION.replace(/\./g, "\\.")}`));
  assert.match(relayed, /ws-l:0\.0\.0\.0:8081 tcp:127\.0\.0\.1:22/);
  // 桥是幂等的：已经装过的沙箱不再下载。
  assert.match(relayed, /if \[ ! -x \/usr\/local\/bin\/websocat \]/);
});

test("bootstrap quotes the public key through base64, never raw", () => {
  const script = build({
    publicKey: "ssh-ed25519 AAAA'; rm -rf / #",
  });

  assert.doesNotMatch(script, /rm -rf \/ #/);
  // 原文只以 base64 形式出现，因此引号/分号不可能被 shell 解释。
  const encoded = /printf '%s' '([^']+)' \| base64 -d/.exec(script)?.[1];
  assert.ok(encoded);
  assert.match(Buffer.from(encoded, "base64").toString("utf8"), /rm -rf \/ #/);
});
