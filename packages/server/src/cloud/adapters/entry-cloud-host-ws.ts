/**
 * host `/ws` 服务通道挂载（specs/cloud-agent/03 §7.1 host 分面、12 §1.2/§4/§5）。
 *
 * 决议⑧：云服务端就是标准 host 本体，浏览器按 web 模式同款经 `/ws?token=` 连上它，
 * 拿到账号域服务（oauth/credential/usage/setting/provider registry）。**零新增账号
 * 装配**——本文件只做「把 host 服务图的哪一部分暴露给浏览器」这一件事。
 *
 * 两条硬边界：
 * 1. host 通道只暴露账号域 + UI 支撑频道；本机执行域（file/terminal/git/system/
 *    agent/session…）不注册，因此绕过 UI 直接调 RPC 得到的是「频道不存在」而不是
 *    部署机文件系统（03 §2、CP-01）。这是 allowlist 而非 denylist：新增服务默认
 *    不外露，避免后来者无意中把执行域带进云入口。
 * 2. 不挂 `/ws/host`（desktop-continuous / trusted-host-relay）：云客户端不得升格
 *    为受信 Host（03 §3「客户端不获得 trusted-host-relay 角色」）。
 */
import {
  IBroadcastService,
  ICodingPlanSubscriptionService,
  ICredentialService,
  IModelSelectionService,
  IOnboardingRecordService,
  IOAuthService,
  IProviderSettingsService,
  ISettingService,
  IUsageStatsService,
  ServiceCollection,
  type ServiceDescriptor,
} from "@zcode/services";
import {
  getProviderProvisioningSource,
  type ProviderProvisioningSource,
} from "@zcode/services/node";
import type { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import type { WebSocket } from "ws";
import { setupChannelServer } from "../../rpcChannelServer.js";
import type { CloudProvisioningChangeTrigger } from "./entry-cloud-host-body.js";

/**
 * 云 host 通道暴露面（03 §7.1 `domains` 的落地映射；`broadcast` 与
 * `coding-plan-subscription` 见下）：
 * - oauth / credential / usage-stats / setting / provider-settings / model-selection =
 *   03 §7.1 列出的五个账号域；
 * - coding-plan-subscription = 12 §1「云模式下必须保留 OAuth 登录与 Coding Plan 入口」；
 * - broadcast = 原 UI 的 `ZCodeIntlProvider` 启动即取 `broadcastService`
 *   （`packages/web/src/main.tsx`），它不是执行域能力。
 * 新增一项都需要先改 03 §7.1 的分面表。
 */
const CLOUD_HOST_CHANNEL_DESCRIPTORS: readonly ServiceDescriptor<unknown>[] = [
  IOAuthService,
  ICredentialService,
  IUsageStatsService,
  ICodingPlanSubscriptionService,
  ISettingService,
  IProviderSettingsService,
  IModelSelectionService,
  IBroadcastService,
  // onboarding-record：引导记录是**账号级 UI 偏好**（写入 host 数据目录的 JSON），不是执行域能力。
  // 实测（2026-10-07）：它不在白名单时，`appendRecord` 走 unknown channel → 记录永远写不进去 →
  // OccupationOnboarding 每次加载都重新触发引导（其代码注释即写明"记录写失败下次启动会再次引导"），
  // 用户卡在"引导页 → 空白"的循环里进不去主界面。判据是"是否账号/UI 偏好"而非"是否本机执行"。
  IOnboardingRecordService,
];

export const CLOUD_HOST_CHANNEL_ALLOWLIST: readonly string[] = CLOUD_HOST_CHANNEL_DESCRIPTORS.map(
  (descriptor) => descriptor.channelName,
);

/**
 * 本机执行域频道（03 §2、07 §7）：**禁止**出现在云入口暴露面上。常量在这里是为了
 * 让「allowlist 与执行域不相交」成为可断言的机械事实，不是候选清单。
 */
export const CLOUD_HOST_DENIED_EXECUTION_CHANNELS: readonly string[] = [
  "file",
  "file-watcher",
  "media-preview",
  "git",
  "git-checkpoint",
  "system",
  "terminal",
  "zcode-agent",
  "zcode-session",
  "zcode-task",
  "window-controller",
  "provider-provisioning-target",
];

/**
 * 从 host 服务图裁出云端对浏览器的暴露面。缺失的频道直接跳过（fail-closed：装配
 * 里没有就不外露），不从别处补一个替代实现。
 */
export function createCloudHostChannelServices(source: ServiceCollection): ServiceCollection {
  const restricted = new ServiceCollection();
  for (const descriptor of CLOUD_HOST_CHANNEL_DESCRIPTORS) {
    const instance = source.getOptional(descriptor);
    if (instance) {
      restricted.register(descriptor, instance);
    }
  }
  return restricted;
}

/** host 自带 provisioning source（12 §6）：唯一 owner 是 host，入口只做取用。 */
export function readCloudHostProvisioningSource(
  services: ServiceCollection,
): ProviderProvisioningSource | undefined {
  return getProviderProvisioningSource(services);
}

/**
 * 挂载 host `/ws`。lite-token 校验沿用 `rpcChannelServer` 的既有实现（`?token=`
 * 放行同 web 模式），本函数不重复鉴权逻辑。
 */
export function mountCloudHostWebSocket(
  app: Hono,
  options: { services: ServiceCollection; upgradeWebSocket: UpgradeWebSocket },
): void {
  app.get(
    "/ws",
    options.upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        // 云客户端统一 `web-remote-replayable`（04 §2）：不能通过 header 升格为
        // trusted host，也不因此获得 provider provisioning target。
        setupChannelServer(ws.raw as WebSocket, options.services, "web-remote-replayable", {
          // 执行域频道显式拒绝（而不是留在「等频道注册」的挂起路径）：绕过 UI 直接
          // 请求 file/terminal/agent 会立刻拿到结构化错误（03 §2、CP-01）。
          denyChannels: CLOUD_HOST_DENIED_EXECUTION_CHANNELS,
        });
      },
    })),
  );
}

export interface ProvisioningSourceChange {
  readonly generation: number;
  readonly trigger: CloudProvisioningChangeTrigger;
}

/**
 * 凭据代际观察（12 §6 A-08）：host 刷新 token/账号配置后入口递增代际并广播，控制面
 * 按「标记 + 下次 bridge 连接时重装」处理。入口只负责代际事实，不做重推决策。
 */
export interface ProvisioningSourceChangeObserver {
  readonly generation: number;
  notify(trigger: CloudProvisioningChangeTrigger): void;
  onDidChange(listener: (change: ProvisioningSourceChange) => void): () => void;
}

export function createProvisioningSourceChangeObserver(): ProvisioningSourceChangeObserver {
  let generation = 0;
  const listeners = new Set<(change: ProvisioningSourceChange) => void>();
  return {
    get generation() {
      return generation;
    },
    notify(trigger) {
      generation += 1;
      const change: ProvisioningSourceChange = { generation, trigger };
      for (const listener of Array.from(listeners)) {
        listener(change);
      }
    },
    onDidChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
