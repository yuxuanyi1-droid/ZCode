/**
 * app 层端口 bundle（W1 §3：runOrchestrator/taskService/... 全部只依赖端口）。
 *
 * 这里只做「把 W0 冻结的端口与 W1 新增的窄端口聚合成一个依赖对象」，
 * 不含任何实现：SQLite、provider SDK、GitHub、Hono 都不在此层出现（W1 §5）。
 */
import type { AttachmentPort } from "./ports/attachmentPort.js";
import type { ArtifactRead, ExecutionProjectionRead } from "./ports/projectionPort.js";
import type { InteractionDecisionRepo } from "./ports/inputPort.js";
import type { GitGrantBrokerPort } from "./ports/gitGrantBrokerPort.js";
import type { GitGrantStore } from "./ports/gitGrantPort.js";
import type { ProvisioningEnvelopeSource } from "./ports/provisioningEnvelopePort.js";
import type { SandboxTemplateResolverPort } from "./ports/sandboxDriverPort.js";
import type { ClockPort } from "./ports/clockPort.js";
import type { GitHubPort } from "./ports/gitHubPort.js";
import type { HashPort } from "./ports/hashPort.js";
import type { IdGeneratorPort } from "./ports/idGeneratorPort.js";
import type { OperationOutboxPort } from "./ports/operationOutboxPort.js";
import type { RuntimeCommandQueryPort } from "./ports/runtimeCommandQueryPort.js";
import type { SandboxDriverRegistryPort } from "./ports/sandboxDriverRegistryPort.js";
import type { SandboxRuntimeSettingsPort } from "./ports/sandboxRuntimeSettingsPort.js";
import type { StoragePort } from "./ports/storagePort.js";
import type { CloudCoreConfig } from "./config.js";

export interface CloudCoreDeps {
  /** 唯一持久入口（03 §4）；事务语义由实现承担（acceptInput/readiness）。 */
  storage: StoragePort;
  /** 外部操作 outbox（03 §5）：租约串行 + ambiguous 对账。 */
  operations: OperationOutboxPort;
  /** 仓库授权与远端事实（09 §2.2、11 §4.3）。 */
  github: GitHubPort;
  /** provider driver 解析（01 §4.2；不无声换 provider）。 */
  drivers: SandboxDriverRegistryPort;
  /**
   * 沙箱运行时账号设置（01 §4.3/§5.1 修订 2026-10-08）：capabilities 投影的
   * `apiKeyConfigured` 与 env 核实上限来源。未接线（测试/嵌入装配）时 providers 投影
   * 按「env 装配校验已通过」处理（apiKeyConfigured=true），不伪造端口。
   */
  sandboxRuntimeSettings?: SandboxRuntimeSettingsPort;
  /** 控制面 → attachment（02 §6.1 唯一投递出口）。 */
  attachments: AttachmentPort;
  /** runtime 命令事实查询（03 §7.2 对账；ACK 丢失不重复副作用）。 */
  runtimeCommands: RuntimeCommandQueryPort;
  clock: ClockPort;
  ids: IdGeneratorPort;
  hash: HashPort;
  config: CloudCoreConfig;
  /**
   * 模板解析（W3 沙箱资产目录，CR-5）：把 recipe 的 `templateRef` 解析成固定的
   * imageRef/templateRevision。未接线时 recipe 必须自带 `imageDigest`，否则明确失败
   * （不猜默认镜像，01 §7.3）。
   */
  templates?: SandboxTemplateResolverPort;
  /**
   * 交互决定的持久投递记录（CR-3，03 §4 `task_input_interaction_decisions`）。
   * 未接线时决定只做围栏 + 传输投递，返回结构化 `not_implemented`（不伪造持久 receipt）。
   */
  interactionDecisions?: InteractionDecisionRepo;
  /** 执行投影读取（CR-4）：未接线时任务详情不返回 `execution`（不猜 idle，08 §3.3）。 */
  executionProjections?: ExecutionProjectionRead;
  /** 产物投影读取（CR-4）：未接线时详情不返回 `artifact`，reactivate 无法核验 PR 状态。 */
  artifacts?: ArtifactRead;
  /** provisioning envelope 来源（12 §6，host 侧账号态/静态 fallback）。 */
  provisioningEnvelope?: ProvisioningEnvelopeSource;
  /**
   * git grant 持久 store（01 §7.2）：控制面签发时的幂等查询。
   * 未接线（部署未配置 GitHub App / 注入的是裸 StoragePort）时签发按 `not_configured`
   * fail-closed，不伪造 grant（01 §7.1/§9）。
   */
  gitGrantStore?: GitGrantStore;
  /** git grant 的 token 机制（W4 broker）：mint / 单次兑换 CAS / TTL / 撤销。 */
  gitGrantBroker?: GitGrantBrokerPort;
}
