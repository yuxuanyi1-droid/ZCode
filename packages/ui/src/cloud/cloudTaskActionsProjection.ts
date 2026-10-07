/**
 * Cloud Task 可用动作的服务端投影消费（specs/cloud-agent/04 §3.3、08 §3.1/§3.2/§9）。
 *
 * 04 §3.3：**可操作 actions 来自控制面/runtime 能力投影**，服务端仍独立验证。
 * 因此这里只做「原样透传 + 缺省为空」两件事：
 *
 * - 元素类型与取值**全部归契约所有**（`taskDetailResponseSchema.actions` =
 *   `CLOUD_TASK_ACTIONS` 枚举数组）。UI 不命名枚举成员、不解释语义，避免再造第二套判定。
 * - 服务端未给出 actions → **空集合**：呈现为「无动作可用」。
 *   绝不回落客户端按 Task/Run 状态推导的动作表——那正是 04 §3.3 禁止的形态，
 *   也会与「服务端仍独立验证」产生两套事实。
 */
import type { CloudTaskAction, TaskDetailResponse } from "@zcode/shared";

/**
 * 可用动作集合：元素类型直接取契约里的 `CloudTaskAction`（`CLOUD_TASK_ACTIONS` 枚举），
 * UI 不重命名、不新增成员。
 */
export type CloudTaskActionSet = readonly CloudTaskAction[];

/** 服务端未给出（或调用方还没有详情投影）时的空集合：冻结以防被下游误改。 */
const EMPTY_CLOUD_TASK_ACTIONS: CloudTaskActionSet = Object.freeze([]);

/**
 * 读取服务端投影的可用动作。
 *
 * 纯透传：不排序、不裁剪、不按状态补全。调用方按成员做入口可见性判断时，
 * 用的也必须是契约里的成员，而不是本地字符串字面量。
 */
export function readCloudTaskActions(detail: TaskDetailResponse | null): CloudTaskActionSet {
  return detail?.actions ?? EMPTY_CLOUD_TASK_ACTIONS;
}
