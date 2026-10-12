/**
 * 用户资源 profile 用例（specs/cloud-agent/14 §9.2①/②/§9.4；W11 §10/§12/§13B；03 §6 端点矩阵）。
 *
 * 职责边界：
 * - 准入校验（便宜、fail-closed）：路径参数与请求体的严格 schema（含 markdown 类的
 *   `entryId` 必须以 `.md` 结尾，14 §4.5）、路径/正文 `category` 一致、单条超限前置
 *   （413 与 400 的区分）、归档最小前置（gzip magic）；**不做 tar 解析**——完整归档权威
 *   校验属于既有 sync 导入实现（14 §4.4/§9.2②，禁止第二套权威校验）；
 * - 聚合上限（总量/条目数）与 sha256/bytes 派生在 store 写事务内（14 §9.2①）：客户端不能
 *   自报 `sha256`/`bytes`，事务内用真实值判定；
 * - 响应永不含正文：snapshot/version 只回元数据（14 §5）；**唯一例外是 `readEntry`**
 *   （14 §9.4①，供 UI 编辑回显，按类别有界）。
 */
import {
  cloudUserProfileEntryEnabledPatchRequestSchema,
  cloudUserProfileEntryPathParamsSchema,
  cloudUserProfileEntryUploadRequestSchema,
  type CloudUserProfileEntryDeleteResponse,
  type CloudUserProfileEntryReadResponse,
  type CloudUserProfileEntryPatchResponse,
  type CloudUserProfileEntryUploadResponse,
  type CloudUserProfileSnapshot,
  type CloudUserProfileVersionResponse,
} from "@zcode/shared";
import {
  isUserProfileArchiveCategory,
  isUserProfileMarkdownCategory,
  userProfileArchiveGzipPrefixOk,
  userProfileContentKindOf,
  userProfileEntryPayloadFromContent,
  userProfileUploadOversizeReason,
} from "../../domain/userProfile.js";
import type { CloudCoreDeps } from "../deps.js";
import { fail, ok, type CloudAppFailure, type CloudAppResult } from "../result.js";

export interface UserProfileService {
  /** 当前版本快照摘要（条目元数据，无正文）。 */
  snapshot(): Promise<CloudAppResult<CloudUserProfileSnapshot>>;
  /** 当前 `profileVersion`（Run 冻结锚点/帧幂等键）。 */
  version(): Promise<CloudAppResult<CloudUserProfileVersionResponse>>;
  /** 幂等整条替换（PUT）：同 key 同内容不递增版本；超限/非法按 14 §9.2① 错误码收口。 */
  putEntry(input: {
    category: string;
    entryId: string;
    body: unknown;
  }): Promise<CloudAppResult<CloudUserProfileEntryUploadResponse>>;
  deleteEntry(input: {
    category: string;
    entryId: string;
  }): Promise<CloudAppResult<CloudUserProfileEntryDeleteResponse>>;
  /**
   * 读当前版本的单条元数据 + 正文（14 §9.4①）：UI 编辑回显（AGENTS.md / MCP 表单）的
   * 唯一通路；键不存在 → 404 `not_found`，正文不可解析 → `invalid_entry`。
   */
  readEntry(input: {
    category: string;
    entryId: string;
  }): Promise<CloudAppResult<CloudUserProfileEntryReadResponse>>;
  /**
   * 条目级开关（14 §9.4①）：body 只含 `{enabled}`；开关**值变化**才递增版本；
   * 键不存在 → 404 `not_found`。
   */
  setEntryEnabled(input: {
    category: string;
    entryId: string;
    body: unknown;
  }): Promise<CloudAppResult<CloudUserProfileEntryPatchResponse>>;
}

/** 错误定位（U-11）：拒绝原因必须能指到 category/entryId，细节有界且不含正文。 */
function reject(
  code: CloudAppFailure["code"],
  reason: string,
  category: string,
  entryId: string,
): CloudAppFailure {
  return fail(code, reason, { category, entryId });
}

