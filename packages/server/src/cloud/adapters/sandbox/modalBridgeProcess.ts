/**
 * Modal 桥子进程执行层（specs/cloud-agent/01 §4.2/§6.2）：spawn + 行协议 + 归一。
 *
 * 与 modalSdkBridge.ts 分工：本文件只管「怎么把一次 JSON 请求交给官方 SDK 子进程、
 * 怎么把结果/失败拿回来」——spawn、stdin 写入、stdout 哨兵行解析、超时/取消/进程级
 * 失败分类、子进程最小环境。桥契约、错误映射与载荷构造在 modalSdkBridge.ts。
 *
 * 协议（与 modal/modal_bridge.py 对应）：请求 = 一个 JSON 对象写 stdin 后关闭；
 * 响应 = stdout 上**最后一行**以 MODAL_BRIDGE_RESPONSE_SENTINEL 开头的 JSON。
 * 用哨兵行而不是「整体 stdout 是 JSON」，因为官方 SDK 会往 stdout 打进度/警告，
 * 任何噪声都不得破坏协议。
 *
 * 凭据边界（01 §7.1）：TokenPair 只经子进程 env 传入；请求体（含 bootstrap ticket）
 * 只经 stdin；两者都不进 argv、不进日志、不落盘。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCloudErrorCode, type CloudErrorCode } from "@zcode/shared";

/** 桥协议版本（桥脚本与 TS 侧必须一致；不一致即协议失败，不猜测）。 */
export const MODAL_BRIDGE_PROTOCOL = 1;
export const MODAL_BRIDGE_RESPONSE_SENTINEL = "##ZCODE-BRIDGE-RESPONSE##";

/** 进程级失败类别；provider 拒绝类失败用 kind="bridge"。 */
export type ModalBridgeFailureKind = "bridge" | "spawn" | "timeout" | "aborted" | "protocol";

export interface ModalBridgeFailure {
  kind: ModalBridgeFailureKind;
  /** 归一错误码；进程级失败给 provider_unreachable，由调用方按操作改判未知码。 */
  code: CloudErrorCode;
  /** 能否判定「provider 侧未生效」；false → 结果未知，必须对账（01 §5.3）。 */
  definite: boolean;
  /** 固定 reason 词表或进程级原因（有界、不含请求内容）。 */
  reason: string;
  /** 桥报告的错误阶段（有界诊断）。 */
  stage?: string;
  /** 桥报告的有界诊断摘要（已脱敏，不含凭据）。 */
  detail?: string;
}

export type ModalBridgeOutcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; failure: ModalBridgeFailure };

export interface ModalBridgeProcessInput {
  command: string;
  scriptPath: string;
  request: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env: NodeJS.ProcessEnv;
  /** 协议版本（测试可注入其它版本覆盖 protocol-mismatch 分支）。 */
  protocol?: number;
}

const MAX_BUFFERED_LINE_BYTES = 8 * 1024 * 1024;

export function runModalBridgeProcess(input: ModalBridgeProcessInput): Promise<ModalBridgeOutcome> {
  const protocol = input.protocol ?? MODAL_BRIDGE_PROTOCOL;
  return new Promise((resolve) => {
    let settled = false;
    let responseLine: string | undefined;
    let stdoutBuffer = "";
    let stderrTail = "";
    let overflow = false;
    const finish = (outcome: ModalBridgeOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(input.command, [input.scriptPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: input.env,
      });
    } catch (error) {
      finish(spawnFailure("spawn-failed", error));
      return;
    }
    const timer = setTimeout(() => {
      killChild(child);
      finish({
        ok: false,
        failure: {
          kind: "timeout",
          code: "provider_unreachable",
          definite: false,
          reason: `timeout-${input.timeoutMs}ms`,
        },
      });
    }, input.timeoutMs);
    const onAbort = (): void => {
      killChild(child);
      finish({
        ok: false,
        failure: {
          kind: "aborted",
          code: "provider_unreachable",
          definite: false,
          reason: "aborted",
        },
      });
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    // 解释器不存在（ENOENT）：进程从未运行 → 不可能有 provider 副作用 → 明确失败。
    child.on("error", (error) => finish(spawnFailure("interpreter-unavailable", error)));
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      let index = stdoutBuffer.indexOf("\n");
      while (index >= 0) {
        const line = stdoutBuffer.slice(0, index);
        stdoutBuffer = stdoutBuffer.slice(index + 1);
        if (line.startsWith(MODAL_BRIDGE_RESPONSE_SENTINEL)) {
          responseLine = line.slice(MODAL_BRIDGE_RESPONSE_SENTINEL.length);
        }
        index = stdoutBuffer.indexOf("\n");
      }
      if (stdoutBuffer.length > MAX_BUFFERED_LINE_BYTES) overflow = true;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      // 只保留尾部有界片段，仅用于失败诊断；不逐条打印（可能含 SDK 噪声）。
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-600);
    });
    child.on("close", () => {
      if (settled) return;
      if (overflow) {
        finish({ ok: false, failure: protocolFailure("stdout-line-overflow") });
        return;
      }
      if (responseLine === undefined) {
        const failure = protocolFailure("no-response-line");
        if (stderrTail) failure.detail = bounded(stderrTail.slice(-200));
        finish({ ok: false, failure });
        return;
      }
      finish(parseBridgeResponse(responseLine, protocol));
    });
    // stdin 写失败由 close/error 分支收口（EPIPE 不单独归类）。
    child.stdin?.on("error", () => {});
    child.stdin?.end(input.request, "utf8");
  });
}

