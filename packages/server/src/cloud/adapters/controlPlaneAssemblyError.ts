/**
 * 控制面装配期的结构化失败（W5 §3：入口只认 code，不解析 message）。
 *
 * 单独一个模块的理由：这个类同时是入口装配（`entry-cloud-control-plane.ts`）、
 * git grant 装配（`gitGrantAssembly.ts`）与 W5 启动路径（经 `contract.ts` 的导出）的
 * 公共符号；放在任一装配文件里都会让另两个文件与它成环。
 */
export class CloudControlPlaneAssemblyError extends Error {
  readonly code: "not_configured" | "validation_failed";
  constructor(code: CloudControlPlaneAssemblyError["code"], message: string) {
    super(message);
    this.name = "CloudControlPlaneAssemblyError";
    this.code = code;
  }
}
