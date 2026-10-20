import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";

import { buildServerRemoteWorkspaceIdentity } from "@zcode/shared";

import {
  CloudError,
  type CloudHistoryEventDto,
  type CloudInputDto,
  type CloudProjectDto,
  type CloudTaskDto,
  type SubmitInputRequest,
} from "@zcode/cloud-protocol";

import type { InputRecord, RunRecord, TaskRecord } from "../domain/types.js";
import {
  isTerminalRun,
  parseRepoUrl,
  sha256,
  toInputDto,
  toProjectDto,
  toTaskDto,
} from "./support.js";
import { ProjectionPoller } from "./projectionPoller.js";
import { CloudStore } from "../adapters/storage/db.js";
import type { SecretBox } from "../adapters/storage/secrets.js";
import type { DaemonConnection } from "../adapters/zcode/daemonClient.js";
import { connectDaemon } from "../adapters/zcode/daemonClient.js";
import type { RunAttachment } from "../adapters/tunnel/server.js";
import type { SandboxDriver, SandboxHandle } from "../adapters/providers/types.js";

export type CloudEvent =
  | { type: "task"; taskId: string }
  | { type: "projection"; taskId: string }
  | { type: "run"; taskId: string; runId: string };

export interface RuntimeLink {
  runId: string;
  getChannel(name: string): ReturnType<DaemonConnection["getChannel"]>;
}

export interface OrchestratorDeps {
  store: CloudStore;
  secrets: SecretBox;
  drivers: Map<string, SandboxDriver>;
  defaultProvider: string;
  publicUrl: string | (() => string);
  broadcast: (event: CloudEvent) => void;
  /** 账号域可用时返回 provisioning 信封；不可用返回 null。 */
  provisioningEnvelope?: () => Promise<unknown | null>;
}

export class Orchestrator {
  private readonly attachments = new Map<string, RunAttachment>();
  private readonly connections = new Map<string, DaemonConnection>();
  private readonly sessions = new Map<string, string>();
  private readonly projectIds = new Map<string, string>();
  private readonly pipeline = new Set<string>();
  private readonly readyWaiters = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  private readonly projection: ProjectionPoller;

  public constructor(private readonly deps: OrchestratorDeps) {
    this.projection = new ProjectionPoller(deps.store, deps.broadcast);
  }

  // ── projects ────────────────────────────────────────────────

  public listProjects(): CloudProjectDto[] {
    return this.deps.store.listProjects().map((project) => toProjectDto(project));
  }

  public createProject(input: {
    name: string;
    repoUrl: string;
    defaultBranch?: string;
  }): CloudProjectDto {
    const existing = this.deps.store
      .listProjects()
      .find((project) => project.repoUrl === input.repoUrl);
    if (existing) {
      return toProjectDto(existing);
    }
    const parsed = parseRepoUrl(input.repoUrl);
    const record = this.deps.store.createProject({
      name: input.name,
      repoUrl: input.repoUrl,
      repoOwner: parsed.owner,
      repoName: parsed.name,
      defaultBranch: input.defaultBranch ?? "main",
    });
    return toProjectDto(record);
  }

  public deleteProject(id: string): void {
    const project = this.deps.store.getProject(id);
    if (!project) {
      throw new CloudError("not_found", `project not found: ${id}`);
    }
    this.deps.store.deleteProject(id);
  }

  // ── tasks ───────────────────────────────────────────────────

  public listTasks(projectId?: string): CloudTaskDto[] {
    return this.deps.store.listTasks(projectId).map((task) => toTaskDto(this.deps.store, task));
  }

  public getTask(taskId: string): CloudTaskDto {
    const task = this.deps.store.getTask(taskId);
    if (!task) {
      throw new CloudError("not_found", `task not found: ${taskId}`);
    }
    return toTaskDto(this.deps.store, task);
  }

