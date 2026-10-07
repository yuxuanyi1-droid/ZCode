/* oxlint-disable eslint(max-lines) -- AppSettings schema 聚合历史迁移、默认值和 patch 校验，拆分会削弱设置迁移的单一入口。 */
import { z } from "zod";
import type { AppSettings } from "./protocol.js";
import { REMOTE_ASSET_INSTALL_MODES } from "./remoteAssetInstallMode.js";
import { isKnownRemoteResourcePackageId } from "./remoteResourcePackages.js";
import {
  normalizeRetiredRemoteWorkspaceEntry,
  projectRetiredRemoteWorkspaceEntry,
  retiredRemoteWorkspaceEntrySchema,
  type RetiredRemoteWorkspaceEntry,
} from "./retiredRemoteWorkspace.js";
import { normalizeZCodeEndpointOrigin } from "./zcodeEndpoint.js";
import {
  DEFAULT_EMBEDDED_BROWSER_VIEWPORT_PREFERENCE,
  embeddedBrowserViewportPreferenceSchema,
} from "./browser-use/command-metadata.js";
import { providerFamilyConnectionSelectionSettingsSchema } from "./provider-family-connection-selection.js";

/** 引导职业枚举；单独导出供 onboarding 记录回填 settings 时做窄化校验。 */
const appSettingsOccupationSchema = z.enum([
  "office",
  "developer",
  "independent",
  "infrastructure",
  "product",
  "design",
  "student",
  "creator",
  "operations",
  "marketing",
  "finance",
  "accounting",
  "legal",
  "other",
]);
export const appSettingsOccupationEnum = appSettingsOccupationSchema;

const nonEmptyStringSchema = z.string().trim().min(1);

export const localeSchema = z.enum(["zh-CN", "en-US"]);
const localePreferenceSchema = z.enum(["system", "zh-CN", "en-US"]);
const zcodeInteractionBehaviorSchema = z.enum(["queue", "guide"]);
const electronReleaseChannelSchema = z.enum(["stable", "preview"]);
const desktopZoomLevelSchema = z.number().int().min(-3).max(5);
const desktopWindowSizeSchema = z.object({
  width: z.number().int().min(480),
  height: z.number().int().min(640),
  maximized: z.boolean(),
});
export const integratedTerminalShellSelectionSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("auto"),
  }),
  z.object({
    mode: z.literal("shell"),
    dialect: z.enum(["cmd", "git-bash"]),
    id: nonEmptyStringSchema,
    label: nonEmptyStringSchema,
    path: nonEmptyStringSchema,
  }),
]);
const providerFamilyDomainSchema = z.enum(["zai", "bigmodel"]);

export const postUpdateReleaseNotesPayloadSchema = z.object({
  version: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  markdown: nonEmptyStringSchema,
  releaseDate: nonEmptyStringSchema.optional(),
  releaseNotesByLocale: z
    .partialRecord(
      localeSchema,
      z.object({ title: nonEmptyStringSchema, markdown: nonEmptyStringSchema }),
    )
    .optional(),
});

const skippedElectronUpdateVersionsSchema = z
  .partialRecord(electronReleaseChannelSchema, nonEmptyStringSchema)
  .default({});

const remoteWorkspaceTargetSchema = z.object({
  kind: z.literal("ssh"),
  host: nonEmptyStringSchema,
  port: z.number().int().positive().max(65535).optional(),
  username: nonEmptyStringSchema,
  sshConfigAlias: nonEmptyStringSchema.optional(),
  privateKeyPath: z.string().optional(),
  assetInstallMode: z.enum(REMOTE_ASSET_INSTALL_MODES).optional(),
  resourcePackages: z
    .object({
      selectedPackageIds: z.array(z.string().refine(isKnownRemoteResourcePackageId)).optional(),
    })
    .optional(),
  passwordCredentialKey: nonEmptyStringSchema.optional(),
  privateKeyPassphraseCredentialKey: nonEmptyStringSchema.optional(),
});

const appWorkspaceSessionEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local"),
    workspacePath: nonEmptyStringSchema,
    workspacePurpose: z.enum(["project", "conversation"]).default("project"),
  }),
  z.object({
    kind: z.literal("remote"),
    workspacePath: nonEmptyStringSchema,
    localWorkspacePath: nonEmptyStringSchema.optional(),
    workspaceIdentity: nonEmptyStringSchema.optional(),
    target: remoteWorkspaceTargetSchema,
    lastOpenedAt: z.number().int().nonnegative(),
    lastConnectionStatus: z.enum(["connected", "failed"]),
    lastConnectionError: z.string().optional(),
  }),
  // 退役远端目标的只读失效投影（specs/cloud-agent/06 §3.2）；不含可执行 target/凭据。
  retiredRemoteWorkspaceEntrySchema,
]);

const zcodeEndpointOriginSchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return normalizeZCodeEndpointOrigin(trimmed);
  } catch {
    return undefined;
  }
}, z.string().optional());

function sanitizeZCodeEndpointOrigin(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const raw = value as Record<string, unknown>;
  if (!("zcodeEndpointOrigin" in raw)) {
    return value;
  }
  const parsed = zcodeEndpointOriginSchema.safeParse(raw.zcodeEndpointOrigin);
  if (parsed.success && typeof parsed.data === "string") {
    return { ...raw, zcodeEndpointOrigin: parsed.data };
  }
  const { zcodeEndpointOrigin: _zcodeEndpointOrigin, ...next } = raw;
  // 非生产 endpoint override 是开发辅助字段，坏值只丢弃该字段，不能拖垮整个 settings 读取。
  return next;
}

function sanitizeDesktopWindowSize(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const raw = value as Record<string, unknown>;
  if (!("desktopWindowSize" in raw)) {
    return value;
  }
  const parsed = desktopWindowSizeSchema.safeParse(raw.desktopWindowSize);
  if (parsed.success) {
    return value;
  }
  const { desktopWindowSize: _desktopWindowSize, ...next } = raw;
  // 窗口尺寸是非关键偏好，坏值若参与整份 schema 校验，会让其他合法设置全部回退默认。
  // 读取历史设置时只丢弃损坏字段；写入 patch 仍保持严格校验，避免继续产生坏数据。
  return next;
}

function sanitizeEmbeddedBrowserViewportPreference(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const raw = value as Record<string, unknown>;
  if (!("embeddedBrowserViewportPreference" in raw)) {
    return value;
  }
  const parsed = embeddedBrowserViewportPreferenceSchema.safeParse(
    raw.embeddedBrowserViewportPreference,
  );
  if (parsed.success) {
    return value;
  }
  const { embeddedBrowserViewportPreference: _embeddedBrowserViewportPreference, ...next } = raw;
  // 显示偏好不是关键启动状态，单字段损坏不应让整份 setting.json 被隔离。
  // 读取时只丢弃坏偏好并回到默认值；patch 写入仍严格拒绝非法尺寸与缩放。
  return next;
}

function migrateCloseToTrayOnWindowsDefault(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const raw = value as Record<string, unknown>;
  if (raw.closeToTrayOnWindowsMigrationInitialized === true) {
    return value;
  }
  return {
    ...raw,
    // 初始化原因：旧版会把默认 false 和用户手动关闭都保存成同一个值，无法可靠区分。
    // 本版本统一开启一次；写入迁移标记后，后续再按用户明确选择保留 true/false。
    closeToTrayOnWindows: true,
    closeToTrayOnWindowsMigrationInitialized: true,
  };
}

