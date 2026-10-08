/**
 * composer 发送/停止控制簇决策（2026-10-08 复检修订，P3）。
 *
 * 背景（实测缺陷）：运行中输入框有草稿时发送位切换成「Queue message」，旧状态机
 * `streaming + 空草稿 → Stop；有草稿 → 发送键` 使 Stop 完全不可达——云 Web 手机端
 * 没有Esc 键，运行中写下一段提示后无法停止，只能等 run 自然结束。
 *
 * 规则（纯函数，node:test 直接覆盖）：
 * - 运行中 + 空草稿：Stop 独占发送位（旧语义不变，桌面/本地 Web 布局零变化）；
 * - 运行中 + 有草稿：发送（入队）按钮保留，**发送旁并置 Stop**，停止不必先清空草稿；
 * - 空闲：只呈现发送按钮（无可停执行，不渲染死按钮）。
 */

export interface ComposerSubmitControlsPlan {
  /** Stop 独占发送位（运行中 + 空草稿）。 */
  readonly showsStopControl: boolean;
  /** 发送/入队按钮（有草稿即可提交时）。 */
  readonly showsSendControl: boolean;
  /** 运行中 + 有草稿：发送旁并置的 Stop（保留可用停止入口）。 */
  readonly showsStopAlongsideSend: boolean;
}

export function resolveComposerSubmitControls(params: {
  /** 当前是否存在可停执行（snapshot.control.canStop）。 */
  readonly canStop: boolean;
  /** composer 是否有可提交草稿（文本/附件/上下文引用任一）。 */
  readonly hasDraftToSubmit: boolean;
}): ComposerSubmitControlsPlan {
  return {
    showsStopControl: params.canStop && !params.hasDraftToSubmit,
    showsSendControl: params.hasDraftToSubmit,
    showsStopAlongsideSend: params.canStop && params.hasDraftToSubmit,
  };
}
