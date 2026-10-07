/**
 * git grant 持久端口的适配边界（specs/cloud-agent 01 §7.1/§7.2、03 §4 `git_grants`）。
 *
 * 归属（W0 冻结）：
 * - **类型与常量**：唯一来源是 `app/ports/gitGrantPort.ts`（`GitGrantStore`/`GitGrantRecord`/
 *   `GitGrantPurpose`/`GIT_GRANT_TTL_MS`）；本文件只做转出，不再声明第二份。
 * - **实现**：W2 落表（迁移 0003）。
 * - **能力**：`gitGrantBroker.ts` 负责单次兑换、过期与撤销的状态判定（01 §7.2）。
 */
export type {
  GitGrantPurpose,
  GitGrantRecord,
  GitGrantStatus,
  GitGrantStore,
} from "../../app/ports/gitGrantPort.js";
export { GIT_GRANT_TTL_MS } from "../../app/ports/gitGrantPort.js";
