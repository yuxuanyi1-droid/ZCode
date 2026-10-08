/**
 * 云入口启动失败面（specs/cloud-agent/modules/W9 §3/§5；04 §2.1/§8「不用白屏或通用报错」）。
 *
 * 每个失败原因都有独立的标题、说明与恢复动作（未配置/探测端点不回答、认证失效、
 * bundle 不兼容、后端不可达各自可操作），并展示结构化诊断（reason/code/traceId）。
 * 诊断信息只来自 `CloudBootFailure`：不含 token、prompt 正文或仓库内容（AGENTS 日志规范）。
 *
 * 2026-10-07（04 §2.1）：`mode-invalid` 与 `origin-mismatch` 两个失败面随客户端模式声明
 * 一并作废——模式由服务端探测得出，不再存在「客户端写错模式」或「构建期 origin 不符」。
 */
import type { CloudBootFailure, CloudBootRecovery } from "./cloudBoot.js";

export type CloudEntryLocale = "zh-CN" | "en";

/** 入口层拿不到服务（`settingService` 未建立）时的语言判定，与既有 Web 启动错误面同款。 */
export function resolveCloudEntryLocale(language?: string): CloudEntryLocale {
  const value = language ?? (typeof navigator === "undefined" ? "" : navigator.language);
  return /^zh\b/i.test(value) ? "zh-CN" : "en";
}

interface FailureCopy {
  readonly title: string;
  readonly description: string;
}

const RECOVERY_LABELS: Readonly<Record<CloudBootRecovery, { "zh-CN": string; en: string }>> = {
  retry: { "zh-CN": "重试", en: "Retry" },
  reload: { "zh-CN": "刷新页面", en: "Reload page" },
  "provide-token": { "zh-CN": "输入访问令牌", en: "Enter access token" },
  "open-home": { "zh-CN": "回到云首页", en: "Go to cloud home" },
};

function copyFor(failure: CloudBootFailure, locale: CloudEntryLocale): FailureCopy {
  const zh = locale === "zh-CN";
  switch (failure.reason) {
    case "remote-unsupported":
      return {
        title: zh ? "云入口不支持桌面远控链接" : "Remote control link is unavailable here",
        description: zh
          ? "?remote= 只在本机 Web / 桌面远控入口生效；云入口没有远端 attachment。请从项目/任务列表进入云任务（?task=）。"
          : "?remote= only works on the local web / desktop remote-control entry. The cloud entry has no remote attachment; open a cloud task (?task=) from the project list instead.",
      };
    case "invalid-task-id":
      return {
        title: zh ? "任务链接无效" : "Invalid task link",
        description: zh
          ? "链接里的任务 ID（?task=）格式不正确，无法打开对应任务。请回到云首页，从项目任务列表重新进入。"
          : "The task id in the link (?task=) is malformed, so the task cannot be opened. Go back to the cloud home and open the task from the project list.",
      };
    case "task-not-found":
      return {
        title: zh ? "任务不存在" : "Task not found",
        description: zh
          ? "这个任务不存在，或已被删除。它可能属于其他账号，也可能链接已过期。请回到云首页从任务列表重新进入。"
          : "This task does not exist or has been deleted. It may belong to another account, or the link may be out of date. Go back to the cloud home and reopen it from the task list.",
      };
    case "missing-token":
      return {
        title: zh ? "需要访问凭据" : "Access token required",
        description: zh
          ? "该云部署需要 lite-token 才能访问账号域与任务接口。请粘贴部署方提供的访问令牌，或使用带 ?token= 的访问链接打开。"
          : "This cloud deployment requires a lite-token for account and task APIs. Paste the access token from your operator, or open the link that carries ?token=.",
      };
    case "invalid-token":
      return {
        title: zh ? "访问凭据已失效" : "Access token rejected",
        description: zh
          ? "访问令牌无效或已过期，云入口没有建立任何本机回落。请使用部署方提供的新链接或粘贴新的令牌。"
          : "The access token is invalid or expired. No local fallback was started; use a fresh link from your operator or paste a new token.",
      };
    case "not-authorized":
      return {
        title: zh ? "凭据无权访问该部署" : "Credential not authorized",
        description: zh
          ? "令牌可用但当前主体没有该部署的访问权限（撤权或主体不匹配）。请与部署方确认访问链接。"
          : "The token works but the current principal is not allowed on this deployment (revoked or mismatched). Check the access link with your operator.",
      };
    case "not-configured":
      return {
        title: zh ? "该地址不是可用的入口" : "This address is not a usable entry",
        description: zh
          ? "模式探测端点 /api/cloud/capabilities 没有按契约回答（404/503 等）。请确认部署已按云或本地模式启动，并使用了正确的地址。"
          : "/api/cloud/capabilities did not answer per contract (404/503 …). Verify the deployment was started in cloud or local mode and that this is the right address.",
      };
    case "incompatible-bundle":
      return {
        title: zh ? "客户端与云入口版本不兼容" : "Client and cloud entry are incompatible",
        description: zh
          ? "当前 Web 产物与云入口的 wire 协议版本不一致。刷新可获取部署方发布的最新产物。"
          : "This bundle does not match the cloud entry wire protocol version. Reloading picks up the version the deployment currently serves.",
      };
    case "backend-unreachable":
      return {
        title: zh ? "无法连接到云服务" : "Cloud service unreachable",
        description: zh
          ? "请求未到达云入口或结果未知。入口不会因此切回本机工作区，请检查网络与部署状态后重试。"
          : "The request did not reach the cloud entry, or the result is unknown. The entry never falls back to a local workspace; check the network and retry.",
      };
    case "host-channel-unavailable":
      return {
        title: zh ? "账号通道不可用" : "Account channel unavailable",
        description: zh
          ? "host /ws 通道没有建立（账号域与模型目录都来自它）。请检查部署的反向代理是否放行 WebSocket 升级。"
          : "The host /ws channel could not be established (the account domain and model catalog come from it). Check that the deployment proxy allows WebSocket upgrades.",
      };
    case "bootstrap-unavailable":
      return {
        title: zh ? "无法构造云会话路由" : "Cloud session route cannot be built",
        description: zh
          ? "云入口无法从当前地址与 ?task= 构造会话路由（控制面 origin / taskId 解析失败）。身份解析失败必须拒绝：不猜、不用假身份顶替，也不回落本机。"
          : "The cloud entry cannot build the session route from the current address and ?task= (control-plane origin / taskId failed to parse). Identity resolution failures must be rejected: nothing is guessed, no fake identity is substituted, and no local workspace is used.",
      };
  }
}

