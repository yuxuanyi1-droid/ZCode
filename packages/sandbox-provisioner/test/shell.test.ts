import assert from "node:assert/strict";
import test from "node:test";
import { shellQuote, shellWriteFile } from "../src/shell.js";

test("shellQuote wraps in single quotes and escapes embedded quotes", () => {
  assert.equal(shellQuote("plain"), "'plain'");
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
});

test("shellQuote neutralizes command substitution and separators", () => {
  // 这些值会被拼进沙箱里的 shell 命令；只要没被正确引用就是远端任意命令执行。
  for (const payload of ["$(rm -rf /)", "`id`", "a; rm -rf /", "a && curl evil", "a\nb"]) {
    const quoted = shellQuote(payload);
    assert.ok(quoted.startsWith("'") && quoted.endsWith("'"), payload);
    // 引号内部不能再出现未转义的单引号闭合。
    assert.equal(quoted.slice(1, -1).replace(/\\''/g, "").includes("'"), false, payload);
  }
});

test("shellWriteFile round-trips through base64 without mangling bytes", () => {
  const contents = "ssh-ed25519 AAAAC3Nza comment\n-----BEGIN OPENSSH PRIVATE KEY-----\nA's\n";

  const snippet = shellWriteFile("/root/.ssh/authorized_keys", contents);
  const encoded = /printf '%s' '([^']+)' \| base64 -d/.exec(snippet)?.[1];

  assert.ok(encoded, snippet);
  assert.equal(Buffer.from(encoded, "base64").toString("utf8"), contents);
});

test("shellWriteFile applies the requested mode", () => {
  assert.match(
    shellWriteFile("/root/.ssh/authorized_keys", "key"),
    /chmod 600 '\/root\/\.ssh\/authorized_keys'/,
  );
  assert.match(shellWriteFile("/etc/ssh/sshd_config.d/zcode.conf", "Port 22", "644"), /chmod 644/);
});
