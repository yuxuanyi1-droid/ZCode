import assert from "node:assert/strict";
import test from "node:test";
import {
  ZCODE_SANDBOX_PROVISIONER_TOKEN_ENV_KEY,
  ZCODE_SANDBOX_PROVISIONER_URL_ENV_KEY,
  type SandboxProvisionRequest,
} from "@zcode/shared";
import {
  SANDBOX_PROVISION_PATH,
  SandboxProvisionerClient,
  SandboxProvisionerError,
  createSandboxProvisionerFromEnv,
} from "../src/remote/sandbox-provisioner.js";

function buildRequest(overrides?: Partial<SandboxProvisionRequest>): SandboxProvisionRequest {
  return {
    provider: "modal",
    repository: { owner: "yuxuanyi1-droid", name: "ZCode" },
    branch: "main",
    ...overrides,
  };
}

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

function createFetchStub(response: Response): { calls: RecordedCall[]; fetchImpl: typeof fetch } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return response;
  }) as typeof fetch;

  return { calls, fetchImpl };
}

test("create posts the request to /sandboxes with a bearer token", async () => {
  const { calls, fetchImpl } = createFetchStub(
    Response.json({
      sandboxId: "sbx-42",
      ssh: { host: "10.0.0.7", port: 2222, username: "dev" },
      workspacePath: "/workspace/ZCode",
    }),
  );
  // 结尾斜杠由客户端归一，否则会拼出 `//sandboxes`。
  const client = new SandboxProvisionerClient({
    baseUrl: "http://127.0.0.1:8788/",
    token: "secret-token",
    fetchImpl,
  });

  const result = await client.create(buildRequest({ timeoutSeconds: 1800 }));

  assert.equal(result.sandboxId, "sbx-42");
  assert.equal(result.workspacePath, "/workspace/ZCode");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, `http://127.0.0.1:8788${SANDBOX_PROVISION_PATH}`);
  assert.equal(calls[0]?.init?.method, "POST");
  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer secret-token");
  assert.deepEqual(
    JSON.parse(String(calls[0]?.init?.body)),
    buildRequest({ timeoutSeconds: 1800 }),
  );
  assert.ok(calls[0]?.init?.signal instanceof AbortSignal);
});

test("create omits the authorization header when no token is configured", async () => {
  const { calls, fetchImpl } = createFetchStub(
    Response.json({
      sandboxId: "sbx-42",
      ssh: { host: "10.0.0.7", username: "dev" },
      workspacePath: "/workspace/ZCode",
    }),
  );

  await new SandboxProvisionerClient({ baseUrl: "http://127.0.0.1:8788", fetchImpl }).create(
    buildRequest(),
  );

  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal("authorization" in headers, false);
});

test("create surfaces a non-2xx response as a typed error with the status and detail", async () => {
  const { fetchImpl } = createFetchStub(
    new Response("no capacity for modal right now", { status: 503 }),
  );
  const client = new SandboxProvisionerClient({ baseUrl: "http://127.0.0.1:8788", fetchImpl });

  const error = await client.create(buildRequest()).catch((err: unknown) => err);

  assert.ok(error instanceof SandboxProvisionerError);
  assert.equal(error.status, 503);
  assert.match(error.message, /no capacity for modal right now/);
});

test("create rejects a response that fails the result schema", async () => {
  // sandboxId 会进 workspace identity；provisioner 返回坏 id 必须当场失败，
  // 不能被当成"能连上就行"放过去。
  const { fetchImpl } = createFetchStub(
    Response.json({
      sandboxId: "modal:sbx-42",
      ssh: { host: "10.0.0.7", username: "dev" },
      workspacePath: "/workspace/ZCode",
    }),
  );
  const client = new SandboxProvisionerClient({ baseUrl: "http://127.0.0.1:8788", fetchImpl });

  await assert.rejects(client.create(buildRequest()), /invalid result/);
});

test("create rejects a non-JSON response body", async () => {
  const { fetchImpl } = createFetchStub(new Response("<html>gateway</html>", { status: 200 }));
  const client = new SandboxProvisionerClient({ baseUrl: "http://127.0.0.1:8788", fetchImpl });

  await assert.rejects(client.create(buildRequest()), /non-JSON/);
});

test("create wraps a transport failure without leaking the raw error type", async () => {
  const fetchImpl = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  const client = new SandboxProvisionerClient({ baseUrl: "http://127.0.0.1:8788", fetchImpl });

  const error = await client.create(buildRequest()).catch((err: unknown) => err);

  assert.ok(error instanceof SandboxProvisionerError);
  assert.equal(error.status, undefined);
  assert.match(error.message, /fetch failed/);
});

test("createSandboxProvisionerFromEnv returns null until the URL is configured", () => {
  assert.equal(createSandboxProvisionerFromEnv({}), null);
  assert.equal(
    createSandboxProvisionerFromEnv({ [ZCODE_SANDBOX_PROVISIONER_URL_ENV_KEY]: "  " }),
    null,
  );

  const client = createSandboxProvisionerFromEnv({
    [ZCODE_SANDBOX_PROVISIONER_URL_ENV_KEY]: "http://127.0.0.1:8788",
    [ZCODE_SANDBOX_PROVISIONER_TOKEN_ENV_KEY]: "token",
  });

  assert.ok(client instanceof SandboxProvisionerClient);
});
