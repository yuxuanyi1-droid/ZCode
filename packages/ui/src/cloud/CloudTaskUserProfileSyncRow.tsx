/**
 * 云任务面板「同步用户资源」入口（specs/cloud-agent/14 §4.6/§9.5；W11 §13D）。
 *
 * 位置：与 `CloudTaskRunStatusBanner` / `CloudTaskArchivedBanner` 同一槽位（工作区主区
 * header 之下、聊天区之上）——云任务的操作与状态呈现都在这一行区域，停止/重开等动作
 * 也在邻近槽位，避免在别处长出第二个"任务操作区"。
 *
 * 显示门控（14 §4.6 门控双保险）：只在 **Run 连接态（bridge ready，attachment 在线）且
 * 非终态** 时渲染；未连接/终态**不渲染**（不是禁用态），判定见
 * `resolveCloudUserProfileSyncEntry`（纯函数 + node:test）。
 *
 * 结果呈现（14 §4.6「结论可见性」）：手动同步的逐条结论在响应里返回，这里就地展示
 * 计数摘要 + 失败条目简列（`error` 为服务端有界诊断文本）；失败文案按结构化 code/reason
 * 归一（409 `run-not-connected` → 「沙箱未连接」），不解析服务端文案（04 §6）。
 */
import { Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useCloudTaskUserProfileSync } from "@/hooks/cloud/useCloudTaskUserProfileSync.js";

export interface CloudTaskUserProfileSyncRowProps {
  /** 当前工作区身份（`cloud-task:<taskId>`）；非云任务返回 null（组件零渲染）。 */
  readonly workspaceIdentity?: string | null;
  readonly className?: string;
}

export function CloudTaskUserProfileSyncRow({
  workspaceIdentity,
  className,
}: CloudTaskUserProfileSyncRowProps) {
  const { intl } = useZCodeIntl();
  const { entry, pending, summary, errorText, sync } =
    useCloudTaskUserProfileSync(workspaceIdentity);

  if (!entry.visible) {
    return null;
  }

  const format = intl.formatMessage.bind(intl);

  return (
    <div
      role="status"
      data-testid="cloud-task-user-profile-sync"
      className={cn(
        "flex w-full shrink-0 flex-col gap-2 border-b border-border bg-surface px-4 py-2 text-ui-base text-foreground",
        className,
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-foreground-subtle">
          {format({ id: "cloud.userProfileSync.hint" })}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="cloud-task-user-profile-sync-submit"
          disabled={pending}
          onClick={() => void sync()}
        >
          {pending ? (
            <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw aria-hidden="true" className="size-3.5" />
          )}
          {format({
            id: pending ? "cloud.userProfileSync.pending" : "cloud.userProfileSync.action",
          })}
        </Button>
      </div>
      {summary !== null ? (
        <div
          className="flex min-w-0 flex-col gap-1 text-ui-base text-foreground-subtle"
          data-testid="cloud-task-user-profile-sync-result"
        >
          <span>
            {format(
              { id: "cloud.userProfileSync.result" },
              {
                total: summary.total,
                synced: summary.synced,
                skipped: summary.skipped,
                failed: summary.failed,
                version: summary.profileVersion,
              },
            )}
          </span>
          {/* join 在飞的自动同步（14 §4.6 单飞）：如实说明本次结果由自动同步承载，不伪写 trigger。 */}
          {summary.trigger === "automatic" ? (
            <span data-testid="cloud-task-user-profile-sync-joined">
              {format({ id: "cloud.userProfileSync.joinedAutomatic" })}
            </span>
          ) : null}
          {summary.failures.length === 0 ? null : (
            <ul
              className="flex flex-col gap-0.5"
              data-testid="cloud-task-user-profile-sync-failures"
            >
              {summary.failures.map((failure) => (
                <li key={`${failure.category}\u0000${failure.entryId}`}>
                  <span className="font-mono">
                    {failure.category}/{failure.entryId}
                  </span>
                  {failure.error === null ? null : <span>: {failure.error}</span>}
                </li>
              ))}
            </ul>
          )}
          {summary.hiddenFailures === 0 ? null : (
            <span>
              {format(
                { id: "cloud.userProfileSync.moreFailures" },
                { count: summary.hiddenFailures },
              )}
            </span>
          )}
        </div>
      ) : null}
      {errorText === null ? null : (
        <p
          className="min-w-0 break-words [overflow-wrap:anywhere] text-ui-base text-destructive"
          data-testid="cloud-task-user-profile-sync-error"
        >
          {errorText}
        </p>
      )}
    </div>
  );
}
