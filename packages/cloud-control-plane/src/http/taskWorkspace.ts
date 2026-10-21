import type { RunRecord } from "../domain/types.js";

/**
 * 原始 Web 首屏从 /api/server-info 的 workspaces[0] 解析工作区；沙箱 daemon 的
 * workspaces 为空。代理层注入当前任务的工作区。
 *
 * 只下发 path、不下发 workspaceIdentity：原始 Web 把任何非空 identity 视为远端目标，
 * 在没有 remote session 的普通 Web 模式会停在 remote-waiting 并禁用发送。控制面的
 * initialize/createSession 也统一使用 path，两端落到同一 workspace key。
 */
export function withTaskWorkspace(body: Buffer, run: RunRecord): Buffer {
  try {
    const info = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    info["workspaces"] = [{ path: run.checkoutPath }];
    return Buffer.from(JSON.stringify(info), "utf8");
  } catch {
    return body;
  }
}
