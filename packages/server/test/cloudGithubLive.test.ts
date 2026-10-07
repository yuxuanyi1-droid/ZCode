/**
 * 真实 GitHub 联调（specs/cloud-agent/W4 §6「真实 GitHub 联调用测试仓库，记录权限与响应码证据」、
 * W4 §8「无凭据时门控 skipped 并写清解禁方式，不得伪造通过」）。
 *
 * **默认全部 skip**：没有真实 App 凭据时不伪造通过。解禁方式（只读路径，不写任何仓库）：
 *
 *   ZCODE_CLOUD_GITHUB_LIVE=1                      必须显式打开，避免误连生产 App
 *   ZCODE_CLOUD_GITHUB_APP_ID=123456               GitHub App id
 *   ZCODE_CLOUD_GITHUB_APP_PRIVATE_KEY_FILE=…      App 私钥 PEM（0600，只在内存使用）
 *   ZCODE_CLOUD_GITHUB_INSTALLATION_ID=…           已安装到测试组织的 installation id
 *   ZCODE_CLOUD_GITHUB_REPOSITORY_ID=…             **隔离测试仓库**的 repository id
 *   ZCODE_CLOUD_GITHUB_API_BASE_URL=…              可选，GitHub Enterprise 自托管地址
 *
 * 红线：本文件只做读路径（installation、权威仓库事实、分支 HEAD、metadata/contents read 的
 * mint 与尽力撤销）。**不得对真实用户仓库执行写操作**：PR 创建、分支推送、check、评论都不在
 * 联调范围，相关用例全部在 fake fetch 下覆盖（cloudGithubPullRequests/cloudGithubEffects）。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createGitHubAdapter } from "../src/cloud/adapters/github/adapter.js";
import { createGitHubAppAuth } from "../src/cloud/adapters/github/appAuth.js";
import { createGitHubTransport } from "../src/cloud/adapters/github/http.js";
import { GITHUB_TOKEN_PERMISSION_MATRIX } from "../src/cloud/adapters/github/tokens.js";

const ENABLED = process.env["ZCODE_CLOUD_GITHUB_LIVE"]?.trim() === "1";
const APP_ID = Number(process.env["ZCODE_CLOUD_GITHUB_APP_ID"]?.trim() ?? "");
const PRIVATE_KEY_FILE = process.env["ZCODE_CLOUD_GITHUB_APP_PRIVATE_KEY_FILE"]?.trim() ?? "";
const INSTALLATION_ID = Number(process.env["ZCODE_CLOUD_GITHUB_INSTALLATION_ID"]?.trim() ?? "");
const REPOSITORY_ID = Number(process.env["ZCODE_CLOUD_GITHUB_REPOSITORY_ID"]?.trim() ?? "");
const API_BASE_URL = process.env["ZCODE_CLOUD_GITHUB_API_BASE_URL"]?.trim() || undefined;

const SKIP_REASON =
  "ZCODE_CLOUD_GITHUB_LIVE=1 未设置（需要 APP_ID/私钥文件/INSTALLATION_ID/REPOSITORY_ID）：" +
  "见本文件头部的解禁说明，不与真实 GitHub 交互时不伪造通过";

const configured =
  ENABLED &&
  Number.isInteger(APP_ID) &&
  APP_ID > 0 &&
  PRIVATE_KEY_FILE.length > 0 &&
  Number.isInteger(INSTALLATION_ID) &&
  INSTALLATION_ID > 0 &&
  Number.isInteger(REPOSITORY_ID) &&
  REPOSITORY_ID > 0;

const skip = configured ? false : SKIP_REASON;

async function createLiveAdapter() {
  const privateKeyPem = await readFile(PRIVATE_KEY_FILE, "utf8");
  return createGitHubAdapter({
    config: {
      principalId: "live-probe",
      appId: APP_ID,
      privateKeyPem,
      apiBaseUrl: API_BASE_URL,
      allowedInstallationIds: [INSTALLATION_ID],
      allowedRepositoryIds: [REPOSITORY_ID],
    },
  });
}

test(
  "live: app jwt resolves the installation and reports its authorization facts",
  { skip },
  async () => {
    const privateKeyPem = await readFile(PRIVATE_KEY_FILE, "utf8");
    const transport = createGitHubTransport({ apiBaseUrl: API_BASE_URL });
    const appAuth = createGitHubAppAuth({
      transport,
      credentials: { appId: APP_ID, privateKeyPem },
    });
    const installation = await appAuth.getInstallation({ installationId: INSTALLATION_ID });
    assert.ok(installation, "the app must be able to read the configured installation");
    assert.equal(installation.installationId, INSTALLATION_ID);
    assert.equal(installation.appId, APP_ID);

    const adapter = await createLiveAdapter();
    const repository = await adapter.catalog.locate(REPOSITORY_ID);
    assert.ok(repository, "the configured repository must be reachable through the installation");
    assert.equal(repository.installationId, INSTALLATION_ID);
    console.log(
      "[cloudGithubLive] installation evidence",
      JSON.stringify({
        appId: APP_ID,
        installationId: installation.installationId,
        accountLogin: installation.accountLogin,
        repositorySelection: installation.repositorySelection,
        suspended: installation.suspended,
        repositoryId: repository.repositoryId,
        fullName: `${repository.owner}/${repository.name}`,
        defaultBranch: repository.defaultBranch,
        private: repository.private,
      }),
    );
  },
);

test("live: branch head reads expose a 40 char sha on the default branch", { skip }, async () => {
  const adapter = await createLiveAdapter();
  const facts = await adapter.catalog.locate(REPOSITORY_ID);
  assert.ok(facts?.defaultBranch, "repository must expose a default branch");
  const head = await adapter.port.getBranchHead({
    repositoryId: REPOSITORY_ID,
    branch: facts!.defaultBranch,
  });
  assert.equal(head?.exists, true);
  assert.match(head?.sha ?? "", /^[0-9a-f]{40}$/);
  console.log(
    "[cloudGithubLive] branch evidence",
    JSON.stringify({ branch: facts!.defaultBranch, sha: head?.sha }),
  );
});

test(
  "live: contents:read mint returns exactly the minimal single-repo permission set",
  { skip },
  async () => {
    const adapter = await createLiveAdapter();
    const minted = await adapter.port.mintToken({
      repositoryId: REPOSITORY_ID,
      installationId: INSTALLATION_ID,
      purpose: "clone",
    });
    const expected = Object.entries(GITHUB_TOKEN_PERMISSION_MATRIX.clone)
      .map(([name, level]) => `${name}:${level}`)
      .sort();
    assert.deepEqual(minted.permissions, expected);
    assert.ok(minted.expiresAt > Date.now());
    console.log(
      "[cloudGithubLive] mint evidence",
      JSON.stringify({
        repositoryId: REPOSITORY_ID,
        purpose: "clone",
        permissions: minted.permissions,
        expiresAt: minted.expiresAt,
        tokenLength: minted.token.length,
      }),
    );

    // 尽力撤销：结果只作为事实记录，不宣称一定成功（01 §7.2）。
    const revocation = await adapter.tokens.revoke({ token: minted.token });
    console.log("[cloudGithubLive] revocation evidence", JSON.stringify(revocation));
  },
);

test(
  "live: a repository outside the allowlist is refused before any GitHub call",
  { skip },
  async () => {
    const adapter = await createLiveAdapter();
    assert.throws(() => adapter.catalog.assertAuthorized({ repositoryId: REPOSITORY_ID + 1 }));
  },
);
