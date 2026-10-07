/**
 * run ↔ runtime session 映射解析（02 §6.2：「控制面保存 receipt commandId 与 runtime
 * query key/sessionId 的映射，不因重连重造会话」；03 §7.2 发送/查询都用同一 query key）。
 *
 * 来源优先级：
 * 1. run 记录自身的 runtimeSessionId（持久层已写入时）；
 * 2. 首输入 receipt 上由 ACK 路径落地的 runtimeSessionId（createSession 的 ACK 携带
 *    sessionId，`InputRepo.markDelivery` 写入；firstInputCommandId 在接纳事务中冻结，
 *    因此该映射是稳定可查的）。
 *
 * 说明：W0 冻结的 `RunRepo` 没有写 `runtimeSessionId` 的方法，因此控制面以第 2 项为准；
 * 若 W2 选择在 ACK 落地时同步写 run，则第 1 项先命中，语义不变（见报告契约说明）。
 */
import type { CloudRunRecord } from "@zcode/shared";
import type { CloudCoreDeps } from "./deps.js";

export async function resolveRuntimeSession(
  deps: CloudCoreDeps,
  run: CloudRunRecord,
): Promise<string | undefined> {
  if (run.runtimeSessionId) return run.runtimeSessionId;
  if (!run.firstInputCommandId) return undefined;
  const first = await deps.storage.inputs.get(run.taskId, run.firstInputCommandId);
  return first?.runtimeSessionId;
}
