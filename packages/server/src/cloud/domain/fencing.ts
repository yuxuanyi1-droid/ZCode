/**
 * 代际与连接纪元围栏（specs/cloud-agent/08 §4.2 代际和租约、02 §2 不变量 3、
 * 02 §5.1 epoch 接管）。
 *
 * 不变量：
 * - `runGeneration` 只在数据库事务中递增，旧 run 终态永久保留；旧代际帧、旧 ready、
 *   旧 ACK、旧 checkpoint 结果一律不得修改新 run（08 §4.2）。
 * - `connectionEpoch` 由当前有效 run 的每次接管递增；同 socket 重复 hello 复用原 epoch，
 *   旧 socket 不得继续投递或发布在线状态（02 §5.1）。
 * - 外部操作、凭据申请、投影 ingest 与输入投递都绑定 run+generation，仅稳定 identity
 *   不足以授权写入（08 §4.2）。
 */

export type FenceDecision =
  | { accepted: true }
  | { accepted: false; reason: "stale-generation" | "stale-epoch" };

export function isStaleGeneration(incomingGeneration: number, currentGeneration: number): boolean {
  return incomingGeneration !== currentGeneration;
}

export function isStaleEpoch(incomingEpoch: number, currentEpoch: number): boolean {
  return incomingEpoch < currentEpoch;
}

/** 帧/回调围栏：generation 必须精确相等，epoch 只在需要时校验（缺省不校验，如握手前）。 */
export function fenceFrame(input: {
  frameGeneration: number;
  currentGeneration: number;
  frameEpoch?: number;
  currentEpoch?: number;
}): FenceDecision {
  if (isStaleGeneration(input.frameGeneration, input.currentGeneration)) {
    return { accepted: false, reason: "stale-generation" };
  }
  if (
    input.frameEpoch !== undefined &&
    input.currentEpoch !== undefined &&
    isStaleEpoch(input.frameEpoch, input.currentEpoch)
  ) {
    return { accepted: false, reason: "stale-epoch" };
  }
  return { accepted: true };
}

/** 新 run 的代际 = 当前 nextRunGeneration（数据库事务内递增，08 §4.2）。 */
export function nextRunGeneration(currentNext: number): number {
  return Math.trunc(currentNext);
}

/**
 * 旧写权处置未决时拒绝自动重开（02 §2 不变量 5、08 §4.2）：
 * 结果不明时返回 recovery-required，而不是新建 run。
 */
export function reopenRequiresRecovery(input: {
  previousRunTerminalConfirmed: boolean;
  previousCredentialsRevoked: boolean;
}): boolean {
  return !(input.previousRunTerminalConfirmed && input.previousCredentialsRevoked);
}
