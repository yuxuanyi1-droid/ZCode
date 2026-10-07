/* eslint-disable max-lines -- 所有 transport 生命周期共享同一个 registry 状态机，必须原子演进。 */
import {
  buildSshRemoteHostKey,
  stripRemoteTargetSecrets,
  type RemoteTarget,
  type WindowHostAttachmentScope,
  type WindowHostRemoteWorkspaceDescriptor,
} from "@zcode/shared";

interface WindowRemoteAssetDirs {
  mockCdnDir?: string;
  remoteCdnBaseUrl?: string;
  remoteCdnBaseUrls?: string[];
  remoteCacheDir?: string;
}

export interface WindowRemoteConnectionCloseEvent {
  exitCode: number | null;
  signal: string | null;
  error?: string;
}

export interface WindowRemoteConnectionHandle<TServices, TCapabilities = never> {
  services: TServices;
  capabilities?: TCapabilities;
  dispose(): void | Promise<void>;
  onDidClose?(listener: (event: WindowRemoteConnectionCloseEvent) => void): { dispose(): void };
}

interface WindowRemoteConnectionConnectRequest {
  target: RemoteTarget;
  remoteAssets: WindowRemoteAssetDirs;
  signal: AbortSignal;
}

type WindowRemoteConnectionState = "connecting" | "online" | "closing" | "failed" | "disconnected";

interface WindowRemoteLogicalSessionSnapshot {
  remoteSessionId: string;
  requestId: string;
  target: RemoteTarget;
  workspacePath?: string;
  workspaceIdentity?: string;
  generation: number;
  state: WindowRemoteConnectionState;
  sourceAvailability: "online" | "offline";
}

class WindowRemoteConnectCancelledError extends Error {
  constructor() {
    super("远程连接已取消");
    this.name = "WindowRemoteConnectCancelledError";
  }
}

class WindowRemoteConnectionUnavailableError extends Error {
  constructor(remoteSessionId: string) {
    super(`远程连接当前不可用，remoteSessionId=${remoteSessionId}`);
    this.name = "WindowRemoteConnectionUnavailableError";
  }
}

interface ConnectionEntry<TServices, TCapabilities> {
  key: string;
  target: RemoteTarget;
  state: WindowRemoteConnectionState;
  abortController: AbortController;
  sessions: Set<string>;
  ready: Promise<WindowRemoteConnectionHandle<TServices, TCapabilities>>;
  handle?: WindowRemoteConnectionHandle<TServices, TCapabilities>;
  closeSubscription?: { dispose(): void };
  disposePromise?: Promise<void>;
  disposed: boolean;
}

interface LogicalSession<TServices, TCapabilities> {
  remoteSessionId: string;
  requestId: string;
  target: RemoteTarget;
  workspacePath?: string;
  workspaceIdentity?: string;
  generation: number;
  state: WindowRemoteConnectionState;
  sourceAvailability: "online" | "offline";
  entry: ConnectionEntry<TServices, TCapabilities>;
  cancelled: boolean;
  rejectCancellation: (error: WindowRemoteConnectCancelledError) => void;
  cancellation: Promise<never>;
}

function buildConnectionKey(target: RemoteTarget): string {
  // SSH 按 host 复用同一条窗口级连接；Docker/WSL 的 pooled/dedicated key 随退役目标删除
  // （specs/cloud-agent/06 §5）。这里保留按 target 复用的语义，不引入按会话独占的分支。
  return `ssh:${buildSshRemoteHostKey(target)}`;
}

function toSessionSnapshot<TServices, TCapabilities>(
  session: LogicalSession<TServices, TCapabilities>,
): WindowRemoteLogicalSessionSnapshot {
  return {
    remoteSessionId: session.remoteSessionId,
    requestId: session.requestId,
    target: stripRemoteTargetSecrets(session.target),
    ...(session.workspacePath ? { workspacePath: session.workspacePath } : {}),
    ...(session.workspaceIdentity ? { workspaceIdentity: session.workspaceIdentity } : {}),
    generation: session.generation,
    state: session.state,
    sourceAvailability: session.sourceAvailability,
  };
}

