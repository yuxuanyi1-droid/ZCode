// Composer 模型权威同步（2026-10-09 实测缺陷：云任务切模型后选择器仍显示旧模型）。
//
// 链路事实：runtime 应用会话模型切换后 emit ModelSelected，v4 投影把它归约为
// config.modelSelection 的 state.updated delta 推给客户端（本机 Host 与云 task
// attachment 走同一条投影协议；时间线的 modelChange marker 因此能实时更新）。
// 但 composer 选择器读的是 per-scope 持久草稿（composerDraftStore 的
// draft.modelSelection）：它只在 scope 首次初始化时从 session config 取种子，
// 此后写入方只有「本端显式点击」与「accepted ACK 写回」——权威事件没有任何
// 消费者，选择器因此停在陈旧值；用户不碰选择器直接发送时， Submission 冻结的
// 还是旧选型，随消息下发把 runtime 又切回去（本机模式同样存在此断链）。
//
// 同步规则（本机/云共用，见 specs/cloud-agent/04 §3.2 2026-10-09 修订二）：
// - 权威选择（投影 config.modelSelection）变化时，无显式标记的草稿一律跟随权威；
// - 本端显式选择（选择器/档位点击）打 explicit 标记，作为 pending 意图保持显示，
//   直到被发送消费（runtime 回发同选型事件后草稿与权威一致，标记收敛清除）；
// - 权威未变化的重复帧不写草稿，避免恢复/历史重放反复扰动。
import type { ModelSelection } from "@zcode/shared";

export interface ComposerModelAuthorityInput {
  /** 上一帧已观察的权威选择；首帧或换 scope 后为 null。 */
  readonly previousAuthority: ModelSelection | null;
  /** 当前投影权威选择（snapshot.config.modelSelection）。 */
  readonly authority: ModelSelection;
  /** 当前草稿选择；空表示草稿没有模型意图。 */
  readonly draftSelection: ModelSelection | null | undefined;
  /** 草稿选择是否为本端显式操作且尚未被权威确认。 */
  readonly draftExplicit: boolean;
}

export interface ComposerModelAuthorityDecision {
  /** 需要写回草稿的权威选择；null 表示草稿保持不动。 */
  readonly adopt: ModelSelection | null;
  /** true = 草稿是未消费的显式 pending 意图；false = 草稿与权威一致（可清 explicit 标记）。 */
  readonly pending: boolean;
}

/** 对象键顺序与 options 引用不是选择身份；只比较协议叶子。 */
export function sameComposerModelSelection(
  left: ModelSelection | null | undefined,
  right: ModelSelection | null | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.options?.reasoningLevel === right.options?.reasoningLevel
  );
}

/**
 * 由投影权威选择与草稿现状决断下一步：返回 null 表示状态无需任何变化；
 * adopt 非空表示把权威选择写回草稿（并清除 explicit 标记）；pending=true
 * 表示保留显式 pending 草稿（不清标记）。
 */
export function resolveComposerModelAuthoritySync(
  input: ComposerModelAuthorityInput,
): ComposerModelAuthorityDecision | null {
  const { authority, draftSelection, draftExplicit, previousAuthority } = input;
  // 已收敛：草稿就是权威（含显式重选同一模型）。显式标记随确认清除。
  if (sameComposerModelSelection(draftSelection, authority)) {
    return draftExplicit ? { adopt: null, pending: false } : null;
  }
  // 权威没变的重复帧：不写草稿。未标记的陈旧草稿等到权威真正变化时再跟随。
  if (sameComposerModelSelection(authority, previousAuthority)) return null;
  // 显式 pending 意图优先于权威事件，保持显示直到发送消费或用户再次更改。
  if (draftExplicit) return { adopt: null, pending: true };
  // 空草稿或无标记草稿（首帧种子/陈旧同步/旧版本遗留）跟随权威事实。
  return { adopt: authority, pending: false };
}
