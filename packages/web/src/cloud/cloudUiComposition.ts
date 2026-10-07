/**
 * W9 → W8 的**唯一接线点**（specs/cloud-agent/modules/W9 §3；W8 §4）。
 *
 * 这里把 W8 已公开的 `@zcode/ui` 导出接到入口的接缝类型上：
 * - `CloudWorkspaceProvider`：base = host `/ws` accessor，执行域由当前 Run attachment 覆盖；
 * - `parseCloudUiBootstrap`：控制面 origin / taskId 的严格解析（未知字段与非法 taskId
 *   一律拒绝，不按旧字段猜测解析）。
 *
 * 主体（principalId）不由入口传递：W8 控制器从 `capabilities` 读取。
 *
 * 不传 `onNavigateTask`：路由写入由 W8 控制器**一处**完成（侧栏只调 `selectTask`，
 * 未提供回调时 controller 回落到 `openCloudTaskRoute`）。入口把深链 `?task=` 经
 * `bootstrap.taskId` 交给它，不在这里回灌，否则会和入口的写入形成回环（04 §5）。
 */
import { CloudWorkspaceProvider, parseCloudUiBootstrap } from "@zcode/ui";
import type { CloudUiBootstrapSource, CloudUiComposition } from "./cloudUi.js";

export const cloudUiComposition: CloudUiComposition = {
  createBootstrap(source: CloudUiBootstrapSource) {
    try {
      return parseCloudUiBootstrap({
        controlPlaneOrigin: source.controlPlaneOrigin,
        ...(source.taskId === undefined ? {} : { taskId: source.taskId }),
      });
    } catch {
      // 控制面 origin / taskId 解析失败：入口据此失败，不猜也不回落本机（08 §4.1）。
      return null;
    }
  },
  WorkspaceProvider: CloudWorkspaceProvider,
};
