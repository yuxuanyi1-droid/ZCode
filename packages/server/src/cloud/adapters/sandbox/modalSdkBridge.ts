/**
 * Modal 控制面 SDK 桥（specs/cloud-agent/01 §4.2/§6.2）：桥契约与错误归一。
 *
 * 为什么是子进程（01 §6.2 实施决议）：Modal 的官方控制面只有 Python/JS/Go SDK
 * （gRPC），**没有文档化的 HTTP/REST 沙箱 API**，不得手写 gRPC 网关。因此控制面以
 * **官方 Python SDK** 为调用面，通过一次性受控子进程桥完成单次操作：请求 JSON 经
 * stdin 进，响应 JSON（带哨兵的一行）经 stdout 出，进程随即退出。沙箱留在 provider
 * 侧（detach 语义见 modal/modal_bridge.py 头注释），控制面重启不需要重新拉起桥。
 *
 * 凭据边界（01 §7.1）：TokenPair 只经子进程 env 传入，不进 argv、不进日志、不进
 * provider tags；请求体（含 bootstrap ticket）只经 stdin，禁止写日志/落盘。
 *
 * 错误分类（与 sandboxRest 同一三分支语义，差异不抹平）：
 * - 桥报告 `definite: true`（请求校验/依赖缺失/镜像构建失败/provider 明确拒绝）
 *   → 明确失败；
 * - `definite: false`（网络/服务/超时）与进程级失败（超时被杀、无响应行、abort）
 *   → 结果未知，由控制面按 operationKey 对账（01 §5.3）。
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxCreateInput } from "../../app/ports/sandboxDriverPort.js";
import { CloudAdapterError, type CloudAdapterLogger } from "./adapterError.js";
import {
  buildModalChildEnv,
  MODAL_BRIDGE_PROTOCOL,
  MODAL_BRIDGE_RESPONSE_SENTINEL,
  runModalBridgeProcess,
  type ModalBridgeFailure,
  type ModalBridgeOutcome,
} from "./modalBridgeProcess.js";
import { buildReconcileLabels } from "./reconcile.js";

export {
  MODAL_BRIDGE_PROTOCOL,
  MODAL_BRIDGE_RESPONSE_SENTINEL,
  type ModalBridgeFailure,
  type ModalBridgeFailureKind,
  type ModalBridgeOutcome,
} from "./modalBridgeProcess.js";

/** 默认解释器与 App 名（部署可用配置覆盖，见 README）。 */
export const MODAL_DEFAULT_PYTHON = "python3";
export const MODAL_DEFAULT_APP_NAME = "zcode-cloud-agent";

/**
 * 桥脚本默认路径：与本模块同目录的 `modal/modal_bridge.py`（源码布局）。
 * 打包/镜像部署若改变布局，必须由入口配置显式传入 `scriptPath`——不在适配层散读
 * 环境变量做 fallback（配置只有 W5 的公开配置契约一个入口）。
 */
export function defaultModalBridgeScriptPath(): string {
  const selfDir = dirname(fileURLToPath(import.meta.url));
  return join(selfDir, "modal", "modal_bridge.py");
}

/**
 * 单次操作超时。create 含 Modal 端镜像构建（首建可能数分钟）→ 15min；其余操作都是
 * 单次 RPC（attach/poll/terminate 亚秒级），给 60s 余量。
 */
export const MODAL_BRIDGE_TIMEOUTS_MS = {
  probe: 60_000,
  create: 900_000,
  exec: 120_000,
  terminate: 60_000,
  inspect: 60_000,
  list: 60_000,
} as const;

export type ModalBridgeOp = keyof typeof MODAL_BRIDGE_TIMEOUTS_MS;

export interface ModalBridgeCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** 控制面 driver 依赖的最小桥接口（测试可注入假实现）。 */
export interface ModalSdkBridge {
  call(
    op: ModalBridgeOp,
    payload: Record<string, unknown>,
    options?: ModalBridgeCallOptions,
  ): Promise<ModalBridgeOutcome>;
}

