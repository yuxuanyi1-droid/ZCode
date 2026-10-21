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

import type { RunRecord, TaskRecord } from "../domain/types.js";
import {
  isTerminalRun,
  parseRepoUrl,
  sha256,
  toInputDto,
  toProjectDto,
  toTaskDto,
} from "./support.js";
import { ProjectionPoller } from "./projectionPoller.js";
import { IdlePauseController } from "./idlePause.js";
import { checkoutWorkspace } from "./checkout.js";
import { debugTask as debugTaskImpl } from "./debugTask.js";
import { deliverOne, deliverPending } from "./inputDelivery.js";
import { ensureRunReadyForAccess } from "./runReadiness.js";
import { publishRunArtifact, type GitHubRunMeta } from "./githubPublish.js";
import { CloudStore } from "../adapters/storage/db.js";
import type { SecretBox } from "../adapters/storage/secrets.js";
import type { DaemonConnection } from "../adapters/zcode/daemonClient.js";
import { connectDaemon } from "../adapters/zcode/daemonClient.js";
import type { RunAttachment } from "../adapters/tunnel/server.js";
import type { GitHubAppClient } from "../adapters/github/githubApp.js";
import type { SandboxDriver, SandboxHandle } from "../adapters/providers/types.js";

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

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
  /** GitHub App；未配置时跳过 clone token 与 PR 发布。 */
  gitHub?: GitHubAppClient | null;
  /** 空闲暂停秒数；require provider 支持 pause。 */
  sandboxIdlePauseSeconds?: number | null;
  /** 诊断用：保留失败沙箱以便抓取日志。 */
  keepFailedSandboxes?: boolean;
}

export class Orchestrator {
  private readonly attachments = new Map<string, RunAttachment>();
  private readonly connections = new Map<string, DaemonConnection>();
  private readonly sessions = new Map<string, string>();
  private readonly projectIds = new Map<string, string>();
  private readonly githubRuns = new Map<string, GitHubRunMeta>();
  private readonly pipeline = new Set<string>();
  private readonly readyWaiters = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  private readonly projection: ProjectionPoller;
  private readonly idle: IdlePauseController;

  public constructor(private readonly deps: OrchestratorDeps) {
    this.projection = new ProjectionPoller(deps.store, deps.broadcast);
    this.idle = new IdlePauseController(
      deps.store,
      deps.drivers,
      deps.sandboxIdlePauseSeconds,
      (runId, taskId) => {
        this.connections.get(runId)?.dispose();
        this.connections.delete(runId);
        this.projection.stop(runId);
        this.deps.broadcast({ type: "task", taskId });
      },
    );
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
      if (activeRun.status === "paused") {
        await this.resumeRun(activeRun);
        return toInputDto(input);
      }
      const connection = this.connections.get(activeRun.id);
      if (connection && activeRun.status === "ready") {
        await deliverOne(this.deliveryContext(), activeRun, task, connection, input);
      }
      return toInputDto(this.deps.store.getInput(taskId, request.commandId) ?? input);
    }

