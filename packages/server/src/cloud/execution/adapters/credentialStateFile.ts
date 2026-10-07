/**
 * 本地凭据状态文件（specs/cloud-agent/02 §5.1 第 2 条、§5.2）。
 *
 * 语义：
 * - hello **之前**必须写成功：当前 token、候选 nextResumeToken、helloAttemptId；
 * - 原子替换（同目录临时文件 + rename）、权限 0600、异步 IO；
 * - 文件内容用 domain 的严格解析，未知版本/字段一律当不存在（fail closed 重新自举），
 *   绝不按旧字段猜测。
 *
 * 秘密边界：本文件只在沙箱内、只在 run 生命周期内存在；内容不进日志（只记长度与状态字段）。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  parseCredentialState,
  type CredentialStateSnapshot,
} from "../domain/credentialRotation.js";
import type { CredentialStatePort, ExecutionLogger } from "../app/ports.js";

/**
 * 运行状态目录（凭据状态、投影 WAL、已安装代际、自举描述都在这里；唯一的路径事实源）。
 *
 * **为什么不是 `/run/zcode-bridge`**：2026-10-05 真实 E2B 沙箱实测，supervisor 启动即退出：
 *   `[cloud-execution] supervisor failed { error: "EACCES: permission denied, mkdir '/run/zcode-bridge'" }`
 * 原因是 E2B（Daytona/Modal 同理）里 supervisor 以**非 root 用户**运行，`/run` 属 root，
 * 模板即使以 root 建过该目录也不可写；把它写进注释当成「模板已授权」的前提不成立。
 *
 * 现口径：与 01 §6.2 的沙箱布局同源（`~/.zcode/server` 也是用户家目录下），落在
 * `~/.zcode/run` —— supervisor 进程的 `homedir()` 就是沙箱用户的家目录，必然可写；
 * 目录**由本模块自己 `mkdir -p`**（recursive），不依赖任何模板预建。
 */
export const DEFAULT_RUNTIME_STATE_DIR = join(homedir(), ".zcode", "run");

/**
 * 确保状态目录存在且可写（自建，不依赖模板）。权限问题在这里就暴露：
 * 早期失败必须带明确诊断退出，而不是等到 hello/写文件时才炸。
 */
export async function ensureRuntimeStateDir(
  stateDir: string = DEFAULT_RUNTIME_STATE_DIR,
): Promise<string> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  return stateDir;
}

export function credentialStatePath(stateDir: string = DEFAULT_RUNTIME_STATE_DIR): string {
  return join(stateDir, "credential-state.json");
}

export function createCredentialStateFile(options: {
  stateDir?: string;
  logger: ExecutionLogger;
}): CredentialStatePort {
  const path = credentialStatePath(options.stateDir);

  return {
    async load() {
      const raw = await readFile(path, "utf8").catch(() => null);
      if (raw === null) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        options.logger.warn(undefined, "credential state file is not valid json; ignoring", {
          path,
        });
        return null;
      }
      const state = parseCredentialState(parsed);
      if (!state) {
        options.logger.warn(undefined, "credential state file rejected by strict parse", { path });
      }
      return state;
    },

    async save(state: CredentialStateSnapshot) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      // 只写状态机字段；日志里绝不出现 token 正文。
      await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      await rename(temporary, path);
      options.logger.debug(undefined, "credential state persisted", {
        recovery: state.recovery,
        hasRotationId: state.rotationId !== undefined,
      });
    },
  };
}
