/**
 * 浏览器命令路由（03 §7.1 沙箱通道分面、§7.2「HTTP 创建首输入与 RPC 发送后续输入不是两套
 * 执行路径」、02 §6.1 唯一写入路径、CP-11）。
 *
 * 两条要求：
 * 1. 浏览器经 `/ws/cloud/tasks/:taskId` 发送的输入，与 HTTP `/inputs` 走**同一个**
 *    durable gateway（本文件只做鉴权/围栏/转发，不复制接纳规则）。
 * 2. 未 ready 或该 Run 没有有效 attachment 时返回结构化 not-ready：绝不回落 host 本机
 *    执行域（03 §2 边界、CP-11）。
 */
import type { CloudAttachmentAddress, InputReceipt } from "@zcode/shared";
import { fenceFrame } from "../../domain/fencing.js";
import type { CloudCoreDeps } from "../deps.js";
import { fail, type CloudAppResult } from "../result.js";
import type { AttachmentRegistry } from "./registry.js";
import type { CloudInputRequest, InputGateway } from "../inputDelivery/gateway.js";

export interface CloudCommandRouter {
  /** `/ws/cloud/tasks/:taskId` 升级时解析执行目标（无有效 attachment 时明确拒绝）。 */
  resolveExecutionTarget(input: {
    principalId: string;
    taskId: string;
    expectedRunGeneration?: number;
  }): Promise<CloudAppResult<CloudAttachmentAddress>>;
  /** RPC 发送：转同一 gateway，不另建写入路径。 */
  send(input: {
    principalId: string;
    taskId: string;
    request: CloudInputRequest;
  }): Promise<CloudAppResult<InputReceipt>>;
}

export function createCloudCommandRouter(
  deps: CloudCoreDeps,
  registry: AttachmentRegistry,
  gateway: InputGateway,
): CloudCommandRouter {
  const { storage } = deps;

  return {
    async resolveExecutionTarget(input) {
      const task = await storage.tasks.get(input.taskId);
      if (!task || task.ownerPrincipalId !== input.principalId)
        return fail("not_found", "task-not-found");
      const run = await storage.runs.activeOfTask(task.taskId);
      if (!run) return fail("not_ready", "no-active-run");
      if (input.expectedRunGeneration !== undefined) {
        const fence = fenceFrame({
          frameGeneration: input.expectedRunGeneration,
          currentGeneration: run.runGeneration,
        });
        // 旧期待值拒绝，不能静默改为新 run 后执行（02 §4）。
        if (!fence.accepted) return fail("stale", fence.reason);
      }
      if (run.status !== "ready") return fail("not_ready", `run-${run.status}`);
      const session = registry.current(run.runId);
      if (!session?.ready) return fail("not_ready", "no-attachment");
      return { ok: true, value: session.address };
    },

    async send(input) {
      return gateway.submit({
        principalId: input.principalId,
        taskId: input.taskId,
        request: input.request,
        source: "rpc",
      });
    },
  };
}
