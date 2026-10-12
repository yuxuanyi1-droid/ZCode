/**
 * 用户资源 profile HTTP 端点（M8；specs/cloud-agent 14 §9.2⑦/§9.4/§4.6、03 §6 端点矩阵）。
 *
 * 边界：Hono 只出现在 adapters/http；业务规则一律经 app 用例（`plane.userProfile` /
 * `plane.userProfileSync`）。
 * - 鉴权沿用云 HTTP 面既有中间件（03 §3/§6，入口层 lite-token）；单主体部署下 profile
 *   属主 = 部署主体，路由不做额外归属校验（store 无 owner 列，14 §9.2⑧）；
 * - `PUT` 请求体上限 80MiB（`CLOUD_PROFILE_UPLOAD_BODY_MAX_BYTES`，hono body-limit）：
 *   超限 413 `payload_too_large`，不截断、不落盘半截（14 §9.2⑦）；
 * - P20 追加（14 §9.4）：条目回显 `GET …/entries/:category/:entryId`（唯一正文出口）与
 *   条目级开关 `PATCH`（矩阵首个 PATCH，body 只含 `{enabled}`）；
 * - 手动同步（14 §4.6）：`POST /api/cloud/tasks/:taskId/user-profile-sync`——连接态
 *   （bridge ready）且非终态前置，未连接/终态 409 `not_ready`（reason
 *   `run-not-connected`/`run-terminal`），受 `stopRequested` 屏障；响应 = 本次逐条结果；
 * - 未接线 profile store / 控制面 RPC 端口时按 `not_configured`(503) 收口（不伪装成功）。
 */
import { bodyLimit } from "hono/body-limit";
import type { Hono } from "hono";
import { CLOUD_PROFILE_UPLOAD_BODY_MAX_BYTES } from "@zcode/shared";
import { errorResponse, readJson, respondFailure, type CloudHttpRouteDeps } from "./support.js";

export function registerCloudUserProfileRoutes(app: Hono, deps: CloudHttpRouteDeps): void {
  const { plane } = deps;

  // ── 快照摘要与版本（GET；响应永不含归档正文，14 §5）──
  app.get("/api/cloud/user-profile", async (c) => {
    const snapshot = await plane.userProfile.snapshot();
    return snapshot.ok ? c.json(snapshot.value) : respondFailure(c, snapshot);
  });
  app.get("/api/cloud/user-profile/version", async (c) => {
    const version = await plane.userProfile.version();
    return version.ok ? c.json(version.value) : respondFailure(c, version);
  });

  const uploadLimit = bodyLimit({
    maxSize: CLOUD_PROFILE_UPLOAD_BODY_MAX_BYTES,
    onError: (c) => errorResponse(c, "payload_too_large", "profile-upload-body-too-large"),
  });

  // ── 幂等整条替换（PUT；矩阵首个 PUT，14 §9.1 追加冻结）──
  app.put("/api/cloud/user-profile/entries/:category/:entryId", uploadLimit, async (c) => {
    const uploaded = await plane.userProfile.putEntry({
      category: c.req.param("category"),
      entryId: c.req.param("entryId"),
      body: await readJson(c),
    });
    return uploaded.ok ? c.json(uploaded.value) : respondFailure(c, uploaded);
  });

  // ── 删除条目（DELETE；键不存在时幂等无操作，版本不变）──
  app.delete("/api/cloud/user-profile/entries/:category/:entryId", async (c) => {
    const deleted = await plane.userProfile.deleteEntry({
      category: c.req.param("category"),
      entryId: c.req.param("entryId"),
    });
    return deleted.ok ? c.json(deleted.value) : respondFailure(c, deleted);
  });

  // ── 条目回显（GET；14 §9.4①：UI 编辑回显唯一通路，响应按类别有界）──
  app.get("/api/cloud/user-profile/entries/:category/:entryId", async (c) => {
    const entry = await plane.userProfile.readEntry({
      category: c.req.param("category"),
      entryId: c.req.param("entryId"),
    });
    return entry.ok ? c.json(entry.value) : respondFailure(c, entry);
  });

  // ── 条目级开关（PATCH；14 §9.4①，矩阵首个 PATCH）：body 只含 {enabled} ──
  app.patch("/api/cloud/user-profile/entries/:category/:entryId", async (c) => {
    const patched = await plane.userProfile.setEntryEnabled({
      category: c.req.param("category"),
      entryId: c.req.param("entryId"),
      body: await readJson(c),
    });
    return patched.ok ? c.json(patched.value) : respondFailure(c, patched);
  });

  // ── 手动同步一次最新 profile（14 §4.6；连接态且非终态前置）──
  app.post("/api/cloud/tasks/:taskId/user-profile-sync", async (c) => {
    const synced = await plane.userProfileSync.syncTaskProfile({
      taskId: c.req.param("taskId"),
      trigger: "manual",
    });
    return synced.ok ? c.json(synced.value) : respondFailure(c, synced);
  });
}