/** stdout 响应行 → 结果或归一失败；code 必须落在 shared 的错误码目录内。 */
export function parseBridgeResponse(line: string, protocol: number): ModalBridgeOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, failure: protocolFailure("invalid-json") };
  }
  if (!isRecord(parsed) || parsed["protocol"] !== protocol) {
    return { ok: false, failure: protocolFailure("protocol-mismatch") };
  }
  if (parsed["ok"] === true && isRecord(parsed["result"])) {
    return { ok: true, result: parsed["result"] };
  }
  const error = isRecord(parsed["error"]) ? parsed["error"] : undefined;
  if (parsed["ok"] !== false || !error) {
    return { ok: false, failure: protocolFailure("malformed-envelope") };
  }
  const failure: ModalBridgeFailure = {
    kind: "bridge",
    code:
      typeof error["code"] === "string" && isCloudErrorCode(error["code"])
        ? error["code"]
        : "provider_unreachable",
    definite: error["definite"] === true,
    reason: typeof error["reason"] === "string" ? error["reason"].slice(0, 64) : "unknown",
  };
  if (typeof error["stage"] === "string") failure.stage = error["stage"].slice(0, 32);
  if (typeof error["detail"] === "string") failure.detail = error["detail"].slice(0, 200);
  return { ok: false, failure };
}

/**
 * 子进程最小环境：只带运行 SDK 所需 + TokenPair。显式固定 MODAL_CONFIG_PATH 到
 * 私有空配置，避免操作者 home 下的 ~/.modal.toml（其它 workspace/环境）影响账号；
 * env 里的 TokenPair 优先级最高（官方 config.get 优先读 MODAL_<KEY>）。
 */
export function buildModalChildEnv(tokenId: string, tokenSecret: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env["HOME"] ?? tmpdir(),
    PYTHONUNBUFFERED: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONIOENCODING: "utf-8",
    MODAL_TOKEN_ID: tokenId,
    MODAL_TOKEN_SECRET: tokenSecret,
    MODAL_CONFIG_PATH: ensurePrivateModalConfig(),
  };
  // 部署若显式选择 Modal workspace 环境，透传该选择（非 secret；MODAL_ENVIRONMENT
  // 是官方配置键 "environment" 的环境变量形式），否则保持账号默认环境。
  const environment = process.env["MODAL_ENVIRONMENT"]?.trim();
  if (environment) env["MODAL_ENVIRONMENT"] = environment;
  return env;
}

function spawnFailure(reason: string, error: unknown): ModalBridgeOutcome {
  return {
    ok: false,
    failure: {
      kind: "spawn",
      code: "resource_unsupported",
      definite: true,
      reason,
      detail: bounded(error),
    },
  };
}

function protocolFailure(reason: string): ModalBridgeFailure {
  return { kind: "protocol", code: "provider_unreachable", definite: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bounded(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 200);
}

/** SIGTERM → 5s 后 SIGKILL：桥内可能正持有一个在途 RPC，不能无限等待。 */
function killChild(child: ReturnType<typeof spawn>): void {
  try {
    child.kill("SIGTERM");
  } catch {
    /* 已退出 */
  }
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* 已退出 */
    }
  }, 5_000);
  timer.unref?.();
}

/** 私有空 .modal.toml（只建一次）：env TokenPair 仍是唯一凭据来源，文件只做隔离。 */
function ensurePrivateModalConfig(): string {
  const dir = join(tmpdir(), "zcode-modal-bridge");
  const path = join(dir, "modal.toml");
  try {
    if (!existsSync(path)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(
        path,
        "# ZCode bridge: intentionally empty; tokens come from the child env.\n",
        {
          mode: 0o600,
        },
      );
    }
  } catch {
    /* 无法创建时退回系统临时目录语义；凭据仍只来自 env */
  }
  return path;
}