function migrateMessageStreamShowReasoningDefault(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const raw = value as Record<string, unknown>;
  if (raw.messageStreamShowReasoningMigrationInitialized === true) {
    return value;
  }
  return {
    ...raw,
    // 初始化原因：旧版会把默认 false 和用户手动关闭都保存成同一个值，无法可靠区分。
    // 本版本统一开启一次；写入迁移标记后，后续再按用户明确选择保留 true/false。
    messageStreamShowReasoning: true,
    messageStreamShowReasoningMigrationInitialized: true,
  };
}

function migrateLegacyLocalePreference(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const raw = value as Record<string, unknown>;
  if ("localePreference" in raw || !("locale" in raw)) {
    return value;
  }

  const parsedLocale = localeSchema.safeParse(raw.locale);
  if (!parsedLocale.success) {
    return value;
  }

  return {
    ...raw,
    // 旧 setting.json 只有 locale，无法区分“用户显式选择 zh-CN”和“默认值 zh-CN”。
    // 对已经落盘的旧配置保留原 locale 作为显式偏好，避免升级后误切到 system。
    localePreference: parsedLocale.data,
  };
}

const legacyRemoteWorkspaceHistoryEntrySchema = z.object({
  id: nonEmptyStringSchema,
  workspacePath: nonEmptyStringSchema,
  localWorkspacePath: nonEmptyStringSchema.optional(),
  workspaceIdentity: nonEmptyStringSchema.optional(),
  // 只覆盖 SSH；更老历史里的 wsl/docker 项由 projectRetiredRemoteWorkspaceEntry 单独投影。
  target: remoteWorkspaceTargetSchema,
  lastOpenedAt: z.number().int().nonnegative(),
  lastConnectionStatus: z.enum(["connected", "failed"]),
  lastConnectionError: z.string().optional(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 受限 legacy reader：把旧记录读成退役只读失效记录。
 * 只读取展示/归属字段；已经是只读投影的条目按严格 schema 复核，非法条目返回 null。
 */
function resolveRetiredRemoteWorkspaceEntry(value: unknown): RetiredRemoteWorkspaceEntry | null {
  if (isRecord(value) && value.kind === "retired-remote") {
    return normalizeRetiredRemoteWorkspaceEntry(value);
  }
  return projectRetiredRemoteWorkspaceEntry(value);
}

function buildRetiredRemoteWorkspaceEntryKey(entry: RetiredRemoteWorkspaceEntry): string {
  return entry.workspaceIdentity?.trim() || entry.workspacePath;
}

function stripHistoricalRemoteResourcePackages(target: unknown): unknown {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    return target;
  }

  const rawTarget = target as Record<string, unknown>;
  if (rawTarget.kind !== "ssh" || !("resourcePackages" in rawTarget)) {
    return target;
  }

  const { resourcePackages: _resourcePackages, ...nextTarget } = rawTarget;
  // SSH 部署固定使用完整 active 资源集；旧 setting.json 里的 resourcePackages 是历史裁剪，
  // 在配置入口清掉，避免后续重连或 tab 恢复继续读取。
  return nextTarget;
}

/**
 * 逐条校验迁移后的会话项：单条历史记录格式非法时只丢弃该条，
 * 绝不让一条坏记录把整份 setting.json 拖回默认值（specs/cloud-agent/06 §3.3）。
 */
function keepValidWorkspaceSessionEntry(value: unknown): Record<string, unknown>[] {
  const parsed = appWorkspaceSessionEntrySchema.safeParse(value);
  return parsed.success ? [parsed.data as Record<string, unknown>] : [];
}

function migrateLegacyWorkspaceSession(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const raw = value as {
    lastOpenTabs?: unknown;
    lastWorkspaceSession?: unknown;
    remoteWorkspaceHistory?: unknown;
  };
  const migrated = { ...raw } as Record<string, unknown>;
  const lastWorkspaceSession = Array.isArray(raw.lastWorkspaceSession)
    ? raw.lastWorkspaceSession
    : [];

  const hasLegacyRemoteEntries = lastWorkspaceSession.some((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }
    return "historyId" in (entry as Record<string, unknown>);
  });

  const legacyRemoteHistory = Array.isArray(raw.remoteWorkspaceHistory)
    ? raw.remoteWorkspaceHistory
    : [];
  const legacyRemoteHistoryById = new Map(
    legacyRemoteHistory.flatMap((entry) => {
      if (!isRecord(entry)) {
        return [];
      }
      const sanitizedEntry = {
        ...entry,
        // 更老的 remoteWorkspaceHistory 可能保存了已退役资源包 ID。
        // 先剥离历史选择再走 schema，避免迁移阶段误删整条远程历史。
        target: stripHistoricalRemoteResourcePackages(entry.target),
      };
      const parsed = legacyRemoteWorkspaceHistoryEntrySchema.safeParse(sanitizedEntry);
      return parsed.success ? [[parsed.data.id, parsed.data] as const] : [];
    }),
  );
  const legacyRetiredHistoryById = new Map(
    legacyRemoteHistory.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) {
        return [];
      }
      const retired = resolveRetiredRemoteWorkspaceEntry(entry);
      return retired ? [[entry.id, retired] as const] : [];
    }),
  );
  const consumedLegacyHistoryIds = new Set<string>();

  // 退役目标是只读失效记录：原 kind/label/workspaceIdentity/workspacePath/最近打开时间与
  // 显示用 authority 保留，禁止重新进入活跃 target/连接路径（specs/cloud-agent/06 §3.2）。
  const retiredEntries: RetiredRemoteWorkspaceEntry[] = [];
  const seenRetiredWorkspaceKeys = new Set<string>();
  const pushRetiredEntry = (entry: RetiredRemoteWorkspaceEntry | null): void => {
    if (!entry) {
      return;
    }
    const key = buildRetiredRemoteWorkspaceEntryKey(entry);
    if (seenRetiredWorkspaceKeys.has(key)) {
      return;
    }
    seenRetiredWorkspaceKeys.add(key);
    retiredEntries.push(entry);
  };

  const migratedWorkspaceSessionEntries: Record<string, unknown>[] =
    lastWorkspaceSession.length > 0
      ? lastWorkspaceSession.flatMap((entry): Record<string, unknown>[] => {
          if (!isRecord(entry)) {
            return [];
          }

          const rawEntry = entry;

          // 已投影过的只读记录：严格复核后保留，不做任何连接相关投影。
          if (rawEntry.kind === "retired-remote") {
            pushRetiredEntry(resolveRetiredRemoteWorkspaceEntry(rawEntry));
            return [];
          }

          if (rawEntry.kind === "local" && typeof rawEntry.workspacePath === "string") {
            return keepValidWorkspaceSessionEntry({
              kind: "local",
              workspacePath: rawEntry.workspacePath,
              workspacePurpose:
                rawEntry.workspacePurpose === "conversation" ? "conversation" : "project",
            });
          }

          if (rawEntry.kind === "remote") {
            // WSL/Docker 旧记录先投影成退役只读记录：只保留展示/归属字段，
            // target、连接状态和凭据都不进入活跃条目。
            const retiredEntry = resolveRetiredRemoteWorkspaceEntry(rawEntry);
            if (retiredEntry) {
              pushRetiredEntry(retiredEntry);
              return [];
            }

            if (typeof rawEntry.workspacePath === "string" && rawEntry.target) {
              return keepValidWorkspaceSessionEntry({
                ...rawEntry,
                target: stripHistoricalRemoteResourcePackages(rawEntry.target),
              });
            }

            if (typeof rawEntry.historyId === "string") {
              consumedLegacyHistoryIds.add(rawEntry.historyId);
              const legacyRetiredEntry = legacyRetiredHistoryById.get(rawEntry.historyId);
              if (legacyRetiredEntry) {
                pushRetiredEntry(legacyRetiredEntry);
                return [];
              }

              const legacyRemoteEntry = legacyRemoteHistoryById.get(rawEntry.historyId);
              return legacyRemoteEntry
                ? keepValidWorkspaceSessionEntry({
                    kind: "remote",
                    workspacePath: legacyRemoteEntry.workspacePath,
                    ...(legacyRemoteEntry.localWorkspacePath
                      ? { localWorkspacePath: legacyRemoteEntry.localWorkspacePath }
                      : {}),
                    ...(legacyRemoteEntry.workspaceIdentity
                      ? { workspaceIdentity: legacyRemoteEntry.workspaceIdentity }
                      : {}),
                    target: stripHistoricalRemoteResourcePackages(legacyRemoteEntry.target),
                    lastOpenedAt: legacyRemoteEntry.lastOpenedAt,
                    lastConnectionStatus: legacyRemoteEntry.lastConnectionStatus,
                    ...(legacyRemoteEntry.lastConnectionError
                      ? { lastConnectionError: legacyRemoteEntry.lastConnectionError }
                      : {}),
                  })
                : [];
            }
          }

          return [];
        })
      : [];

  // 更老历史格式里未被 lastWorkspaceSession 引用的退役记录同样是用户历史：
  // 它们不能再连接，但保留为只读失效投影，避免迁移时静默删除用户数据。
  for (const [historyId, retiredEntry] of legacyRetiredHistoryById) {
    if (consumedLegacyHistoryIds.has(historyId)) {
      continue;
    }
    pushRetiredEntry(retiredEntry);
  }

  const migratedLegacyLocalEntries = Array.isArray(raw.lastOpenTabs)
    ? raw.lastOpenTabs.flatMap((workspacePath) =>
        typeof workspacePath === "string"
          ? keepValidWorkspaceSessionEntry({
              kind: "local",
              workspacePath,
              workspacePurpose: "project",
            })
          : [],
      )
    : [];
  const existingLocalWorkspacePaths = new Set(
    migratedWorkspaceSessionEntries.flatMap((entry) =>
      entry.kind === "local" && typeof entry.workspacePath === "string"
        ? [entry.workspacePath]
        : [],
    ),
  );
  const nextWorkspaceSession = [
    ...migratedWorkspaceSessionEntries,
    // 退役只读投影稳定排在末尾，重复读取/写回不会改变顺序（幂等）。
    ...retiredEntries,
    ...migratedLegacyLocalEntries.filter(
      (entry) => !existingLocalWorkspacePaths.has(String(entry.workspacePath)),
    ),
  ];

  // 旧 setting.json 把本地会话、远端历史、组合会话拆在三处存，
  // 一旦只删掉其中一处，启动恢复就会出现“列表还在但恢复不到”或“远端数据残留”的分叉状态。
  // 这里在 schema 解析阶段统一合并进 lastWorkspaceSession，并主动移除旧字段，
  // 保证后续所有读写都只围绕单一真相源展开。
  if (
    nextWorkspaceSession.length > 0 ||
    hasLegacyRemoteEntries ||
    Array.isArray(raw.lastOpenTabs)
  ) {
    migrated.lastWorkspaceSession = nextWorkspaceSession;
  }
  delete migrated.lastOpenTabs;
  delete migrated.remoteWorkspaceHistory;
  return migrated;
}

