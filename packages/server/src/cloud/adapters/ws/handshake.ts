/**
 * bridge 握手与 Ready 门控的控制面一侧（specs/cloud-agent 02 §5.1 初始认证与持久恢复、
 * §5.2 旋转响应丢失、§5.3 Ready 条件；01 §6.2 bootstrap 步骤）。
 *
 * 顺序固定：`hello`（凭据 hash 兑换 + epoch 接管）→ `welcome` → `bootstrap.config` → `ready`。
 * 任何一步失败都 fail-closed：不发布 ready、不用旧凭据重试，等下一次连接重装。
 */
import type { CloudBridgeControlFrame, CloudRunAddress } from "@zcode/shared";
import {
  CLOUD_BRIDGE_CAPABILITIES,
  bridgeLogger,
  sendFrame,
  type CloudBridgeContext,
  type LiveConnection,
} from "./types.js";

export interface HandshakeOutcome {
  /** 该帧是否已由握手路径处理（true 时不再进入入站路由）。 */
  handled: boolean;
}

export async function handleBridgeHandshake(
  context: CloudBridgeContext,
  connection: LiveConnection,
  frame: CloudBridgeControlFrame,
): Promise<HandshakeOutcome> {
  if (frame.type !== "bridge.hello") return { handled: false };
  const { storage, registry, clock, hash } = context;
  const logger = bridgeLogger(context);
  /** 握手拒绝统一出口：warn 带结构化 reason（不记 token/帧正文，02 §9）。 */
  const rejectHandshake = (reason: string, detail?: Record<string, string | number | boolean>) => {
    logger.warn(undefined, "bridge handshake rejected", {
      runId: connection.runId,
      reason,
      ...detail,
    });
  };
  const address: CloudRunAddress = frame.address;
  if (address.runId !== connection.runId || address.taskId !== connection.taskId) {
    // 路由由 socket 绑定；帧内地址不一致即整帧拒绝（02 §4 尾段）。
    rejectHandshake("address-mismatch", {
      socketRunId: connection.runId,
      frameRunId: address.runId,
      taskMatches: address.taskId === connection.taskId,
    });
    connection.socket.close(1008, "address-mismatch");
    return { handled: true };
  }
  const run = await storage.runs.get(connection.runId);
  if (!run || run.taskId !== connection.taskId) {
    rejectHandshake("run-not-found");
    connection.socket.close(1008, "run-not-found");
    return { handled: true };
  }
  if (run.runGeneration !== address.runGeneration) {
    rejectHandshake("stale-generation", {
      frameGeneration: address.runGeneration,
      currentGeneration: run.runGeneration,
    });
    // 旧代际连接不得复活（08 §4.2）：告知原因后关闭，不进入 welcome。
    sendFrame(connection, {
      protocolVersion: 1,
      type: "bridge.fault",
      faultCode: "stale",
      message: "stale run generation",
      retryable: false,
    });
    connection.socket.close(1008, "stale-generation");
    return { handled: true };
  }
  if (address.workspaceIdentity !== `cloud-task:${run.taskId}`) {
    // 身份必须与首次创建时固定的 cloud-task:<taskId> 一致（02 §2 不变量 1）。
    rejectHandshake("identity-mismatch");
    connection.socket.close(1008, "identity-mismatch");
    return { handled: true };
  }

  // 凭据只比较 hash，失败 fail-closed（02 §5.1）。
  const credential = await storage.credentials.consumeForHello({
    runId: run.runId,
    proofHash: await hash.sha256Hex(frame.credentialToken),
    candidateHash: await hash.sha256Hex(frame.candidateNextResumeToken),
    helloAttemptId: frame.helloAttemptId,
    now: clock.now(),
  });
  if (!credential) {
    // 凭据 hash 不匹配或已过期（端口只回 null，具体是过期还是未知由 W2 侧判定）。
    rejectHandshake("credential-rejected", { helloAttemptId: frame.helloAttemptId });
    sendFrame(connection, {
      protocolVersion: 1,
      type: "bridge.fault",
      faultCode: "unauthenticated",
      message: "bridge credential rejected",
      retryable: false,
    });
    connection.socket.close(1008, "credential-rejected");
    return { handled: true };
  }

  // 工作区一致性：路径由控制面在创建期计算并持久化（domain/workspacePath.ts 是唯一
  // 计算点）。hello 上报的值必须与持久事实**逐字节相同**，控制面不接受沙箱改写路径
  // （08 §4.1：workspacePath 来自 run 的已验证工作区描述；01 §6.2 步骤 2 防越界）。
  if (!run.workspacePath || address.workspacePath !== run.workspacePath) {
    rejectHandshake("workspace-path-mismatch", {
      hasPersistedWorkspace: run.workspacePath !== undefined,
    });
    sendFrame(connection, {
      protocolVersion: 1,
      type: "bridge.fault",
      faultCode: "validation_failed",
      message: "workspace path mismatch with persisted run workspace",
      retryable: false,
    });
    connection.socket.close(1008, "workspace-path-mismatch");
    return { handled: true };
  }

  // 新 socket 接管：epoch 由数据库 CAS 递增（同 socket 重复 hello 复用原值，02 §5.1）。
  const epoch =
    (await storage.runs.bumpConnectionEpoch({
      runId: run.runId,
      runGeneration: run.runGeneration,
      expectedEpoch: connection.connectionEpoch,
    })) ?? connection.connectionEpoch;
  connection.connectionEpoch = epoch;
  connection.runtimeIncarnation = frame.runtimeIncarnation;
  registry.register({
    taskId: run.taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
    connectionEpoch: epoch,
    // 地址以持久事实为准（与上面的校验一致，不采用上报值覆盖）。
    address: { ...address, workspacePath: run.workspacePath, connectionEpoch: epoch },
    ready: false,
    runtimeIncarnation: frame.runtimeIncarnation,
    connectedAt: clock.now(),
  });

  const ingestCursors = await storage.projections.ingestCursors({ runId: run.runId });
  // 握手成功：epoch 接管 + 能力/策略版本（不记 token、不记帧正文）。
  logger.info(undefined, "bridge welcome sent", {
    runId: run.runId,
    runGeneration: run.runGeneration,
    connectionEpoch: epoch,
    rotationIdPresent:
      typeof credential.rotationId === "string" && credential.rotationId.length > 0,
    capabilitiesCount: CLOUD_BRIDGE_CAPABILITIES.length,
    policyVersion: context.services().config.bootstrapPolicyVersion,
    ingestCursorStreams: ingestCursors.length,
  });
  sendFrame(connection, {
    protocolVersion: 1,
    type: "bridge.welcome",
    connectionEpoch: epoch,
    rotationId: credential.rotationId,
    capabilities: [...CLOUD_BRIDGE_CAPABILITIES],
    ingestCursors,
    policyVersion: context.services().config.bootstrapPolicyVersion,
  });

  // welcome 之后、ready 之前下发运行配置/clone 事实/envelope（02 §5.3、01 §6.2）。
  const bootstrap = await context.services().provisioning.bootstrapConfig.send({
    taskId: run.taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
    connectionEpoch: epoch,
  });
  if (!bootstrap.ok) {
    logger.warn(undefined, "cloud bootstrap config unavailable at handshake", {
      runId: run.runId,
      reason: bootstrap.reason,
    });
    sendFrame(connection, {
      protocolVersion: 1,
      type: "bridge.fault",
      faultCode: bootstrap.code,
      message: `bootstrap config unavailable: ${bootstrap.reason}`,
      retryable: false,
      connectionEpoch: epoch,
    });
  }
  return { handled: true };
}
