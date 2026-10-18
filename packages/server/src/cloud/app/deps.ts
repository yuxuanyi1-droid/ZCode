/**
 * app 层端口 bundle（W1 §3：runOrchestrator/taskService/... 全部只依赖端口）。
 *
 * 这里只做「把 W0 冻结的端口与 W1 新增的窄端口聚合成一个依赖对象」，
 * 不含任何实现：SQLite、provider SDK、GitHub、Hono 都不在此层出现（W1 §5）。
 */
import type { AttachmentPort } from "./ports/attachmentPort.js";
import type { BrowserWatchPort } from "./ports/browserWatchPort.js";
import type { ArtifactRead, ExecutionProjectionRead } from "./ports/projectionPort.js";
import type { InteractionDecisionRepo } from "./ports/inputPort.js";
import type { ControlPlaneRpcPort } from "./ports/controlPlaneRpcPort.js";
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
import type { UserPreferencesPort } from "./ports/userPreferencesPort.js";
import type { UserProfileStorePort } from "./ports/userProfileStorePort.js";
import type { CloudCoreConfig } from "./config.js";
import type { CredentialCipherProvider } from "@zcode/services/node";

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
  /**
   * 控制面 RPC 会话（M8；14 §4.2/§4.6）：连接期用户资源同步经它调沙箱既有 sync 服务
   * （`rpc.*` 帧 + `serviceScope: "control-plane"`）。未接线（测试/嵌入装配）时同步
   * 按 `not_configured` fail-closed，不伪造成功；其它控制面功能不受影响。
   */
  controlPlaneRpc?: ControlPlaneRpcPort;
  /**
   * 浏览器观看事实（08 §7 空闲 pause 的连接条件）：该 run 是否有打开的
   * `/ws/cloud/tasks/:taskId` 观看流。未接线（测试/嵌入装配）视为无人观看，
   * 不阻塞空闲 pause——事实缺失不虚构「有人看着」。
   */
  browserWatch?: BrowserWatchPort;
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
  /**
   * 用户资源 profile store（M8；14 §9.2①）：上传用例与连接期同步都经它。
   * 未接线（测试/嵌入装配）时上传端点按 `not_configured`(503) fail-closed，不伪装空
   * profile。
   */
  userProfile?: UserProfileStorePort;
  /**
   * 用户资源 profile 的凭据信封加密（M8 / R4；14 §5）：mcp-config（token/headers/env）
   * 落库前加密、回显与连接期同步前解密。未接线时由服务用部署密钥
   * （`ZCODE_CREDENTIAL_SECRET`，与 host 凭据同一 provider）构造；测试可注入固定密钥实例。
   */
  credentialCipher?: CredentialCipherProvider;
  /**
   * 账号行为偏好读取（M8；14 §6/§9.2⑥）：`bootstrap.config.preferences` 的唯一来源。
   * 未接线时不下发 `preferences` 块、不 fail（偏好缺失不是 run 失败条件）。
   */
  userPreferences?: UserPreferencesPort;
}
