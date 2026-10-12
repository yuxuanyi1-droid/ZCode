/**
 * `useCloudUserResources` —— 云用户资源 profile 的读写入口（specs/cloud-agent/14 §4.5/§9.4、
 * W11 §12/§13D、W8 §4：组件只经 hooks 访问服务，不直连 SDK）。
 *
 * 服务来源：`CloudWorkspaceProvider` 注入的控制面端口（非云模式为 null → 不取数、不伪造空列表）。
 * 权威在控制面：每个写操作都用**服务端响应**回填（`{entry, profileVersion}`），本地只保留
 * 未提交的 optimistic overlay（store `cloudUserResourcesStore`）。
 *
 * 录入面（14 §4.3/§4.5 简化修订）：归档上传只有 skills/plugins；commands/subagents 是
 * **单文件 markdown 文本**（`saveMarkdownEntry`，entryId = 文件名 `*.md`）；mcp 走 JSON 表单、
 * agents-md 走单例文本编辑器——每个类别只有一条录入路径（`userResourceInputKindOf`）。
 *
 * store 访问规则：状态用细粒度 selector 订阅、动作一律经 `getState()` 取（动作引用在
 * zustand 里稳定，且不把整个 state 放进 useCallback 依赖——否则每次写回填都会重建
 * `load`，再触发自动加载形成回环）。
 *
 * 错误处理：动作不抛异常，返回结构化结果 `{ok:false, error}`——
 * - `kind: "validation"`：客户端前置校验失败（entryId 形状 / 归档上限 / markdown 正文上限 /
 *   JSON 形状），带 `failure` 供 UI 出具体文案；
 * - `kind: "server"`：控制面拒绝或结果未知，带 shared 错误码（`CloudUserResourcesError`）。
 * 文案映射见 `userResourcesErrorKey`（UI 不解析服务端 message，04 §6）。
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import type {
  CloudUserProfileArchiveCategory,
  CloudUserProfileCategory,
  CloudUserProfileEntry,
  CloudUserProfileEntryPayload,
  CloudUserProfileMarkdownCategory,
} from "@zcode/shared";
import { CLOUD_USER_PROFILE_AGENTS_MD_MAX_BYTES } from "@zcode/shared";
import { readCloudErrorCode, readCloudErrorReason } from "@/cloud/cloudApiErrorLike.js";
import type { CloudControlPlanePort } from "@/cloud/cloudPorts.js";
import { useCloudWorkspaceContext } from "@/cloud/cloudWorkspaceContext.js";
import {
  CLOUD_USER_RESOURCES_AGENTS_MD_ENTRY_ID,
  buildUserResourceArchiveUploadBody,
  buildUserResourceMarkdownUploadBody,
  encodeUserResourceArchiveBase64,
  findUserResourceEntry,
  parseUserResourceMcpConfigJson,
  userResourceEntryKey,
  validateUserResourceArchiveFile,
  validateUserResourceEntryId,
  validateUserResourceMarkdownEntry,
  type CloudUserResourcesError,
  type UserResourceMcpJsonFailure,
  type UserResourceValidationFailure,
} from "@/cloud/userResourcesModel.js";
import {
  selectVisibleUserResourceEntries,
  useCloudUserResourcesStore,
  type CloudUserResourcePendingAction,
} from "@/store/cloud/cloudUserResourcesStore.js";

export type UserResourceActionError =
  | {
      readonly kind: "validation";
      readonly failure: UserResourceValidationFailure | UserResourceMcpJsonFailure;
    }
  | { readonly kind: "server"; readonly error: CloudUserResourcesError };

export type UserResourceActionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: UserResourceActionError };

export interface UseCloudUserResourcesOptions {
  /** 显式端口；缺省读 `CloudWorkspaceProvider` 注入的那一个。 */
  readonly controlPlane?: CloudControlPlanePort | null;
  /** 挂载时自动加载快照（默认 true；只为断言取数行为的用例可关掉）。 */
  readonly autoLoad?: boolean;
}

