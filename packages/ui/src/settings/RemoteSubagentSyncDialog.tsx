/* eslint-disable max-lines -- 远端子智能体同步弹窗集中维护加载、三态判定、选择与结果，拆分会增加跨状态传递复杂度。 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircleIcon, Bot, Loader2, UploadCloud } from "lucide-react";
import { TID_SUBAGENT_REMOTE_SYNC_START, formatModelPickerValue } from "@zcode/shared";
import type {
  RemoteTarget,
  SubagentSyncCandidate,
  SubagentSyncImportResult,
  SubagentSyncRemoteItemState,
} from "@zcode/shared";
import type { ISubagentSyncService } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatRemoteSkillSyncTarget } from "@/settings/RemoteSkillSyncDialog.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import {
  isRemoteSyncPreflightTimeoutError,
  runRemoteSyncPreflightWithTimeout,
  shouldStartRemoteSyncOperation,
} from "@/settings/RemoteSyncActions.js";

type Step = "loading" | "selection" | "preflighting" | "syncing" | "complete";

interface RemoteSubagentSyncRow {
  candidate: SubagentSyncCandidate;
  remoteState: SubagentSyncRemoteItemState;
  remotePath?: string;
}

interface RemoteSubagentSyncDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  localSubagentSyncService: ISubagentSyncService;
  remoteSubagentSyncService: ISubagentSyncService;
  remoteTarget: RemoteTarget;
  workspacePath: string;
  onSynced: () => Promise<void> | void;
}

function buildRemoteSubagentSyncRows(
  candidates: readonly SubagentSyncCandidate[],
  statuses: readonly { id: string; state: SubagentSyncRemoteItemState; path?: string }[],
): RemoteSubagentSyncRow[] {
  const statusById = new Map(statuses.map((status) => [status.id, status]));
  return candidates.map((candidate) => {
    const status = statusById.get(candidate.id);
    return {
      candidate,
      remoteState: status?.state ?? "missing",
      ...(status?.path ? { remotePath: status.path } : {}),
    };
  });
}

// 默认勾选缺失与内容不同的项：前者是首次同步，后者是用户显式发起的更新。
function resolveDefaultRemoteSubagentSyncSelection(
  rows: readonly RemoteSubagentSyncRow[],
): Set<string> {
  return new Set(rows.filter((row) => row.remoteState !== "same").map((row) => row.candidate.id));
}

function filterRemoteSubagentSyncRows(
  rows: readonly RemoteSubagentSyncRow[],
  showUpToDateRemote: boolean,
): RemoteSubagentSyncRow[] {
  return showUpToDateRemote ? [...rows] : rows.filter((row) => row.remoteState !== "same");
}

function describeCandidate(candidate: SubagentSyncCandidate): string | null {
  if (candidate.kind === "builtInModelOverride") {
    return candidate.modelSelection ? formatModelPickerValue(candidate.modelSelection) : null;
  }
  return candidate.relativePath ?? null;
}

function remoteStateLabelId(state: SubagentSyncRemoteItemState): string {
  return `settings.subagents.remoteSync.state.${state}`;
}

function RemoteSubagentSyncTitle() {
  const { intl } = useZCodeIntl();
  const [warningTooltipOpen, setWarningTooltipOpen] = useState(false);
  const warningTitle = intl.formatMessage({
    id: "settings.subagents.remoteSync.warningTitle",
  });

  return (
    <DialogTitle className="flex min-w-0 items-center gap-2 pr-8">
      <span className="min-w-0 truncate">
        {intl.formatMessage({ id: "settings.subagents.remoteSync.title" })}
      </span>
      <ControlHintTooltip
        open={warningTooltipOpen}
        title={warningTitle}
        description={intl.formatMessage({
          id: "settings.subagents.remoteSync.warningDescription",
        })}
        side="right"
        align="center"
      >
        <span
          aria-label={warningTitle}
          className="inline-flex size-5 items-center justify-center rounded-full text-warning transition-colors hover:bg-hover hover:text-warning focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
          onMouseEnter={() => setWarningTooltipOpen(true)}
          onMouseLeave={() => setWarningTooltipOpen(false)}
          role="img"
        >
          <AlertCircleIcon className="size-3.5" aria-hidden="true" />
        </span>
      </ControlHintTooltip>
    </DialogTitle>
  );
}

function RemoteSubagentSyncExistingFilterCheckbox({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <label className="inline-flex h-6 cursor-pointer items-center gap-2 rounded-md px-1 text-ui-base text-foreground-subtle hover:text-foreground">
      <input
        type="checkbox"
        className="size-4"
        checked={checked}
        onChange={(event) => onCheckedChange(event.currentTarget.checked)}
      />
      <span>{intl.formatMessage({ id: "settings.subagents.remoteSync.showUpToDate" })}</span>
    </label>
  );
}

function RemoteSubagentSyncTargetRow({
  targetLabel,
  showUpToDateRemote,
  showUpToDateFilter,
  onShowUpToDateRemoteChange,
}: {
  targetLabel: string;
  showUpToDateRemote: boolean;
  showUpToDateFilter: boolean;
  onShowUpToDateRemoteChange: (checked: boolean) => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <p className="min-w-0 break-words font-mono text-ui-base text-foreground-subtle">
        {intl.formatMessage(
          { id: "settings.subagents.remoteSync.target" },
          { target: targetLabel },
        )}
      </p>
      {showUpToDateFilter ? (
        <div className="shrink-0">
          <RemoteSubagentSyncExistingFilterCheckbox
            checked={showUpToDateRemote}
            onCheckedChange={onShowUpToDateRemoteChange}
          />
        </div>
      ) : null}
    </div>
  );
}

function RemoteSubagentSyncBulkSelectionCheckbox({
  selectedCount,
  totalSelectable,
  onSelectAll,
  onClearAll,
}: {
  selectedCount: number;
  totalSelectable: number;
  onSelectAll: () => void;
  onClearAll: () => void;
}) {
  const { intl } = useZCodeIntl();
  const inputRef = useRef<HTMLInputElement>(null);
  const disabled = totalSelectable === 0;
  const checked = totalSelectable > 0 && selectedCount >= totalSelectable;
  const indeterminate = totalSelectable > 0 && selectedCount > 0 && selectedCount < totalSelectable;

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  return (
    <label
      className={`inline-flex h-6 items-center gap-2 rounded-md px-1 text-ui-base text-foreground-subtle ${
        disabled ? "opacity-50" : "cursor-pointer hover:text-foreground"
      }`}
    >
      <input
        ref={inputRef}
        type="checkbox"
        className="size-4"
        checked={checked}
        disabled={disabled}
        aria-checked={indeterminate ? "mixed" : checked ? "true" : "false"}
        onChange={(event) => {
          if (event.currentTarget.checked) {
            onSelectAll();
          } else {
            onClearAll();
          }
        }}
      />
      <span>{intl.formatMessage({ id: "settings.subagents.remoteSync.selectAll" })}</span>
    </label>
  );
}

function RemoteSubagentSyncSelectionList({
  rows,
  selectedIds,
  emptyMessageId,
  onToggle,
}: {
  rows: readonly RemoteSubagentSyncRow[];
  selectedIds: ReadonlySet<string>;
  emptyMessageId?: string;
  onToggle: (id: string, checked: boolean) => void;
}) {
  const { intl } = useZCodeIntl();

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({
          id: emptyMessageId ?? "settings.subagents.remoteSync.empty",
        })}
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      {rows.map((row) => {
        const checkboxId = `remote-subagent-sync-${row.candidate.id}`;
        const labelId = `${checkboxId}-label`;
        const selected = selectedIds.has(row.candidate.id);
        const selectable = row.remoteState !== "same";
        const description = describeCandidate(row.candidate);
        return (
          <label
            key={row.candidate.id}
            htmlFor={checkboxId}
            className={`grid grid-cols-[auto_auto_minmax(0,1fr)] gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-ui-base ${
              selectable
                ? "cursor-pointer hover:border-border-hover hover:bg-surface-hover"
                : "cursor-default"
            }`}
          >
            <input
              id={checkboxId}
              type="checkbox"
              aria-labelledby={labelId}
              className="mt-1 size-4"
              checked={selectable && selected}
              disabled={!selectable}
              onChange={(event) => onToggle(row.candidate.id, event.currentTarget.checked)}
            />
            <span
              className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-border text-foreground-subtle"
              aria-hidden="true"
            >
              <Bot className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                <span id={labelId} className="font-medium text-foreground">
                  {row.candidate.name}
                </span>
                <span className="rounded-md bg-secondary px-1.5 py-0.5 text-ui-xs font-medium text-foreground-subtle">
                  {intl.formatMessage({
                    id:
                      row.candidate.kind === "builtInModelOverride"
                        ? "settings.subagents.remoteSync.kind.builtIn"
                        : "settings.subagents.remoteSync.kind.userAgent",
                  })}
                </span>
                <span className="text-ui-base text-foreground-subtlest">
                  {intl.formatMessage({ id: remoteStateLabelId(row.remoteState) })}
                </span>
              </span>
              {description ? (
                <span className="mt-1 block break-all font-mono text-ui-base text-foreground-subtlest">
                  {description}
                </span>
              ) : null}
              {row.remotePath ? (
                <span className="mt-0.5 block break-all font-mono text-ui-xs text-foreground-subtlest">
                  {row.remotePath}
                </span>
              ) : null}
            </span>
          </label>
        );
      })}
    </div>
  );
}

function RemoteSubagentSyncResultList({ result }: { result: SubagentSyncImportResult | null }) {
  const { intl } = useZCodeIntl();
  const items = result?.results ?? [];

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.subagents.remoteSync.resultEmpty" })}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="divide-y divide-border">
        {items.map((item) => (
          <div
            key={`${item.id}-${item.status}`}
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-3"
          >
            <div className="min-w-0">
              <div className="truncate text-ui-base font-medium text-foreground">{item.name}</div>
              {item.error ? (
                <div className="mt-0.5 break-words text-ui-base text-destructive">{item.error}</div>
              ) : item.path ? (
                <div className="mt-0.5 truncate font-mono text-ui-xs text-foreground-subtlest">
                  {item.path}
                </div>
              ) : null}
            </div>
            <span className="shrink-0 rounded-md bg-surface px-1.5 py-0.5 text-ui-xs text-foreground-subtle ring-1 ring-border">
              {intl.formatMessage({ id: `settings.subagents.remoteSync.${item.status}` })}
            </span>
          </div>
        ))}
      </div>
      <div className="border-t border-border bg-surface px-4 py-2 text-ui-base text-foreground-subtle">
        {result?.rolledBack
          ? intl.formatMessage({ id: "settings.subagents.remoteSync.rolledBack" })
          : intl.formatMessage({ id: "settings.subagents.remoteSync.takesEffect" })}
      </div>
    </div>
  );
}

export function RemoteSubagentSyncDialog(props: RemoteSubagentSyncDialogProps) {
  const { intl } = useZCodeIntl();
  const {
    localSubagentSyncService,
    onOpenChange,
    onSynced,
    open,
    remoteSubagentSyncService,
    remoteTarget,
    workspacePath,
  } = props;
  const [step, setStep] = useState<Step>("loading");
  const [rows, setRows] = useState<RemoteSubagentSyncRow[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showUpToDateRemote, setShowUpToDateRemote] = useState(true);
  const [importResult, setImportResult] = useState<SubagentSyncImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const syncInFlightRef = useRef(false);

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;
    setStep("loading");
    setRows([]);
    setSelectedIds(new Set());
    setShowUpToDateRemote(true);
    setImportResult(null);
    setError(null);
    syncInFlightRef.current = false;

    void (async () => {
      try {
        const localResult = await localSubagentSyncService.listLocalUserSubagentCandidates();
        const remoteResult = await remoteSubagentSyncService.listRemoteUserSubagentStatuses({
          candidates: localResult.candidates.map((candidate) => ({
            id: candidate.id,
            kind: candidate.kind,
            ...(candidate.agentName ? { agentName: candidate.agentName } : {}),
            ...(candidate.modelSelection ? { modelSelection: candidate.modelSelection } : {}),
            ...(candidate.relativePath ? { relativePath: candidate.relativePath } : {}),
            ...(candidate.contentHash ? { contentHash: candidate.contentHash } : {}),
          })),
        });
        if (cancelled) {
          return;
        }
        const nextRows = buildRemoteSubagentSyncRows(localResult.candidates, remoteResult.statuses);
        setRows(nextRows);
        setSelectedIds(resolveDefaultRemoteSubagentSyncSelection(nextRows));
        setStep("selection");
      } catch (loadError) {
        if (cancelled) {
          return;
        }
        setError(loadError instanceof Error ? loadError.message : String(loadError));
        setStep("selection");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [localSubagentSyncService, open, remoteSubagentSyncService]);

  const visibleRows = useMemo(
    () => filterRemoteSubagentSyncRows(rows, showUpToDateRemote),
    [rows, showUpToDateRemote],
  );
  const visibleSelectableIds = useMemo(
    () => visibleRows.filter((row) => row.remoteState !== "same").map((row) => row.candidate.id),
    [visibleRows],
  );
  const selectedSyncIds = useMemo(
    () => visibleSelectableIds.filter((id) => selectedIds.has(id)),
    [selectedIds, visibleSelectableIds],
  );
  const selectedCount = selectedSyncIds.length;
  const targetLabel = formatRemoteSkillSyncTarget(remoteTarget, workspacePath);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && (step === "preflighting" || step === "syncing")) {
      return;
    }
    onOpenChange(nextOpen);
  };

  const toggleItem = (id: string, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  const syncSelected = async () => {
    if (
      !shouldStartRemoteSyncOperation({
        inFlight: syncInFlightRef.current,
        selectedCount: selectedSyncIds.length,
      })
    ) {
      if (selectedSyncIds.length === 0) {
        setError(intl.formatMessage({ id: "settings.subagents.remoteSync.noSelection" }));
      }
      return;
    }

    syncInFlightRef.current = true;
    setError(null);
    setStep("preflighting");
    try {
      const access = await runRemoteSyncPreflightWithTimeout(() =>
        remoteSubagentSyncService.checkRemoteUserSubagentWriteAccess(),
      );
      if (!access.ok) {
        throw new Error(
          intl.formatMessage(
            { id: "settings.remoteSync.preflightFailed" },
            { path: access.path, error: access.error ?? "" },
          ),
        );
      }
      setStep("syncing");
      const exported = await localSubagentSyncService.exportSubagentConfig({
        ids: selectedSyncIds,
      });
      const result = await remoteSubagentSyncService.importSubagentConfig({
        entries: exported.entries,
      });
      await onSynced();
      setImportResult(result);
      setStep("complete");
    } catch (syncError) {
      setError(
        isRemoteSyncPreflightTimeoutError(syncError)
          ? intl.formatMessage(
              { id: "settings.remoteSync.preflightTimeout" },
              { seconds: String(Math.ceil(syncError.timeoutMs / 1000)) },
            )
          : syncError instanceof Error
            ? syncError.message
            : String(syncError),
      );
      setStep("selection");
    } finally {
      syncInFlightRef.current = false;
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="h-[min(720px,calc(100dvh-2rem))] max-h-[min(720px,calc(100dvh-2rem))] max-w-2xl flex flex-col overflow-hidden">
        <DialogHeader>
          <RemoteSubagentSyncTitle />
          <RemoteSubagentSyncTargetRow
            targetLabel={targetLabel}
            showUpToDateRemote={showUpToDateRemote}
            showUpToDateFilter={step === "selection" && rows.length > 0}
            onShowUpToDateRemoteChange={setShowUpToDateRemote}
          />
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {error ? (
            <div className="mb-3 rounded-lg border border-destructive/40 bg-surface px-3 py-2 text-ui-base text-destructive">
              {error}
            </div>
          ) : null}
          {step === "loading" ? (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.subagents.remoteSync.loading" })}
            </div>
          ) : null}
          {step === "preflighting" ? (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.remoteSync.preflighting" })}
            </div>
          ) : null}
          {step === "selection" ? (
            <RemoteSubagentSyncSelectionList
              rows={visibleRows}
              selectedIds={selectedIds}
              emptyMessageId={
                rows.length > 0 ? "settings.subagents.remoteSync.filteredEmpty" : undefined
              }
              onToggle={toggleItem}
            />
          ) : null}
          {step === "syncing" ? (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.subagents.remoteSync.syncing" })}
            </div>
          ) : null}
          {step === "complete" ? <RemoteSubagentSyncResultList result={importResult} /> : null}
        </div>

        <div className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-ui-base text-foreground-subtle">
            {intl.formatMessage(
              { id: "settings.subagents.remoteSync.selectionCount" },
              { selected: String(selectedCount), total: String(visibleSelectableIds.length) },
            )}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {step === "selection" ? (
              <RemoteSubagentSyncBulkSelectionCheckbox
                selectedCount={selectedCount}
                totalSelectable={visibleSelectableIds.length}
                onSelectAll={() => setSelectedIds(new Set(visibleSelectableIds))}
                onClearAll={() => setSelectedIds(new Set())}
              />
            ) : null}
            <Button
              type="button"
              size="sm"
              data-testid={TID_SUBAGENT_REMOTE_SYNC_START}
              disabled={step !== "selection" || selectedCount === 0}
              onClick={syncSelected}
            >
              <UploadCloud className="size-3.5" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.subagents.remoteSync.start" })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
