/**
 * 云执行节点（沙箱）行为偏好快照读取与落值（specs/cloud-agent 14 §6/§9.3、07 §8 表首行）。
 *
 * 链路：控制面把账号设置的**实值快照**放进 `bootstrap.config.preferences`（P18/P19a），
 * 沙箱 supervisor 的 policy 安装器把它落成 `applied-policy.json` v2 并注入
 * `ZCODE_APPLIED_POLICY_SNAPSHOT`（= 该文件绝对路径）；本模块是 services 侧的唯一读取方：
 * 在 authority = `cloud-execution-node` 时优先用快照实值应答 runtime preferences，
 * 不再读沙箱自身 settingService 的默认值。
 *
 * 回落语义（fail-safe，不 fail-closed）：env 未注入 / 文件缺失 / JSON 损坏 / 版本不是 v2 /
 * 没有 `preferences` 块 / 值形状非法 → 一律返回 null 并只记一条 warn（不抛、不崩、不静默
 * 伪造值）；调用方（node.ts 的 responder）据此回落到既有沙箱本地设置默认值。
 * 这条链路刻意不做 ready 门控：偏好缺失不是 run 失败条件（14 §4.1 同款口径）。
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  integratedTerminalShellSelectionSchema,
  ZCODE_APPLIED_POLICY_SNAPSHOT_ENV_KEY,
  zcodeModelContextBudgetStrategySchema,
  type ZCodeModelContextBudgetStrategy,
  type ZCodeSessionRuntimePreferencesResult,
} from "@zcode/shared";

/** 已应用策略快照的文件格式版本：v2 追加 configVersion 与 preferences 块（v1 只有 policyVersion）。 */
const APPLIED_POLICY_SNAPSHOT_VERSION_V2 = 2 as const;

/**
 * 快照值块：五键全可选（控制面只收进 shared schema 支持的键）；值类型复用 shared 既有
 * schema，不在这里复制枚举（`modelContextBudgetStrategy`/`integratedTerminalShell`）。
 * 不做 `.strict()`：未知键直接剥离（前向兼容），已知键类型非法才判损坏。
 */
const snapshotValuesSchema = z.object({
  askUserQuestionAutoResolutionEnabled: z.boolean().optional(),
  nativeSearchEnhancementsEnabled: z.boolean().optional(),
  memoryEnabled: z.boolean().optional(),
  modelContextBudgetStrategy: zcodeModelContextBudgetStrategySchema.optional(),
  integratedTerminalShell: integratedTerminalShellSelectionSchema.optional(),
});

const appliedPolicySnapshotV2Schema = z.object({
  version: z.literal(APPLIED_POLICY_SNAPSHOT_VERSION_V2),
  policyVersion: z.string().trim().min(1).max(64),
  configVersion: z.string().trim().min(1).max(64),
  preferences: snapshotValuesSchema,
});

export type RuntimePreferencesSnapshotValues = z.infer<typeof snapshotValuesSchema>;

export interface RuntimePreferencesSnapshot {
  /** 已应用配置版本（控制面内容寻址签发）；用于 `bridge.ready.configVersion` 口径核对。 */
  configVersion: string;
  values: RuntimePreferencesSnapshotValues;
}

export interface ReadRuntimePreferencesSnapshotInput {
  /** 注入环境（测试用）；缺省 `process.env`。 */
  env?: Record<string, string | undefined>;
  /** 缺失/损坏时的一条 warn 回调（原因 + 路径，不含值正文）。 */
  onWarning?: (warning: { reason: string; path: string }) => void;
}

/**
 * 读 `ZCODE_APPLIED_POLICY_SNAPSHOT` 指向的 v2 快照；任何异常都收敛为 null（调用方回落）。
 */
export async function readRuntimePreferencesSnapshot(
  input: ReadRuntimePreferencesSnapshotInput = {},
): Promise<RuntimePreferencesSnapshot | null> {
  const env = input.env ?? process.env;
  const path = env[ZCODE_APPLIED_POLICY_SNAPSHOT_ENV_KEY]?.trim();
  if (!path) {
    // 非云节点（或未注入）：不是异常，也不是损坏，静默回落。
    return null;
  }
  const warn = (reason: string) => input.onWarning?.({ reason, path });
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    warn("snapshot-file-unreadable");
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warn("snapshot-not-json");
    return null;
  }
  const snapshot = appliedPolicySnapshotV2Schema.safeParse(parsed);
  if (!snapshot.success) {
    // v1 文件（只有 policyVersion）落在这一支：没有 preferences 块 → 回落本地默认值。
    warn("snapshot-shape-invalid");
    return null;
  }
  return { configVersion: snapshot.data.configVersion, values: snapshot.data.preferences };
}

/** 回落时的沙箱本地默认值（来源仍是 settingService，由调用方读取后传入）。 */
export interface RuntimePreferencesDefaults {
  askUserQuestionAutoResolutionEnabled: boolean;
  nativeSearchEnhancementsEnabled: boolean;
  memoryEnabled: boolean;
  modelContextBudgetStrategy: ZCodeModelContextBudgetStrategy;
  integratedTerminalShell?: ZCodeSessionRuntimePreferencesResult["integratedTerminalShell"];
}

/**
 * 快照实值优先、缺键/无快照回落本地默认值；`integratedTerminalShell` 只对
 * `user-execution` scope 生效（与 07 §8、既有 responder 的口径一致）。
 * 返回值形状即 `ZCodeSessionRuntimePreferencesResult`（wire 边界仍会再校验一次）。
 */
export function mergeRuntimePreferences(input: {
  defaults: RuntimePreferencesDefaults;
  snapshot: RuntimePreferencesSnapshot | null;
  scope: string;
}): ZCodeSessionRuntimePreferencesResult {
  const { defaults, snapshot, scope } = input;
  const values = snapshot?.values ?? {};
  const integratedTerminalShell =
    values.integratedTerminalShell ?? defaults.integratedTerminalShell;
  return {
    askUserQuestionAutoResolutionEnabled:
      values.askUserQuestionAutoResolutionEnabled ?? defaults.askUserQuestionAutoResolutionEnabled,
    nativeSearchEnhancementsEnabled:
      values.nativeSearchEnhancementsEnabled ?? defaults.nativeSearchEnhancementsEnabled,
    memoryEnabled: values.memoryEnabled ?? defaults.memoryEnabled,
    modelContextBudgetStrategy:
      values.modelContextBudgetStrategy ?? defaults.modelContextBudgetStrategy,
    // user-execution 之外不消费 Shell（共享默认策略是统一 result schema 的兼容占位）。
    ...(scope === "user-execution" && integratedTerminalShell ? { integratedTerminalShell } : {}),
  };
}
