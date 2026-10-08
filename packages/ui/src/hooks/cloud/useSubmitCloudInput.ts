/**
 * `useSubmitCloudInput` —— 持久输入提交与对账（specs/cloud-agent/04 §3.2/§3.4/§3.4.1、11 §6/§7、03 §6.2）。
 *
 * 这个 hook 是**客户端唯一**的 Cloud 输入写入口：
 * - 首发（draft start）与补充（append）都调用同一 durable application port；
 *   ready 之后共享 composer 也不允许绕控制面直发 CLI（04 §3.4 尾段）。
 * - `commandId` 在用户触发时生成一次，重试/恢复只能沿用原 key，不得自动换 key。
 * - `202` 只显示「已提交，等待环境」；`receipt` 与 `runtimeAck` 分别表达收据与
 *   runtime 准入，UI 不合成 CommandAck（04 §3.2.4、03 §7.2）。
 * - 本地冻结失败（`not-frozen`）时**不发 HTTP**（04 §3.4.1）。
 */
import { useCallback, useMemo, useRef, useState } from "react";
import type { CloudDraftStartConfig, CloudExecutionConfig, InputReceipt } from "@zcode/shared";
import type { CloudControlPlanePort } from "@/cloud/cloudPorts.js";
import {
  reconcileCloudTaskInput,
  submitCloudTaskInput,
  type CloudSubmissionOutcome,
} from "@/cloud/cloudTaskSubmission.js";
import { useCloudWorkspaceContext } from "@/cloud/cloudWorkspaceContext.js";
import {
  useCloudDraftStore,
  type CloudSubmitAttempt,
  type CloudSubmitSettlement,
} from "@/store/cloud/cloudDraftStore.js";

export interface SubmitFirstInputArgs {
  readonly prompt: string;
  /** 必须与已保存的 draftStartConfig 一致：服务端在接纳事务里做一致性校验（03 §6 start 行）。 */
  readonly start: CloudDraftStartConfig;
  readonly expectedTaskRevision: number;
  readonly requestedConfig?: CloudExecutionConfig;
  /** 复用已有 key（用户点重试或恢复 unknown attempt）。 */
  readonly commandId?: string;
}

export interface SubmitAppendInputArgs {
  readonly prompt: string;
  readonly expectedRunGeneration: number;
  readonly requestedConfig?: CloudExecutionConfig;
  /** 复用已有 key（用户点重试或恢复 unknown attempt）。 */
  readonly commandId?: string;
}

export interface UseSubmitCloudInputResult {
  readonly draftBody: string;
  readonly bodyVersion: number;
  /** 未决（frozen/unknown）attempt：刷新后必须先把它们查清楚（04 §3.2.5）。 */
  readonly pendingAttempts: readonly CloudSubmitAttempt[];
  /** 最近一次提交结果；`unknown` 时调用方展示「结果待确认」而不是失败。 */
  readonly lastOutcome: CloudSubmissionOutcome | null;
  setDraftBody(body: string): void;
  submitFirstInput(args: SubmitFirstInputArgs): Promise<CloudSubmissionOutcome>;
  submitAppendInput(args: SubmitAppendInputArgs): Promise<CloudSubmissionOutcome>;
  /** 用**原 payload 原 commandId** 重投：只在确认 unknown 之后调用（03 §5）。 */
  retryAttempt(attempt: CloudSubmitAttempt): Promise<CloudSubmissionOutcome>;
  /** 刷新后先对账：按原 commandId 查询，拿到 receipt 才清本次正文（04 §3.2.5）。 */
  reconcilePending(): Promise<readonly InputReceipt[]>;
}

export interface UseSubmitCloudInputOptions {
  readonly controlPlane?: CloudControlPlanePort | null;
}

/** UI 侧本地生成 commandId（uuid v4 形态），与 shared `commandIdSchema` 兼容。 */
export function createCloudCommandId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // 没有安全随机源时直接失败：不允许用弱随机数伪造幂等键。
  throw new Error("crypto.randomUUID is required to create a cloud commandId");
}

