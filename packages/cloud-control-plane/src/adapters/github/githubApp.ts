import { createPrivateKey, createSign, type KeyObject } from "node:crypto";

export interface GitHubAppConfig {
  appId: number;
  privateKeyPem: string;
  allowedInstallationIds: number[];
}

export interface GitHubRepositoryInfo {
  id: number;
  owner: string;
  name: string;
  defaultBranch: string;
}

export class GitHubApiError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

const API_BASE = "https://api.github.com";

/**
 * GitHub App 的最小 REST 客户端：JWT 只在内存签名，installation token 按用途最小权限签发，
 * 不把 App 私钥或 token 写入日志与数据库。
 */
export class GitHubAppClient {
  private readonly key: KeyObject;

  public constructor(
    private readonly config: GitHubAppConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const key = createPrivateKey(config.privateKeyPem);
    if (key.asymmetricKeyType !== "rsa") {
      throw new Error("GitHub App private key must be RSA");
    }
    this.key = key;
  }

  public get allowedInstallationIds(): readonly number[] {
    return this.config.allowedInstallationIds;
  }

  public appJwt(now: number = Date.now()): string {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iat: Math.floor((now - 60_000) / 1_000),
        exp: Math.floor((now + 9 * 60_000) / 1_000),
        iss: this.config.appId,
      }),
    ).toString("base64url");
    const signature = createSign("RSA-SHA256")
      .update(`${header}.${payload}`)
      .sign(this.key)
      .toString("base64url");
    return `${header}.${payload}.${signature}`;
  }

  private async request<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${API_BASE}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        authorization: `Bearer ${token}`,
        "user-agent": "zcode-cloud-control-plane",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new GitHubApiError(response.status, text.slice(0, 500) || response.statusText);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  public async installationToken(
    installationId: number,
    options: {
      repositories?: string[];
      permissions?: Record<string, "read" | "write">;
    } = {},
  ): Promise<string> {
    if (!this.config.allowedInstallationIds.includes(installationId)) {
      throw new Error("installation is not in the configured allowlist");
    }
    const body: Record<string, unknown> = {};
    if (options.repositories?.length) {
      body["repositories"] = options.repositories;
    }
    if (options.permissions) {
      body["permissions"] = options.permissions;
    }
    const result = await this.request<{ token?: string }>(
      `/app/installations/${installationId}/access_tokens`,
      this.appJwt(),
      { method: "POST", body: JSON.stringify(body) },
    );
    if (!result.token) {
      throw new Error("installation token missing in response");
    }
    return result.token;
  }

  public async getRepository(
    owner: string,
    name: string,
    token: string,
  ): Promise<GitHubRepositoryInfo> {
    const repo = await this.request<{
      id: number;
      name: string;
      default_branch: string;
      owner: { login: string };
    }>(`/repos/${owner}/${name}`, token);
    return {
      id: repo.id,
      owner: repo.owner.login,
      name: repo.name,
      defaultBranch: repo.default_branch,
    };
  }

  public async getBranchSha(
    owner: string,
    name: string,
    branch: string,
    token: string,
  ): Promise<string | null> {
    try {
      const ref = await this.request<{ object: { sha: string } }>(
        `/repos/${owner}/${name}/git/ref/heads/${encodeURIComponent(branch)}`,
        token,
      );
      return ref.object.sha;
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  public async createBranch(
    input: { owner: string; name: string; branch: string; sha: string },
    token: string,
  ): Promise<void> {
    await this.request(`/repos/${input.owner}/${input.name}/git/refs`, token, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${input.branch}`, sha: input.sha }),
    });
  }

  public async createPullRequest(
    input: {
      owner: string;
      name: string;
      head: string;
      base: string;
      title: string;
      body: string;
    },
    token: string,
  ): Promise<{ number: number; url: string }> {
    const pr = await this.request<{ number: number; html_url: string }>(
      `/repos/${input.owner}/${input.name}/pulls`,
      token,
      {
        method: "POST",
        body: JSON.stringify({
          head: input.head,
          base: input.base,
          title: input.title,
          body: input.body,
        }),
      },
    );
    return { number: pr.number, url: pr.html_url };
  }

  public async closePullRequest(
    owner: string,
    name: string,
    number: number,
    token: string,
  ): Promise<void> {
    await this.request(`/repos/${owner}/${name}/pulls/${number}`, token, {
      method: "PATCH",
      body: JSON.stringify({ state: "closed" }),
    });
  }

  public async deleteBranch(
    owner: string,
    name: string,
    branch: string,
    token: string,
  ): Promise<void> {
    try {
      await this.request(
        `/repos/${owner}/${name}/git/refs/heads/${encodeURIComponent(branch)}`,
        token,
        { method: "DELETE" },
      );
    } catch {
      // 删除是尽力操作。
    }
  }
}
