/**
 * 投影 WAL 文件存储（specs/cloud-agent/02 §7.2 写入顺序、§8 WAL 满/不可写）。
 *
 * 形态：单个 NDJSON 文件，首行为游标头（已 ACK 水位），其余为待投递记录。
 * 写路径始终「临时文件 + rename 原子替换」：崩溃只会留下上一个完整状态，不会半截。
 * 解析失败**不删文件、不静默丢记录**：返回 healthy=false，由 ready 门控拒绝 ready 并
 * 上报故障（02 §5.3、§8）。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { cloudProjectionDedupKey, type CloudStreamCursor } from "@zcode/shared";
import type { WalEntry } from "../domain/projectionWal.js";
import type { ExecutionLogger, ProjectionWalPort } from "../app/ports.js";
import { DEFAULT_RUNTIME_STATE_DIR } from "./credentialStateFile.js";

export function projectionWalPath(stateDir: string = DEFAULT_RUNTIME_STATE_DIR): string {
  return join(stateDir, "projection-wal.ndjson");
}

interface WalHeader {
  kind: "header";
  version: 1;
  cursors: CloudStreamCursor[];
}

export function createProjectionWalStore(options: {
  stateDir?: string;
  logger: ExecutionLogger;
}): ProjectionWalPort {
  const path = projectionWalPath(options.stateDir);

  return {
    async load() {
      const raw = await readFile(path, "utf8").catch(() => null);
      if (raw === null) return { entries: [], cursors: [], healthy: true };
      const lines = raw.split("\n").filter((line) => line.trim().length > 0);
      if (lines.length === 0) return { entries: [], cursors: [], healthy: true };
      const header = parseHeader(lines[0] ?? "");
      if (!header) {
        // 头部不可解析：整份拒绝（不猜测），保留文件等待人工/上层对账。
        options.logger.error(undefined, "projection WAL header invalid; delivery paused", { path });
        return { entries: [], cursors: [], healthy: false };
      }
      const entries: WalEntry[] = [];
      for (const line of lines.slice(1)) {
        try {
          const record = JSON.parse(line) as WalEntry["record"];
          entries.push({ record, dedupKey: cloudProjectionDedupKey(record) });
        } catch {
          options.logger.error(undefined, "projection WAL line invalid; delivery paused", { path });
          return { entries, cursors: header.cursors, healthy: false };
        }
      }
      return { entries, cursors: header.cursors, healthy: true };
    },

    async save(entries, cursors) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const header: WalHeader = { kind: "header", version: 1, cursors: [...cursors] };
      const body = [
        JSON.stringify(header),
        ...entries.map((entry) => JSON.stringify(entry.record)),
      ];
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${body.join("\n")}\n`, { mode: 0o600 });
      await rename(temporary, path);
      options.logger.debug(undefined, "projection WAL persisted", {
        entries: entries.length,
        cursors: cursors.length,
      });
    },
  };
}

function parseHeader(line: string): WalHeader | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.kind !== "header" || value.version !== 1) return null;
  if (!Array.isArray(value.cursors)) return null;
  const cursors: CloudStreamCursor[] = [];
  for (const cursor of value.cursors) {
    if (!cursor || typeof cursor !== "object") return null;
    const entry = cursor as Record<string, unknown>;
    if (
      typeof entry.topic !== "string" ||
      typeof entry.logEpoch !== "string" ||
      typeof entry.sourceSeq !== "number"
    ) {
      return null;
    }
    cursors.push({ topic: entry.topic, logEpoch: entry.logEpoch, sourceSeq: entry.sourceSeq });
  }
  return { kind: "header", version: 1, cursors };
}
