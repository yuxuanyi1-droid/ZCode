/**
 * bridge 凭据端口（specs/cloud-agent 02 §5.1/§5.2：只持久 hash + 候选恢复）。
 * W2 实现。
 */
export interface RunCredentialRepo {
  saveInitial(request: {
    runId: string;
    runGeneration: number;
    credentialHash: string;
    expiresAt: number;
    bootstrapOperationId: string;
  }): Promise<void>;
  /** 事务校验 hash/时效并消费初始凭据；失败 fail closed（02 §5.1 第 3 条）。 */
  consumeForHello(request: {
    runId: string;
    proofHash: string;
    candidateHash: string;
    helloAttemptId: string;
    now: number;
  }): Promise<{ rotationId: string } | null>;
  /**
   * 旋转响应丢失后的同 attempt 恢复：内容一致复用 rotationId，不一致拒绝（02 §5.2）。
   * **不接受 `now`**（W2 口径确认）：时效/审计时间用 worker 真实时钟。
   */
  recoverByAttempt(request: {
    runId: string;
    helloAttemptId: string;
    candidateHash: string;
  }): Promise<{ rotationId: string; committed: boolean } | null>;
  /**
   * **非消费**校验：只读地确认该 proof 仍是该 run 的当前有效凭据（01 §7.2 run-scoped 认证）。
   *
   * 与 `consumeForHello` 的区别：不旋转 hash、不写 helloAttempt —— 那些是握手语义。执行
   * 节点出站端点（git-grant）必须用本方法：调 `consumeForHello` 会打断 bridge 重连。
   * 判定口径照 `run_credentials` 现有列（不加列）：hash 恒定时间比较、`revoked_at IS NULL`、
   * `expires_at > now`；`used_at` 不参与判定（初始票被 hello 消费后 hash 已切换为当前凭据）。
   */
  verifyActiveCredential(request: {
    runId: string;
    /** sha256(Bearer) 的 hex。 */
    proofHash: string;
    now: number;
  }): Promise<{ runGeneration: number } | null>;
  /**
   * 撤销该 Run 的全部凭据（终止/回收）。
   * **不接受 `now`**（W2 口径确认）：审计时间用 worker 真实时钟。
   */
  revokeRun(request: { runId: string; reason: string }): Promise<number>;
}
