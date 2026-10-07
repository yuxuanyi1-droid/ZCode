/**
 * ready 门控与阶段推进（specs/cloud-agent/02 §5.3、§4 帧表，W6 §3「ready 门控」）。
 *
 * 纯决策：welcome 只证明认证；ready 必须按 02 §5.3 的顺序逐条满足，不能靠加长超时或
 * 页面 responder 兜底。本文件只回答「当前卡在哪一步」，执行由 app/bootstrap 承担。
 */

export const READY_CONDITIONS = [
  "local-runtime-handshake",
  "provisioning-installed",
  "preferences-installed",
  "exporter-ready",
  "reconciliation-done",
] as const;

export type ReadyCondition = (typeof READY_CONDITIONS)[number];

/** bootstrap 阶段（`bridge.phase.phase` 的合法取值，来自 shared 冻结帧 schema）。 */
export type BootstrapPhase =
  | "registering"
  | "cloning"
  | "handshaking"
  | "installing-config"
  | "exporter-starting"
  | "reconciling";

export interface ReadyChecklist {
  localRuntimeHandshake: boolean;
  provisioningInstalled: boolean;
  preferencesInstalled: boolean;
  exporterReady: boolean;
  walReady: boolean;
  reconciliationDone: boolean;
  /** 旧网络 facade 已释放（02 §5.3 第 5 条）；未释放时不允许 ready。 */
  previousFacadeReleased: boolean;
}

export type ReadyVerdict =
  | { ready: true }
  | { ready: false; blockedBy: ReadyCondition; detail: string };

/**
 * 按 02 §5.3 顺序求第一个未满足条件。`walReady` 单独判定并归入 exporter-ready
 * 这一步报告（帧内 exporterReady/walReady 仍是两个独立布尔）。
 */
export function evaluateReady(checklist: ReadyChecklist): ReadyVerdict {
  if (!checklist.localRuntimeHandshake) {
    return {
      ready: false,
      blockedBy: "local-runtime-handshake",
      detail: "runtime-stdio-not-ready",
    };
  }
  if (!checklist.provisioningInstalled) {
    return { ready: false, blockedBy: "provisioning-installed", detail: "envelope-not-installed" };
  }
  if (!checklist.preferencesInstalled) {
    return { ready: false, blockedBy: "preferences-installed", detail: "policy-snapshot-missing" };
  }
  if (!checklist.exporterReady || !checklist.walReady) {
    return {
      ready: false,
      blockedBy: "exporter-ready",
      detail: checklist.exporterReady ? "wal-not-writable" : "exporter-not-started",
    };
  }
  if (!checklist.reconciliationDone || !checklist.previousFacadeReleased) {
    return { ready: false, blockedBy: "reconciliation-done", detail: "reconciliation-pending" };
  }
  return { ready: true };
}

/** bootstrap 阶段推进表：只允许沿固定顺序前进，避免跳步假装 ready。 */
export function nextPhase(current: BootstrapPhase | undefined): BootstrapPhase | null {
  const index = current === undefined ? -1 : PHASE_ORDER.indexOf(current);
  const next = PHASE_ORDER[index + 1];
  return next ?? null;
}

const PHASE_ORDER: readonly BootstrapPhase[] = [
  "registering",
  "cloning",
  "handshaking",
  "installing-config",
  "exporter-starting",
  "reconciling",
];

/** 严格解析阶段名：只接受冻结枚举（未知阶段不上报，不猜）。 */
export function parseBootstrapPhase(value: string): BootstrapPhase | null {
  return (PHASE_ORDER as readonly string[]).includes(value) ? (value as BootstrapPhase) : null;
}

export function isPhaseAtOrAfter(current: BootstrapPhase, target: BootstrapPhase): boolean {
  return PHASE_ORDER.indexOf(current) >= PHASE_ORDER.indexOf(target);
}
