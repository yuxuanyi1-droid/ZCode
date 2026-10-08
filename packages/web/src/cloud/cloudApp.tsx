/**
 * 云模式应用壳（specs/cloud-agent/modules/W9 §3；04 §3.0/§3.0.1/§4；12 §5）。
 *
 * 职责只有三件：把 host accessor 交给 UI 组合（W8）、把 cloud providers 包在原 `Root`
 * 外层、把启动阶段（booting / 需要凭据 / 失败 / ready）显式呈现。云任务与浏览器的执行
 * 请求由 W8 的 attachment 覆盖提供，入口层不写业务规则，也不提前返回自建外壳
 * （04 §3.0 禁止 `cloudShell` 式绕过）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Root as ReactRoot } from "react-dom/client";
import {
  AppErrorBoundary,
  Root,
  ZCodeIntlProvider,
  resolveCloudTaskRouteFailure,
  useCloudWorkspaceContext,
  useServices,
} from "@zcode/ui";
import type { IPlatformService } from "@zcode/shared";
import {
  classifyCloudBootError,
  createCloudBootFailure,
  type CloudBootFailure,
  type CloudBootRecovery,
  type CloudEntryPlan,
} from "./cloudBoot.js";
import { bootstrapCloudRuntime, type CloudRuntime } from "./cloudRuntime.js";
import { cloudUiComposition } from "./cloudUiComposition.js";
import {
  CloudBootstrapErrorScreen,
  resolveCloudEntryLocale,
  type CloudEntryLocale,
} from "./CloudBootstrapErrorScreen.js";
import { CloudTokenGate } from "./CloudTokenGate.js";
import { createWebPlatform } from "../webPlatform.js";

type CloudAppPhase =
  | { readonly kind: "booting" }
  | { readonly kind: "token-required" }
  | { readonly kind: "failed"; readonly failure: CloudBootFailure }
  | { readonly kind: "ready"; readonly runtime: CloudRuntime };

/** 启动失败只记录结构化事实：不含 token、prompt 正文与仓库内容（AGENTS 日志规范）。 */
function reportBootFailure(failure: CloudBootFailure): void {
  console.warn("[cloud-web]", "bootstrap_failed", {
    reason: failure.reason,
    code: failure.code,
    traceId: failure.traceId,
    httpStatus: failure.detail?.httpStatus,
  });
}

export interface CloudAppProps {
  readonly plan: CloudEntryPlan;
}

export function CloudApp({ plan }: CloudAppProps) {
  const locale: CloudEntryLocale = resolveCloudEntryLocale();
  const [attempt, setAttempt] = useState(0);
  // 探测被 401/403 拒绝（`plan.credentialRequired`，04 §2.1）时直接进凭据门：
  // 服务端已经明确要求凭据，不必再跑一次必然失败的启动流程。
  const [needsToken, setNeedsToken] = useState(plan.credentialRequired);
  const [phase, setPhase] = useState<CloudAppPhase>(
    plan.credentialRequired ? { kind: "token-required" } : { kind: "booting" },
  );
  const platform = useMemo(() => createWebPlatform({ mode: "cloud" }), []);

  useEffect(() => {
    if (needsToken) {
      return;
    }
    let cancelled = false;
    let started: CloudRuntime | null = null;
    void bootstrapCloudRuntime(plan, { ui: cloudUiComposition })
      .then((result) => {
        if (cancelled) {
          if (result.ok) {
            result.runtime.dispose();
          }
          return;
        }
        if (!result.ok) {
          reportBootFailure(result.failure);
          // 凭据缺失是「可以自己解决」的情况：给门而不是错误页（W9 §3 CloudTokenGate）。
          setPhase(
            result.failure.reason === "missing-token"
              ? { kind: "token-required" }
              : { kind: "failed", failure: result.failure },
          );
          return;
        }
        started = result.runtime;
        setPhase({ kind: "ready", runtime: result.runtime });
      })
      .catch((error: unknown) => {
        // 编排本身抛错也要停在失败面：启动阶段不允许卡在 loading 或白屏（W9 §5）。
        if (cancelled) {
          return;
        }
        const failure = classifyCloudBootError(error, { tokenProvided: plan.token !== undefined });
        reportBootFailure(failure);
        setPhase({ kind: "failed", failure });
      });
    return () => {
      cancelled = true;
      started?.dispose();
    };
  }, [attempt, needsToken, plan]);

  const retry = useCallback(() => {
    setPhase({ kind: "booting" });
    setAttempt((value) => value + 1);
  }, []);

  const handleTokenAccepted = useCallback(() => {
    // cookie 已建立：清掉凭据门，再把启动流程跑一遍（needsToken 与 attempt 同一轮变化）。
    setNeedsToken(false);
    retry();
  }, [retry]);

  const handleRecover = useCallback(
    (recovery: CloudBootRecovery) => {
      switch (recovery) {
        case "retry":
          retry();
          return;
        case "reload":
          window.location.reload();
          return;
        case "provide-token":
          setNeedsToken(true);
          setPhase({ kind: "token-required" });
          return;
        case "open-home": {
          // 丢弃入口参数（?task=/?remote=/?token=）回到云首页；不涉及任务事实写入。
          const url = new URL(window.location.href);
          url.search = "";
          window.location.replace(url.toString());
          return;
        }
      }
    },
    [retry],
  );

  if (phase.kind === "token-required") {
    return (
      <CloudTokenGate
        origin={plan.origin}
        // 部署链接 `?token=` 仍是凭据传入通道（04 §2.1）：门里自动用它握手一次，失败再手填。
        {...(plan.token === undefined ? {} : { initialToken: plan.token })}
        onTokenAccepted={handleTokenAccepted}
      />
    );
  }

  if (phase.kind === "failed") {
    return (
      <CloudBootstrapErrorScreen
        failure={phase.failure}
        locale={locale}
        onRecover={handleRecover}
      />
    );
  }

  if (phase.kind !== "ready") {
    // 启动中：沿用 index.html 的首屏壳语义，只给状态区，不渲染任何半套工作区。
    return (
      <div className="flex h-dvh min-h-dvh w-screen items-center justify-center bg-background">
        <span role="status" aria-live="polite" className="text-ui-xs text-foreground-subtle">
          ZCode
        </span>
      </div>
    );
  }

  const { runtime } = phase;
  const WorkspaceProvider = cloudUiComposition.WorkspaceProvider;
  return (
    <AppErrorBoundary>
      <ZCodeIntlProvider
        // 账号域（设置/广播）来自 host `/ws`：与 web 模式同款，不加云分支（12 §5）。
        settingService={runtime.hostAccessor.settingService}
        broadcastService={runtime.hostAccessor.broadcastService}
      >
        <WorkspaceProvider
          bootstrap={runtime.bootstrap}
          controlPlane={runtime.client.controlPlane}
          hostAccessor={runtime.hostAccessor}
          attachmentProvider={runtime.attachmentProvider}
        >
          {/*
           * 不传 onNavigateTask：任务切换的路由写入由 W8 控制器一处完成（侧栏只调
           * selectTask，未提供回调时 controller 回落到 openCloudTaskRoute）。入口只把
           * 深链 `?task=` 经 bootstrap.taskId 交给它，避免写入回环（04 §5）。
           */}
          <CloudRootBridge
            platform={platform}
            locale={locale}
            onRecover={handleRecover}
            {...(runtime.bootstrap.taskId === undefined
              ? {}
              : { taskId: runtime.bootstrap.taskId })}
          />
        </WorkspaceProvider>
      </ZCodeIntlProvider>
    </AppErrorBoundary>
  );
}