    void this.ensureRun(task.id).catch(() => undefined);
    return toInputDto(input);
  }

  /** 诊断：见 app/debugTask。 */
  public async debugTask(taskId: string): Promise<unknown> {
    return debugTaskImpl({ store: this.deps.store, connections: this.connections, taskId });
  }

  public getInput(taskId: string, commandId: string): CloudInputDto {
    const input = this.deps.store.getInput(taskId, commandId);
    if (!input) {
      throw new CloudError("not_found", "input not found");
    }
    return toInputDto(input);
  }

  /** 浏览器进入任务时唤醒 paused Run；语义见 runReadiness。 */
  public ensureReadyForAccess(taskId: string): Promise<RunRecord | null> {
    return ensureRunReadyForAccess(this.deps.store, taskId, (run) => this.resumeRun(run));
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

    // 停止前把沙箱内改动发布为分支/PR；失败只标记 dataAtRisk，不阻断停止。
    await this.publish(run, task).catch((error: unknown) => {
      this.deps.store.updateRun(run.id, {
        dataAtRisk: true,
        lastError: error instanceof Error ? error.message : String(error),
      });
    });

    const connection = this.connections.get(run.id);
    const sessionId = this.sessions.get(run.id);
    if (connection && sessionId) {
      await connection
        .callAgent("closeSession", {
          workspacePath: run.checkoutPath,
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
    this.idle.clearAll();
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

  private deliveryContext() {
    return {
      store: this.deps.store,
      sessions: this.sessions,
      projectIds: this.projectIds,
      projection: this.projection,
      broadcast: this.deps.broadcast,
    };
  }

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
    process.stderr.write(`[cloud-pipeline] ${run.id} connect\n`);
    const connection = await connectDaemon(attachment, ingressToken);
    this.connections.set(run.id, connection);
    process.stderr.write(`[cloud-pipeline] ${run.id} connected\n`);

    if (this.deps.provisioningEnvelope) {
      const envelope = await this.deps.provisioningEnvelope();
      if (envelope) {
        process.stderr.write(`[cloud-pipeline] ${run.id} provisioning\n`);
        try {
          const result = (await withTimeout(
            connection.applyProvisioning(envelope),
            30_000,
            "provider provisioning",
          )) as { status?: string };
          const status = result?.status ?? "";
          if (status !== "applied" && status !== "already-applied") {
            process.stderr.write(
              `[cloud-pipeline] ${run.id} provisioning returned ${status || "unknown"}; continuing with seeded config\n`,
            );
          }
        } catch (error) {
          // 公网隧道下 host 通道可能不可用；沙箱已预置 provider_config.json，降级继续。
          process.stderr.write(
            `[cloud-pipeline] ${run.id} provisioning skipped: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }
    }

    const driver = this.deps.drivers.get(run.provider);
    if (driver && !driver.skipCheckout) {
      process.stderr.write(`[cloud-pipeline] ${run.id} checkout\n`);
      const project = this.deps.store.getProject(task.projectId);
      if (!project) {
        throw new Error("project disappeared");
      }
      await withTimeout(
        checkoutWorkspace({
          attachment,
          task,
          run,
          project,
          gitHub: this.deps.gitHub,
          onGitHubMeta: (meta) => this.githubRuns.set(run.id, meta),
        }),
        180_000,
        "checkout",
      );
    }
    process.stderr.write(`[cloud-pipeline] ${run.id} project\n`);

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
    process.stderr.write(`[cloud-pipeline] ${run.id} ready\n`);
    // Session 不在供给期强建：没有模型凭据时会让整个 Run 失败，
    // 且浏览器会自行创建会话；首个 API 输入到达时再惰性创建。
    this.deps.store.updateRun(run.id, { status: "ready", readyAt: Date.now() });
    this.deps.store.setTaskStatus(task.id, "active");
    this.deps.broadcast({ type: "task", taskId: task.id });

    await deliverPending(this.deliveryContext(), run, task, connection);
    this.projection.start(run, task, connection);
    this.idle.schedule(run, task);
    this.resolveReadyWaiter(run.id);
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
    const ready = this.waitForReady(run.id, 300_000);
    let handle: SandboxHandle | null = null;
    const envelope =
      driver.seedsProviderConfig && this.deps.provisioningEnvelope
        ? await this.deps.provisioningEnvelope().catch(() => null)
        : null;
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
        ...(envelope
          ? { providerConfig: (envelope as { personalConfig?: unknown }).personalConfig }
          : {}),
      });
      this.deps.store.updateRun(run.id, { providerHandle: JSON.stringify(handle) });
      await ready;
    } catch (error) {
      await this.failRun(run, error);
      if (handle && !this.deps.keepFailedSandboxes) {
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
    const driver = this.deps.drivers.get(run.provider);
    if (driver && latest?.providerHandle && !this.deps.keepFailedSandboxes) {
      try {
        await driver.terminate(JSON.parse(latest.providerHandle) as SandboxHandle);
      } catch {
        // provider 已回收。
      }
    }
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

  private publish(run: RunRecord, task: TaskRecord): Promise<void> {
    return publishRunArtifact({
      gitHub: this.deps.gitHub,
      meta: this.githubRuns.get(run.id),
      attachment: this.attachments.get(run.id),
      run,
      task,
      store: this.deps.store,
    });
  }

  private async resumeRun(run: RunRecord): Promise<void> {
    const driver = this.deps.drivers.get(run.provider);
    if (!driver?.resume || !run.providerHandle) {
      return;
    }
    const handle = JSON.parse(run.providerHandle) as SandboxHandle;
    await driver.resume(handle);
    this.deps.store.updateRun(run.id, { status: "provisioning" });
    this.deps.broadcast({ type: "task", taskId: run.taskId });
  }
}
