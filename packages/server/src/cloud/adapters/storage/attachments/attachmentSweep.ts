/**
 * 附件清扫调度（03 §4「未引用对象按保留期清扫」、W2 §3）。
 *
 * 策略：定期调用受控存储的 sweep——未发布的临时对象按 stagedTtlMs 回收，已发布但
 * 从未被输入引用的对象按 unreferencedRetentionMs 回收。周期本身不决定正确性：
 * 单次执行的语义由 attachmentStore/attachmentRepo 保证，调度失败只记日志并等下一轮。
 */
import { createServiceLogger } from "@zcode/services/node";
import type { CloudAttachmentStore } from "./attachmentStore.js";

const logger = createServiceLogger("cloud-storage-attachments");

export interface AttachmentSweepScheduleOptions {
  store: CloudAttachmentStore;
  intervalMs: number;
  /** 注入时钟（测试用）；默认 Date.now。 */
  now?: () => number;
}

export interface AttachmentSweepHandle {
  runOnce(): Promise<{ removedRows: number; orphanShas: number }>;
  stop(): void;
}

export function startAttachmentSweep(
  options: AttachmentSweepScheduleOptions,
): AttachmentSweepHandle {
  const now = options.now ?? (() => Date.now());
  let stopped = false;

  async function runOnce(): Promise<{ removedRows: number; orphanShas: number }> {
    const result = await options.store.sweep(now());
    if (result.removedRows > 0) {
      logger.info(undefined, "附件清扫完成", {
        removedRows: result.removedRows,
        orphanObjects: result.orphanShas.length,
      });
    }
    return { removedRows: result.removedRows, orphanShas: result.orphanShas.length };
  }

  const timer = setInterval(
    () => {
      if (stopped) return;
      void runOnce().catch((error: unknown) => {
        // 清扫失败不影响服务：下一轮重试，风险记录在日志。
        logger.warn(undefined, "附件清扫失败", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    },
    Math.max(1_000, options.intervalMs),
  );
  timer.unref?.();

  return {
    runOnce,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
