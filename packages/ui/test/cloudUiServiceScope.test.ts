/**
 * W8 服务作用域用例（specs/cloud-agent 04 §8 最大风险项、03 §7.1、12 §5、04 §9 W-11/W-17）。
 *
 * 断言的核心是「哪个调用打到 host `/ws`、哪个打到当前 Run attachment」：
 * 这是 acceptance 要求的服务目标证据，不能只靠读组件代码推断。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Event, type IChannel, type IChannelClient } from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import { CLOUD_ATTACHMENT_SERVICE_ALLOWLIST, ServiceChannels } from "@zcode/shared";
import {
  CLOUD_EXECUTION_SERVICE_BINDINGS,
  CLOUD_HOST_CHANNEL_ENDPOINT,
  CLOUD_TASK_ATTACHMENT_ENDPOINT,
  assertCloudExecutionBindingsMatchAllowlist,
  describeCloudExecutionTargets,
  describeCloudHostTargets,
  isCloudExecutionServiceKey,
} from "../src/cloud/cloudServiceScope.js";
import {
  createCloudBrowserServices,
  selectCloudAttachmentForTask,
  type CloudAttachmentAccessor,
} from "../src/cloud/cloudBrowserServices.js";
import {
  CLOUD_ATTACHMENT_UNAVAILABLE_CODE,
  isCloudServiceUnavailableError,
} from "../src/cloud/unavailableServiceAccessor.js";

/** host 侧桩服务的探测接口：每个 host 服务都暴露 `call(command)`。 */
interface HostProbe {
  call(command: string): Promise<unknown>;
}

interface RecordedCall {
  readonly channel: string;
  readonly command: string;
}

/** 记录每个 channel 收到哪些命令，用来证明调用确实落在目标通道上。 */
function createRecordingChannelClient(calls: RecordedCall[]): IChannelClient {
  return {
    getChannel<T extends IChannel>(channelName: string): T {
      const channel: IChannel = {
        call: async (command: string) => {
          calls.push({ channel: channelName, command });
          return { channel: channelName, command };
        },
        listen: () => Event.None,
      };
      return channel as T;
    },
  };
}

function createHostAccessor(calls: RecordedCall[]): IServiceAccessor {
  return new Proxy(Object.create(null), {
    get(_target, property) {
      if (typeof property !== "string") {
        return undefined;
      }
      // host 侧的每个服务面都用一个同名 channel 表示。
      return {
        __channel: `host:${property}`,
        call: (command: string) => {
          calls.push({ channel: `host:${property}`, command });
          return Promise.resolve({ channel: `host:${property}`, command });
        },
        once: () => Promise.resolve({ channel: `host:${property}`, command: "once" }),
        onDidChange: () => Event.None,
      };
    },
  }) as IServiceAccessor;
}

test("execution bindings cover exactly the frozen attachment allowlist", () => {
  // 两侧任一漂移都必须 fail-closed：多覆盖或少覆盖一个 channel 都会让
  // 「哪些服务来自沙箱」失去唯一事实源（W8 §8 风险项）。
  assert.doesNotThrow(() => assertCloudExecutionBindingsMatchAllowlist());
  assert.deepEqual(
    CLOUD_EXECUTION_SERVICE_BINDINGS.map((binding) => binding.channel).sort(),
    [...CLOUD_ATTACHMENT_SERVICE_ALLOWLIST].sort(),
  );
});

test("targets name the host channel for the account domain and the attachment for execution", () => {
  const hostTargets = describeCloudHostTargets();
  const executionTargets = describeCloudExecutionTargets();

  assert.ok(hostTargets.length > 0);
  for (const target of hostTargets) {
    assert.equal(target.scope, "host");
    assert.equal(target.endpoint, CLOUD_HOST_CHANNEL_ENDPOINT);
    assert.equal(isCloudExecutionServiceKey(target.accessorKey), false);
  }
  for (const target of executionTargets) {
    assert.equal(target.scope, "task-attachment");
    assert.equal(target.endpoint, CLOUD_TASK_ATTACHMENT_ENDPOINT);
    assert.equal(isCloudExecutionServiceKey(target.accessorKey), true);
  }
  // 账号域与模型目录永远来自 host（12 §5）；attachment 通道显式拒绝它们。
  for (const key of ["oauthService", "credentialService", "modelSelectionService"] as const) {
    const target = hostTargets.find((entry) => entry.accessorKey === key);
    assert.ok(target, `${key} must be a host target`);
  }
});

