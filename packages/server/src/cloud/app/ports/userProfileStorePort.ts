/**
 * 用户资源 profile 持久端口（specs/cloud-agent/14 §9.2①/§9.4；W11 §10/§12）。
 *
 * 唯一所有者 = 控制面 profile store（属主：账号域，单主体部署下即部署主体）。端口只
 * 描述「快照读写 + 条目写事务」；`profileVersion` 单调递增、sha256/bytes 服务端派生、
 * 版本保留与修剪语义都写在各方法 JSDoc（W2 落到 cloud.db 两表）。
 *
 * P20 追加（14 §9.4）：`readEntry`（当前版本单条元数据 + 正文，UI 编辑回显）与
 * `setEntryEnabled`（条目级开关；开关变化递增版本，因为交付集合属于 manifest）。
 *
 * 写方法用判别结果（不是异常）表达**预期内的**上限拒绝：调用方（app 用例）把它映射成
 * 结构化错误（03 §6），与 `AcceptInputResult` 的 conflict 先例同型。
 */
import type {
  CloudUserProfileCategory,
  CloudUserProfileEntry,
  CloudUserProfileSnapshot,
} from "@zcode/shared";
import type { UserProfileEntryContentKind } from "../../domain/userProfile.js";

/** 条目记录 = 元数据（shared 形状）+ 正文存储形态与正文。 */
export interface UserProfileEntryRecord extends CloudUserProfileEntry {
  contentKind: UserProfileEntryContentKind;
  /**
   * 正文（文本）：`archive-base64` = canonical base64（skills/plugins）；`mcp-config` =
   * JSON 文本；`markdown` = 单文件正文（commands/subagents，14 §4.5）；`agents-md` = 正文。
   */
  content: string;
}

export type UserProfileWriteRejectionCode =
  | "payload_too_large"
  | "invalid_entry"
  | "profile_total_exceeded"
  | "profile_entries_exceeded";

export type UserProfileUpsertResult =
  | { status: "ok"; entry: CloudUserProfileEntry; profileVersion: number }
  | { status: "rejected"; code: UserProfileWriteRejectionCode; reason: string };

export type UserProfileDeleteResult =
  | { status: "ok"; profileVersion: number; deleted: boolean }
  | { status: "rejected"; code: UserProfileWriteRejectionCode; reason: string };

/**
 * 条目级开关结果（14 §9.4①，PATCH 端点）。
 *
 * 与 DELETE 的差别：DELETE 对"键不存在"是幂等无操作，PATCH 对不存在的键**不是**无操作
 * （没有可翻的开关），因此单列 `not_found`（app 映射 404 `not_found` 风格）。
 * 请求值与当前值相同时按"重复提交同结果"处理：返回当前条目与当前版本、**不递增**。
 */
export type UserProfileSetEnabledResult =
  | { status: "ok"; entry: CloudUserProfileEntry; profileVersion: number }
  | { status: "not_found" }
  | { status: "rejected"; code: UserProfileWriteRejectionCode; reason: string };

export interface UserProfileUpsertRequest {
  category: CloudUserProfileCategory;
  entryId: string;
  displayName?: string;
  enabled: boolean;
  contentKind: UserProfileEntryContentKind;
  /** 正文文本（形态同 `UserProfileEntryRecord.content`）；sha256/bytes 由 store 派生。 */
  content: string;
  now: number;
}

export interface UserProfileStorePort {
  /**
   * 当前版本快照摘要（条目元数据 + `profileVersion` + `totalBytes` + `createdAtMs`）。
   * 迁移种下空版本 1（14 §9.2①），因此永不缺席；响应永不含正文。
   */
  snapshot(): Promise<CloudUserProfileSnapshot>;
  /** 按版本读快照摘要；版本已被修剪时返回 null（不猜版本）。 */
  readVersion(profileVersion: number): Promise<CloudUserProfileSnapshot | null>;
  /**
   * 按版本读条目元数据 + 正文（连接期同步组装用）。任一 manifest 条目的正文行缺失/不匹配
   * （已被修剪）返回 null——整版本不可解析，调用方按结构化失败收口（不装半份）。
   */
  readVersionEntries(profileVersion: number): Promise<UserProfileEntryRecord[] | null>;
  /**
   * 读**当前版本**中某个键的条目元数据 + 正文（14 §9.4① 的编辑回显通路）。
   * 键不在当前版本 manifest 里返回 null（调用方映射 404 `not_found`）；元数据以 manifest
   * 为准（`enabled`/`displayName` 属版本事实，14 §9.2①），正文取自内容寻址行。
   */
  readEntry(request: {
    category: CloudUserProfileCategory;
    entryId: string;
  }): Promise<UserProfileEntryRecord | null>;
  /**
   * 幂等整条替换（14 §9.2①）：同 `(category, entryId)` 且派生 `sha256`、`enabled`、
   * `displayName` 全同 → **不递增版本**、返回当前版本；否则事务内递增并修剪。
   * 上限以真实聚合值在事务内判定（总量/条目数/单条类别上限）。
   */
  upsertEntry(request: UserProfileUpsertRequest): Promise<UserProfileUpsertResult>;
  /** 从当前版本移除该键并递增版本；键不存在时幂等无操作（版本不变、`deleted:false`）。 */
  deleteEntry(request: {
    category: CloudUserProfileCategory;
    entryId: string;
    now: number;
  }): Promise<UserProfileDeleteResult>;
  /**
   * 翻转条目级开关（14 §9.4①）：同一写事务内写新版本 manifest（`enabled` 已改）并按内容
   * 寻址行同步该列；开关**值变化**才递增 `profileVersion`（交付集合 = manifest 的 enabled
   * 子集，变了才是新版本）。键不存在 → `not_found`（不制造空版本噪声）。
   */
  setEntryEnabled(request: {
    category: CloudUserProfileCategory;
    entryId: string;
    enabled: boolean;
    now: number;
  }): Promise<UserProfileSetEnabledResult>;
}
