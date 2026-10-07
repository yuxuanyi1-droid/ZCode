/**
 * `useCloudCapabilities` —— 云启动能力投影（specs/cloud-agent/04 §6 capabilities 行、
 * 03 §6、01 §4.1）。
 *
 * 能力声明是**门控事实源**：provider 列表、启用的客户端特性、是否支持 task-owned 附件。
 * 协议版本不在 UI 侧二次判定——SDK 已按 `CLOUD_WIRE_PROTOCOL_SUPPORTED_VERSIONS`
 * fail-closed（W7 CR-1），UI 再做一遍只会长出第二条规则。
 *
 * `mode` 例外：云入口拿到的能力声明必须是 `cloud`。拿到 `local` 说明部署配置与客户端
 * 选择的模式不一致，此时 fail-closed，**不回落本机**（04 §2「URL 缺少 remote、网络失败或
 * identity 解析失败不能自动切回本机」）。
 *
 * 主体标识（`capabilities.principalId`，03 §6 已冻结）也随这份投影一起到达；
 * 控制器直接从类型化字段消费，不另做结构化读取。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CapabilitiesResponse } from "@zcode/shared";
import { useCloudWorkspaceContext } from "@/cloud/cloudWorkspaceContext.js";
import type { CloudControlPlanePort } from "@/cloud/cloudPorts.js";
import { describeCloudSubmissionError } from "@/cloud/cloudTaskSubmission.js";
import type { CloudCapabilitiesStatus } from "@/cloud/cloudWorkspaceContext.js";

export interface UseCloudCapabilitiesResult {
  readonly status: CloudCapabilitiesStatus;
  readonly capabilities: CapabilitiesResponse | null;
  readonly error: string | null;
  readonly reload: () => Promise<void>;
}

export interface UseCloudCapabilitiesOptions {
  /** 显式端口；缺省读 CloudWorkspaceProvider 注入的那一个。 */
  readonly controlPlane?: CloudControlPlanePort | null;
}

/** 独立加载器：有显式端口时自取，没有则读 workspace context（唯一取数点）。 */
export function useCloudCapabilities(
  options?: UseCloudCapabilitiesOptions,
): UseCloudCapabilitiesResult {
  const context = useCloudWorkspaceContext();
  const explicitPort = options?.controlPlane;
  const usesContext = explicitPort === undefined && context !== null;

  const [state, setState] = useState<{
    status: CloudCapabilitiesStatus;
    capabilities: CapabilitiesResponse | null;
    error: string | null;
  }>({ status: "idle", capabilities: null, error: null });

  const port = explicitPort ?? context?.controlPlane ?? null;
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    if (!port) {
      // 没有端口就是「未配置」，不是「空能力」：不伪造 ready。
      setState({ status: "idle", capabilities: null, error: null });
      return;
    }
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setState((current) => ({ ...current, status: "loading", error: null }));
    try {
      const capabilities = await port.getCapabilities();
      if (requestIdRef.current !== requestId) {
        return;
      }
      if (capabilities.mode !== "cloud") {
        setState({
          status: "error",
          capabilities: null,
          error: "cloud capabilities reported a non-cloud mode",
        });
        return;
      }
      setState({ status: "ready", capabilities, error: null });
    } catch (error) {
      if (requestIdRef.current !== requestId) {
        return;
      }
      setState({ status: "error", capabilities: null, error: describeCloudSubmissionError(error) });
    }
  }, [port]);

  useEffect(() => {
    if (usesContext) {
      // 由 provider 统一取数；这里不再发第二次请求。
      return;
    }
    void load();
  }, [load, usesContext]);

  return useMemo(() => {
    if (usesContext && context) {
      return {
        status: context.capabilitiesStatus,
        capabilities: context.capabilities,
        error: context.capabilitiesError,
        reload: context.reloadCapabilities,
      };
    }
    return { ...state, reload: load };
  }, [context, load, state, usesContext]);
}
