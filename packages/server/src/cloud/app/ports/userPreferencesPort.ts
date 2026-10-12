/**
 * 账号行为偏好读取端口（specs/cloud-agent/14 §6/§9.2⑥；W11 §10）。
 *
 * 值来源 = 云 host 本体 `settingService`（[12 §2]：账号设置权威在 host 本体），语义口径
 * 对齐 `packages/services/src/node.ts` 的 `resolveSessionRuntimePreferences`（`user-execution`
 * scope）。端口只回**显式设置过的键**：缺席键由沙箱 responder 经既有默认值收敛
 * （14 §9.2⑥：不新增第二套默认值规则），不在此层补默认值。
 *
 * 未接线（测试/嵌入装配）时 `bootstrap.config` 不带 `preferences` 块、**不 fail**：
 * 偏好缺失不是 run 失败条件（14 §9.2⑥）。
 */
import type { CloudBootstrapPreferences } from "@zcode/shared";

/** 五键实值快照（值类型复用 shared 的严格 schema，不在此复制枚举）。 */
export type CloudUserPreferencesValues = CloudBootstrapPreferences["values"];

export interface UserPreferencesPort {
  /** 读取账号偏好实值；读取失败（设置存储故障）回空对象而不抛错（不带块不 fail）。 */
  readUserPreferences(): Promise<CloudUserPreferencesValues>;
}
