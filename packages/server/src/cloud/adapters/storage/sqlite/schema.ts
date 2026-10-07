/**
 * Cloud 控制面 SQLite schema 与迁移编号（03 §4 表/约束、CONTRACT.md「DB schema 冻结」）。
 *
 * 表定义按表族拆在 `tables/`（core/runs/inputs/operations/projections/accounts/
 * grants/credentials/interactions/attachments），本文件只负责：
 * 1. 按原顺序拼装每个编号的语句序列（顺序即语义：CREATE TABLE 必须先于其索引与
 *    引用它的表，因此表族顺序不能随机化）；
 * 2. 暴露迁移链与词表常量给 migrations.ts / 各 repository（对外导出面不变）。
 *
 * 编号纪律（10 §7、W2 §8）：`0001`/`0002`/`0003`/`0005` 沿用回退前编号，`0004`
 * 永久退役不复用（原 SSH attachment，随 00 §11⑥ 移除），下一条从 `0006` 起。
 * 编号一经应用不可改：任何后续 schema 变更只能追加新的编号，不得改已应用 id 的
 * 内容——checksum 校验会拒绝被改写的历史迁移。
 *
 * 约束承担状态迁移（03 §4）：单有效写 run、owner+creationKey、task+acceptanceSeq、
 * commandId 幂等、projection 去重键都在表族文件里用唯一/部分索引与 CHECK 表达，
 * 不用设置 JSON 或内存表替代。
 *
 * 未发布链上的在修订（2026-10-07）：`0001`/`0003`/`0005` 的内容在本机修订过
 * （GitHub effect 分面列、git_grants 按 `GitGrantStore` 端口、交互决定按
 * `InteractionDecisionRepo` 记录对齐），编号与已发布语义均未变；本链从未离开
 * 本机、无部署实例，因此允许原地修订——**链一旦外发即冻结**，后续只能追加
 * 新编号（10 §7）。修订依据与日期同步记在 `packages/server/src/cloud/CONTRACT.md`。
 */
import type { ExternalOperationKind } from "../../../app/ports/operationOutboxPort.js";
import type { GitHubEffectKind } from "../../../app/ports/gitHubEffectPort.js";
import { coreTables } from "./tables/core.js";
import { runTables } from "./tables/runs.js";
import { inputTables } from "./tables/inputs.js";
import { operationTables } from "./tables/operations.js";
import { projectionTables } from "./tables/projections.js";
import { accountTables } from "./tables/accounts.js";
import { credentialTables } from "./tables/credentials.js";
import { grantTables } from "./tables/grants.js";
import { interactionTables } from "./tables/interactions.js";
import { attachmentTables } from "./tables/attachments.js";

export interface CloudMigration {
  readonly id: string;
  /** 已应用的 id 只能追加：这里的语句一旦发布就是冻结常量。 */
  readonly statements: readonly string[];
}

export { ACTIVE_RUN_STATUSES } from "./tables/constants.js";

/** 0001 的语句顺序（顺序即语义：表先于索引，被引用表先于引用表）。 */
const initial = [
  coreTables,
  runTables,
  inputTables,
  operationTables,
  projectionTables,
  accountTables,
].join("\n");

/**
 * 迁移链（冻结编号）。`0004` 不在本列表：它已永久退役，只作为账本墓碑写入，
 * 见 migrations.ts 的 RETIRED_MIGRATION_IDS。
 */
export const CLOUD_MIGRATIONS: readonly CloudMigration[] = [
  { id: "0001_cloud_control_plane_initial", statements: splitStatements(initial) },
  { id: "0002_run_credentials", statements: splitStatements(credentialTables) },
  { id: "0003_git_grants", statements: splitStatements(grantTables) },
  {
    id: "0005_task_input_interaction_decisions",
    statements: splitStatements(interactionTables),
  },
  { id: "0006_attachment_objects", statements: splitStatements(attachmentTables) },
];

/**
 * 永久退役的编号（W2 §8）：原 `0004` 是 SSH attachment 的 external_operations
 * kind 扩展，随 00 §11⑥ 移除。编号不复用，但必须在账本里留下墓碑，否则
 * 「全新库」与「旧库增量」的账本 id 集合会不同，迁移一致性检查将无法通过。
 */
export const RETIRED_MIGRATIONS: readonly { id: string; reason: string }[] = [
  { id: "0004_external_operations_ssh_attach", reason: "云侧 SSH attachment 已移除（00 §11⑥）" },
];

/** schema 版本：当前链的最大编号（降级启动检查用，10 §7）。 */
export const CLOUD_SCHEMA_VERSION = 6;

export const OPERATION_KIND_VALUES: readonly ExternalOperationKind[] = [
  "create",
  "terminate",
  "extend",
  "checkpoint",
  "publish-pr",
  "check",
  "comment",
  "token-revoke",
  "cleanup",
];

/**
 * GitHub effect 分面的 kind 集合（`external_operations.business_key IS NOT NULL`
 * 的那些行）：provider/生命周期操作不会出现在该集合里，两个 facet 的恢复扫描
 * 因此互不串台（gitHubEffectPort.ts；09 §5.2）。
 */
export const GITHUB_EFFECT_KIND_VALUES: readonly GitHubEffectKind[] = [
  "pull-request",
  "check",
  "comment",
  "token-revoke",
];

/** 按 `;` 切分 DDL；注释行先剥离，保证切分结果只由语句本体决定（checksum 稳定）。 */
function splitStatements(source: string): string[] {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}
