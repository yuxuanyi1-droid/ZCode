/**
 * app 层日志入口（AGENTS「日志」、03 §9：日志使用 `createServiceLogger(scope)`，
 * trace 关联 taskId/runId/operationId/commandId/connectionEpoch；不记录 prompt 正文、
 * header、token 或完整工具输出）。
 *
 * 所有 app 文件的日志都从这里取 logger，避免每个文件各自决定 scope 与级别：
 * - `info`：进程/会话生命周期、一次性初始化等生产可用事件；
 * - `debug`：高频诊断（逐条投递、逐帧水位），生产不落盘；
 * - `warn`：可恢复异常；`error`：不可恢复错误。
 */
import { createServiceLogger } from "@zcode/services/node";

export type CloudCoreLogger = ReturnType<typeof createServiceLogger>;

export const cloudCoreLogger: CloudCoreLogger = createServiceLogger("cloud-control-plane");
