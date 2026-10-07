/**
 * 无 attachment / 未知服务时的**显式不可用面**（specs/cloud-agent/W8 §3、04 §3.0/§4、03 §7.1）。
 *
 * 云任务的执行域只路由到沙箱 attachment（03 §2 不变量 7）：没有 ready attachment 时，
 * 文件/终端/Git/会话等调用必须返回结构化的 `attachment_unavailable`，**不回落部署机
 * host 本机执行域**，也不返回伪造的空列表 / 空快照（04 §4「无 ready attachment 拒绝执行
 * 请求，不回落本机」）。
 *
 * 这里不是「永久不可用 stub」：attachment ready 后由 `createCloudBrowserServices`
 * 用当前 Run 的真实服务覆盖同一批字段（W8 §3）。
 */
import { Event, ProxyChannel, type IChannel } from "@zcode/rpc";
import type { CloudErrorCode } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";

/** 缺省错误码：attachment 不可用（07 §5、03 §7.1）。 */
export const CLOUD_ATTACHMENT_UNAVAILABLE_CODE: CloudErrorCode = "attachment_unavailable";

/**
 * 云服务不可用错误：`code` 用 shared 的归一错误码，UI 不解析异常文案
 * （04 §6「错误 code 区分…UI 不解析异常文字」）。
 */
export class CloudServiceUnavailableError extends Error {
  readonly code: CloudErrorCode;

  constructor(code: CloudErrorCode = CLOUD_ATTACHMENT_UNAVAILABLE_CODE, reason?: string) {
    super(reason && reason.length > 0 ? reason : "cloud execution services are unavailable");
    this.name = "CloudServiceUnavailableError";
    this.code = code;
  }
}

export interface UnavailableServiceAccessorOptions {
  readonly code?: CloudErrorCode;
  readonly reason?: string;
}

function createUnavailableError(options: UnavailableServiceAccessorOptions): Error {
  return new CloudServiceUnavailableError(options.code, options.reason);
}

/**
 * 构造一个所有调用都显式失败的 accessor。
 *
 * 事件按既有 RPC 代理契约返回空订阅（`Event.None`），命令一律 rejected：
 * 与 `useWorkspaceServices` 的断连代理同款分类规则，避免「事件被误判成 RPC 方法」
 * 那类二次崩溃（AGENTS「保留 owner/lease…不能仅根据单一路径删除边界判断」）。
 */
export function createUnavailableServiceAccessor(
  options: UnavailableServiceAccessorOptions = {},
): IServiceAccessor {
  const error = createUnavailableError(options);
  const channel: IChannel = {
    call: () => Promise.reject(error),
    listen: () => Event.None,
  };
  const serviceProxy = ProxyChannel.toService<object>(channel);

  return new Proxy(Object.create(null), {
    get() {
      return serviceProxy;
    },
  }) as IServiceAccessor;
}

/**
 * 进程内共享的 attachment-unavailable accessor：同一份 reason 复用同一实例，
 * 避免每次渲染都重新构造代理对象而让下游 memo 失效。
 */
let sharedAttachmentUnavailable: IServiceAccessor | null = null;

export function getCloudAttachmentUnavailableServices(
  reason = "cloud task has no ready run attachment",
): IServiceAccessor {
  if (!sharedAttachmentUnavailable) {
    sharedAttachmentUnavailable = createUnavailableServiceAccessor({
      code: CLOUD_ATTACHMENT_UNAVAILABLE_CODE,
      reason,
    });
  }
  return sharedAttachmentUnavailable;
}

/** 仅测试使用：清掉共享实例，避免用例之间互相影响。 */
export function resetCloudUnavailableServiceAccessorForTests(): void {
  sharedAttachmentUnavailable = null;
}

/** 判断是否为云服务不可用错误（调用方按 code 分支，不解析文案）。 */
export function isCloudServiceUnavailableError(
  error: unknown,
): error is CloudServiceUnavailableError {
  return error instanceof CloudServiceUnavailableError;
}