  public createTask(input: {
    projectId: string;
    title?: string;
    baseBranch?: string;
    provider?: string;
  }): CloudTaskDto {
    const project = this.deps.store.getProject(input.projectId);
    if (!project) {
      throw new CloudError("not_found", `project not found: ${input.projectId}`);
    }
    const providerId = input.provider ?? this.deps.defaultProvider;
    const driver = this.deps.drivers.get(providerId);
    if (!driver) {
      throw new CloudError("provider_unavailable", `provider not available: ${providerId}`);
    }
    const taskStableId = `t-${randomUUID().replace(/-/gu, "").slice(0, 16)}`;
    const checkoutPath = driver.checkoutPath(taskStableId, project.repoName);
    const workspaceIdentity = buildServerRemoteWorkspaceIdentity({
      serverId: taskStableId,
      workspacePath: checkoutPath,
    });
    const task = this.deps.store.createTask({
      projectId: project.id,
      title: input.title?.trim() || `${project.name} task`,
      provider: providerId,
      taskStableId,
      workspaceIdentity,
      baseBranch: input.baseBranch ?? project.defaultBranch,
      taskBranch: `zcode/${taskStableId}`,
    });
    this.deps.broadcast({ type: "task", taskId: task.id });
    return toTaskDto(this.deps.store, task);
  }

  public archiveTask(taskId: string): CloudTaskDto {
    const task = this.deps.store.getTask(taskId);
    if (!task) {
      throw new CloudError("not_found", `task not found: ${taskId}`);
    }
    if (task.activeRunId) {
      const run = this.deps.store.getRun(task.activeRunId);
      if (run && !isTerminalRun(run)) {
        throw new CloudError("conflict", "stop the running task before archiving");
      }
    }
    this.deps.store.archiveTask(taskId);
    this.deps.broadcast({ type: "task", taskId });
    return this.getTask(taskId);
  }

  public reopenTask(taskId: string): CloudTaskDto {
    const task = this.deps.store.getTask(taskId);
    if (!task) {
      throw new CloudError("not_found", `task not found: ${taskId}`);
    }
    if (task.status === "archived") {
      throw new CloudError("conflict", "archived task cannot be reopened");
    }
    if (task.activeRunId) {
      const run = this.deps.store.getRun(task.activeRunId);
      if (run && !isTerminalRun(run)) {
        return this.getTask(taskId);
      }
      this.deps.store.clearActiveRun(task.id, task.activeRunId);
    }
    this.deps.store.setTaskStatus(task.id, "active");
    this.deps.broadcast({ type: "task", taskId });
    return this.getTask(taskId);
  }

  // ── inputs ──────────────────────────────────────────────────

  public async submitInput(taskId: string, request: SubmitInputRequest): Promise<CloudInputDto> {
    const task = this.deps.store.getTask(taskId);
    if (!task) {
      throw new CloudError("not_found", `task not found: ${taskId}`);
    }
    if (task.status === "archived") {
      throw new CloudError("conflict", "archived task cannot accept input");
    }
    const existing = this.deps.store.getInput(taskId, request.commandId);
    if (existing) {
      return toInputDto(existing);
    }
    const run = task.activeRunId ? this.deps.store.getRun(task.activeRunId) : null;
    const activeRun = run && !isTerminalRun(run) ? run : null;
    if (
      activeRun &&
      request.intent === "append" &&
      this.deps.store.hasInputIntent(taskId, "stop")
    ) {
      throw new CloudError("task_stopping", "task is stopping");
    }
    const payloadJson = JSON.stringify({
      prompt: request.prompt,
      ...(request.modelSelection ? { modelSelection: request.modelSelection } : {}),
    });
    const input = this.deps.store.appendInput({
      taskId,
      commandId: request.commandId,
      intent: request.intent,
      payloadJson,
      payloadHash: sha256(payloadJson),
    });
    this.deps.broadcast({ type: "task", taskId });

    if (activeRun) {
      const connection = this.connections.get(activeRun.id);
      if (connection && activeRun.status === "ready") {
        await this.deliverOne(activeRun, task, connection, input);
      }
      return toInputDto(this.deps.store.getInput(taskId, request.commandId) ?? input);
    }

    void this.ensureRun(task.id).catch(() => undefined);
    return toInputDto(input);
  }