export interface CloudBootstrapErrorScreenProps {
  readonly failure: CloudBootFailure;
  readonly locale: CloudEntryLocale;
  readonly onRecover: (recovery: CloudBootRecovery) => void;
}

export function CloudBootstrapErrorScreen({
  failure,
  locale,
  onRecover,
}: CloudBootstrapErrorScreenProps) {
  const copy = copyFor(failure, locale);
  const diagnosticsLabel = locale === "zh-CN" ? "诊断信息" : "Diagnostics";
  const diagnostics = [
    `reason=${failure.reason}`,
    failure.code === undefined ? undefined : `code=${failure.code}`,
    failure.traceId === undefined ? undefined : `traceId=${failure.traceId}`,
  ].filter((part): part is string => part !== undefined);

  return (
    <div className="h-dvh min-h-dvh w-screen overflow-y-auto bg-background text-foreground">
      <div className="mx-auto flex h-full w-full max-w-lg items-center px-4 py-6">
        <section
          role="alert"
          aria-live="assertive"
          className="w-full rounded-xl border border-card-border bg-card p-5"
        >
          <div className="flex items-center gap-3">
            <span className="size-2 shrink-0 rounded-full bg-destructive" aria-hidden="true" />
            <h1 className="text-ui-xs font-medium">{copy.title}</h1>
          </div>
          <p className="mt-2 text-ui-xs/relaxed text-foreground-subtle">{copy.description}</p>
          <p className="mt-3 break-all font-mono text-ui-caption text-foreground-subtle">
            {diagnosticsLabel}: {diagnostics.join(" · ")}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {failure.recoveries.map((recovery) => (
              <button
                key={recovery}
                type="button"
                className="rounded-lg border border-border bg-surface px-3 py-2 text-ui-xs text-foreground-subtle hover:bg-surface-hover"
                onClick={() => onRecover(recovery)}
              >
                {RECOVERY_LABELS[recovery][locale]}
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
