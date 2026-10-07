/**
 * 云入口的凭据门（specs/cloud-agent/modules/W9 §3/§5；03 §3；12 §5）。
 *
 * 只在「客户端完全没有凭据」时出现：URL 无 `?token=` 且服务端未下发 lite-token cookie。
 * 用户粘贴的令牌只用于**一次**同源握手（`/api/cloud/capabilities?token=`），服务端按既有
 * 约定下发 HttpOnly cookie；此后 `/api/cloud/*` 与 `/ws` 都走 cookie，令牌不进 URL、不写
 * localStorage/sessionStorage，也不进日志（12 §5「浏览器不持有 token 正文」）。
 */
import { useCallback, useState } from "react";
import { completeCloudTokenHandshake } from "./cloudBoot.js";
import { resolveCloudEntryLocale, type CloudEntryLocale } from "./CloudBootstrapErrorScreen.js";

export interface CloudTokenGateProps {
  readonly origin: string;
  /** 握手成功：cookie 已建立，入口可以重跑启动流程。 */
  readonly onTokenAccepted: () => void;
}

const COPY = {
  "zh-CN": {
    title: "需要访问凭据",
    description: "该云部署需要访问令牌才能打开账号域与任务接口。",
    hint: "粘贴部署方提供的访问令牌。令牌只用于一次同源握手，不会保存在浏览器存储中。",
    label: "访问令牌",
    placeholder: "粘贴访问令牌",
    submit: "继续",
    pending: "校验中…",
    empty: "请输入访问令牌",
  },
  en: {
    title: "Access token required",
    description: "This cloud deployment requires an access token for account and task APIs.",
    hint: "Paste the access token from your operator. It is used for one same-origin handshake only and is never written to browser storage.",
    label: "Access token",
    placeholder: "Paste access token",
    submit: "Continue",
    pending: "Verifying…",
    empty: "Enter an access token",
  },
} as const;

export function CloudTokenGate({ origin, onTokenAccepted }: CloudTokenGateProps) {
  const locale: CloudEntryLocale = resolveCloudEntryLocale();
  const copy = COPY[locale];
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    const token = value.trim();
    if (!token) {
      setError(copy.empty);
      return;
    }
    setPending(true);
    setError(null);
    const result = await completeCloudTokenHandshake({ origin, token });
    setPending(false);
    // 只保留「成功/失败」两个结果：失败原因由启动流程的失败面统一呈现，这里不复制文案。
    setError(result.ok ? null : copyFailure(locale, result.failure.reason));
    if (result.ok) {
      onTokenAccepted();
    }
  }, [copy.empty, locale, onTokenAccepted, origin, value]);

  return (
    <div className="h-dvh min-h-dvh w-screen overflow-y-auto bg-background text-foreground">
      <div className="mx-auto flex h-full w-full max-w-lg items-center px-4 py-6">
        <section className="w-full rounded-xl border border-card-border bg-card p-5">
          <div className="flex items-center gap-3">
            <span className="size-2 shrink-0 rounded-full bg-brand" aria-hidden="true" />
            <h1 className="text-ui-xs font-medium">{copy.title}</h1>
          </div>
          <p className="mt-2 text-ui-xs/relaxed text-foreground-subtle">{copy.description}</p>
          <form
            className="mt-4 flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label className="text-ui-caption text-foreground-subtle" htmlFor="cloud-token-input">
              {copy.label}
            </label>
            <input
              id="cloud-token-input"
              // 令牌是凭据：用 password 形态避免肩窥；移动端用固定 16px 令牌避免 iOS 聚焦缩放。
              type="password"
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={copy.placeholder}
              aria-invalid={error !== null}
              className="text-mobile-input-safe md:text-ui-sm w-full rounded-lg border border-input-border bg-input px-3 py-2 text-foreground outline-none placeholder:text-foreground-subtlest focus-visible:border-input-border-focused"
            />
            <p className="text-ui-caption text-foreground-subtle">{copy.hint}</p>
            <div className="mt-1 flex items-center gap-3">
              <button
                type="submit"
                disabled={pending}
                className="rounded-lg border border-border bg-surface px-3 py-2 text-ui-xs text-foreground-subtle hover:bg-surface-hover disabled:opacity-60"
              >
                {pending ? copy.pending : copy.submit}
              </button>
              {error === null ? null : (
                <span role="alert" className="text-ui-xs text-destructive">
                  {error}
                </span>
              )}
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}

/** 门内只做「能不能进」的提示，具体分类文案由启动失败面负责（W9 §5）。 */
function copyFailure(locale: CloudEntryLocale, reason: string): string {
  const zh = locale === "zh-CN";
  switch (reason) {
    case "backend-unreachable":
      return zh ? "无法连接到云服务，请检查网络后重试" : "Cloud service unreachable, retry later";
    case "incompatible-bundle":
    case "not-configured":
      return zh ? "该地址不是可用的云入口" : "This address is not a usable cloud entry";
    default:
      return zh ? "访问令牌无效" : "Access token is invalid";
  }
}
