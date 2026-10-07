/**
 * `bootstrap.config` 的控制面发送侧（specs/cloud-agent 02 §4/§5.3 Ready 条件、
 * 01 §6.2 bootstrap 步骤、12 §6 envelope 安装）。
 *
 * 时序：bridge `welcome`（认证 + epoch 接管）之后、`ready` 之前，经已认证的 bridge 通道
 * 下发：`taskId`、`workspacePath`、clone 事实（repositoryId/repositoryFullName/baseSha/
 * taskBranch）、`provisioningEnvelopeJson`、`credentialGeneration`、`policyVersion`。
 * 不变量：
 * - 不走 provider env/元数据（那些对外可读），凭据正文不进日志（02 §9、01 §6.2）；
 * - clone 事实与自有字段全部取自已持久 Task/Run：不引入第二份状态、不在发送时重算基线；
 * - envelope 只来自注入的 host 侧来源（12 §6 账号态或静态 fallback，二选一互斥在 host 侧），
 *   控制面不自己拼、也不复制账号域 schema；
 * - 发送失败按 run fault 语义收口：不重做 ready、不用旧凭据重试，等下一次连接重装
 *   （02 §8「welcome/旋转响应丢失」行 + 01 §6.2）。
 */
import type { BootstrapConfigFrame } from "@zcode/shared";
import type { CloudCoreDeps } from "../deps.js";
import { cloudCoreLogger } from "../logger.js";
import { fail, ok, type CloudAppResult } from "../result.js";
import type { AttachmentRegistry } from "../attachments/registry.js";

export interface BootstrapConfigSendResult {
  credentialGeneration: number;
  policyVersion: string;
}

export interface BootstrapConfigSender {
  /**
   * 幂等：同一 run/epoch 重复调用会重发（02 §8：重连后重装），但不会改变 run 状态、
   * 也不会推进 ready；调用方（bridge 入站）负责在 welcome 后触发一次。
   */
  send(input: {
    taskId: string;
    runId: string;
    runGeneration: number;
    connectionEpoch: number;
  }): Promise<CloudAppResult<BootstrapConfigSendResult>>;
}

export function createBootstrapConfigSender(
  deps: CloudCoreDeps,
  registry: AttachmentRegistry,
): BootstrapConfigSender {
  const { storage, attachments, clock, config } = deps;

  return {
    async send(input) {
      const task = await storage.tasks.get(input.taskId);
      if (!task) return fail("not_found", "task-not-found");
      const run = await storage.runs.get(input.runId);
      if (!run || run.taskId !== input.taskId) return fail("not_found", "run-not-found");
      if (run.runGeneration !== input.runGeneration) return fail("stale", "stale-generation");
      if (run.status === "stopped" || run.status === "expired" || run.status === "failed") {
        return fail("stale", "run-terminal");
      }
      if (run.stopRequested) {
        // 停止屏障：不再向该 run 下发配置（08 §8.1、CT-15）。
        return fail("recovery_required", "stop-requested");
      }
      const session = registry.current(run.runId);
      if (!session) return fail("not_ready", "no-attachment");
      if (session.connectionEpoch !== input.connectionEpoch) return fail("stale", "stale-epoch");

      // clone 事实与自有字段：全部取自已持久 Task/Run（08 §4.1/§9、09 §4.1）。
      if (!task.baseSha || !task.taskBranch) return fail("invalid_ref", "task-baseline-not-frozen");
      if (!run.workspacePath) return fail("not_ready", "workspace-path-unknown");
      const project = await storage.projects.get(task.projectId);
      if (!project?.repositoryId || !project.repoOwner || !project.repoName) {
        return fail("not_found", "project-repository-missing");
      }

      // envelope 来源唯一：host 侧 provisioning source（12 §6）。未接线即 fail-closed。
      const envelopeSource = deps.provisioningEnvelope;
      if (!envelopeSource) return fail("not_configured", "provisioning-envelope-source-missing");
      const envelope = await envelopeSource.buildProvisioningEnvelopeJsonForRun({
        taskId: task.taskId,
        runId: run.runId,
        runGeneration: run.runGeneration,
      });
      if (!envelope) return fail("not_configured", "provisioning-envelope-unavailable");

      const frame: Omit<BootstrapConfigFrame, "protocolVersion" | "type"> = {
        taskId: task.taskId,
        workspacePath: run.workspacePath,
        clone: {
          repositoryId: project.repositoryId,
          repositoryFullName: `${project.repoOwner}/${project.repoName}`,
          baseSha: task.baseSha,
          taskBranch: task.taskBranch,
        },
        provisioningEnvelopeJson: envelope.envelopeJson,
        credentialGeneration: envelope.credentialGeneration,
        policyVersion: config.bootstrapPolicyVersion,
      };

      const sent = await attachments.sendBootstrapConfig({
        taskId: task.taskId,
        runId: run.runId,
        runGeneration: run.runGeneration,
        config: frame,
      });
      if (sent.status !== "sent") {
        // fail-closed：不重做 ready、不携带旧 envelope 重试（等下次连接重装）。
        cloudCoreLogger.warn(undefined, "cloud bootstrap config not delivered", {
          taskId: task.taskId,
          runId: run.runId,
          reason: sent.reason,
        });
        return fail(
          sent.reason === "stale" || sent.reason === "closed" ? "stale" : "not_ready",
          sent.reason,
        );
      }
      registry.markBootstrapConfigSent({
        runId: run.runId,
        runGeneration: run.runGeneration,
        connectionEpoch: input.connectionEpoch,
        at: clock.now(),
      });
      cloudCoreLogger.info(undefined, "cloud bootstrap config sent", {
        taskId: task.taskId,
        runId: run.runId,
        runGeneration: run.runGeneration,
        credentialGeneration: envelope.credentialGeneration,
      });
      return ok({
        credentialGeneration: envelope.credentialGeneration,
        policyVersion: frame.policyVersion,
      });
    },
  };
}
