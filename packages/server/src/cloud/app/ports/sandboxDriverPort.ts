/**
 * 沙箱 provider 端口草案（specs/cloud-agent/01 §4.1 内部接口草案、§4.3 期限与配额）。
 * W0 只冻结接口形状；E2B/Modal/Daytona 三个 adapter 的实现属 W3，控制面 app 只依赖
 * 本端口（domain→app→adapters 单向）。
 *
 * 关键约束：
 * - 各家能力不抹平：期限、资源、停止语义差异通过能力声明与显式能力错误表达，
 *   不支持的能力不伪造成功（01 §4.2/§4.3）。
 * - create 结果未知进入对账（按 operationKey），不得自动第二次 create；没有原生
 *   operation lookup 时必须允许返回 unknown（03 §5、01 §4.1）。
 * - labels/tags/metadata 只作 provider 侧对账键，**不得承载控制面数据**（taskId/workspacePath
 *   走 `bootstrapAddress`，秘密走 `bootstrap.config`），也不含 prompt、用户内容或凭据；
 *   bootstrapTicket 只经秘密注入通道（01 §6.2）。
 */
import type { CloudErrorCode, CloudDeadlineConfidence } from "@zcode/shared";

/** 能力声明（01 §4.1 describeCapabilities）：决定 UI 门控与控制面分支，不用于抹平差异。 */
export interface SandboxDriverCapabilities {
  /** 按 operationKey 查询 create 结果的能力；none 时只能靠运营确认。 */
  createOperationLookup: "native-key" | "metadata-search" | "none";
  canInspect: boolean;
  canExtendDeadline: boolean;
  canConfirmTermination: boolean;
  /**
   * 分级暂停/恢复能力（01 §4.1/§4.2 修订 2026-10-09）：memory=保留进程态（E2B 目标）；
   * disk=仅保留文件系统、进程态丢失的冷恢复（Daytona 目标）；none=不支持。
   * **实测解禁门禁（A-7）**：真实账号实测通过前，实现一律上报 "none"（fail-closed：
   * pause/resume 代码路径存在但不可达，不虚构暂停状态）。
   */
  pauseResume: "memory" | "disk" | "none";
  maxLifetimeSeconds?: number;
  /** provider 真实期限 vs 只能估计：估计值必须标 deadlineConfidence 并保守 drain。 */
  deadlineSource: "provider" | "estimated";
  supportsOutboundWss: boolean;
}

/** 资源规格（01 §4.1）：不满足时返回 resource_unsupported，不做静默降级。 */
export interface SandboxResources {
  cpu: number;
  memoryMiB: number;
  diskGiB: number;
}

export interface SandboxCreateInput {
  /** 持久 operationId：重试不更换，用于结果对账（03 §5）。 */
  operationKey: string;
  runId: string;
  runGeneration: number;
  /**
   * supervisor 在**连接之前**就必须知道的两个非秘密值（01 §6.2 步骤 1/2）：
   * - `taskId`：task 身份；supervisor 据此填 `bridge.hello.address.taskId`，
   *   `workspaceIdentity` 不在此传递（由冻结 helper 从 taskId 派生）；
   * - `workspacePath`：沙箱内 checkout 绝对路径，由控制面按 01 §6.2 步骤 2 **一处计算**
   *   （唯一计算点 `domain/workspacePath.ts`），同一值持久化到 `run.workspacePath` 并校验
   *   hello 上报值；identity 不作 cwd。
   *
   * **凭据绝不放这里**：bootstrap ticket 之外的秘密（provider/model envelope、git token）
   * 只走已认证的 `bootstrap.config`（12 §6）；本对象经 provider 命令通道下发，provider 侧可见。
   * 也不得改用 provider labels/tags/metadata 运输控制面数据（那是 provider 侧对账键）。
   */
  bootstrapAddress: { taskId: string; workspacePath: string };
  /** 版本/digest 固定的镜像引用，禁止 latest（01 §5.1 第 2 条）。 */
  imageRef: string;
  resources: SandboxResources;
  /** epoch 毫秒（01 §4.1 实施决议：与 V4 Timestamp 对齐）。 */
  requestedDeadline: number;
  publicControlPlaneUrl: string;
  /** 短效单次、绑定 run 的自举票据；无 App/provider key（01 §6.2）。 */
  bootstrapTicket: string;
  /**
   * **额外的** provider 标签（非保留、非秘密）。语义与 driver 实现严格对齐（01 §4.1）：
   *
   * - 保留键 `operationKey` / `runId` / `runGeneration` **由 driver 从输入顶层字段自动写入**
   *   provider 的 labels/metadata/tags（对账键的固定名见 `SANDBOX_RECONCILE_KEYS`）；
   *   **调用方不得把它们放进 `labels`**——传了会被 driver 确定性拒绝
   *   （`validation_failed: <channel> key reserved: <key>`）。这是有意的防线，不是 bug。
   * - 本字段只承载额外的非保留标签；键须匹配 `[A-Za-z0-9._-]{1,64}`、值非空且 ≤256 字符。
   * - 边界不变：不含 prompt、用户内容或凭据；provider labels/tags/metadata 对 provider API
   *   可见，**不得承载控制面数据**（taskId/workspacePath 走 `bootstrapAddress`，秘密走
   *   `bootstrap.config`）。
   */
  labels: Record<string, string>;
  signal: AbortSignal;
}

