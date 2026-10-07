/**
 * W8 草稿 scope 与主体来源用例（specs/cloud-agent 04 §3.2/§3.4.1、12 §5、03 §6）。
 *
 * 覆盖：
 * - scope 键 = principal + controlPlaneOrigin + taskId，**不随 runtime session 漂移**（W-06/W-07/W-18）；
 * - 主体来自 capabilities 投影，不由客户端自造、也不回落 ui-bootstrap（12 §5）；
 * - bootstrap 只承载 origin / taskId，未知字段 fail-closed（04 §2 不切回本机）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { capabilitiesResponseSchema } from "@zcode/shared";
import {
  buildCloudDraftScope,
  cloudDraftScopePrincipalPrefix,
  isSameCloudDraftScope,
  parseCloudDraftScopeKey,
} from "../src/cloud/cloudDraftScope.js";
import {
  CloudBootstrapError,
  parseCloudUiBootstrap,
  readCloudTaskIdFromSearch,
  resolveCloudTaskIdFromWorkspaceIdentity,
  withCloudTaskSearch,
} from "../src/cloud/cloudUiBootstrap.js";

const PRINCIPAL = "3c8a6d2b-0e4f-4a9b-8c1d-2e3f4a5b6c7d";
const TASK_ID = "8f14e45f-ceea-467a-9a1e-1f0d3b2a4c51";

test("draft scope is stable across runtime session / path / provider changes", () => {
  const base = buildCloudDraftScope({
    principalId: PRINCIPAL,
    controlPlaneOrigin: "https://cloud.example.com",
    taskId: TASK_ID,
  });
  // 同一个 Task 在任何 Run 换代后都必须得到同一个键：scope 里没有 runtimeSessionId，
  // 也没有 workspacePath（04 §3.4.1）。
  const sameTaskAfterReopen = buildCloudDraftScope({
    principalId: PRINCIPAL,
    controlPlaneOrigin: "https://cloud.example.com",
    taskId: TASK_ID,
  });
  assert.equal(base.key, sameTaskAfterReopen.key);
  assert.equal(isSameCloudDraftScope(base, sameTaskAfterReopen), true);
  assert.equal(base.key.includes("session"), false);
  assert.equal(base.key.includes("/tmp"), false);
});

test("draft scope isolates different principals, origins and tasks", () => {
  const base = buildCloudDraftScope({
    principalId: PRINCIPAL,
    controlPlaneOrigin: "https://cloud.example.com",
    taskId: TASK_ID,
  });
  const otherPrincipal = buildCloudDraftScope({
    principalId: "4d9b7e3c-1f5a-4b0c-9d2e-3f4a5b6c7d8e",
    controlPlaneOrigin: "https://cloud.example.com",
    taskId: TASK_ID,
  });
  const otherOrigin = buildCloudDraftScope({
    principalId: PRINCIPAL,
    controlPlaneOrigin: "https://cloud.other.example",
    taskId: TASK_ID,
  });
  const otherTask = buildCloudDraftScope({
    principalId: PRINCIPAL,
    controlPlaneOrigin: "https://cloud.example.com",
    taskId: "9a1e1f0d-3b2a-4c51-8f14-e45fceea467a",
  });

  assert.notEqual(base.key, otherPrincipal.key);
  assert.notEqual(base.key, otherOrigin.key);
  assert.notEqual(base.key, otherTask.key);
  assert.equal(isSameCloudDraftScope(base, otherPrincipal), false);
  assert.equal(isSameCloudDraftScope(base, null), false);

  // 登出切主体时按主体前缀清投影（04 §3.4.1「登出切主体清投影」）。
  assert.equal(otherPrincipal.key.startsWith(cloudDraftScopePrincipalPrefix(PRINCIPAL)), false);
  assert.equal(base.key.startsWith(cloudDraftScopePrincipalPrefix(PRINCIPAL)), true);
});

test("draft scope key round-trips, and malformed keys are rejected instead of guessed", () => {
  const scope = buildCloudDraftScope({
    principalId: PRINCIPAL,
    controlPlaneOrigin: "https://cloud.example.com",
    taskId: TASK_ID,
  });
  assert.deepEqual(parseCloudDraftScopeKey(scope.key), scope);
  // 解析失败返回 null：调用方必须丢弃本地记录，不能把别人的草稿挂上来。
  assert.equal(parseCloudDraftScopeKey("only-one-part"), null);
  assert.equal(parseCloudDraftScopeKey("a|b"), null);
  assert.equal(parseCloudDraftScopeKey(`${PRINCIPAL}||${TASK_ID}`), null);
});

test("the principal is a frozen, typed field of the capabilities response", () => {
  // 主体由控制面 capabilities 提供（03 §6、12 §5）：UI 直接消费类型化字段，
  // 既不做结构化绕过，也不回落到 ui-bootstrap 或本地生成的 id。
  const parsed = capabilitiesResponseSchema.parse({
    mode: "cloud",
    principalId: PRINCIPAL,
    providers: [],
    features: [],
    protocolVersion: 1,
    taskOwnedAttachments: false,
  });
  assert.equal(parsed.principalId, PRINCIPAL);
  // 字段缺失 / 形状不对一律被 schema 拒绝：UI 拿不到主体时 scope 保持不可用，不猜。
  for (const invalid of [undefined, "", "not-a-uuid", 42]) {
    assert.equal(
      capabilitiesResponseSchema.safeParse({
        mode: "cloud",
        ...(invalid === undefined ? {} : { principalId: invalid }),
        providers: [],
        features: [],
        protocolVersion: 1,
        taskOwnedAttachments: false,
      }).success,
      false,
    );
  }
});

test("ui-bootstrap carries only client-confirmed addressing, and rejects unknown fields", () => {
  const bootstrap = parseCloudUiBootstrap({
    controlPlaneOrigin: "https://cloud.example.com",
    taskId: TASK_ID,
  });
  assert.equal(bootstrap.controlPlaneOrigin, "https://cloud.example.com");
  assert.equal(bootstrap.taskId, TASK_ID);
  // 主体不再经 bootstrap 传递（12 §5）：带上它是配置错误，直接 fail-closed。
  assert.throws(
    () =>
      parseCloudUiBootstrap({
        controlPlaneOrigin: "https://cloud.example.com",
        principalId: PRINCIPAL,
      }),
    CloudBootstrapError,
  );
  assert.throws(
    () => parseCloudUiBootstrap({ controlPlaneOrigin: "http://x/y" }),
    CloudBootstrapError,
  );
  assert.throws(
    () => parseCloudUiBootstrap({ controlPlaneOrigin: "https://u:p@x" }),
    CloudBootstrapError,
  );
  assert.throws(
    () => parseCloudUiBootstrap({ controlPlaneOrigin: "ftp://x" }),
    CloudBootstrapError,
  );
});

test("main route reads and writes ?task=<taskId> without disturbing other params", () => {
  assert.equal(readCloudTaskIdFromSearch(`?task=${TASK_ID}`), TASK_ID);
  // 非法 taskId 视为「没有选中任务」，不抛错（路由要能渲染错误态）。
  assert.equal(readCloudTaskIdFromSearch("?task=not-a-uuid"), null);
  assert.equal(readCloudTaskIdFromSearch(""), null);
  // ?remote=<id> 保留原本机 Web / 桌面远控语义，不自动导入 CloudTask（04 §5）。
  assert.equal(readCloudTaskIdFromSearch("?remote=abc"), null);

  assert.equal(withCloudTaskSearch("?remote=abc", TASK_ID), `?remote=abc&task=${TASK_ID}`);
  assert.equal(withCloudTaskSearch(`?task=${TASK_ID}`, null), "");
});

test("workspace identity resolves to a taskId, and non-cloud identities stay null", () => {
  assert.equal(resolveCloudTaskIdFromWorkspaceIdentity(`cloud-task:${TASK_ID}`), TASK_ID);
  // 非 cloud-task 身份必须返回 null：调用方据此沿用既有本地 / 远程解析。
  assert.equal(resolveCloudTaskIdFromWorkspaceIdentity("/home/me/project"), null);
  assert.equal(resolveCloudTaskIdFromWorkspaceIdentity("ssh://host/path"), null);
  assert.equal(resolveCloudTaskIdFromWorkspaceIdentity(`cloud-task:not-a-uuid`), null);
  assert.equal(resolveCloudTaskIdFromWorkspaceIdentity(null), null);
  assert.equal(resolveCloudTaskIdFromWorkspaceIdentity(undefined), null);
});