const appSettingsObjectSchema = z.object({
  recentProjects: z.array(z.string()).default([]),
  locale: localeSchema.default("zh-CN"),
  // 快捷键用户覆盖（语义校验在 ui/src/shortcuts 生效表阶段容错，schema 只管形状）
  shortcutBindings: z.record(z.string(), z.array(z.string())).optional(),
  localePreference: localePreferenceSchema.default("system"),
  terminalInheritSystemProfile: z.boolean().default(true),
  terminalFontFamily: nonEmptyStringSchema.optional(),
  integratedTerminalShell: integratedTerminalShellSelectionSchema.optional(),
  httpProxy: nonEmptyStringSchema.optional(),
  httpProxyNoProxy: nonEmptyStringSchema.optional(),
  httpProxyCaCertPath: nonEmptyStringSchema.optional(),
  embeddedBrowserAllowInsecureCertificates: z.boolean().default(false),
  embeddedBrowserViewportPreference: embeddedBrowserViewportPreferenceSchema.default(
    DEFAULT_EMBEDDED_BROWSER_VIEWPORT_PREFERENCE,
  ),
  // 输入框电脑操作入口改为默认不展示，设置项保留、默认关闭。
  // default 只对缺省字段生效，显式存过 false 的用户仍保持展示。
  computerUseComposerEntryHidden: z.boolean().default(true),
  taskAutoArchiveEnabled: z.boolean().default(false),
  taskAutoArchiveOlderThanDays: z.number().int().positive().max(365).default(7),
  closeToTrayOnWindows: z.boolean().default(true),
  closeToTrayOnWindowsMigrationInitialized: z.boolean().default(true),
  keepAwakeWhileRunning: z.boolean().default(false),
  desktopZoomLevel: desktopZoomLevelSchema.optional(),
  desktopWindowSize: desktopWindowSizeSchema.optional(),
  desktopChromiumHardwareAccelerationEnabled: z.boolean().default(true),
  messageStreamShowReasoning: z.boolean().default(true),
  messageStreamShowReasoningMigrationInitialized: z.boolean().default(true),
  messageStreamShowTodos: z.boolean().default(false),
  toolGroupingExploreEnabled: z.boolean().default(true),
  toolGroupingTerminalEnabled: z.boolean().default(true),
  toolGroupingChangesEnabled: z.boolean().default(false),
  zcodeInteractionBehavior: zcodeInteractionBehaviorSchema.default("queue"),
  askUserQuestionAutoResolutionEnabled: z.boolean().default(true),
  modelIoFullRetentionEnabled: z.boolean().default(false),
  startPlanRecommendationDismissed: z.boolean().default(false),
  providerFamilyConnectionSelections: providerFamilyConnectionSelectionSettingsSchema.default({}),
  providerFamilyDomain: providerFamilyDomainSchema.optional(),
  providerFamilyDomainUpdatedAt: z.number().int().nonnegative().optional(),
  providerFamilyDomainMigrated: z.boolean().default(false),
  nativeSearchEnhancementsEnabled: z.boolean().default(true),
  onboardingOccupation: appSettingsOccupationSchema.nullish(),
  proactiveSuggestionsEnabled: z.boolean().optional(),
  memoryEnabled: z.boolean().default(false),
  lastWorkspaceSession: z.array(appWorkspaceSessionEntrySchema).default([]),
  lastActiveTabIndex: z.number().int().nonnegative().default(0),
  lastActiveTaskByWorkspace: z.record(z.string(), z.string()).optional(),
  dataBaseDir: z.string().trim().min(1).optional(),
  pendingPostUpdateReleaseNotes: postUpdateReleaseNotesPayloadSchema.optional(),
  receivePreviewUpdates: z.boolean().default(false),
  autoDownloadAndInstallUpdates: z.boolean().default(false),
  skippedElectronUpdateVersions: skippedElectronUpdateVersionsSchema,
  settingsSyncFirstRunPromptHandled: z.boolean().optional(),
  zcodeEndpointOrigin: zcodeEndpointOriginSchema.optional(),
});