export function createWindowRemoteConnectionRegistry<TServices, TCapabilities = never>(options: {
  connect: (
    request: WindowRemoteConnectionConnectRequest,
  ) => Promise<WindowRemoteConnectionHandle<TServices, TCapabilities>>;
  createId: () => string;
  onSessionClosed?: (event: WindowRemoteConnectionCloseEvent & { remoteSessionId: string }) => void;
}) {
  const entriesByKey = new Map<string, ConnectionEntry<TServices, TCapabilities>>();
  const sessionsById = new Map<string, LogicalSession<TServices, TCapabilities>>();
  const pendingSessionsByRequestId = new Map<string, LogicalSession<TServices, TCapabilities>>();
  let disposed = false;
  let disposePromise: Promise<void> | null = null;

  async function disposeEntry(entry: ConnectionEntry<TServices, TCapabilities>): Promise<void> {
    if (entry.disposePromise) {
      return entry.disposePromise;
    }
    entry.disposed = true;
    entry.state = "closing";
    entry.abortController.abort();
    entry.closeSubscription?.dispose();
    entry.closeSubscription = undefined;
    if (entriesByKey.get(entry.key) === entry) {
      entriesByKey.delete(entry.key);
    }
    entry.disposePromise = Promise.resolve(entry.handle?.dispose()).then(() => undefined);
    return entry.disposePromise;
  }

  function handleConnectionClosed(
    entry: ConnectionEntry<TServices, TCapabilities>,
    event: WindowRemoteConnectionCloseEvent,
  ): void {
    if (entry.disposed || entry.state === "closing") {
      return;
    }
    entry.state = "disconnected";
    if (entriesByKey.get(entry.key) === entry) {
      entriesByKey.delete(entry.key);
    }
    for (const remoteSessionId of entry.sessions) {
      const session = sessionsById.get(remoteSessionId);
      if (!session) {
        continue;
      }
      session.state = "disconnected";
      session.sourceAvailability = "offline";
      options.onSessionClosed?.({ remoteSessionId, ...event });
    }
  }

  function createEntry(params: {
    key: string;
    target: RemoteTarget;
    remoteAssets: WindowRemoteAssetDirs;
  }): ConnectionEntry<TServices, TCapabilities> {
    const abortController = new AbortController();
    const entry: ConnectionEntry<TServices, TCapabilities> = {
      key: params.key,
      target: params.target,
      state: "connecting" as const,
      abortController,
      sessions: new Set<string>(),
      ready: Promise.resolve(undefined as never),
      disposed: false,
    };
    entry.ready = options
      .connect({
        target: params.target,
        remoteAssets: params.remoteAssets,
        signal: abortController.signal,
      })
      .then(async (handle) => {
        entry.handle = handle;
        if (entry.disposed || entry.sessions.size === 0) {
          // 底层 SSH connector 可能无法中断认证或部署。
          // 最后一个 logical owner 取消后，迟到的成功结果必须立即释放，不能复活旧连接。
          await disposeEntry(entry);
          return handle;
        }
        entry.state = "online";
        entry.closeSubscription = handle.onDidClose?.((event) => {
          handleConnectionClosed(entry, event);
        });
        for (const remoteSessionId of entry.sessions) {
          const session = sessionsById.get(remoteSessionId);
          if (!session || session.cancelled) {
            continue;
          }
          session.state = "online";
          session.sourceAvailability = "online";
        }
        return handle;
      })
      .catch((error) => {
        entry.state = "failed";
        if (entriesByKey.get(entry.key) === entry) {
          entriesByKey.delete(entry.key);
        }
        for (const remoteSessionId of Array.from(entry.sessions)) {
          const session = sessionsById.get(remoteSessionId);
          if (!session) {
            continue;
          }
          session.state = "failed";
          session.sourceAvailability = "offline";
          sessionsById.delete(remoteSessionId);
          pendingSessionsByRequestId.delete(session.requestId);
        }
        entry.sessions.clear();
        throw error;
      });
    entriesByKey.set(entry.key, entry);
    return entry;
  }

  function resolveEntry(params: {
    key: string;
    target: RemoteTarget;
    remoteAssets: WindowRemoteAssetDirs;
  }): ConnectionEntry<TServices, TCapabilities> {
    const existing = entriesByKey.get(params.key);
    if (
      existing &&
      !existing.disposed &&
      !existing.abortController.signal.aborted &&
      (existing.state === "connecting" || existing.state === "online")
    ) {
      return existing;
    }
    return createEntry(params);
  }

  async function connect(params: {
    requestId: string;
    target: RemoteTarget;
    remoteAssets: WindowRemoteAssetDirs;
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<WindowHostRemoteWorkspaceDescriptor> {
    if (disposed) {
      throw new Error("窗口 Host 的远程连接 registry 已释放");
    }
    if (pendingSessionsByRequestId.has(params.requestId)) {
      throw new Error(`远程连接 requestId 重复，requestId=${params.requestId}`);
    }

    const remoteSessionId = options.createId();
    const key = buildConnectionKey(params.target);
    const entry = resolveEntry({
      key,
      target: params.target,
      remoteAssets: params.remoteAssets,
    });
    let rejectCancellation!: (error: WindowRemoteConnectCancelledError) => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const session: LogicalSession<TServices, TCapabilities> = {
      remoteSessionId,
      requestId: params.requestId,
      target: params.target,
      ...(params.workspacePath ? { workspacePath: params.workspacePath } : {}),
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      generation: 1,
      state: entry.state === "online" ? "online" : "connecting",
      sourceAvailability: entry.state === "online" ? "online" : "offline",
      entry,
      cancelled: false,
      rejectCancellation,
      cancellation,
    };
    entry.sessions.add(remoteSessionId);
    sessionsById.set(remoteSessionId, session);
    pendingSessionsByRequestId.set(params.requestId, session);

    try {
      await Promise.race([entry.ready, cancellation]);
      if (session.cancelled || !sessionsById.has(remoteSessionId)) {
        throw new WindowRemoteConnectCancelledError();
      }
      session.state = "online";
      session.sourceAvailability = "online";
      return {
        remoteSessionId,
        target: stripRemoteTargetSecrets(params.target),
        ...(session.workspacePath ? { workspacePath: session.workspacePath } : {}),
        ...(session.workspaceIdentity ? { workspaceIdentity: session.workspaceIdentity } : {}),
        generation: session.generation,
      };
    } catch (error) {
      if (sessionsById.get(remoteSessionId) === session) {
        sessionsById.delete(remoteSessionId);
        entry.sessions.delete(remoteSessionId);
        session.state = "failed";
        session.sourceAvailability = "offline";
        if (entry.sessions.size === 0) {
          await disposeEntry(entry);
        }
      }
      throw error;
    } finally {
      if (pendingSessionsByRequestId.get(params.requestId) === session) {
        pendingSessionsByRequestId.delete(params.requestId);
      }
    }
  }

  function cancelConnect(requestId: string): void {
    const session = pendingSessionsByRequestId.get(requestId);
    if (!session || session.cancelled) {
      return;
    }
    session.cancelled = true;
    pendingSessionsByRequestId.delete(requestId);
    sessionsById.delete(session.remoteSessionId);
    session.entry.sessions.delete(session.remoteSessionId);
    session.rejectCancellation(new WindowRemoteConnectCancelledError());
    if (session.entry.sessions.size === 0) {
      if (session.entry.state === "connecting") {
        // 最后一个 waiter 取消后，旧 entry 仍以 connecting 留在复用表；立即重连会
        // 继续等待已经 aborted 的 readiness，并沿用上一次凭据。先按对象身份退休旧 entry，
        // 再触发底层取消；迟到的旧 completion 不能删除或复活同 key 的新连接。
        if (entriesByKey.get(session.entry.key) === session.entry) {
          entriesByKey.delete(session.entry.key);
        }
        session.entry.state = "closing";
        session.entry.abortController.abort();
      } else if (session.entry.state === "online") {
        // ready SSH connection 是窗口 cache；取消一次 logical attach 不应把后续 workspace 的
        // 复用连接一并销毁，真实窗口 Host shutdown 时统一释放。
      } else if (session.entry.handle) {
        void disposeEntry(session.entry);
      }
    }
  }

  function bindWorkspaceContext(params: {
    remoteSessionId: string;
    workspacePath: string;
    workspaceIdentity: string;
  }): Promise<void> {
    const session = sessionsById.get(params.remoteSessionId);
    if (!session) {
      throw new Error(`未找到远程 logical session，remoteSessionId=${params.remoteSessionId}`);
    }
    // SSH 连接按 host 复用，不存在需要等待的 workspace runtime 释放屏障；
    // 这里只推进 generation 与 scope 字段，保持 descriptor/attachment 的既有语义。
    session.workspacePath = params.workspacePath;
    session.workspaceIdentity = params.workspaceIdentity;
    session.generation += 1;
    return Promise.resolve();
  }

  function resolveScopedHandle(
    scope: WindowHostAttachmentScope,
  ): WindowRemoteConnectionHandle<TServices, TCapabilities> {
    if (scope.kind !== "remote") {
      throw new Error("远程连接 registry 不能解析 local attachment scope");
    }
    const session = sessionsById.get(scope.remoteSessionId);
    if (!session) {
      throw new WindowRemoteConnectionUnavailableError(scope.remoteSessionId);
    }
    if (
      session.workspacePath !== scope.workspacePath ||
      session.workspaceIdentity !== scope.workspaceIdentity
    ) {
      throw new Error(
        `远程 attachment scope 与 logical session 不匹配，remoteSessionId=${scope.remoteSessionId}`,
      );
    }
    if (
      session.state !== "online" ||
      session.sourceAvailability !== "online" ||
      !session.entry.handle
    ) {
      throw new WindowRemoteConnectionUnavailableError(scope.remoteSessionId);
    }
    return session.entry.handle;
  }

  function resolveScopedServices(scope: WindowHostAttachmentScope): TServices {
    return resolveScopedHandle(scope).services;
  }

  function resolveScopedCapabilities(scope: WindowHostAttachmentScope): TCapabilities | undefined {
    return resolveScopedHandle(scope).capabilities;
  }

  async function disposeSession(remoteSessionId: string): Promise<void> {
    const session = sessionsById.get(remoteSessionId);
    if (!session) {
      return;
    }
    sessionsById.delete(remoteSessionId);
    pendingSessionsByRequestId.delete(session.requestId);
    session.entry.sessions.delete(remoteSessionId);
    if (session.entry.sessions.size === 0) {
      if (session.entry.state === "online") {
        // 只迁移 SSH pool 的 owner：ready connection 继续保持 window-scoped cache，
        // logical session 清空不等于连接退出；真实窗口 Host shutdown 时统一释放。
      } else {
        await disposeEntry(session.entry);
      }
    }
  }

  return {
    connect,
    cancelConnect,
    bindWorkspaceContext,
    resolveScopedServices,
    resolveScopedCapabilities,
    getSession(remoteSessionId: string): WindowRemoteLogicalSessionSnapshot | null {
      const session = sessionsById.get(remoteSessionId);
      return session ? toSessionSnapshot(session) : null;
    },
    listSessions(): WindowRemoteLogicalSessionSnapshot[] {
      return Array.from(sessionsById.values(), toSessionSnapshot);
    },
    findSessionForWorkspace(params: {
      workspacePath: string;
      workspaceIdentity?: string;
    }): WindowRemoteLogicalSessionSnapshot | null {
      const matches = Array.from(sessionsById.values()).filter(
        (session) =>
          session.workspacePath === params.workspacePath &&
          session.workspaceIdentity === params.workspaceIdentity,
      );
      const onlineMatches = matches.filter(
        (session) => session.state === "online" && session.sourceAvailability === "online",
      );
      if (onlineMatches.length > 1 || (onlineMatches.length === 0 && matches.length > 1)) {
        throw new Error(
          `远程 workspace scope 匹配到多个 logical session，workspacePath=${params.workspacePath}`,
        );
      }
      const match = onlineMatches[0] ?? matches[0];
      return match ? toSessionSnapshot(match) : null;
    },
    getStats(): { connectionCount: number; logicalSessionCount: number } {
      return {
        connectionCount: entriesByKey.size,
        logicalSessionCount: sessionsById.size,
      };
    },
    async waitForScopedServices(scope: WindowHostAttachmentScope): Promise<TServices> {
      if (scope.kind !== "remote") {
        throw new Error("远程连接 registry 不能解析 local attachment scope");
      }
      const session = sessionsById.get(scope.remoteSessionId);
      if (!session) {
        throw new WindowRemoteConnectionUnavailableError(scope.remoteSessionId);
      }
      return resolveScopedServices(scope);
    },
    disposeSession,
    async dispose(): Promise<void> {
      if (disposePromise) {
        return disposePromise;
      }
      disposed = true;
      for (const requestId of Array.from(pendingSessionsByRequestId.keys())) {
        cancelConnect(requestId);
      }
      const entries = new Set(Array.from(sessionsById.values(), (session) => session.entry));
      for (const entry of entriesByKey.values()) {
        entries.add(entry);
      }
      sessionsById.clear();
      pendingSessionsByRequestId.clear();
      disposePromise = Promise.all(Array.from(entries, disposeEntry)).then(() => undefined);
      return disposePromise;
    },
  };
}
