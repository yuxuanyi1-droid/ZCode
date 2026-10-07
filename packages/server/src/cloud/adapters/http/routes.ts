/**
 * cloud HTTP 路由注册（03 §6 端点矩阵；端点 id 与形状取自 shared 的 `CLOUD_HTTP_ENDPOINTS`）。
 *
 * 边界：Hono 只出现在本层（adapters/http）；业务规则一律经 app 用例调用。
 * 单用户部署下主体由入口从部署秘密解析（03 §3）：请求认证/Origin 白名单由入口中间件负责，
 * 这里只做资源所有权校验（跨主体统一 404）。
 * 分阶段端点按矩阵如实返回 `not_implemented` / `not_configured`，不伪装空列表或成功。
 */
import type { Hono } from "hono";
import {
  cloudEmptyBodySchema,
  cloudListQuerySchema,
  cloudHistoryQuerySchema,
  cloudSnapshotQuerySchema,
  createCloudProjectRequestSchema,
  createCloudTaskRequestSchema,
  forceStopCloudTaskRequestSchema,
  patchCloudProjectRequestSchema,
  patchCloudTaskRequestSchema,
  reopenCloudTaskRequestSchema,
  submitTaskInputSchema,
  CLOUD_WIRE_PROTOCOL_VERSION,
} from "@zcode/shared";
import {
  errorResponse,
  notImplemented,
  readJson,
  readQuery,
  respondFailure,
  type CloudHttpRouteDeps,
} from "./support.js";
import { registerCloudRepositoryRoutes } from "./repositoryRoutes.js";

