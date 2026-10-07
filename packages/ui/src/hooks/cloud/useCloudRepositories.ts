/**
 * `useCloudRepositories` —— 已授权仓库选择器（specs/cloud-agent/04 §3.1、09 §2.2、11 §4.1）。
 *
 * 新建项目只有仓库一种类型，因此仓库选择器是 Project 创建的唯一入口。它必须能表达
 * 真实状态而不是空列表：
 * - `not_configured`（503）：部署未装配 installation 投影 → 「部署未配置」引导；
 * - `installation_revoked` / `permission_revoked`：撤权 → 明确提示，不当作空；
 * - 分页 + 搜索（游标分页，服务端做权限过滤，客户端不传权限字段）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CloudBranchPage, CloudRepositoryRecord } from "@zcode/shared";
import { readCloudErrorCode } from "@/cloud/cloudApiErrorLike.js";
import type { CloudControlPlanePort } from "@/cloud/cloudPorts.js";
import { useCloudWorkspaceContext } from "@/cloud/cloudWorkspaceContext.js";
import type { CloudCapabilitiesStatus } from "@/cloud/cloudWorkspaceContext.js";

export type CloudRepositoryBlockingReason =
  /** 部署未配置：与「用户未授权」是两件事（04 §3.1）。 */
  | "not_configured"
  /** App 未安装 / 已撤权。 */
  | "revoked";

export interface UseCloudRepositoriesResult {
  readonly status: CloudCapabilitiesStatus;
  readonly error: string | null;
  /** 非空表示选择器不能提供列表；调用方必须渲染对应引导，而不是空态。 */
  readonly blockingReason: CloudRepositoryBlockingReason | null;
  readonly repositories: readonly CloudRepositoryRecord[];
  readonly hasMore: boolean;
  readonly query: string;
  setQuery(query: string): void;
  refresh(): Promise<void>;
  loadMore(): Promise<void>;
  /** 基础分支候选：repo 授权后查询（03 §6 branches 子资源、11 §5）。 */
  listBranches(repositoryId: number): Promise<CloudBranchPage>;
}

export interface UseCloudRepositoriesOptions {
  readonly controlPlane?: CloudControlPlanePort | null;
}

export function useCloudRepositories(
  options?: UseCloudRepositoriesOptions,
): UseCloudRepositoriesResult {
  const context = useCloudWorkspaceContext();
  const controlPlane = options?.controlPlane ?? context?.controlPlane ?? null;

  const [status, setStatus] = useState<CloudCapabilitiesStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [blockingReason, setBlockingReason] = useState<CloudRepositoryBlockingReason | null>(null);
  const [repositories, setRepositories] = useState<readonly CloudRepositoryRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState("");
  const requestIdRef = useRef(0);

  const load = useCallback(
    async (mode: "replace" | "append", searchQuery: string) => {
      if (!controlPlane) {
        setStatus("idle");
        return;
      }
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setStatus("loading");
      setError(null);
      try {
        const page = await controlPlane.listRepositories({
          ...(mode === "append" && nextCursor ? { cursor: nextCursor } : {}),
          ...(searchQuery.trim().length === 0 ? {} : { query: searchQuery.trim() }),
        });
        if (requestIdRef.current !== requestId) {
          return;
        }
        setRepositories((current) =>
          mode === "append"
            ? dedupeRepositories([...current, ...page.items])
            : dedupeRepositories(page.items),
        );
        setNextCursor(page.nextCursor);
        setBlockingReason(null);
        setStatus("ready");
      } catch (loadError) {
        if (requestIdRef.current !== requestId) {
          return;
        }
        const code = readCloudErrorCode(loadError);
        setStatus("error");
        setError(code ?? (loadError instanceof Error ? loadError.message : String(loadError)));
        if (code === "not_configured") {
          setBlockingReason("not_configured");
        } else if (code === "installation_revoked" || code === "permission_revoked") {
          setBlockingReason("revoked");
        } else {
          setBlockingReason(null);
        }
        // 失败不伪造空列表：保留上一次成功的结果，清空由调用方按 blockingReason 决定。
      }
    },
    [controlPlane, nextCursor],
  );

  useEffect(() => {
    void load("replace", query);
    // query 变化时重新从第一页开始；分页由 loadMore 处理。
  }, [load, query]);

  const refresh = useCallback(() => load("replace", query), [load, query]);
  const loadMore = useCallback(() => load("append", query), [load, query]);

  const listBranches = useCallback(
    async (repositoryId: number): Promise<CloudBranchPage> => {
      if (!controlPlane) {
        throw new Error("cloud control plane is not configured");
      }
      return controlPlane.listRepositoryBranches(repositoryId);
    },
    [controlPlane],
  );

  return useMemo(
    () => ({
      status,
      error,
      blockingReason,
      repositories,
      hasMore: nextCursor !== undefined,
      query,
      setQuery,
      refresh,
      loadMore,
      listBranches,
    }),
    [
      blockingReason,
      error,
      listBranches,
      loadMore,
      nextCursor,
      query,
      refresh,
      repositories,
      status,
    ],
  );
}

function dedupeRepositories(
  items: readonly CloudRepositoryRecord[],
): readonly CloudRepositoryRecord[] {
  const byId = new Map<number, CloudRepositoryRecord>();
  for (const item of items) {
    byId.set(item.repositoryId, item);
  }
  return [...byId.values()];
}
