/**
 * run 授权判定（specs/cloud-agent 01 §7.1 授权与存放、§7.2 Git grant、08 §4.2 旧写权处置、
 * 09 §3 权限矩阵）。
 *
 * 边界（本轮收口）：本文件只做**判定**，不生成任何 grant 元数据。
 * - grantId / TTL / 绑定字段 / 单次兑换 CAS 全部由 `GitGrantBrokerPort`（W4 broker）一处定义；
 *   控制面签发路径（`app/gitGrants.ts`）只负责"授权成立与否 + 幂等复用"。
 * - `GIT_GRANT_TTL_MS` / `GitGrantPurpose` 的规范来源是端口层，这里原样转出。
 *
 * 规则：
 * - 终态 run 不得再签发/兑换 git 凭据（08 §3.2：终态不可复活）；
 * - 停止受理后不再签发新凭据（08 §8.1）；唯一例外是 **draining 的 checkpoint push**
 *   ——停止通路的依赖顺序本身要求「保存 → 再 terminate」，该写入是规格内的；
 * - 写能力（push）只在可写的 run 状态（ready/disconnected/draining）签发；clone/fetch
 *   允许在 provisioning（bootstrap 首次 clone 就发生在 ready 之前）；
 * - `runGeneration` 绑定由调用方（签发/兑换都带当前 generation）与 broker 的绑定字段共同保证；
 *   跨 run 的旧 writer 处置由 reopen 的 `reopenRequiresRecovery` 与 provider 终止核验负责。
 */
import type { CloudRunRecord, CloudTaskRecord } from "@zcode/shared";
import { isTerminalRunStatus } from "../../domain/taskRunState.js";
import type { GitGrantPurpose } from "../ports/gitGrantPort.js";
import { fail, ok, type CloudAppResult } from "../result.js";

export { GIT_GRANT_TTL_MS } from "../ports/gitGrantPort.js";
export type { GitGrantPurpose } from "../ports/gitGrantPort.js";

/** 可写 run 状态（08 §3.2）：ready/disconnected 常规写；draining 是停止通路的保存写。 */
const WRITABLE_RUN_STATUSES: ReadonlySet<string> = new Set(["ready", "disconnected", "draining"]);

export interface RunAuthorizationPolicy {
  /** run 是否具备写能力：终态/停止意图/状态不符时拒绝（08 §4.2、§8.1）。 */
  authorizeWrite(input: {
    run: CloudRunRecord;
    task: CloudTaskRecord;
  }): CloudAppResult<{ runId: string }>;
}

export function authorizeWrite(input: {
  run: CloudRunRecord;
  task: CloudTaskRecord;
}): CloudAppResult<{ runId: string }> {
  if (isTerminalRunStatus(input.run.status)) return fail("not_ready", "run-terminal");
  if (input.run.stopRequested && input.run.status !== "draining") {
    // 停止屏障：stop 受理后不再接纳写能力入口（08 §8.1）；draining 的保存写见 authorizeGitGrant。
    return fail("not_ready", "stop-requested");
  }
  if (!WRITABLE_RUN_STATUSES.has(input.run.status)) {
    return fail("not_ready", `run-${input.run.status}`);
  }
  if (input.task.status !== "active") return fail("not_ready", "task-not-active");
  return ok({ runId: input.run.runId });
}

/**
 * git grant 授权判定（签发前的唯一步骤，01 §7.2）：不生成元数据、不落库。
 * 失败码用于调用方分流：可自愈（外部临时不可用）由调用方记录并继续，其余让 run 以可读原因收口。
 */
export function authorizeGitGrant(input: {
  run: CloudRunRecord;
  task: CloudTaskRecord;
  purpose: GitGrantPurpose;
}): CloudAppResult<{ runId: string }> {
  if (isTerminalRunStatus(input.run.status)) return fail("not_ready", "run-terminal");
  if (input.purpose === "push") {
    // write lease：只在可写状态签发；draining 是停止通路的保存写（08 §8.1 依赖顺序）。
    const write = authorizeWrite(input);
    if (!write.ok) return write;
    return ok({ runId: input.run.runId });
  }
  // clone/fetch（只读凭据）：bootstrap 首 clone 发生在 ready 之前，因此允许 provisioning；
  // 但 stop 受理后不再签发（08 §8.1）。
  if (input.run.stopRequested) return fail("not_ready", "stop-requested");
  if (input.task.status === "archived" || input.task.status === "completed") {
    return fail("not_ready", "task-not-active");
  }
  return ok({ runId: input.run.runId });
}

export function createRunAuthorizationPolicy(deps: unknown): RunAuthorizationPolicy {
  void deps;
  return { authorizeWrite };
}
