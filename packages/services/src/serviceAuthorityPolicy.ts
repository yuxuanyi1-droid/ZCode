/**
 * service authority 策略（specs/cloud-agent 07 §2.7 交互同构、§8 执行节点 authority、
 * 12 §6 沙箱注入；决策集中一处，装配处只读结论）。
 *
 * 为什么单独成文件：`node.ts` 已有近 3k 行，新增模式不应再往里堆判定分支；
 * 本文件是纯函数（只依赖 `ServiceAuthorityMode` 类型），可被装配、入口与测试共用。
 *
 * 四种 authority 的语义（**既有三种一行不改**，云节点是新增列）：
 *
 * | 能力                                   | desktop-local | desktop-attached-remote | standalone-server | cloud-execution-node |
 * | -------------------------------------- | ------------- | ----------------------- | ----------------- | -------------------- |
 * | runtime preferences/policy 应答         | 本机          | 外部 Desktop Host       | 本机              | **本节点**（无浏览器） |
 * | provider provisioning target           | 关闭          | 开启                    | 关闭（可显式开）  | **开启**             |
 * | 桌面本机专属能力（CUA/主进程/呈现面）   | 是            | 否                      | 否                | **否**               |
 * | host 绑定工具面（账号域/Off-Peak/Bot 启动任务/会话发布） | 是 | 否                | 是                | **否**               |
 *
 * 云执行节点为什么不是 `desktop-attached-remote`：它不是「由外部 Desktop Host 应答配置」的
 * 远端 workspace，而是**无人值守**节点——设置/策略快照由节点自己应答（07 §8 表首行），
 * 浏览器不在线也不得阻塞 runtime 创建。为什么不是 `standalone-server`：它必须显式开启
 * provider provisioning target（envelope 安装需要，12 §6），且按远端口径裁剪 host 绑定工具面。
 */
import type { ServiceAuthorityMode } from "@zcode/shared";

/**
 * 云执行节点 authority 名：唯一事实源是 shared 的 `serviceAuthorityModes`。
 * `satisfies ServiceAuthorityMode` 让枚举改名/删除立刻编译失败——不在本文件留第二份
 * 可漂移的定义（能力矩阵与实际模式一旦对不上，测试很难暴露）。
 */
export const CLOUD_EXECUTION_NODE_AUTHORITY_MODE =
  "cloud-execution-node" satisfies ServiceAuthorityMode;

export interface ServiceAuthorityPolicy {
  /** 实际生效的模式（未设置时为 undefined = 历史 host 装配语义）。 */
  readonly mode: ServiceAuthorityMode | undefined;
  /** 桌面本机 authority：唯一可以创建桌面专属能力（CUA helper、主进程交互、桌面呈现面）的模式。 */
  readonly isDesktopLocal: boolean;
  /** 远端 workspace：由外部 Desktop Host 应答 runtime preferences/policy。 */
  readonly isDesktopAttachedRemote: boolean;
  /** 云执行节点：无人值守的沙箱节点（07 §8）。 */
  readonly isCloudExecutionNode: boolean;
  /**
   * runtime preferences/policy 是否由**本节点**应答（不依赖页面/外部 Host）。
   * 只有远端 attachment 模式交给外部 Host；其余全部本地应答。
   */
  readonly answersRuntimePreferencesLocally: boolean;
  /** 是否开启 provider provisioning target（按 run 授权清单安装 envelope 的前提）。 */
  readonly exposesProviderProvisioningTarget: boolean;
  /**
   * 是否暴露桌面本机专属能力（CUA helper 创建、CUA turn 投影、桌面呈现面）。
   * 这是「不含本机 workspace 执行」在装配层的可断言口径。
   */
  readonly exposesDesktopLocalExecution: boolean;
  /**
   * 是否暴露 host 绑定工具面：账号域（Off-Peak）、Bot 启动期后台任务、会话发布到账号域。
   * 远端与云节点都不暴露（不把远端/沙箱 workspace 的账号侧动作投影到部署机）。
   */
  readonly exposesHostBoundTooling: boolean;
}

export function isCloudExecutionNodeMode(mode: ServiceAuthorityMode | undefined): boolean {
  return mode === CLOUD_EXECUTION_NODE_AUTHORITY_MODE;
}

export function resolveServiceAuthorityPolicy(
  mode: ServiceAuthorityMode | undefined,
): ServiceAuthorityPolicy {
  const isDesktopLocal = mode === "desktop-local";
  const isDesktopAttachedRemote = mode === "desktop-attached-remote";
  const isCloudExecutionNode = isCloudExecutionNodeMode(mode);
  return {
    mode,
    isDesktopLocal,
    isDesktopAttachedRemote,
    isCloudExecutionNode,
    // 既有语义不变：仅 desktop-attached-remote 交给外部 Host；云节点落在本地应答一侧。
    answersRuntimePreferencesLocally: !isDesktopAttachedRemote,
    exposesProviderProvisioningTarget: isDesktopAttachedRemote || isCloudExecutionNode,
    exposesDesktopLocalExecution: isDesktopLocal,
    exposesHostBoundTooling: !isDesktopAttachedRemote && !isCloudExecutionNode,
  };
}
