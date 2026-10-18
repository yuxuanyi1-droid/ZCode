/**
 * composer 自定义 provider「configOptions 错误恢复」判定（2026-10-17 云任务修订）。
 *
 * 背景：workspace configOptions 水合失败时，桌面本地对 apiKey access 的 custom provider
 * 选择会走 `restartWorkspaceProcess` + prepare 恢复链；该链路依赖桌面本地的 `zcode-task`
 * 频道。云任务视图的 configOptions 水合同样会失败，但该频道在云模式不存在，恢复必然失败；
 * 若恢复分支仍然劫持点击并在失败后直接 return，用户的显式选择就被静默丢弃（选择器停留
 * 原模型，2026-10-17 真机取证）。
 *
 * 规则：四项事实全真才尝试恢复。云工作区由调用方（SessionPane 按 `isCloudWorkspace`）
 * 不传恢复 handler，`recoveryHandlerAvailable=false` 使云模式点击恒走正常 `onSelectModel`
 * 草稿意图。本函数保持纯判定、不引入云概念，也不做 IO。
 */
export function shouldAttemptCustomModelRecovery(input: {
  readonly configOptionsError: boolean;
  readonly decodedProviderId: string | null;
  readonly recoveryHandlerAvailable: boolean;
  readonly providerApiKeyAccess: boolean;
}): boolean {
  return (
    input.configOptionsError &&
    Boolean(input.decodedProviderId) &&
    input.recoveryHandlerAvailable &&
    input.providerApiKeyAccess
  );
}
