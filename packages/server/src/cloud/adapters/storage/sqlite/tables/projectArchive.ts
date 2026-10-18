/**
 * 0009_project_archive：Project 软删除（specs/cloud-agent/15 §R3、03 §6 deleteProject 行）。
 *
 * 删除 Project 采用「明确归档，不静默销毁」：只追加可空 `archived_at`，不物理删除行，
 * 任务历史与任务外键保持完整。`archived_at IS NULL` 表示未归档；读路径（get /
 * findByRepository / list）一律过滤已归档行。
 *
 * 编号纪律（10 §7）：`0001` 已应用冻结，本列只能以新编号追加；链头同步推进
 * `CLOUD_SCHEMA_VERSION`。
 */
export const projectArchiveTables = `
ALTER TABLE projects ADD COLUMN archived_at INTEGER;
`;