export function registerCloudHttpRoutes(app: Hono, deps: CloudHttpRouteDeps): void {
  const { plane, principalId } = deps;

  // 仓库目录端点单独成文件（保持单文件职责与行数预算）：先注册。
  registerCloudRepositoryRoutes(app, deps);

  // ── capabilities（03 §6）──
  app.get("/api/cloud/capabilities", async (c) => {
    const providers = await plane.providers();
    return c.json({
      mode: "cloud" as const,
      providers,
      features: ["durable-input", "replayable-history", "checkpoint-v1"],
      protocolVersion: CLOUD_WIRE_PROTOCOL_VERSION,
      taskOwnedAttachments: plane.config.taskOwnedAttachments,
      // 客户端 scope 隔离键（12 §5、03 §6）：`capabilitiesResponseSchema` 把它冻结为**必填**，
      // 而这里一度漏发——单测用的是自带 principalId 的 fixture，所以只有真启动后才暴露：
      // SDK 会用冻结 schema 拒绝整个响应，web 在启动握手阶段直接失败。它非秘密、非凭据，
      // 认证仍由 bearer / host lite-token 承担（03 §3）。
      principalId,
    });
  });
  // ── projects（03 §6 projects 行、11 §4）──
  app.get("/api/cloud/projects", async (c) => {
    const query = cloudListQuerySchema.safeParse(readQuery(c));
    if (!query.success) return errorResponse(c, "validation_failed", "invalid query");
    const page = await plane.tasks.listProjects({
      principalId,
      ...(query.data.cursor ? { cursor: query.data.cursor } : {}),
      ...(query.data.limit ? { limit: query.data.limit } : {}),
    });
    return page.ok ? c.json(page.value) : respondFailure(c, page);
  });
  app.post("/api/cloud/projects", async (c) => {
    const body = createCloudProjectRequestSchema.safeParse(await readJson(c));
    if (!body.success) return errorResponse(c, "validation_failed", "invalid body");
    const created = await plane.tasks.createProject({
      principalId,
      repositoryId: body.data.repositoryId,
      ...(body.data.displayName ? { displayName: body.data.displayName } : {}),
    });
    return created.ok ? c.json(created.value, 200) : respondFailure(c, created);
  });
  app.patch("/api/cloud/projects/:projectId", async (c) => {
    const body = patchCloudProjectRequestSchema.safeParse(await readJson(c));
    if (!body.success) return errorResponse(c, "validation_failed", "invalid body");
    const updated = await plane.tasks.patchProject({
      principalId,
      projectId: c.req.param("projectId"),
      expectedRevision: body.data.expectedRevision,
      ...(body.data.displayName ? { displayName: body.data.displayName } : {}),
    });
    return updated.ok ? c.json(updated.value) : respondFailure(c, updated);
  });
  app.delete("/api/cloud/projects/:projectId", async (c) => {
    const deleted = await plane.tasks.deleteProject({
      principalId,
      projectId: c.req.param("projectId"),
    });
    return deleted.ok ? c.json(deleted.value) : respondFailure(c, deleted);
  });
  app.get("/api/cloud/projects/:projectId/tasks", async (c) => {
    const query = cloudListQuerySchema.safeParse(readQuery(c));
    if (!query.success) return errorResponse(c, "validation_failed", "invalid query");
    const page = await plane.tasks.listTasks({
      principalId,
      projectId: c.req.param("projectId"),
      ...(query.data.cursor ? { cursor: query.data.cursor } : {}),
      ...(query.data.limit ? { limit: query.data.limit } : {}),
    });
    return page.ok ? c.json(page.value) : respondFailure(c, page);
  });

  // ── tasks（03 §6 tasks 行、11 §5）──
  app.post("/api/cloud/tasks", async (c) => {
    const body = createCloudTaskRequestSchema.safeParse(await readJson(c));
    if (!body.success) return errorResponse(c, "validation_failed", "invalid body");
    const created = await plane.tasks.createTask({
      principalId,
      projectId: body.data.projectId,
      title: body.data.title,
      creationKey: body.data.creationKey,
      ...(body.data.draftStartConfig ? { draftStartConfig: body.data.draftStartConfig } : {}),
    });
    return created.ok ? c.json(created.value, 201) : respondFailure(c, created);
  });
  app.get("/api/cloud/tasks/:taskId", async (c) => {
    const detail = await plane.taskDetail.getDetail({ principalId, taskId: c.req.param("taskId") });
    return detail.ok ? c.json(detail.value) : respondFailure(c, detail);
  });
  app.patch("/api/cloud/tasks/:taskId", async (c) => {
    const body = patchCloudTaskRequestSchema.safeParse(await readJson(c));
    if (!body.success) return errorResponse(c, "validation_failed", "invalid body");
    const updated = await plane.tasks.patchTask({
      principalId,
      taskId: c.req.param("taskId"),
      expectedRevision: body.data.expectedRevision,
      ...(body.data.title ? { title: body.data.title } : {}),
      ...(body.data.draftStartConfig ? { draftStartConfig: body.data.draftStartConfig } : {}),
    });
    return updated.ok ? c.json(updated.value) : respondFailure(c, updated);
  });

  // ── 输入（03 §6.1/§6.2：202 = 持久接收）──
  app.post("/api/cloud/tasks/:taskId/inputs", async (c) => {
    const body = submitTaskInputSchema.safeParse(await readJson(c));
    if (!body.success) return errorResponse(c, "validation_failed", "invalid body");
    const receipt = await plane.inputs.submit({
      principalId,
      taskId: c.req.param("taskId"),
      source: "http",
      request: body.data,
    });
    return receipt.ok ? c.json(receipt.value, 202) : respondFailure(c, receipt);
  });
  app.get("/api/cloud/tasks/:taskId/inputs", async (c) => {
    const query = cloudListQuerySchema.safeParse(readQuery(c));
    if (!query.success) return errorResponse(c, "validation_failed", "invalid query");
    const page = await plane.inputs.listInputs({
      principalId,
      taskId: c.req.param("taskId"),
      ...(query.data.cursor ? { cursor: query.data.cursor } : {}),
      ...(query.data.limit ? { limit: query.data.limit } : {}),
    });
    return page.ok ? c.json(page.value) : respondFailure(c, page);
  });
  app.get("/api/cloud/tasks/:taskId/inputs/:commandId", async (c) => {
    const receipt = await plane.inputs.getReceipt({
      principalId,
      taskId: c.req.param("taskId"),
      commandId: c.req.param("commandId"),
    });
    return receipt.ok ? c.json(receipt.value) : respondFailure(c, receipt);
  });
  app.post("/api/cloud/tasks/:taskId/inputs/:commandId/cancel", async (c) => {
    const receipt = await plane.inputControl.cancelInput({
      principalId,
      taskId: c.req.param("taskId"),
      commandId: c.req.param("commandId"),
    });
    return receipt.ok ? c.json(receipt.value) : respondFailure(c, receipt);
  });

  // ── 生命周期动作（03 §6；每个动作都在 app 层裁决，不在路由内联规则）──
  app.post("/api/cloud/tasks/:taskId/reopen", async (c) => {
    const body = reopenCloudTaskRequestSchema.safeParse(await readJson(c));
    if (!body.success) return errorResponse(c, "validation_failed", "invalid body");
    const receipt = await plane.inputs.submit({
      principalId,
      taskId: c.req.param("taskId"),
      source: "http",
      request: { ...body.data, intent: "reopen" },
    });
    if (!receipt.ok) return respondFailure(c, receipt);
    const detail = await plane.taskDetail.getDetail({ principalId, taskId: c.req.param("taskId") });
    return detail.ok ? c.json(detail.value) : respondFailure(c, detail);
  });
  app.post("/api/cloud/tasks/:taskId/stop", async (c) => {
    if (!cloudEmptyBodySchema.safeParse(await readJson(c)).success) {
      return errorResponse(c, "validation_failed", "invalid body");
    }
    const detail = await plane.commands.stop.stopTask({
      principalId,
      taskId: c.req.param("taskId"),
    });
    return detail.ok ? c.json(detail.value) : respondFailure(c, detail);
  });
  app.post("/api/cloud/tasks/:taskId/force-stop", async (c) => {
    const body = forceStopCloudTaskRequestSchema.safeParse(await readJson(c));
    if (!body.success) return errorResponse(c, "validation_failed", "invalid body");
    const detail = await plane.commands.stop.forceStopTask({
      principalId,
      taskId: c.req.param("taskId"),
      operationId: body.data.operationId,
      expectedRevision: body.data.expectedRevision,
      lossAcknowledgement: body.data.lossAcknowledgement,
    });
    return detail.ok ? c.json(detail.value) : respondFailure(c, detail);
  });
  app.post("/api/cloud/tasks/:taskId/extend", async (c) => {
    const extended = await plane.lifecycle.keepalive.extendTask({
      principalId,
      taskId: c.req.param("taskId"),
    });
    return extended.ok ? c.json(extended.value) : respondFailure(c, extended);
  });
  for (const [segment, action] of [
    ["complete", "completeTask"],
    ["archive", "archiveTask"],
    ["reactivate", "reactivateTask"],
    ["restore", "restoreTask"],
  ] as const) {
    app.post(`/api/cloud/tasks/:taskId/${segment}`, async (c) => {
      if (!cloudEmptyBodySchema.safeParse(await readJson(c)).success) {
        return errorResponse(c, "validation_failed", "invalid body");
      }
      const detail = await plane.commands.taskLifecycle[action]({
        principalId,
        taskId: c.req.param("taskId"),
      });
      return detail.ok ? c.json(detail.value) : respondFailure(c, detail);
    });
  }

  // ── 历史与快照（02 §7.3：只读控制面持久副本）──
  app.get("/api/cloud/tasks/:taskId/history", async (c) => {
    const query = cloudHistoryQuerySchema.safeParse(readQuery(c));
    if (!query.success) return errorResponse(c, "validation_failed", "invalid query");
    const page = await plane.projections.history.readHistory({
      principalId,
      taskId: c.req.param("taskId"),
      ...(query.data.topic ? { topic: query.data.topic } : {}),
      ...(query.data.cursor ? { cursor: query.data.cursor } : {}),
      ...(query.data.limit ? { limit: query.data.limit } : {}),
    });
    return page.ok ? c.json(page.value) : respondFailure(c, page);
  });
  app.get("/api/cloud/tasks/:taskId/snapshot", async (c) => {
    const query = cloudSnapshotQuerySchema.safeParse(readQuery(c));
    if (!query.success) return errorResponse(c, "validation_failed", "invalid query");
    const snapshot = await plane.projections.history.readSnapshot({
      principalId,
      taskId: c.req.param("taskId"),
      ...(query.data.topic ? { topic: query.data.topic } : {}),
      ...(query.data.logEpoch ? { logEpoch: query.data.logEpoch } : {}),
    });
    return snapshot.ok ? c.json(snapshot.value) : respondFailure(c, snapshot);
  });
  app.get("/api/cloud/tasks/:taskId/events", (c) => notImplemented(c, "durable-events-m3"));
  app.get("/api/cloud/events", (c) => notImplemented(c, "metadata-events-m3"));
  app.post("/api/cloud/attachments", (c) => notImplemented(c, "attachment-upload-owned-by-entry"));

  // ── 执行节点端点（01 §7.2 git grant、01 §6 资产）──
  // git-grant 由入口在 `controlPlane.registerRoutes()` **之前**注册（`entry-cloud-git-grant.ts`）：
  // 它要拿入口自持的存储客户端装配 broker，且必须先于本函数命中；这里不再放同路径桩，
  // 避免日后再出现"路由能通但留着 501 影子"的隐患。
  app.get("/api/cloud/assets/:assetId", (c) => notImplemented(c, "asset-distribution-m3"));
}