test("ready attachment overrides execution services and keeps the account domain on the host", async () => {
  const calls: RecordedCall[] = [];
  const attachmentCalls: RecordedCall[] = [];
  const attachment: CloudAttachmentAccessor = {
    taskId: "8f14e45f-ceea-467a-9a1e-1f0d3b2a4c51",
    channelClient: createRecordingChannelClient(attachmentCalls),
  };

  const { services, executionScope } = createCloudBrowserServices({
    hostAccessor: createHostAccessor(calls),
    attachment,
  });
  assert.equal(executionScope, "attachment-ready");

  // 执行域：调用落到当前 Run attachment 的 channel 上。
  await (services.fileService as unknown as { readFile(p: string): Promise<unknown> }).readFile(
    "/repo/a.ts",
  );
  assert.deepEqual(attachmentCalls, [{ channel: ServiceChannels.File, command: "readFile" }]);

  // 账号域：同一 accessor 上仍然打到 host，不走 attachment。
  await (services.oauthService as unknown as HostProbe).call("getStatus");
  assert.ok(calls.some((call) => call.channel === "host:oauthService"));
  assert.equal(
    attachmentCalls.some((call) => call.channel === ServiceChannels.OAuth),
    false,
  );
});

test("without a ready attachment the execution domain is unavailable, never the host", async () => {
  const calls: RecordedCall[] = [];
  const { services, executionScope } = createCloudBrowserServices({
    hostAccessor: createHostAccessor(calls),
  });
  assert.equal(executionScope, "unavailable");

  await assert.rejects(
    async () =>
      (services.fileService as unknown as { readFile(p: string): Promise<unknown> }).readFile(
        "/repo/a.ts",
      ),
    (error: unknown) => {
      assert.ok(isCloudServiceUnavailableError(error));
      assert.equal(error.code, CLOUD_ATTACHMENT_UNAVAILABLE_CODE);
      return true;
    },
  );
  // 关键断言：拒绝的同时**没有**任何调用落到 host 执行域（不回落本机）。
  assert.deepEqual(calls, []);

  // 账号域仍然可用：draft 期的登录 / 套餐 / 模型设置页不受影响（12 §5）。
  await (services.oauthService as unknown as HostProbe).call("getStatus");
  assert.ok(calls.some((call) => call.channel === "host:oauthService"));
});

test("spreading the accessor keeps the execution override", async () => {
  // 既有合并代码里存在 `{...baseServices, fileService: remote.fileService}` 这类写法；
  // 若只拦 get 不补 ownKeys/描述符，覆盖会在展开那一刻悄悄丢失。
  const attachmentCalls: RecordedCall[] = [];
  const { services } = createCloudBrowserServices({
    hostAccessor: createHostAccessor([]),
    attachment: {
      taskId: "8f14e45f-ceea-467a-9a1e-1f0d3b2a4c51",
      channelClient: createRecordingChannelClient(attachmentCalls),
    },
  });

  const spread = { ...services } as IServiceAccessor;
  await (spread.gitService as unknown as { getStatus(): Promise<unknown> }).getStatus();
  assert.ok(attachmentCalls.some((call) => call.channel === ServiceChannels.Git));
});

test("an attachment belonging to another task is not reused", () => {
  const attachment: CloudAttachmentAccessor = {
    taskId: "8f14e45f-ceea-467a-9a1e-1f0d3b2a4c51",
    channelClient: createRecordingChannelClient([]),
  };
  assert.equal(selectCloudAttachmentForTask(attachment, attachment.taskId), attachment);
  // 身份不同 → 执行域不可用；既不借别的任务的 attachment，也不回落 host。
  assert.equal(
    selectCloudAttachmentForTask(attachment, "4d9b7e3c-1f5a-4b0c-9d2e-3f4a5b6c7d8e"),
    null,
  );
  assert.equal(selectCloudAttachmentForTask(attachment, null), null);
  assert.equal(selectCloudAttachmentForTask(null, attachment.taskId), null);
});
