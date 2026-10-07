/**
 * 适配层日志形状（specs/cloud-agent 03 §9、AGENTS.md「日志」段）。
 *
 * 只描述用到的四个分级方法，避免绑定 `@zcode/services/node` 的内部类型导出；
 * `createServiceLogger(scope)` 的返回值在结构上满足本接口（TraceId = string）。
 * 日志中不得出现 App 私钥、JWT、installation token 或私有仓库内容（09 §8、01 §7.2）。
 */
export interface CloudAdapterLogger {
  debug(traceId: string | undefined, ...args: unknown[]): void;
  info(traceId: string | undefined, ...args: unknown[]): void;
  warn(traceId: string | undefined, ...args: unknown[]): void;
  error(traceId: string | undefined, ...args: unknown[]): void;
}