/** provider 句柄：不含浏览器 attach 凭据（01 §4.1）。 */
export interface ProviderSandboxHandle {
  provider: string;
  sandboxId: string;
  templateRevision?: string;
  /** provider 确认的期限（epoch 毫秒）。 */
  providerDeadline?: number;
  /** 只能估计时的估计值（epoch 毫秒）。 */
  deadlineEstimate?: number;
}

/**
 * 观测结论：network timeout、503、权限丢失不是 notFound（01 §4.1）。
 * `paused` 为 2026-10-09 生命周期 v2 增补（01 §4.1 修订）：暂停保留期的实例是**存在
 * 且被 provider 保留**的资源，不得被 keepalive liveness 按 stopped/notFound 收口；
 * 暂停保留期的存在性核对走 paused 态。
 */
export interface ProviderObservation {
  status: "running" | "paused" | "stopped" | "notFound" | "unknown";
  observedAt: number;
  evidenceSource: "provider-api" | "metadata-search" | "termination-confirmation" | "none";
  /**
   * 运营核对用的有界证据（如命中的 tag、状态原文要点，≤160 字符）；不得放凭据、
   * prompt 或私有代码（01 §9 审计边界）。
   */
  evidence?: string;
  errorCode?: CloudErrorCode;
}

/** create 对账结论：未知结果保留 operation/quota，不盲重试（03 §5）。 */
export type CreateReconciliation =
  | { status: "created"; handle: ProviderSandboxHandle }
  | { status: "notFound" }
  | { status: "unknown"; errorCode: CloudErrorCode };

/** 续期结论：不支持返回 unsupported（能力错误），不伪造成功（01 §4.3）。 */
export type DeadlineResult =
  | { status: "confirmed"; expiresAt: number }
  | { status: "estimated"; deadlineEstimate: number; deadlineConfidence: CloudDeadlineConfidence }
  | { status: "unsupported" };

/**
 * 控制面在 handle 持久化之后启动沙箱内 supervisor 所需的自举要素
 * （01 §5.1 第 3 条：create 成功**立即持久 handle/deadline，再等 bridge**）。
 *
 * 字段与实现侧（W3 `adapters/sandbox/sandboxSupervisorStart.ts` 的 `SupervisorStartInput`）
 * 逐字对齐；类型定义在端口层，adapter 引用本类型，避免 `app/**` 反向依赖 adapters。
 */
export interface SandboxSupervisorStartInput {
  operationKey: string;
  runId: string;
  runGeneration: number;
  publicControlPlaneUrl: string;
  bootstrapTicket: string;
  taskId: string;
  workspacePath: string;
}

/** 终止结论：确认前资源槽与配额不释放（01 §4.3、08 §6）。 */
export type TerminationObservation =
  | { status: "terminated" }
  | { status: "notTerminated"; errorCode?: CloudErrorCode }
  | { status: "unknown"; errorCode?: CloudErrorCode };