  public getInput(taskId: string, commandId: string): CloudInputDto {
    const input = this.deps.store.getInput(taskId, commandId);
    if (!input) {
      throw new CloudError("not_found", "input not found");
    }
    return toInputDto(input);
  }

  public async stopTask(taskId: string): Promise<CloudTaskDto> {
    const task = this.deps.store.getTask(taskId);
    if (!task) {
      throw new CloudError("not_found", `task not found: ${taskId}`);
    }
    const run = task.activeRunId ? this.deps.store.getRun(task.activeRunId) : null;
    if (!run || isTerminalRun(run)) {
      throw new CloudError("conflict", "task is not running");
    }
    const commandId = `stop-${run.id}`;
    this.deps.store.appendInput({
      taskId,
      commandId,
      intent: "stop",
      payloadJson: "{}",
      payloadHash: sha256("stop"),
    });
    this.deps.store.updateRun(run.id, { status: "draining" });
    this.deps.broadcast({ type: "task", taskId });

    const connection = this.connections.get(run.id);
    const sessionId = this.sessions.get(run.id);
    if (connection && sessionId) {
      await connection
        .callAgent("closeSession", {
          workspacePath: run.checkoutPath,
          workspaceIdentity: task.workspaceIdentity,
          sessionId,
        })
        .catch(() => undefined);
    }
    this.projection.stop(run.id);
    connection?.dispose();
    this.connections.delete(run.id);
    this.attachments.delete(run.id);
    this.sessions.delete(run.id);

    const driver = this.deps.drivers.get(run.provider);
    if (driver && run.providerHandle) {
      try {
        const handle = JSON.parse(run.providerHandle) as SandboxHandle;
        await driver.terminate(handle);
      } catch {
        // provider 已回收。
      }
    } else if (driver) {
      await driver
        .terminate({ id: run.id, provider: run.provider, meta: {} })
        .catch(() => undefined);
    }

    this.deps.store.updateRun(run.id, {
      status: "stopped",
      endedAt: Date.now(),
      endReason: "user_stop",
    });
    this.deps.store.clearActiveRun(task.id, run.id);
    this.deps.store.setTaskStatus(task.id, "completed");
    this.deps.broadcast({ type: "task", taskId });
    return this.getTask(taskId);
  }

  // ── history ─────────────────────────────────────────────────

  public getHistory(
    taskId: string,
    cursor: string | null,
    limit: number,
  ): {
    events: CloudHistoryEventDto[];
    nextCursor: string | null;
  } {
    this.getTask(taskId);
    const records = this.deps.store.listProjections(taskId, cursor, limit);
    const events = records.map((record) => ({
      logEpoch: record.logEpoch,
      seq: record.seq,
      kind: record.kind,
      payload: JSON.parse(record.payloadJson) as unknown,
      ingestedAt: record.ingestedAt,
    }));
    const last = events.at(-1);
    return {
      events,
      nextCursor:
        last && events.length === Math.min(Math.max(limit, 1), 500)
          ? `${last.logEpoch}:${last.seq}`
          : null,
    };
  }

  // ── bridge integration ──────────────────────────────────────