export function createUserProfileService(deps: CloudCoreDeps): UserProfileService {
  const { clock, userProfile } = deps;

  function storeMissing(): CloudAppFailure {
    // 未接线 profile store（测试/嵌入装配）：503，不伪装空 profile（03 §6 分阶段语义）。
    return fail("not_configured", "user-profile-store-missing");
  }

  return {
    async snapshot() {
      if (!userProfile) return storeMissing();
      return ok(await userProfile.snapshot());
    },

    async version() {
      if (!userProfile) return storeMissing();
      const snapshot = await userProfile.snapshot();
      return ok({ profileVersion: snapshot.profileVersion });
    },

    async putEntry(input) {
      if (!userProfile) return storeMissing();
      const params = cloudUserProfileEntryPathParamsSchema.safeParse({
        category: input.category,
        entryId: input.entryId,
      });
      if (!params.success) {
        return reject("invalid_entry", "invalid-entry-path", input.category, input.entryId);
      }
      const { category, entryId } = params.data;

      // 单条超限前置：明显超限直接 413（不截断、不落盘），形状错误才归 400。
      const oversize = userProfileUploadOversizeReason(category, input.body);
      if (oversize) return reject("payload_too_large", oversize, category, entryId);

      const body = cloudUserProfileEntryUploadRequestSchema.safeParse(input.body);
      if (!body.success) {
        return reject("invalid_entry", "invalid-entry-payload", category, entryId);
      }
      if (body.data.category !== category) {
        // 路径是路由事实、正文是自描述事实：不一致显式拒绝，不隐式取其一（14 §9.2⑦）。
        return reject("invalid_entry", "path-body-category-mismatch", category, entryId);
      }

      // 正文形态 → 存储文本（store 从它派生 sha256/bytes，客户端不传，14 §9.2①）。
      let content: string;
      if (isUserProfileArchiveCategory(category)) {
        const archive = body.data as { archiveBase64: string };
        if (!userProfileArchiveGzipPrefixOk(archive.archiveBase64)) {
          // 上传侧最小前置（14 §9.2②）：只验 gzip magic；tar/manifest 权威校验在既有导入链路。
          return reject("invalid_entry", "archive-not-gzip", category, entryId);
        }
        content = archive.archiveBase64;
      } else if (category === "agents-md" || isUserProfileMarkdownCategory(category)) {
        // 文本类条目（agents-md 单例与 commands/subagents 单文件 markdown，14 §4.5）：
        // 正文原样入库；entryId/正文形状已由 shared 严格 schema 判定（含 `.md` 后缀）。
        content = (body.data as { content: string }).content;
      } else {
        content = JSON.stringify((body.data as { config: unknown }).config);
      }

      const result = await userProfile.upsertEntry({
        category,
        entryId,
        ...(body.data.displayName === undefined ? {} : { displayName: body.data.displayName }),
        enabled: body.data.enabled,
        contentKind: userProfileContentKindOf(category),
        content,
        now: clock.now(),
      });
      if (result.status === "rejected") {
        return reject(result.code, result.reason, category, entryId);
      }
      return ok({ entry: result.entry, profileVersion: result.profileVersion });
    },

    async deleteEntry(input) {
      if (!userProfile) return storeMissing();
      const params = cloudUserProfileEntryPathParamsSchema.safeParse({
        category: input.category,
        entryId: input.entryId,
      });
      if (!params.success) {
        return reject("invalid_entry", "invalid-entry-path", input.category, input.entryId);
      }
      const result = await userProfile.deleteEntry({
        category: params.data.category,
        entryId: params.data.entryId,
        now: clock.now(),
      });
      if (result.status === "rejected") {
        return reject(result.code, result.reason, params.data.category, params.data.entryId);
      }
      return ok({ profileVersion: result.profileVersion });
    },

    async readEntry(input) {
      if (!userProfile) return storeMissing();
      const params = cloudUserProfileEntryPathParamsSchema.safeParse({
        category: input.category,
        entryId: input.entryId,
      });
      if (!params.success) {
        return reject("invalid_entry", "invalid-entry-path", input.category, input.entryId);
      }
      const { category, entryId } = params.data;
      const record = await userProfile.readEntry({ category, entryId });
      if (!record) {
        // 键不在当前版本：404 not_found（不泄漏"曾经存在过"这种版本历史细节）。
        return reject("not_found", "profile-entry-not-found", category, entryId);
      }
      const payload = userProfileEntryPayloadFromContent(
        record.contentKind,
        record.category,
        record.content,
      );
      if (!payload) {
        // 持久正文与类别不符/不可解析（写事务保证不该发生）：fail-closed，不回半份。
        return reject("invalid_entry", "profile-entry-unreadable", category, entryId);
      }
      return ok({
        entry: {
          category: record.category,
          entryId: record.entryId,
          ...(record.displayName === undefined ? {} : { displayName: record.displayName }),
          enabled: record.enabled,
          sha256: record.sha256,
          bytes: record.bytes,
        },
        payload,
      });
    },

    async setEntryEnabled(input) {
      if (!userProfile) return storeMissing();
      const params = cloudUserProfileEntryPathParamsSchema.safeParse({
        category: input.category,
        entryId: input.entryId,
      });
      if (!params.success) {
        return reject("invalid_entry", "invalid-entry-path", input.category, input.entryId);
      }
      const { category, entryId } = params.data;
      const body = cloudUserProfileEntryEnabledPatchRequestSchema.safeParse(input.body);
      if (!body.success) {
        // toggle 意图必须显式：把"漏传 enabled"当成 false 会静默改变交付集合（14 §9.4①）；
        // 形状唯一来源是 shared schema（strict，未知字段一并拒绝）。
        return reject("invalid_entry", "invalid-enabled-body", category, entryId);
      }
      const result = await userProfile.setEntryEnabled({
        category,
        entryId,
        enabled: body.data.enabled,
        now: clock.now(),
      });
      if (result.status === "not_found") {
        return reject("not_found", "profile-entry-not-found", category, entryId);
      }
      if (result.status === "rejected") {
        return reject(result.code, result.reason, category, entryId);
      }
      return ok({ entry: result.entry, profileVersion: result.profileVersion });
    },
  };
}
