import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { GitHubAppClient, GitHubApiError } from "../src/adapters/github/githubApp.js";

function createKeyPair(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

describe("GitHubAppClient", () => {
  it("signs a JWT with issuer and bounded lifetime", () => {
    const client = new GitHubAppClient({
      appId: 12345,
      privateKeyPem: createKeyPair(),
      allowedInstallationIds: [1],
    });
    const jwt = client.appJwt(1_700_000_000_000);
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString()) as {
      iss: number;
      iat: number;
      exp: number;
    };
    expect(claims.iss).toBe(12345);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(10 * 60);
    expect(claims.exp - claims.iat).toBeGreaterThan(9 * 60);
    expect(signature?.length).toBeGreaterThan(100);
  });

  it("mints an installation token with the allowlist and minimal permissions", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ token: "ghs_test" }),
      } as unknown as Response;
    }) as typeof fetch;
    const client = new GitHubAppClient(
      { appId: 1, privateKeyPem: createKeyPair(), allowedInstallationIds: [99] },
      fetchImpl,
    );
    await expect(
      client.installationToken(99, {
        repositories: ["epdg"],
        permissions: { contents: "read" },
      }),
    ).resolves.toBe("ghs_test");
    expect(calls[0]?.url).toBe("https://api.github.com/app/installations/99/access_tokens");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      repositories: ["epdg"],
      permissions: { contents: "read" },
    });
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^Bearer eyJ/u);
  });

  it("rejects installations outside the allowlist", async () => {
    const client = new GitHubAppClient({
      appId: 1,
      privateKeyPem: createKeyPair(),
      allowedInstallationIds: [1],
    });
    await expect(client.installationToken(2)).rejects.toThrow(/allowlist/u);
  });

  it("normalizes API failures", async () => {
    const fetchImpl = (async () =>
      ({
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: async () => "missing",
      }) as unknown as Response) as typeof fetch;
    const client = new GitHubAppClient(
      { appId: 1, privateKeyPem: createKeyPair(), allowedInstallationIds: [1] },
      fetchImpl,
    );
    await expect(client.getRepository("a", "b", "token")).rejects.toBeInstanceOf(GitHubApiError);
  });
});