  public verifyAttach(runId: string, token: string): RunRecord | null {
    const run = this.deps.store.getRun(runId);
    if (!run || isTerminalRun(run)) {
      return null;
    }
    let expected: string;
    try {
      expected = this.deps.secrets.decrypt(run.attachTokenEnc);
    } catch {
      return null;
    }
    const left = Buffer.from(expected);
    const right = Buffer.from(token);
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      return null;
    }
    return run;
  }

  public onAttached(attachment: RunAttachment): void {
    this.attachments.set(attachment.runId, attachment);
    this.maybeStartPipeline(attachment);
  }

  public onDaemonStatus(attachment: RunAttachment): void {
    this.maybeStartPipeline(attachment);
  }

  public onDetached(runId: string, _epoch: number): void {
    if (this.attachments.get(runId)) {
      this.attachments.delete(runId);
    }
    const connection = this.connections.get(runId);
    connection?.dispose();
    this.connections.delete(runId);
    this.projection.stop(runId);
  }

  public async openRunStream(
    runId: string,
    kind: "daemon" | "exec" = "daemon",
  ): Promise<Duplex | null> {
    const attachment = this.attachments.get(runId);
    if (!attachment) {
      return null;
    }
    try {
      return await attachment.openStream(kind);
    } catch {
      return null;
    }
  }

  public getIngressToken(runId: string): string | null {
    return this.attachments.get(runId)?.daemon.ingressToken ?? null;
  }

  public getRuntimeLink(runId: string): RuntimeLink | null {
    const connection = this.connections.get(runId);
    if (!connection) {
      return null;
    }
    return {
      runId,
      getChannel: (name: string) => connection.getChannel(name),
    };
  }

  public getActiveRun(taskId: string): RunRecord | null {
    const task = this.deps.store.getTask(taskId);
    if (!task?.activeRunId) {
      return null;
    }
    return this.deps.store.getRun(task.activeRunId);
  }

  public dispose(): void {
    this.projection.stopAll();
    for (const connection of this.connections.values()) {
      connection.dispose();
    }
    this.connections.clear();
    for (const waiter of this.readyWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("control plane shutting down"));
    }
    this.readyWaiters.clear();
    for (const attachment of this.attachments.values()) {
      attachment.close("control-plane shutdown");
    }
    this.attachments.clear();
  }

  // ── internal ────────────────────────────────────────────────

  private publicUrl(): string {
    return typeof this.deps.publicUrl === "function" ? this.deps.publicUrl() : this.deps.publicUrl;
  }

  private maybeStartPipeline(attachment: RunAttachment): void {
    if (
      attachment.daemon.state !== "ready" ||
      !attachment.daemon.port ||
      !attachment.daemon.ingressToken
    ) {
      return;
    }
    if (this.pipeline.has(attachment.runId)) {
      return;
    }
    const run = this.deps.store.getRun(attachment.runId);
    if (!run || run.status !== "provisioning") {
      return;
    }
    this.pipeline.add(attachment.runId);
    void this.runPipeline(attachment)
      .catch(async (error: unknown) => {
        await this.failRun(run, error);
      })
      .finally(() => this.pipeline.delete(attachment.runId));
  }

  private async runPipeline(attachment: RunAttachment): Promise<void> {
    const run = this.deps.store.getRun(attachment.runId);
    if (!run) {
      throw new Error("run disappeared");
    }
    const task = this.deps.store.getTask(run.taskId);
    if (!task) {
      throw new Error("task disappeared");
    }
    const ingressToken = attachment.daemon.ingressToken;
    if (!ingressToken) {
      throw new Error("daemon ingress token missing");
    }
    const connection = await connectDaemon(attachment, ingressToken);
    this.connections.set(run.id, connection);

    if (this.deps.provisioningEnvelope) {
      const envelope = await this.deps.provisioningEnvelope();
      if (envelope) {
        const result = (await connection.applyProvisioning(envelope)) as { status?: string };
        const status = result?.status ?? "";
        if (status !== "applied" && status !== "already-applied") {
          throw new Error(`provider provisioning failed: ${status || "unknown"}`);
        }
      }
    }

    const driver = this.deps.drivers.get(run.provider);
    if (driver && !driver.skipCheckout) {
      await this.checkout(attachment, task, run);
    }

    // 远程 owner 的 Host 要求 session 绑定项目（project.remote-project-required）。
    // 每个云任务在沙箱内是单 root 项目，checkout 完成后登记。
    let projectId: string | undefined;
    try {
      const projectChannel = connection.getChannel("project");
      const saved = (await projectChannel.call("saveProject", [
        {
          name: task.title,
          roots: [run.checkoutPath],
          primaryRoot: run.checkoutPath,
        },
      ])) as { id?: string };
      projectId = saved?.id;
    } catch {
      // 旧 daemon 没有 project 通道时继续按 workspace 执行。
    }

    if (projectId) {
      this.projectIds.set(run.id, projectId);
    }
    // Session 不在供给期强建：没有模型凭据时会让整个 Run 失败，
    // 且浏览器会自行创建会话；首个 API 输入到达时再惰性创建。
    this.deps.store.updateRun(run.id, { status: "ready", readyAt: Date.now() });
    this.deps.store.setTaskStatus(task.id, "active");
    this.deps.broadcast({ type: "task", taskId: task.id });

    await this.deliverPending(run, task, connection);
    this.projection.start(run, task, connection);
    this.resolveReadyWaiter(run.id);
  }

  private async checkout(
    attachment: RunAttachment,
    task: TaskRecord,
    run: RunRecord,
  ): Promise<void> {
    const project = this.deps.store.getProject(task.projectId);
    if (!project) {
      throw new Error("project disappeared");
    }
    const duplex = await attachment.openStream("exec", [
      "git",
      "clone",
      "--depth",
      "1",
      "--branch",
      task.baseBranch ?? project.defaultBranch,
      project.repoUrl,
      run.checkoutPath,
    ]);
    let output = "";
    duplex.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 20_000) output = output.slice(-20_000);
    });
    await new Promise<void>((resolve, reject) => {
      duplex.once("end", () => resolve());
      duplex.once("error", (error) => reject(error));
    }).catch((error: unknown) => {
      throw new Error(
        `checkout failed: ${error instanceof Error ? error.message : String(error)} ${output}`,
      );
    });
  }

  private async ensureRun(taskId: string): Promise<void> {
    const task = this.deps.store.getTask(taskId);
    if (!task) {
      return;
    }
    if (task.activeRunId) {
      const current = this.deps.store.getRun(task.activeRunId);
      if (current && !isTerminalRun(current)) {
        return;
      }
    }
    const project = this.deps.store.getProject(task.projectId);
    if (!project) {
      throw new CloudError("not_found", "project disappeared");
    }
    const driver =
      this.deps.drivers.get(task.provider) ?? this.deps.drivers.get(this.deps.defaultProvider);
    if (!driver) {
      throw new CloudError("provider_unavailable", `provider not available: ${task.provider}`);
    }
    const generation = task.nextRunGeneration;
    const runId = randomUUID();
    const attachToken = randomBytes(32).toString("base64url");
    const checkoutPath = driver.checkoutPath(task.taskStableId, project.repoName);
    const run = this.deps.store.createRun({
      id: runId,
      taskId: task.id,
      generation,
      provider: driver.id,
      templateVersion: "1",
      checkoutPath,
      attachTokenEnc: this.deps.secrets.encrypt(attachToken),
    });
    this.deps.broadcast({ type: "task", taskId: task.id });
    const ready = this.waitForReady(run.id, 120_000);
    let handle: SandboxHandle | null = null;
    try {
      handle = await driver.create({
        runId,
        taskId: task.id,
        taskStableId: task.taskStableId,
        generation,
        repoUrl: project.repoUrl,
        repoName: project.repoName,
        baseBranch: task.baseBranch ?? project.defaultBranch,
        taskBranch: task.taskBranch ?? `zcode/${task.taskStableId}`,
        checkoutPath,
        controlPlaneUrl: this.publicUrl(),
        attachToken,
      });
      this.deps.store.updateRun(run.id, { providerHandle: JSON.stringify(handle) });
      await ready;
    } catch (error) {
      await this.failRun(run, error);
      if (handle) {
        await driver.terminate(handle).catch(() => undefined);
      }
      throw error;
    }
  }

  private waitForReady(runId: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiters.delete(runId);
        reject(new Error("sandbox did not become ready in time"));
      }, timeoutMs);
      timer.unref?.();
      this.readyWaiters.set(runId, { resolve, reject, timer });
    });
  }

  private resolveReadyWaiter(runId: string): void {
    const waiter = this.readyWaiters.get(runId);
    if (!waiter) {
      return;
    }
    clearTimeout(waiter.timer);
    this.readyWaiters.delete(runId);
    waiter.resolve();
  }

  private async failRun(run: RunRecord, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.projection.stop(run.id);
    this.connections.get(run.id)?.dispose();
    this.connections.delete(run.id);
    this.sessions.delete(run.id);
    const latest = this.deps.store.getRun(run.id);
    if (latest && !isTerminalRun(latest)) {
      this.deps.store.updateRun(run.id, {
        status: "failed",
        endedAt: Date.now(),
        endReason: "provisioning_failed",
        lastError: message,
      });
      this.deps.store.setTaskStatus(run.taskId, "failed");
      this.deps.store.clearActiveRun(run.taskId, run.id);
    }
    const waiter = this.readyWaiters.get(run.id);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.readyWaiters.delete(run.id);
      waiter.reject(error instanceof Error ? error : new Error(message));
    }
    this.deps.broadcast({ type: "task", taskId: run.taskId });
  }

  private async deliverPending(
    run: RunRecord,
    task: TaskRecord,
    connection: DaemonConnection,
  ): Promise<void> {
    const inputs = this.deps.store.listDeliverableInputs(task.id, run.id);
    for (const input of inputs) {
      if (input.intent === "stop") {
        continue;
      }
      await this.deliverOne(run, task, connection, input);
    }
  }

  /** 惰性创建 runtime session；浏览器也可能先自行创建，二者共用同一 workspace。 */
  private async ensureSession(
    run: RunRecord,
    task: TaskRecord,
    connection: DaemonConnection,
  ): Promise<string> {
    const existing = this.sessions.get(run.id);
    if (existing) {
      return existing;
    }
    await connection
      .callAgent("initialize", {
        workspacePath: run.checkoutPath,
        workspaceIdentity: task.workspaceIdentity,
      })
      .catch(() => undefined);
    const projectId = this.projectIds.get(run.id);
    const snapshot = await connection.callAgent<{
      sessionId?: string;
      session?: { sessionId?: string };
    }>("createSession", {
      ...(projectId ? { projectId } : {}),
      workspacePath: run.checkoutPath,
      workspaceIdentity: task.workspaceIdentity,
    });
    const sessionId = snapshot?.sessionId ?? snapshot?.session?.sessionId;
    if (!sessionId) {
      throw new Error("createSession returned no sessionId");
    }
    this.sessions.set(run.id, sessionId);
    this.projection.start(run, task, connection);
    return sessionId;
  }

  private async deliverOne(
    run: RunRecord,
    task: TaskRecord,
    connection: DaemonConnection,
    input: InputRecord,
  ): Promise<void> {
    if (input.deliveryStatus === "acked") {
      return;
    }
    const payload = JSON.parse(input.payloadJson) as {
      prompt?: string;
      modelSelection?: Record<string, unknown>;
    };
    this.deps.store.markInputDelivered(input.id, run.id);
    try {
      const sessionId = await this.ensureSession(run, task, connection);
      await connection.callAgent("sendPrompt", {
        workspacePath: run.checkoutPath,
        workspaceIdentity: task.workspaceIdentity,
        sessionId,
        content: payload.prompt ?? "",
        ...(payload.modelSelection ? { modelSelection: payload.modelSelection } : {}),
      });
      this.deps.store.markInputAcked(input.id);
    } catch (error) {
      this.deps.store.markInputFailed(
        input.id,
        error instanceof Error ? error.message : String(error),
      );
    }
    this.deps.broadcast({ type: "task", taskId: task.id });
  }
}
