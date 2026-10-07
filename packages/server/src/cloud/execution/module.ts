/**
 * cloud-execution 模块清单（specs/cloud-agent/00 §8、02 §1、13 §3）。
 * 沙箱内执行节点 bridge 的独立受控子模块：独立 domain/app/adapters、独立公开
 * contract 与构建入口。依赖父模块 cloud-control-plane 只走其公开入口
 * （`packages/server/src/cloud/contract.ts`），禁止深导入父模块 app/domain 实现。
 * server：复用 `packages/server/src/remote/` 的既有远端连接原语（07 §2.7 交互
 * 同构要求与 SSH 同一实现，避免握手/stdio 语义分叉）。
 */
export const cloudExecutionModule = {
  id: "cloud-execution",
  requires: ["shared", "rpc", "services", "server", "cloud-control-plane"],
  provides: ["cloud-execution-contract"],
  publicEntrypoints: ["contract.ts"],
} as const;