export function useSubmitCloudInput(
  options?: UseSubmitCloudInputOptions,
): UseSubmitCloudInputResult {
  const context = useCloudWorkspaceContext();
  const controlPlane = options?.controlPlane ?? context?.controlPlane ?? null;
  const selection = context?.selection ?? null;
  const scopeKey = selection?.draftScope?.key ?? null;
  const taskId = selection?.taskId ?? null;
  // 首发 202 后请求控制器启动有界 run 观察（04 §3.2.4）。函数引用由控制器保证稳定，
  // 不把整个 context 对象放进依赖（它随每次详情刷新换引用）。
  const beginTaskRunWatch = context?.beginTaskRunWatch ?? null;

  const [lastOutcome, setLastOutcome] = useState<CloudSubmissionOutcome | null>(null);

  const draftRecord = useCloudDraftStore((state) =>
    scopeKey ? state.drafts[scopeKey] : undefined,
  );
  const attemptsForScope = useCloudDraftStore((state) =>
    scopeKey ? state.attempts[scopeKey] : undefined,
  );
  const bodyVersionRef = useRef(0);
  bodyVersionRef.current = draftRecord?.bodyVersion ?? 0;

  const deps = useMemo(() => {
    if (!controlPlane || !scopeKey || !taskId) {
      return null;
    }
    return {
      controlPlane,
      scopeKey,
      taskId,
      freezeAttempt: (attempt: Omit<CloudSubmitAttempt, "scopeKey" | "phase" | "frozenAt">) =>
        useCloudDraftStore.getState().freezeAttempt(scopeKey, attempt),
      settleAttempt: (commandId: string, settlement: CloudSubmitSettlement) =>
        useCloudDraftStore.getState().settleAttempt(scopeKey, commandId, settlement),
      applyReceipt: (commandId: string, receipt: InputReceipt) =>
        useCloudDraftStore.getState().applyReceipt(scopeKey, commandId, receipt),
    };
  }, [controlPlane, scopeKey, taskId]);

  const setDraftBody = useCallback(
    (body: string) => {
      if (!scopeKey) {
        return;
      }
      useCloudDraftStore.getState().setBody(scopeKey, body);
    },
    [scopeKey],
  );

  const run = useCallback(
    async (input: {
      commandId: string;
      request: Parameters<typeof submitCloudTaskInput>[0]["request"];
    }): Promise<CloudSubmissionOutcome> => {
      if (!deps) {
        throw new Error("cloud control plane or task scope is not configured");
      }
      const outcome = await submitCloudTaskInput({
        commandId: input.commandId,
        request: input.request,
        bodyVersion: bodyVersionRef.current,
        deps,
      });
      setLastOutcome(outcome);
      return outcome;
    },
    [deps],
  );

  const submitFirstInput = useCallback(
    (args: SubmitFirstInputArgs): Promise<CloudSubmissionOutcome> => {
      const commandId = args.commandId ?? createCloudCommandId();
      return run({
        commandId,
        request: {
          kind: "input",
          body: {
            intent: "start",
            commandId,
            prompt: args.prompt,
            expectedTaskRevision: args.expectedTaskRevision,
            start: args.start,
            ...(args.requestedConfig === undefined
              ? {}
              : { requestedConfig: args.requestedConfig }),
          },
        },
      }).then((outcome) => {
        // 首发 202 ≠ run 已可见（04 §3.2.4）：立刻请求有界轮询，把详情从 draft 翻到
        // provisioning/ready/failed，否则用户要手动刷新才能看到任务已启动。
        if (outcome.kind === "persisted") {
          beginTaskRunWatch?.();
        }
        return outcome;
      });
    },
    [beginTaskRunWatch, run],
  );

  const submitAppendInput = useCallback(
    (args: SubmitAppendInputArgs): Promise<CloudSubmissionOutcome> => {
      const commandId = args.commandId ?? createCloudCommandId();
      return run({
        commandId,
        request: {
          kind: "input",
          body: {
            intent: "append",
            commandId,
            prompt: args.prompt,
            expectedRunGeneration: args.expectedRunGeneration,
            ...(args.requestedConfig === undefined
              ? {}
              : { requestedConfig: args.requestedConfig }),
          },
        },
      });
    },
    [run],
  );

  const retryAttempt = useCallback(
    (attempt: CloudSubmitAttempt): Promise<CloudSubmissionOutcome> =>
      // 直接用冻结时的 payload 与 commandId 重投：不重新组装、不换 key（11 §7）。
      run({ commandId: attempt.commandId, request: attempt.request }),
    [run],
  );

  const pendingAttempts = useMemo(
    () =>
      Object.values(attemptsForScope ?? {}).filter(
        (attempt) => attempt.phase === "frozen" || attempt.phase === "unknown",
      ),
    [attemptsForScope],
  );

  const reconcilePending = useCallback(async (): Promise<readonly InputReceipt[]> => {
    if (!deps) {
      return [];
    }
    const receipts: InputReceipt[] = [];
    for (const attempt of pendingAttempts) {
      receipts.push(await reconcileCloudTaskInput(deps, attempt.commandId));
    }
    return receipts;
  }, [deps, pendingAttempts]);

  return useMemo(
    () => ({
      draftBody: draftRecord?.body ?? "",
      bodyVersion: draftRecord?.bodyVersion ?? 0,
      pendingAttempts,
      lastOutcome,
      setDraftBody,
      submitFirstInput,
      submitAppendInput,
      retryAttempt,
      reconcilePending,
    }),
    [
      draftRecord?.body,
      draftRecord?.bodyVersion,
      lastOutcome,
      pendingAttempts,
      reconcilePending,
      retryAttempt,
      setDraftBody,
      submitAppendInput,
      submitFirstInput,
    ],
  );
}
