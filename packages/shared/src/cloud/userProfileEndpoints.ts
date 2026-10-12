/**
 * 用户资源 profile 端点矩阵行（M8；specs/cloud-agent 14 §9.2⑦/§9.4/§4.6、03 §6 端点表）。
 *
 * 单独成文件的原因：`endpoints.ts` 贴近架构门禁的文件行数上限（max-lines）。profile 端点的
 * 形状唯一来源是 `user-profile.ts`（schema 与路径常量，14 §9.2⑦），本文件只把该来源登记成
 * 矩阵行（含连接期手动同步 `POST /api/cloud/tasks/:taskId/user-profile-sync`，14 §4.6）；
 * 注册表仍是 `CLOUD_HTTP_ENDPOINTS`（在 endpoints.ts 展开，不产生第二个事实源）。
 * 对 endpoints.ts 只有 **type-only** 依赖（运行时无环：endpoints → 本文件 → user-profile）。
 */
import type { CloudHttpEndpointDescriptor } from "./endpoints.js";
import { CLOUD_USER_PROFILE_ENDPOINT_PATHS } from "./user-profile.js";

/** 行数据：路径常量来自 user-profile.ts（唯一来源），响应/请求 schema 名同源。 */
export const CLOUD_USER_PROFILE_HTTP_ENDPOINTS: readonly CloudHttpEndpointDescriptor[] = [
  {
    id: "userProfile",
    method: "GET",
    path: CLOUD_USER_PROFILE_ENDPOINT_PATHS.snapshot,
    request: null,
    response: "cloudUserProfileSnapshotSchema",
    availability: "available",
    note: "快照摘要（条目元数据 + profileVersion + totalBytes + createdAtMs），不含归档正文",
  },
  {
    id: "userProfileVersion",
    method: "GET",
    path: CLOUD_USER_PROFILE_ENDPOINT_PATHS.version,
    request: null,
    response: "cloudUserProfileVersionResponseSchema",
    availability: "available",
    note: "当前 profileVersion（单调递增；Run 冻结锚点与帧幂等键）",
  },
  {
    id: "putUserProfileEntry",
    method: "PUT",
    path: CLOUD_USER_PROFILE_ENDPOINT_PATHS.entry,
    request: "cloudUserProfileEntryUploadRequestSchema",
    response: "cloudUserProfileEntryUploadResponseSchema",
    availability: "available",
    note: "幂等整条替换；sha256/bytes 服务端派生；路径与正文 category 必须一致；超限 413/409",
  },
  {
    id: "deleteUserProfileEntry",
    method: "DELETE",
    path: CLOUD_USER_PROFILE_ENDPOINT_PATHS.entry,
    request: null,
    response: "cloudUserProfileEntryDeleteResponseSchema",
    availability: "available",
    note: "删除条目并递增 profileVersion；键不存在时幂等无操作",
  },
  // ── P20 追加冻结（14 §9.4，2026-10-11）：条目级开关与正文回显 ──
  {
    id: "readUserProfileEntry",
    method: "GET",
    path: CLOUD_USER_PROFILE_ENDPOINT_PATHS.entry,
    request: null,
    response: "cloudUserProfileEntryReadResponseSchema",
    availability: "available",
    note: "条目元数据 + 正文（按类别有界）；UI 编辑回显唯一通路（14 §9.4①）；键不存在 404 not_found",
  },
  {
    id: "patchUserProfileEntryEnabled",
    method: "PATCH",
    path: CLOUD_USER_PROFILE_ENDPOINT_PATHS.entry,
    request: "cloudUserProfileEntryEnabledPatchRequestSchema",
    response: "cloudUserProfileEntryUploadResponseSchema",
    availability: "available",
    note: "条目级 enabled 开关（只收 {enabled}）；开关变化递增 profileVersion；键不存在 404 not_found",
  },
  // ── 连接期手动同步（14 §4.6，2026-10-11 简化定调；B 批实现）──
  {
    id: "syncTaskUserProfile",
    method: "POST",
    path: CLOUD_USER_PROFILE_ENDPOINT_PATHS.syncTask,
    request: "cloudEmptyBodySchema",
    response: "cloudUserProfileSyncResponseSchema",
    availability: "available",
    note: "手动同步一次最新 profile 到该 Run 的沙箱；连接态（bridge ready）且非终态前置（未连接/终态 409 not_ready），stopRequested 屏障",
  },
];