export interface CloudRootBridgeProps {
  readonly platform: IPlatformService;
  readonly taskId?: string | undefined;
  readonly locale: CloudEntryLocale;
  readonly onRecover: (recovery: CloudBootRecovery) => void;
}

/**
 * 原 `Root` 的唯一挂载点：服务面由 W8 的 provider 合成（base = host `/ws`，执行域 = 当前
 * Run attachment），这里只把合成结果读回来交给 Root，因此组件里没有 `isCloud` 分支
 * （04 §3.0「禁止提前返回独立外壳」、12 §5）。
 */
function CloudRootBridge({ platform, taskId, locale, onRecover }: CloudRootBridgeProps) {
  const services = useServices();
  const cloudWorkspace = useCloudWorkspaceContext();
  // 主路由任务不存在（?task=<合法 UUID> 但控制面 404，2026-10-08 巡检修订）：与非法
  // task id 一致地渲染错误屏，不静默回落欢迎页；同时整棵工作区树卸载，收敛多个订阅方
  // 各自重发的 404 详情请求。判定按结构化错误码（not_found），不解析文案。
  const routeFailure = resolveCloudTaskRouteFailure({
    bootstrappedTaskId: taskId,
    selectionTaskId: cloudWorkspace?.selection.taskId ?? null,
    taskDetailStatus: cloudWorkspace?.taskDetailStatus ?? "idle",
    taskDetailErrorCode: cloudWorkspace?.taskDetailErrorCode ?? null,
  });

  if (routeFailure) {
    return (
      <CloudBootstrapErrorScreen
        failure={createCloudBootFailure(routeFailure.reason)}
        locale={locale}
        onRecover={onRecover}
      />
    );
  }

  return (
    <Root
      services={services}
      platform={platform}
      {...(taskId === undefined ? {} : { initialTaskId: taskId })}
      // 云入口没有本机 workspace：关掉「打开工作区」才能避免 Root 兜底调用
      // fileService.ensureConversationWorkspace（04 §2「禁本机」；host `/ws` 也不暴露执行域）。
      allowOpenWorkspace={false}
      allowRemoteWorkspace={false}
      restoreSession={false}
      preferDirectoryBrowser={false}
      supportsEmbeddedBrowser={false}
    />
  );
}

/** 入口分派入口：`main.tsx` 在 mode=cloud 时调用（W9 §3）。 */
export function renderCloudApp(root: ReactRoot, plan: CloudEntryPlan): void {
  document.title = "ZCode";
  root.render(<CloudApp plan={plan} />);
}

/**
 * 入口本身失败（启动探测 404/不可达、`?task=` 非法、云入口下的 `?remote=` 等）时的失败面：
 * 任何模式都可渲染，避免回落到白屏或通用报错（W9 §5；04 §2.1 探测不确定不回落 local）。
 */
export function renderCloudEntryFailure(root: ReactRoot, failure: CloudBootFailure): void {
  root.render(
    <CloudBootstrapErrorScreen
      failure={failure}
      locale={resolveCloudEntryLocale()}
      onRecover={(recovery) => {
        if (recovery === "open-home") {
          const url = new URL(window.location.href);
          url.search = "";
          window.location.replace(url.toString());
          return;
        }
        window.location.reload();
      }}
    />,
  );
}
