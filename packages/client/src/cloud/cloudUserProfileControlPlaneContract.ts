/**
 * 用户资源 profile 的控制面方法契约（M8；specs/cloud-agent 14 §9.2⑦/§9.4）。
 *
 * 从主客户端契约拆出（max-lines 门禁）：实现仍在 `createCloudControlPlaneClient`，
 * `CloudControlPlaneClient` 通过 extends 组合本接口，公开入口不变。
 */
import type {
  CloudUserProfileCategory,
  CloudUserProfileEntryDeleteResponse,
  CloudUserProfileEntryReadResponse,
  CloudUserProfileEntryUploadRequest,
  CloudUserProfileEntryUploadResponse,
  CloudUserProfileSnapshot,
  CloudUserProfileSyncResponse,
  CloudUserProfileVersionResponse,
} from "@zcode/shared";
import type { CloudRequestOptions } from "./cloudRequestTypes.js";

export interface CloudUserProfileControlPlaneClient {
  /** 用户资源 profile 快照摘要（M8；14 §9.2⑦）：条目元数据，**不含归档正文**。 */
  listUserProfile(options?: CloudRequestOptions): Promise<CloudUserProfileSnapshot>;
  /** 当前 `profileVersion`（Run 冻结锚点/帧幂等键）。 */
  getUserProfileVersion(options?: CloudRequestOptions): Promise<CloudUserProfileVersionResponse>;
  /**
   * 幂等整条替换一个 profile 条目（矩阵首个 PUT）。请求体形状由 shared 严格 schema
   * 校验；路径与正文的 `category` 必须一致（不一致在发出请求前拒绝，14 §9.2⑦）。
   */
  putUserProfileEntry(
    category: CloudUserProfileCategory,
    entryId: string,
    body: CloudUserProfileEntryUploadRequest,
    options?: CloudRequestOptions,
  ): Promise<CloudUserProfileEntryUploadResponse>;
  /** 删除一个 profile 条目并递增版本；键不存在时幂等无操作（服务端语义）。 */
  deleteUserProfileEntry(
    category: CloudUserProfileCategory,
    entryId: string,
    options?: CloudRequestOptions,
  ): Promise<CloudUserProfileEntryDeleteResponse>;
  /**
   * 读**单个**条目的元数据 + 正文（14 §9.4①）：UI 编辑回显（AGENTS.md 文本、MCP 表单）的
   * 唯一通路，响应按类别有界；键不存在抛 `not_found`（404）。
   */
  getUserProfileEntry(
    category: CloudUserProfileCategory,
    entryId: string,
    options?: CloudRequestOptions,
  ): Promise<CloudUserProfileEntryReadResponse>;
  /**
   * 条目级开关（14 §9.4①，矩阵首个 PATCH）：只发 `{enabled}`、不重发正文；开关值变化才
   * 递增 `profileVersion`（服务端语义），键不存在抛 `not_found`（404）。
   */
  setUserProfileEntryEnabled(
    category: CloudUserProfileCategory,
    entryId: string,
    enabled: boolean,
    options?: CloudRequestOptions,
  ): Promise<CloudUserProfileEntryUploadResponse>;
  /**
   * 手动同步一次最新 profile 到该 Task 当前 Run 的沙箱（M8 连接期同步；14 §4.6）。
   *
   * 前置在服务端权威裁决：Run 非终态且连接态（bridge ready）、无 `stopRequested`；
   * 不满足 → 409 `not_ready`（`run-not-connected`/`run-terminal`/`stop-requested`）。
   * 响应 = `{runId, profileVersion, trigger, results[]}`（逐条定位 `category/entryId`）；
   * 逐条 `failed` 不影响 HTTP 200（失败不 fail run，靠手动或下次连接重试）。
   */
  syncTaskUserProfile(
    taskId: string,
    options?: CloudRequestOptions,
  ): Promise<CloudUserProfileSyncResponse>;
}