export interface UseCloudUserResourcesResult {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly error: CloudUserResourcesError | null;
  readonly profileVersion: number | null;
  readonly totalBytes: number;
  /** 展示用条目（快照投影 + 未提交的 optimistic overlay）。 */
  readonly entries: readonly CloudUserProfileEntry[];
  readonly pendingByKey: Readonly<Record<string, CloudUserResourcePendingAction>>;
  readonly errorByKey: Readonly<Record<string, CloudUserResourcesError>>;
  readonly contentByKey: Readonly<Record<string, { payload: CloudUserProfileEntryPayload }>>;
  readonly contentStatusByKey: Readonly<Record<string, "loading" | "ready" | "error">>;
  load(): Promise<void>;
  uploadArchive(input: {
    category: CloudUserProfileArchiveCategory;
    entryId: string;
    displayName?: string | undefined;
    file: Blob;
  }): Promise<UserResourceActionResult<CloudUserProfileEntry>>;
  /**
   * markdown 单文件条目保存（commands/subagents；14 §4.5）：`entryId` 必须是 `*.md`
   * 文件名，正文为 UTF-8 文本 ≤256KiB；同 key 重复提交 = 幂等整条替换（覆盖语义）。
   */
  saveMarkdownEntry(input: {
    category: CloudUserProfileMarkdownCategory;
    entryId: string;
    content: string;
    displayName?: string | undefined;
  }): Promise<UserResourceActionResult<CloudUserProfileEntry>>;
  saveMcpEntry(input: {
    entryId: string;
    configJson: string;
    displayName?: string | undefined;
  }): Promise<UserResourceActionResult<CloudUserProfileEntry>>;
  saveAgentsMd(content: string): Promise<UserResourceActionResult<CloudUserProfileEntry>>;
  remove(
    category: CloudUserProfileCategory,
    entryId: string,
  ): Promise<UserResourceActionResult<null>>;
  setEnabled(
    category: CloudUserProfileCategory,
    entryId: string,
    enabled: boolean,
  ): Promise<UserResourceActionResult<CloudUserProfileEntry>>;
  loadContent(
    category: CloudUserProfileCategory,
    entryId: string,
    options?: { readonly force?: boolean },
  ): Promise<UserResourceActionResult<CloudUserProfileEntryPayload>>;
}

/** 任意抛出物 → 结构化错误（识别 SDK 的 code/reason，未知结果不猜语义）。 */
function toStructuredError(error: unknown, entryKey: string | null): CloudUserResourcesError {
  const code = readCloudErrorCode(error);
  const reason = readCloudErrorReason(error);
  return {
    code,
    reason,
    message: error instanceof Error ? error.message : String(error),
    entryKey,
  };
}

/** 无控制面端口（非云模式/未接线）时的统一失败：不伪装成功，也不发明错误码。 */
function portUnavailable(entryKey: string | null): UserResourceActionError {
  return {
    kind: "server",
    error: {
      code: null,
      reason: "cloud-control-plane-unavailable",
      message: "cloud control plane unavailable",
      entryKey,
    },
  };
}

