/**
 * 审查（Git）侧栏面板的云作用域用例
 * （specs/cloud-agent/04 §3.3「2026-10-10 修订」、W8 §3）。
 *
 * 回归背景（2026-10-10 用户实测缺陷）：云任务 paused（横幅「运行环境已暂停」）时，
 * 审查面板呈现「当前环境没有可用的 Git——请先安装 Git」。两层根因：
 * 1. 取数门控 `shouldEnableWorkspaceRpc` 要求 remote 目标已注册 remote session，而云任务
 *    工作区（identity = `cloud-task:<taskId>`）没有、也不会有 remote session 登记——
 *    ready run 也从未发起 Git 查询（服务路由本身无缺陷：gitService 已按 W8 绑定表
 *    走当前 Run attachment 通道，allowlist 含 Git）。
 * 2. 无 attachment（paused / provisioning / 终态）时面板渲染空摘要态
 *    （isGitAvailable=false），命中「install Git」文案——这是环境事实，不是本机没装 Git。
 *
 * 规则本体在 `src/cloud/cloudGitPaneScope.ts`（纯函数，无 `@/` 别名 import）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Event, type IChannel, type IChannelClient } from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import { ServiceChannels } from "@zcode/shared";
import {
  resolveCloudGitPaneScope,
  resolveGitPaneEmptyStateCopy,
} from "../src/cloud/cloudGitPaneScope.js";
import {
  createCloudBrowserServices,
  type CloudAttachmentAccessor,
} from "../src/cloud/cloudBrowserServices.js";

const CLOUD_IDENTITY = "cloud-task:8f14e45f-ceea-467a-9a1e-1f0d3b2a4c51";

// ── 第 1 层：ready run 的取数门控与 accessor 路由 ──

test("cloud ready run enables the git pane rpc even though no remote session is registered", () => {
  // 回归点：云身份 + 无 remote session 在通用判据下恒为 false（isRemoteTarget=true 且
  // remoteSessionId 为空），审查面板因此从未调用 gitService。云身份只看 attachment 真实状态。
  const genericGate = false; // shouldEnableWorkspaceRpc({identity, remoteSessionId: null}) 的结果
  const scope = resolveCloudGitPaneScope({
    cloudTaskId: CLOUD_IDENTITY.slice("cloud-task:".length),
    attachmentReady: true,
    activeRunStatus: "ready",
    genericWorkspaceRpcEnabled: genericGate,
  });

  assert.equal(scope.workspaceRpcEnabled, true);
  assert.equal(scope.environment, "ready");
});

test("cloud git pane accessor routes to the attachment git channel", async () => {
  // 验收要求的服务目标证据：审查面板拿到的 gitService 调用必须落到当前 Run attachment
  // 的 Git channel（W8 绑定表），而不是 host `/ws` 执行域。
  const hostCalls: { channel: string; command: string }[] = [];
  const attachmentCalls: { channel: string; command: string }[] = [];
  const channelClient: IChannelClient = {
    getChannel<T extends IChannel>(channelName: string): T {
      return {
        call: async (command: string) => {
          attachmentCalls.push({ channel: channelName, command });
          return { ok: true };
        },
        listen: () => Event.None,
      } as IChannel as T;
    },
  };
  const attachment: CloudAttachmentAccessor = {
    taskId: CLOUD_IDENTITY.slice("cloud-task:".length),
    channelClient,
  };
  const hostAccessor = new Proxy(Object.create(null), {
    get(_target, property) {
      if (typeof property !== "string") {
        return undefined;
      }
      return {
        call: (command: string) => {
          hostCalls.push({ channel: `host:${property}`, command });
          return Promise.resolve({ ok: true });
        },
        once: () => Promise.resolve({ ok: true }),
        onDidChange: () => Event.None,
      };
    },
  }) as IServiceAccessor;

  const { services } = createCloudBrowserServices({ hostAccessor, attachment });
  await (
    services.gitService as unknown as {
      refresh(params: { workspacePath: string }): Promise<unknown>;
    }
  ).refresh({ workspacePath: "/repo" });

  assert.deepEqual(attachmentCalls, [{ channel: ServiceChannels.Git, command: "refresh" }]);
  assert.deepEqual(hostCalls, []);
});

// ── 第 2 层：paused / 无 attachment 的环境感知呈现 ──

test("cloud paused run gates the git pane and presents the paused guidance", () => {
  // paused 时 attachment 已被控制面 detach（isAttachableRunStatus 不含 paused），
  // 面板不得发起注定失败的 Git RPC，也不得呈现 install 文案。
  const scope = resolveCloudGitPaneScope({
    cloudTaskId: CLOUD_IDENTITY.slice("cloud-task:".length),
    attachmentReady: false,
    activeRunStatus: "paused",
    genericWorkspaceRpcEnabled: false,
  });

  assert.equal(scope.workspaceRpcEnabled, false);
  assert.equal(scope.environment, "paused");

  const copy = resolveGitPaneEmptyStateCopy({
    isLastTurnSource: false,
    loading: false,
    error: null,
    cloudEnvironment: scope.environment,
    isGitAvailable: false,
    isRepository: false,
  });
  // 复用状态横幅同款 paused 语义（04 §3.3），描述给出「发消息恢复」引导。
  assert.equal(copy.titleMessageId, "cloud.run.statusPaused");
  assert.equal(copy.descriptionMessageId, "git.cloud.pausedDescription");
  // 关键反断言：不得把沙箱暂停误报成「本机没装 Git」。
  assert.notEqual(copy.titleMessageId, "git.empty.gitUnavailableTitle");
  assert.notEqual(copy.descriptionMessageId, "git.empty.gitUnavailableDescription");
});

test("cloud non-paused environments without an attachment present the unavailable guidance", () => {
  for (const activeRunStatus of ["provisioning", "draining", null]) {
    const scope = resolveCloudGitPaneScope({
      cloudTaskId: CLOUD_IDENTITY.slice("cloud-task:".length),
      attachmentReady: false,
      activeRunStatus,
      genericWorkspaceRpcEnabled: false,
    });

    assert.equal(scope.workspaceRpcEnabled, false);
    assert.equal(scope.environment, "unavailable");

    const copy = resolveGitPaneEmptyStateCopy({
      isLastTurnSource: false,
      loading: false,
      error: null,
      cloudEnvironment: scope.environment,
      isGitAvailable: false,
      isRepository: false,
    });
    assert.equal(copy.titleMessageId, "git.cloud.environmentUnavailableTitle");
    assert.notEqual(copy.titleMessageId, "git.empty.gitUnavailableTitle");
  }
});

test("a cloud workspace of a non-selected task never claims paused from another task's status", () => {
  // 详情投影属于当前选中的任务：非选中云任务工作区只能按 attachment 不可用呈现，
  // 不能拿别的任务的 paused 状态当自己的（与 CloudTaskRunStatusBanner 同款判定）。
  const scope = resolveCloudGitPaneScope({
    cloudTaskId: CLOUD_IDENTITY.slice("cloud-task:".length),
    attachmentReady: false,
    activeRunStatus: null, // 调用方对非选中任务传 null
    genericWorkspaceRpcEnabled: false,
  });

  assert.equal(scope.environment, "unavailable");
});

// ── 非云链路：语义不变 ──

test("non-cloud workspaces keep the legacy gate and never enter cloud guidance", () => {
  // 本地 ready：通用判据 true。
  const localReady = resolveCloudGitPaneScope({
    cloudTaskId: null,
    attachmentReady: false,
    activeRunStatus: null,
    genericWorkspaceRpcEnabled: true,
  });
  assert.equal(localReady.workspaceRpcEnabled, true);
  assert.equal(localReady.environment, "ready");

  // SSH / 已配对远控未注册 session：保持空壳，不挂数据层（既有 fail-closed 语义）。
  const remoteWaiting = resolveCloudGitPaneScope({
    cloudTaskId: null,
    attachmentReady: false,
    activeRunStatus: null,
    genericWorkspaceRpcEnabled: false,
  });
  assert.equal(remoteWaiting.workspaceRpcEnabled, false);
  assert.equal(remoteWaiting.environment, "ready");
});

test("install-git copy is preserved only for ready environments without git", () => {
  // 环境 ready 后「没有 Git」仍是真实结论：既有文案只留给这条路径。
  const copy = resolveGitPaneEmptyStateCopy({
    isLastTurnSource: false,
    loading: false,
    error: null,
    cloudEnvironment: "ready",
    isGitAvailable: false,
    isRepository: false,
  });
  assert.equal(copy.titleMessageId, "git.empty.gitUnavailableTitle");
  assert.equal(copy.descriptionMessageId, "git.empty.gitUnavailableDescription");
});

test("loading and error states keep their precedence over the environment guidance", () => {
  const loadingCopy = resolveGitPaneEmptyStateCopy({
    isLastTurnSource: false,
    loading: true,
    error: null,
    cloudEnvironment: "paused",
    isGitAvailable: false,
    isRepository: false,
  });
  assert.equal(loadingCopy.titleMessageId, "common.loading");

  const errorCopy = resolveGitPaneEmptyStateCopy({
    isLastTurnSource: false,
    loading: false,
    error: "git blew up",
    cloudEnvironment: "paused",
    isGitAvailable: false,
    isRepository: false,
  });
  assert.equal(errorCopy.titleMessageId, "git.error.title");
  assert.equal(errorCopy.descriptionMessageId, "git.error.description");

  const lastTurnCopy = resolveGitPaneEmptyStateCopy({
    isLastTurnSource: true,
    loading: false,
    error: null,
    cloudEnvironment: "paused",
    isGitAvailable: false,
    isRepository: false,
  });
  assert.equal(lastTurnCopy.titleMessageId, "git.empty.lastTurnTitle");
});
