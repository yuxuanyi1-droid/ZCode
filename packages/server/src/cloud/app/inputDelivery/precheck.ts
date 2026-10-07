/**
 * 新建请求的外部预检（03 §6.1：主体认证/资源归属后先查同 commandId，仅**新**请求进入
 * 外部预检；预检不占 SQLite 写事务）。
 *
 * 与 gateway 的分工：本文件只产出「接纳事务需要的冻结事实」（Run recipe、taskBranch、
 * create 意图、runId）或结构化失败；接纳事务本身仍在 gateway → `StoragePort.acceptInput`。
 * 从 gateway 分出是为了保持每个文件单一职责与行数预算，规则不复制。
 */
import type {
  CloudDraftStartConfig,
  CloudExecutionRecipe,
  CloudTaskRecord,
  ReopenCloudTaskRequest,
  SubmitTaskInput,
} from "@zcode/shared";
import { verifyReopenEligibility } from "../commands/reopenOperations.js";
import { DEFAULT_SANDBOX_RESOURCES } from "../config.js";
import type { CloudCoreDeps } from "../deps.js";
import { fail, type CloudAppFailure } from "../result.js";
import { planRunLifetime, type RunLifetimePlan } from "../../domain/savePolicy.js";
import { buildTaskBranchName, isValidGitRefName } from "./taskBranch.js";

/**
 * 三条意图走同一接纳入口（03 §6）：start/append 由 shared 的 `submitTaskInputSchema`
 * 判别；reopen 是独立命令（`reopenCloudTaskRequestSchema`，本身不带 intent 字段），
 * 由入口层显式打上 `intent: "reopen"` 后进入 gateway/precheck。
 */
export type CloudInputRequest = SubmitTaskInput | (ReopenCloudTaskRequest & { intent: "reopen" });

/** 预检通过时交给接纳事务的冻结事实；失败复用 app 统一失败形状（03 §6.1）。 */
export interface AcceptFields {
  runId?: string;
  runRecipe?: CloudExecutionRecipe;
  taskBranch?: string;
  /** start 的启动选择：随接纳事务提交，事务内再校验与已持久 draftStartConfig 一致（W1 CR-1）。 */
  start?: CloudDraftStartConfig;
  /** create 操作幂等键：仅 start/reopen 携带；append 不创建 create 操作（W1 CR-2）。 */
  createOperationId?: string;
  /**
   * 请求寿命计划（01 §4.3）：接纳期算一次，接纳事务提交后由 gateway 落成 run 的
   * `hardDeadlineAt`/`deadlineEstimate`/`deadlineConfidence`；create 只读该值，不重算。
   */
  lease?: RunLifetimePlan;
}

export type PrecheckResult = { ok: true; acceptFields: AcceptFields } | CloudAppFailure;

export interface InputPrechecks {
  precheck(request: CloudInputRequest, task: CloudTaskRecord): Promise<PrecheckResult>;
}