export interface ModalSdkBridgeOptions {
  /** TokenPair 经注入函数读取；只经子进程 env 传入，不进 URL/日志/tags。 */
  tokenId: () => string | Promise<string>;
  tokenSecret: () => string | Promise<string>;
  /** 装载 `modal` 包的解释器（venv 部署必须显式指定）。 */
  pythonPath?: string;
  /** 桥脚本路径；缺省按模块位置推导（打包部署必须显式传入）。 */
  scriptPath?: string;
  logger?: CloudAdapterLogger;
}

export function createModalSdkBridge(options: ModalSdkBridgeOptions): ModalSdkBridge {
  const pythonPath = options.pythonPath?.trim() || MODAL_DEFAULT_PYTHON;
  const scriptPath = options.scriptPath?.trim() || defaultModalBridgeScriptPath();
  const logger = options.logger;

  async function call(
    op: ModalBridgeOp,
    payload: Record<string, unknown>,
    callOptions: ModalBridgeCallOptions = {},
  ): Promise<ModalBridgeOutcome> {
    const timeoutMs = callOptions.timeoutMs ?? MODAL_BRIDGE_TIMEOUTS_MS[op];
    // 凭据为空即拒绝：绝不用「空 token + 操作者 home 下的 ~/.modal.toml」跑真实账号。
    const tokenId = (await options.tokenId()).trim();
    const tokenSecret = (await options.tokenSecret()).trim();
    if (!tokenId || !tokenSecret) {
      return {
        ok: false,
        failure: {
          kind: "bridge",
          code: "validation_failed",
          definite: true,
          reason: "credentials-missing",
        },
      };
    }
    const request = JSON.stringify({ protocol: MODAL_BRIDGE_PROTOCOL, op, ...payload });
    const startedAt = Date.now();
    const outcome = await runModalBridgeProcess({
      command: pythonPath,
      scriptPath,
      request,
      timeoutMs,
      ...(callOptions.signal === undefined ? {} : { signal: callOptions.signal }),
      env: buildModalChildEnv(tokenId, tokenSecret),
    });
    // 只记录操作级事实（op/耗时/失败类别）；请求体与凭据绝不入日志。
    logger?.debug(undefined, "modal bridge call finished", {
      op,
      ok: outcome.ok,
      elapsedMs: Date.now() - startedAt,
      ...(outcome.ok ? {} : { kind: outcome.failure.kind, reason: outcome.failure.reason }),
    });
    return outcome;
  }

  return { call };
}

/** 桥报告的失败 → 归一错误（明确失败）。 */
export function modalBridgeDefiniteError(
  operation: string,
  failure: ModalBridgeFailure,
): CloudAdapterError {
  const suffix = failure.stage ? ` (${failure.stage})` : "";
  return new CloudAdapterError(
    failure.code,
    `modal ${operation} failed: ${failure.reason}${suffix}`,
    {
      operation,
      ...(failure.stage === undefined ? {} : { stage: failure.stage }),
      ...(failure.detail === undefined ? {} : { detail: failure.detail.slice(0, 200) }),
    },
  );
}

/**
 * 结果未知（与 sandboxRest.unknownOutcomeError 同一码表：create/terminate 有副作用的
 * 操作分别进对账；查询类归 provider_unreachable）。绝不写成明确失败。
 */
export function modalBridgeUnknownOutcome(
  operation: "create" | "terminate" | "query",
  failure: ModalBridgeFailure,
): CloudAdapterError {
  const code =
    operation === "create"
      ? "provider_create_unknown"
      : operation === "terminate"
        ? "provider_termination_unknown"
        : "provider_unreachable";
  const cause = failure.kind === "bridge" ? failure.reason : failure.kind;
  return new CloudAdapterError(
    code,
    `modal ${operation} result unknown (${cause}); reconcile before retrying`,
    { operation, cause },
  );
}

/**
 * Modal tags（01 §4.1：只含 operationKey/runId/runGeneration 与调用方标签，无
 * prompt、用户内容或凭据）。保留键占用/格式越界 → validation_failed（与 E2B/Datona 同规则）。
 */
export function buildModalTags(input: SandboxCreateInput): Record<string, string> {
  return buildReconcileLabels(input, "tag");
}
