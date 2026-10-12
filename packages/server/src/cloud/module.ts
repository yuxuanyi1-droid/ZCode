/**
 * cloud-control-plane 模块清单（specs/cloud-agent/03 §2 模块结构、00 §8 工程边界）。
 * 依赖声明与 architecture-policy.yaml 保持一致；对外暴露 `contract.ts` 单一公开入口
 * （2026-10-11 简化定调：`bootstrap.resources` 退役后，执行节点复用 bundle schema 的窄
 * 入口 `userProfileBundleContract.ts` 随帧 schema 一并删除，14 §4.8）。
 * 子模块 cloud-execution（更深的 root `packages/server/src/cloud/execution`）按最深
 * root 归属，控制面侧消费其公开契约也只走它自己的 contract.ts。
 */
export const cloudControlPlaneModule = {
  id: "cloud-control-plane",
  requires: ["shared", "rpc", "services", "server", "cloud-execution"],
  provides: ["cloud-control-plane-contract"],
  publicEntrypoints: ["contract.ts"],
} as const;