export function createInputPrechecks(deps: CloudCoreDeps): InputPrechecks {
  const { storage, github, drivers, templates, clock, ids, config } = deps;

  /**
   * 模板解析（CR-5，01 §5.1 第 2 条）：解析不到就明确失败，猜默认镜像或在 worker 里
   * 临时替换模板都是禁止的（01 §7.3）。未接线 resolver 时退回 recipe 自带 digest。
   */
  async function resolveTemplate(
    provider: string,
    templateRef?: string,
  ): Promise<{ imageRef: string; templateRevision: string } | null> {
    if (templates) {
      return templates.resolve(
        templateRef === undefined ? { provider } : { provider, templateRef },
      );
    }
    return null;
  }

  /**
   * 接纳期冻结模板（01 §5.1 第 2 条：Run recipe 固定启动时的 provider、templateRef 与
   * 版本/image digest，**不读取新部署默认值**；03 §6.1：首次接纳即固定，重放不重新解析）。
   *
   * 取值规则：
   * - 请求带 `start.templateRef` → 以它为准（经 resolver 校验/归一）并写进 recipe；
   * - 请求未带 → 用 resolver 对该 provider 的**部署默认模板**，其解析结果（imageDigest +
   *   templateVersion）同样写进 recipe（resolver 的冻结形状只回 imageRef/revision，
   *   不回默认模板的名字，故 recipe 的 `templateRef` 只在用户显式选择时出现）；
   * - 解析不到（provider 无默认/未配置）→ **接纳期拒绝**，不等 provisioning 阶段才报错；
   * - 浮动标签（`:latest`）在接纳期就拒（01 §5.1 第 2 条；driver 侧仍会再校验一次）。
   */
  async function freezeTemplate(
    provider: string,
    templateRef?: string,
  ): Promise<
    | {
        ok: true;
        fields: Pick<CloudExecutionRecipe, "templateRef" | "templateVersion" | "imageDigest">;
      }
    | { ok: false; reason: string }
  > {
    const resolved = await resolveTemplate(provider, templateRef);
    if (!resolved) return { ok: false, reason: "template-unresolved" };
    if (/[:@]latest$/i.test(resolved.imageRef) || resolved.imageRef === "latest") {
      return { ok: false, reason: "floating-image-tag" };
    }
    return {
      ok: true,
      fields: {
        ...(templateRef ? { templateRef } : {}),
        templateVersion: resolved.templateRevision,
        imageDigest: resolved.imageRef,
      },
    };
  }

  return {
    async precheck(request, task) {
      switch (request.intent) {
        case "start":
          return precheckStart(request, task);
        case "reopen":
          return precheckReopen(request, task);
        default:
          return precheckAppend(request, task);
      }
    },
  };

  async function precheckStart(
    request: SubmitTaskInput & { intent: "start" },
    task: CloudTaskRecord,
  ): Promise<PrecheckResult> {
    if (task.status !== "draft") {
      // 03 §6：active 上的新 start 冲突，不忽略选择降为 append。
      return fail("stale", "start-on-non-draft", { status: task.status });
    }
    if (task.revision !== request.expectedTaskRevision) {
      return fail("stale", "task-revision-mismatch");
    }
    const saved = task.draftStartConfig;
    if (
      !saved ||
      saved.baseBranch !== request.start.baseBranch ||
      saved.provider !== request.start.provider ||
      saved.templateRef !== request.start.templateRef
    ) {
      // 11 §5/§6：start 携带的完整选择必须与已保存 draftStartConfig 一致，事务内再校验一次。
      return fail("validation_failed", "draft-start-config-mismatch");
    }
    const project = await storage.projects.get(task.projectId);
    if (!project?.repositoryId) return fail("not_found", "project-repository-missing");

    const provider = await drivers.resolve(request.start.provider);
    if (!provider) return fail("validation_failed", "provider-not-configured");
    const capabilities = await provider.describeCapabilities();
    if (!capabilities.supportsOutboundWss) {
      // 02 §4：bridge 是沙箱出站 WSS；不支持即能力错误，不做静默降级。
      return fail("resource_unsupported", "provider-no-outbound-wss");
    }

    // 11 §6：采用本次预检查询到的分支 SHA，接纳事务固定它，之后不再解析 HEAD。
    const baseHead = await github.getBranchHead({
      repositoryId: project.repositoryId,
      branch: request.start.baseBranch,
    });
    if (!baseHead || !baseHead.exists) return fail("invalid_ref", "base-branch-not-found");

    const taskBranch = buildTaskBranchName({ taskId: task.taskId, title: task.title });
    if (!isValidGitRefName(taskBranch)) return fail("invalid_ref", "task-branch-invalid");
    const existingBranch = await github.getBranchHead({
      repositoryId: project.repositoryId,
      branch: taskBranch,
    });
    if (existingBranch?.exists) {
      // 09 §4.1：外部已占用同名分支且不能证实由该 Task 建立时拒绝覆盖。
      return fail("branch_conflict", "task-branch-already-exists");
    }

    // 模板在**接纳期**冻结（含部署默认），避免 provisioning 阶段才发现没有镜像可跑。
    const frozen = await freezeTemplate(request.start.provider, request.start.templateRef);
    if (!frozen.ok) return fail("unsupported_template", frozen.reason);

    const runId = ids.newId();
    const recipe: CloudExecutionRecipe = {
      provider: request.start.provider,
      ...frozen.fields,
      resources: { ...DEFAULT_SANDBOX_RESOURCES },
      baseSha: baseHead.sha,
      firstCommandConfig: request.requestedConfig ?? {},
    };
    return {
      ok: true,
      acceptFields: {
        runId,
        runRecipe: recipe,
        taskBranch,
        start: request.start,
        // 请求寿命：部署预算与 provider 上限取较小值（01 §4.3），接纳期算一次。
        lease: planRunLifetime({
          now: clock.now(),
          deploymentBudgetMs: config.hardRunDurationMs,
          ...(capabilities.maxLifetimeSeconds === undefined
            ? {}
            : { providerMaxLifetimeSeconds: capabilities.maxLifetimeSeconds }),
          deadlineSource: capabilities.deadlineSource,
        }),
        // create 操作幂等键与 run 绑定：重试复用同一 operation（03 §5）。
        createOperationId: ids.newId(),
      },
    };
  }

  async function precheckAppend(
    request: SubmitTaskInput & { intent: "append" },
    task: CloudTaskRecord,
  ): Promise<PrecheckResult> {
    const run = await storage.runs.activeOfTask(task.taskId);
    if (!run || run.status === "stopped" || run.status === "expired" || run.status === "failed") {
      // 无有效 Run 时普通 append 不能自动 reopen（08 §5、11 §7）。
      return fail("not_ready", "no-active-run");
    }
    if (run.runGeneration !== request.expectedRunGeneration) {
      // 旧 generation 提交返回 stale，不静默改为新 run（02 §4、CT-16）。
      return fail("stale", "run-generation-mismatch");
    }
    if (run.stopRequested) {
      return fail("not_ready", "stop-requested");
    }
    if (run.status !== "ready") {
      // 11 §7：provisioning/disconnected 首版不接受新的 append，只保留客户端下一条草稿。
      return fail("not_ready", "run-not-ready", { status: run.status });
    }
    // append 不改写 Run 启动 recipe（03 §6.1 尾段），也不创建 create 操作（W1 CR-2）：
    // 不携带 runId/runRecipe/createOperationId。
    return { ok: true, acceptFields: {} };
  }

  async function precheckReopen(
    request: ReopenCloudTaskRequest,
    task: CloudTaskRecord,
  ): Promise<PrecheckResult> {
    if (task.status === "draft") {
      // draft 的首发走 start；reopen 是独立显式命令（03 §6）。
      return fail("validation_failed", "task-is-draft");
    }
    if (task.status === "completed") {
      // 08 §3.1：completed 需要先 reactivate（PR 未 merged）或新建 follow-up Task。
      return fail("validation_failed", "task-completed-requires-reactivate");
    }
    if (task.status === "archived") {
      return fail("validation_failed", "task-archived-requires-restore");
    }
    if (task.revision !== request.expectedTaskRevision) {
      return fail("stale", "task-revision-mismatch");
    }
    if (!task.taskBranch || !task.baseSha) {
      return fail("invalid_ref", "task-baseline-not-frozen");
    }
    // 08 §9 / 02 §2 不变量 5：重开前核验无有效写 run；旧实例终止未确认时拒绝自动重开。
    const eligibility = await verifyReopenEligibility(deps, task);
    if (!eligibility.ok) return eligibility;
    if (eligibility.value.lastRun) {
      // 旧写凭据先处置，再创建新 run（01 §7.2：不确定则不宣称 CAS 能拦旧 sandbox）。
      // revokeRun 由 W2 用真实时钟；端口不接受调用方时间（冻结口径）。
      await storage.credentials.revokeRun({
        runId: eligibility.value.lastRun.runId,
        reason: "superseded-by-reopen",
      });
    }
    const provider = await drivers.resolve(request.provider);
    if (!provider) return fail("validation_failed", "provider-not-configured");
    const providerCapabilities = await provider.describeCapabilities();
    const project = await storage.projects.get(task.projectId);
    if (!project?.repositoryId) return fail("not_found", "project-repository-missing");

    let resumeSha = task.baseSha;
    if (request.resume.mode === "checkpoint") {
      if (!task.lastCheckpointSha) {
        // 08 §9：没有 checkpoint 的任务只能显式选择从冻结 baseSha 重新开始。
        return fail("validation_failed", "no-confirmed-checkpoint");
      }
      const head = await github.getBranchHead({
        repositoryId: project.repositoryId,
        branch: task.taskBranch,
      });
      if (!head || !head.exists) {
        // 外部分支删除明确失败，不能默认 clone main 当成恢复（08 §9、CT-13/CT-19）。
        return fail("invalid_ref", "task-branch-missing");
      }
      if (head.sha !== task.lastCheckpointSha) {
        // 远端事实与最后确认 checkpoint 不一致：保留远端事实、不 force 覆盖，先对账。
        return fail("branch_conflict", "task-branch-head-mismatch");
      }
      resumeSha = task.lastCheckpointSha;
    }

    const frozenTemplate = await freezeTemplate(request.provider);
    if (!frozenTemplate.ok) return fail("unsupported_template", frozenTemplate.reason);

    const runId = ids.newId();
    const recipe: CloudExecutionRecipe = {
      provider: request.provider,
      ...frozenTemplate.fields,
      resources: { ...DEFAULT_SANDBOX_RESOURCES },
      baseSha: task.baseSha,
      resumeSha,
      firstCommandConfig: request.requestedConfig ?? {},
    };
    return {
      ok: true,
      acceptFields: {
        runId,
        runRecipe: recipe,
        taskBranch: task.taskBranch,
        lease: planRunLifetime({
          now: clock.now(),
          deploymentBudgetMs: config.hardRunDurationMs,
          ...(providerCapabilities.maxLifetimeSeconds === undefined
            ? {}
            : { providerMaxLifetimeSeconds: providerCapabilities.maxLifetimeSeconds }),
          deadlineSource: providerCapabilities.deadlineSource,
        }),
        createOperationId: ids.newId(),
      },
    };
  }
}