export const appSettingsSchema = z.preprocess(
  (value) =>
    sanitizeEmbeddedBrowserViewportPreference(
      sanitizeDesktopWindowSize(
        migrateMessageStreamShowReasoningDefault(
          migrateCloseToTrayOnWindowsDefault(
            migrateLegacyLocalePreference(
              sanitizeZCodeEndpointOrigin(migrateLegacyWorkspaceSession(value)),
            ),
          ),
        ),
      ),
    ),
  appSettingsObjectSchema,
);

export const appSettingsPatchSchema = z.object({
  recentProjects: z.array(z.string()).optional(),
  locale: localeSchema.optional(),
  shortcutBindings: z.record(z.string(), z.array(z.string())).optional(),
  localePreference: localePreferenceSchema.optional(),
  terminalInheritSystemProfile: z.boolean().optional(),
  terminalFontFamily: nonEmptyStringSchema.optional(),
  integratedTerminalShell: integratedTerminalShellSelectionSchema.optional(),
  httpProxy: nonEmptyStringSchema.optional(),
  httpProxyNoProxy: nonEmptyStringSchema.optional(),
  httpProxyCaCertPath: nonEmptyStringSchema.optional(),
  embeddedBrowserAllowInsecureCertificates: z.boolean().optional(),
  embeddedBrowserViewportPreference: embeddedBrowserViewportPreferenceSchema.optional(),
  computerUseComposerEntryHidden: z.boolean().optional(),
  taskAutoArchiveEnabled: z.boolean().optional(),
  taskAutoArchiveOlderThanDays: z.number().int().positive().max(365).optional(),
  closeToTrayOnWindows: z.boolean().optional(),
  keepAwakeWhileRunning: z.boolean().optional(),
  closeToTrayOnWindowsMigrationInitialized: z.boolean().optional(),
  desktopZoomLevel: desktopZoomLevelSchema.optional(),
  desktopWindowSize: desktopWindowSizeSchema.optional(),
  desktopChromiumHardwareAccelerationEnabled: z.boolean().optional(),
  messageStreamShowReasoning: z.boolean().optional(),
  messageStreamShowReasoningMigrationInitialized: z.boolean().optional(),
  messageStreamShowTodos: z.boolean().optional(),
  toolGroupingExploreEnabled: z.boolean().optional(),
  toolGroupingTerminalEnabled: z.boolean().optional(),
  toolGroupingChangesEnabled: z.boolean().optional(),
  zcodeInteractionBehavior: zcodeInteractionBehaviorSchema.optional(),
  askUserQuestionAutoResolutionEnabled: z.boolean().optional(),
  modelIoFullRetentionEnabled: z.boolean().optional(),
  startPlanRecommendationDismissed: z.boolean().optional(),
  providerFamilyConnectionSelections: providerFamilyConnectionSelectionSettingsSchema.optional(),
  providerFamilyDomain: z.union([providerFamilyDomainSchema, z.literal("")]).optional(),
  providerFamilyDomainUpdatedAt: z.number().int().nonnegative().optional(),
  providerFamilyDomainMigrated: z.boolean().optional(),
  nativeSearchEnhancementsEnabled: z.boolean().optional(),
  onboardingOccupation: z
    .enum([
      "office",
      "developer",
      "independent",
      "infrastructure",
      "product",
      "design",
      "student",
      "creator",
      "operations",
      "marketing",
      "finance",
      "accounting",
      "legal",
      "other",
    ])
    .nullish(),
  proactiveSuggestionsEnabled: z.boolean().optional(),
  memoryEnabled: z.boolean().optional(),
  lastWorkspaceSession: z.array(appWorkspaceSessionEntrySchema).optional(),
  lastActiveTabIndex: z.number().int().nonnegative().optional(),
  lastActiveTaskByWorkspace: z.record(z.string(), z.string()).optional(),
  dataBaseDir: z.string().trim().min(1).optional(),
  pendingPostUpdateReleaseNotes: postUpdateReleaseNotesPayloadSchema.optional(),
  receivePreviewUpdates: z.boolean().optional(),
  autoDownloadAndInstallUpdates: z.boolean().optional(),
  skippedElectronUpdateVersions: z
    .partialRecord(electronReleaseChannelSchema, nonEmptyStringSchema)
    .optional(),
  settingsSyncFirstRunPromptHandled: z.boolean().optional(),
  zcodeEndpointOrigin: zcodeEndpointOriginSchema.optional(),
});
