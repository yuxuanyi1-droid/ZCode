/**
 * 契约用法示例：只经端口完成两件事——
 * 1) 接纳一条 start 输入后向当前 attachment 投递首命令（03 §6.1）；
 * 2) 读只读投影填充 task detail，并解析模板引用（W1 CR-4/CR-5）。
 * 不触碰 SQLite、provider SDK 或 WS 实现细节。
 */
import type {
  AcceptInputRequest,
  ArtifactRead,
  AttachmentPort,
  ExecutionProjectionRead,
  SandboxTemplateResolverPort,
  StoragePort,
} from "./contract.js";

export async function acceptStartInputThenDeliver(
  deps: { storage: StoragePort; attachments: AttachmentPort },
  request: AcceptInputRequest,
): Promise<"accepted" | "duplicate" | "conflict"> {
  const result = await deps.storage.acceptInput(request);
  if (result.status !== "accepted") return result.status;
  if (result.runId === undefined) return "accepted";

  // 投递前必须读当前 attachment 事实：地址缺失不回落 host 执行域（03 §2）。
  const address = await deps.attachments.currentAddress(result.runId);
  if (!address) return "accepted";

  await deps.attachments.sendCommand({
    taskId: request.taskId,
    commandId: request.commandId,
    // 复用 V4 命令原信封；此处只示意形状，真实构造在 W1 的 durable gateway。
    envelope: { type: "createSession", commandId: request.commandId },
    expectation: {
      runGeneration: address.runGeneration,
      connectionEpoch: address.connectionEpoch,
      requireReady: true,
    },
  });
  return "accepted";
}

/**
 * task detail 的 execution/artifact 只读面：没有 runtime 事实时留空，不猜 idle；
 * PR 事实缺失时 reactivate 必须返回 not_implemented 语义（W1 CR-4）。
 */
export async function readTaskDetailProjections(
  deps: { execution: ExecutionProjectionRead; artifacts: ArtifactRead },
  taskId: string,
): Promise<{ executionStatus: string | null; prStatus: string | null }> {
  const execution = await deps.execution.readTaskExecution(taskId);
  const artifact = await deps.artifacts.read(taskId);
  return {
    executionStatus: execution?.status ?? null,
    prStatus: artifact?.prStatus ?? null,
  };
}

/** 模板引用 → 固定镜像/版本；解析不到即 fail-closed，不猜默认镜像（W1 CR-5）。 */
export async function resolveTemplateOrReject(
  resolver: SandboxTemplateResolverPort,
  request: { provider: string; templateRef?: string },
): Promise<{ imageRef: string; templateRevision: string } | null> {
  return resolver.resolve(request);
}