export interface SandboxDriverPort {
  describeCapabilities(): Promise<SandboxDriverCapabilities>;
  create(input: SandboxCreateInput): Promise<ProviderSandboxHandle>;
  /**
   * 唯一 worker 用持久租约串行调用；未知结果进 reconcile，不自动第二次 create。
   *
   * `operationAttemptedAtMs` 是控制面持久的 create 尝试时间（durable 事实由 W1 提供）：
   * 只有明显晚于该时刻的查询窗口内仍无命中，才允许判 `notFound`（可安全重试）；窗口内
   * 一律回 `unknown` 保守对账，避免把「provider 元数据尚未可见」误判成「从未创建」。
   */
  findCreateResult(
    operationKey: string,
    options?: { operationAttemptedAtMs?: number },
  ): Promise<CreateReconciliation>;
  /**
   * 拉起沙箱内 supervisor（01 §5.1 第 3 条：**持久 handle/deadline 之后**才启动）。
   * 正常 create 路径与对账恢复路径都必须调用；失败即补偿终止，不留"看起来在 provisioning"
   * 的状态（01 §9）。
   */
  startSupervisor(handle: ProviderSandboxHandle, input: SandboxSupervisorStartInput): Promise<void>;
  inspect(handle: ProviderSandboxHandle): Promise<ProviderObservation>;
  /**
   * `requestedDeadlineMs` 为 epoch 毫秒。spec 01 §4.1 的 `create.requestedDeadline`
   * 已明确改用 epoch 毫秒替换 ISO 字符串，extendDeadline 的 string 是同一节内的
   * 遗留写法；W0 统一为毫秒（见 W0 报告的契约变更请求 CR-2）。
   */
  extendDeadline(
    handle: ProviderSandboxHandle,
    requestedDeadlineMs: number,
  ): Promise<DeadlineResult>;
  terminate(handle: ProviderSandboxHandle): Promise<TerminationObservation>;
  /**
   * 暂停沙箱（01 §4.1 修订 2026-10-09）。返回 provider 确认的 paused 观察才算暂停成功；
   * 确认前不得写 run=paused（B-4 顺序冻结：checkpoint(如需)→provider paused 确认→
   * detach registry→status=paused，watchdog 显式跳过 paused）。
   *
   * **门禁（A-7）**：`describeCapabilities().pauseResume === "none"` 时实现必须抛
   * `resource_unsupported` 能力错误（"capability-not-enabled"），不得发起 provider 请求、
   * 不得伪造 paused 观察——未实测核实的 provider 一律按 none 行为（fail-closed）。
   */
  pause(handle: ProviderSandboxHandle): Promise<ProviderObservation>;
  /**
   * 恢复同一沙箱（同 run 同 generation，不换代、不重开；01 §4.1 修订）。失败不换代、
   * 不改写原 run。`requestedDeadline` 为 epoch 毫秒：恢复通路同步续展 provider 期限、
   * run 租期与 bridge 凭据有效期（B-6；收敛于能力上限，不放大）。
   *
   * 门禁同 `pause`：能力为 none 时抛 `resource_unsupported`，路径不可达。
   */
  resume(handle: ProviderSandboxHandle, requestedDeadline: number): Promise<ProviderObservation>;
}

/** 解析后的模板事实：镜像引用与版本固定，禁止 latest（01 §5.1 第 2 条）。 */
export interface ResolvedSandboxTemplate {
  imageRef: string;
  templateRevision: string;
}

/**
 * 模板解析端口（W1 CR-5）：由 W3 的沙箱资产目录实现（`loadSandboxAssetCatalog`），
 * 控制面 provisioning 在冻结 Run recipe 时消费，把 `templateRef` 解析成固定的
 * `imageRef`/`templateRevision`。
 *
 * fail-closed：解析不到返回 null，调用方按 `unsupported_template` 拒绝，绝不猜默认
 * 镜像、也不在 worker 里临时替换模板（01 §7.3「provider 能力变化或所需版本不可用返回
 * 明确失败，不在 worker 中替换模板或 provider」）。
 */
export interface SandboxTemplateResolverPort {
  resolve(request: {
    provider: string;
    /** 缺省表示使用该 provider 的受控默认模板；部署未配置默认模板时同样返回 null。 */
    templateRef?: string;
  }): Promise<ResolvedSandboxTemplate | null>;
}
