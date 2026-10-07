/**
 * Cloud Agent 跨包公共契约入口（specs/cloud-agent/00 §8：跨包 schema 放 shared
 * 公开入口；W0 §5：不得把同一规则复制到多个文件，跨包引用只走这里）。
 *
 * 内容：身份（identity）、归一错误码（errors）、bridge 控制帧与投影记录
 * （bridge-protocol）、RPC 帧（rpc-protocol）、领域实体与状态（domain）、
 * HTTP 请求与端点矩阵（http-contracts）、响应信封（responses）。
 *
 * 版本纪律（00 §8）：runtime、bridge protocol、数据库 schema 独立版本化；本目录
 * 只声明 wire 形状与状态目录，不含任何实现（SQLite、SDK、路由、UI）。
 * 端点 ↔ schema 的对照表（谁生产、谁消费）见同目录 CONTRACT.md。
 */
export * from "./identity.js";
export * from "./errors.js";
export * from "./domain.js";
export * from "./bridge-protocol.js";
export * from "./rpc-protocol.js";
export * from "./http-contracts.js";
export * from "./responses.js";
export * from "./endpoints.js";
