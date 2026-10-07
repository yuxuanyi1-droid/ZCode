/**
 * provisioning envelope 注入缝（specs/cloud-agent 12 §6 envelope 安装、01 §6.2 步骤 1/6）。
 *
 * 来源唯一：host 本体的 `providerProvisioningSource`（账号登录态）或静态 `config.model`
 * 单一配置源，**二选一互斥**的选择逻辑在 host 侧，控制面只调用本端口、不自己拼 envelope，
 * 也不复制账号域的 schema（`bootstrap.config.provisioningEnvelopeJson` 在 shared 侧只
 * 冻结为有界字符串，内部结构归 provisioning 契约所有）。
 *
 * 返回 `null` 表示当前无法为这个 run 组装 envelope（未登录/未配置）：调用方按
 * `not_configured` fail-closed，不伪造默认模型、不静默跳过 ready 前置。
 */
export interface ProvisioningEnvelopeForRun {
  /** 有界 JSON 字符串（上限见 shared `CLOUD_BOOTSTRAP_ENVELOPE_JSON_MAX_CHARS`）。 */
  envelopeJson: string;
  /** 账号/app 凭据代际：供执行节点核对（12 §6 A-08）。 */
  credentialGeneration: number;
}

export interface ProvisioningEnvelopeSource {
  buildProvisioningEnvelopeJsonForRun(input: {
    taskId: string;
    runId: string;
    runGeneration: number;
  }): Promise<ProvisioningEnvelopeForRun | null>;
}