export function useCloudUserResources(
  options?: UseCloudUserResourcesOptions,
): UseCloudUserResourcesResult {
  const context = useCloudWorkspaceContext();
  const explicitPort = options?.controlPlane;
  const port = explicitPort ?? context?.controlPlane ?? null;
  const principalId = context?.selection.principalId ?? null;
  const autoLoad = options?.autoLoad !== false;

  const status = useCloudUserResourcesStore((state) => state.status);
  const error = useCloudUserResourcesStore((state) => state.error);
  const profileVersion = useCloudUserResourcesStore((state) => state.profileVersion);
  const totalBytes = useCloudUserResourcesStore((state) => state.totalBytes);
  const snapshotEntries = useCloudUserResourcesStore((state) => state.entries);
  const enabledOverlay = useCloudUserResourcesStore((state) => state.enabledOverlay);
  const removedOverlay = useCloudUserResourcesStore((state) => state.removedOverlay);
  const pendingByKey = useCloudUserResourcesStore((state) => state.pendingByKey);
  const errorByKey = useCloudUserResourcesStore((state) => state.errorByKey);
  const contentByKey = useCloudUserResourcesStore((state) => state.contentByKey);
  const contentStatusByKey = useCloudUserResourcesStore((state) => state.contentStatusByKey);
  const requestIdRef = useRef(0);

  // 主体围栏：账号切换即清空投影（不跨主体复用缓存）。显式端口（测试/嵌入）下由调用方负责。
  useEffect(() => {
    if (explicitPort !== undefined) return;
    useCloudUserResourcesStore.getState().setPrincipal(principalId);
  }, [explicitPort, principalId]);

  const load = useCallback(async () => {
    if (!port) return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const actions = useCloudUserResourcesStore.getState();
    actions.beginLoad();
    try {
      const snapshot = await port.listUserProfile();
      if (requestIdRef.current !== requestId) return;
      actions.applySnapshot(snapshot);
    } catch (loadError) {
      if (requestIdRef.current !== requestId) return;
      actions.failLoad(toStructuredError(loadError, null));
    }
  }, [port]);

  useEffect(() => {
    if (!autoLoad || !port) return;
    void load();
  }, [autoLoad, load, port]);

  const entries = useMemo(
    () =>
      selectVisibleUserResourceEntries({
        entries: snapshotEntries,
        enabledOverlay,
        removedOverlay,
      }),
    [snapshotEntries, enabledOverlay, removedOverlay],
  );

  const uploadArchive = useCallback<UseCloudUserResourcesResult["uploadArchive"]>(
    async (input) => {
      const id = validateUserResourceEntryId(input.entryId);
      if (!id.ok) return { ok: false, error: { kind: "validation", failure: id.failure } };
      const size = validateUserResourceArchiveFile({
        category: input.category,
        bytes: input.file.size,
      });
      if (!size.ok) return { ok: false, error: { kind: "validation", failure: size.failure } };
      const key = userResourceEntryKey(input.category, input.entryId);
      if (!port) return { ok: false, error: portUnavailable(key) };
      const actions = useCloudUserResourcesStore.getState();
      actions.beginWrite(key, "upload");
      try {
        // 保留现有开关：PUT 省略 enabled 时服务端按 true 归一，会静默打开已关闭的条目。
        const existing = findUserResourceEntry(actions.entries, input.category, input.entryId);
        const body = buildUserResourceArchiveUploadBody({
          category: input.category,
          archiveBase64: await encodeUserResourceArchiveBase64(input.file),
          displayName: input.displayName,
          enabled: existing?.enabled ?? true,
        });
        const response = await port.putUserProfileEntry(input.category, id.value, body);
        actions.applyEntryResult(response.entry, response.profileVersion);
        return { ok: true, value: response.entry };
      } catch (writeError) {
        const structured = toStructuredError(writeError, key);
        actions.failWrite(key, structured);
        return { ok: false, error: { kind: "server", error: structured } };
      }
    },
    [port],
  );

  const saveMarkdownEntry = useCallback<UseCloudUserResourcesResult["saveMarkdownEntry"]>(
    async (input) => {
      // 前置校验与 shared 同源（entryId 的 `.md` 形状 + 正文 UTF-8 上限，14 §4.5）。
      const validated = validateUserResourceMarkdownEntry({
        entryId: input.entryId,
        content: input.content,
      });
      if (!validated.ok)
        return { ok: false, error: { kind: "validation", failure: validated.failure } };
      const key = userResourceEntryKey(input.category, validated.value.entryId);
      if (!port) return { ok: false, error: portUnavailable(key) };
      const actions = useCloudUserResourcesStore.getState();
      actions.beginWrite(key, "markdown-text");
      try {
        // 保留现有开关：PUT 省略 enabled 时服务端按 true 归一，会静默打开已关闭的条目。
        const existing = findUserResourceEntry(
          actions.entries,
          input.category,
          validated.value.entryId,
        );
        const response = await port.putUserProfileEntry(
          input.category,
          validated.value.entryId,
          buildUserResourceMarkdownUploadBody({
            category: input.category,
            content: validated.value.content,
            displayName: input.displayName,
            enabled: existing?.enabled ?? true,
          }),
        );
        actions.applyEntryResult(response.entry, response.profileVersion);
        // 回填正文缓存：刚保存的文本就是当前版本的正文（编辑回显不必再发一次 GET）。
        actions.applyContent(key, {
          payload: { category: input.category, content: validated.value.content },
          sha256: response.entry.sha256,
        });
        return { ok: true, value: response.entry };
      } catch (writeError) {
        const structured = toStructuredError(writeError, key);
        actions.failWrite(key, structured);
        return { ok: false, error: { kind: "server", error: structured } };
      }
    },
    [port],
  );

  const saveMcpEntry = useCallback<UseCloudUserResourcesResult["saveMcpEntry"]>(
    async (input) => {
      const id = validateUserResourceEntryId(input.entryId);
      if (!id.ok) return { ok: false, error: { kind: "validation", failure: id.failure } };
      const parsed = parseUserResourceMcpConfigJson(input.configJson);
      if (!parsed.ok) return { ok: false, error: { kind: "validation", failure: parsed.failure } };
      const key = userResourceEntryKey("mcp", input.entryId);
      if (!port) return { ok: false, error: portUnavailable(key) };
      const actions = useCloudUserResourcesStore.getState();
      actions.beginWrite(key, "mcp-json");
      try {
        const existing = findUserResourceEntry(actions.entries, "mcp", input.entryId);
        const response = await port.putUserProfileEntry("mcp", id.value, {
          category: "mcp",
          config: parsed.config,
          ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
          enabled: existing?.enabled ?? true,
        });
        actions.applyEntryResult(response.entry, response.profileVersion);
        // 回填正文缓存：刚保存的 JSON 文本就是当前版本的正文（不必再发一次 GET）。
        actions.applyContent(key, {
          payload: { category: "mcp", config: parsed.config },
          sha256: response.entry.sha256,
        });
        return { ok: true, value: response.entry };
      } catch (writeError) {
        const structured = toStructuredError(writeError, key);
        actions.failWrite(key, structured);
        return { ok: false, error: { kind: "server", error: structured } };
      }
    },
    [port],
  );

  const saveAgentsMd = useCallback<UseCloudUserResourcesResult["saveAgentsMd"]>(
    async (content) => {
      const key = userResourceEntryKey("agents-md", CLOUD_USER_RESOURCES_AGENTS_MD_ENTRY_ID);
      if (content.length > CLOUD_USER_PROFILE_AGENTS_MD_MAX_BYTES) {
        // 便宜前置（字符数 ≥ 字节数）：真实 UTF-8 字节判定在 shared schema 与服务端写事务内。
        return {
          ok: false,
          error: {
            kind: "validation",
            failure: { reason: "file-too-large", maxBytes: CLOUD_USER_PROFILE_AGENTS_MD_MAX_BYTES },
          },
        };
      }
      if (!port) return { ok: false, error: portUnavailable(key) };
      const actions = useCloudUserResourcesStore.getState();
      actions.beginWrite(key, "agents-md-text");
      try {
        const existing = findUserResourceEntry(
          actions.entries,
          "agents-md",
          CLOUD_USER_RESOURCES_AGENTS_MD_ENTRY_ID,
        );
        const response = await port.putUserProfileEntry(
          "agents-md",
          CLOUD_USER_RESOURCES_AGENTS_MD_ENTRY_ID,
          { category: "agents-md", content, enabled: existing?.enabled ?? true },
        );
        actions.applyEntryResult(response.entry, response.profileVersion);
        actions.applyContent(key, {
          payload: { category: "agents-md", content },
          sha256: response.entry.sha256,
        });
        return { ok: true, value: response.entry };
      } catch (writeError) {
        const structured = toStructuredError(writeError, key);
        actions.failWrite(key, structured);
        return { ok: false, error: { kind: "server", error: structured } };
      }
    },
    [port],
  );

  const remove = useCallback<UseCloudUserResourcesResult["remove"]>(
    async (category, entryId) => {
      const key = userResourceEntryKey(category, entryId);
      if (!port) return { ok: false, error: portUnavailable(key) };
      const actions = useCloudUserResourcesStore.getState();
      // optimistic：先隐藏，失败回滚（failWrite 清 overlay 与 pending）。
      actions.markRemovedOverlay(key);
      actions.beginWrite(key, "delete");
      try {
        const response = await port.deleteUserProfileEntry(category, entryId);
        actions.applyDeleteResult(key, response.profileVersion);
        return { ok: true, value: null };
      } catch (deleteError) {
        const structured = toStructuredError(deleteError, key);
        actions.failWrite(key, structured);
        return { ok: false, error: { kind: "server", error: structured } };
      }
    },
    [port],
  );

  const setEnabled = useCallback<UseCloudUserResourcesResult["setEnabled"]>(
    async (category, entryId, enabled) => {
      const key = userResourceEntryKey(category, entryId);
      if (!port) return { ok: false, error: portUnavailable(key) };
      const actions = useCloudUserResourcesStore.getState();
      // optimistic：开关先动；响应回来以服务端条目为准（含版本推进）。
      actions.setEnabledOverlay(key, enabled);
      actions.beginWrite(key, "toggle");
      try {
        const response = await port.setUserProfileEntryEnabled(category, entryId, enabled);
        actions.applyEntryResult(response.entry, response.profileVersion);
        return { ok: true, value: response.entry };
      } catch (toggleError) {
        const structured = toStructuredError(toggleError, key);
        actions.failWrite(key, structured);
        return { ok: false, error: { kind: "server", error: structured } };
      }
    },
    [port],
  );

  const loadContent = useCallback<UseCloudUserResourcesResult["loadContent"]>(
    async (category, entryId, contentOptions) => {
      const key = userResourceEntryKey(category, entryId);
      const actions = useCloudUserResourcesStore.getState();
      const current = findUserResourceEntry(actions.entries, category, entryId);
      const cached = actions.contentByKey[key];
      // 缓存失效条件 = 版本事实（sha256）不符：编辑回显绝不能展示上一版正文。
      if (
        contentOptions?.force !== true &&
        current !== null &&
        cached !== undefined &&
        cached.sha256 === current.sha256
      ) {
        return { ok: true, value: cached.payload };
      }
      if (!port) return { ok: false, error: portUnavailable(key) };
      actions.beginContentLoad(key);
      try {
        const response = await port.getUserProfileEntry(category, entryId);
        actions.applyContent(key, { payload: response.payload, sha256: response.entry.sha256 });
        return { ok: true, value: response.payload };
      } catch (readError) {
        const structured = toStructuredError(readError, key);
        actions.failContent(key, structured);
        return { ok: false, error: { kind: "server", error: structured } };
      }
    },
    [port],
  );

  return {
    status,
    error,
    profileVersion,
    totalBytes,
    entries,
    pendingByKey,
    errorByKey,
    contentByKey,
    contentStatusByKey,
    load,
    uploadArchive,
    saveMarkdownEntry,
    saveMcpEntry,
    saveAgentsMd,
    remove,
    setEnabled,
    loadContent,
  };
}
