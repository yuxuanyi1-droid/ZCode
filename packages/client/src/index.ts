export { RemoteServiceAccess } from "./remoteServiceAccess.js";
export { connectViaProtocol, connectViaWebSocket } from "./websocket.js";
export type { WebSocketConnectionCloseEvent } from "./websocket.js";
export { connectViaMessagePort, createMessagePortServiceConnection } from "./messageport.js";
export type { MessagePortServiceConnection } from "./messageport.js";

// Cloud SDK（specs/cloud-agent/W7）：控制面 HTTP 与 attachment 通道的唯一客户端入口。
export { createCloudClient } from "./cloud/cloudClient.js";
export type { CloudClient, CreateCloudClientOptions } from "./cloud/cloudClient.js";
export {
  createCloudControlPlaneClient,
  isRuntimeAckPending,
  isRuntimeAdmitted,
} from "./cloud/cloudControlPlaneClient.js";
export type {
  CloudBranchPage,
  CloudControlPlaneClient,
  CloudInputSubmission,
  CloudProjectPage,
  CloudRepositoryPage,
  CloudRequestOptions,
  CloudTaskPage,
  CloudUploadAttachmentOptions,
} from "./cloud/cloudControlPlaneClient.js";
export { createCloudAttachClient } from "./cloud/cloudAttachClient.js";
export type {
  CloudAttachClient,
  CloudAttachClientOptions,
  CloudAttachConnector,
  CloudAttachConnectorInput,
  CloudAttachReconnectPolicy,
  CloudAttachSocket,
  CloudAttachState,
  CloudAttachStateChange,
  CloudAttachSubscribeOptions,
  CloudAttachSubscriptionHandle,
  CloudAttachSubscriptionSpec,
  CloudAttachSubscriptionState,
  CloudSubscriptionWatermark,
} from "./cloud/cloudAttachClient.js";
export { createBrowserCloudAttachConnector } from "./cloud/cloudAttachmentSocket.js";
export type { CloudWebSocketFactory } from "./cloud/cloudAttachmentSocket.js";
export {
  CLOUD_HTTP_DEFAULT_TIMEOUT_MS,
  buildCloudRequestPath,
  buildCloudUrl,
  buildCloudWebSocketUrl,
  createCloudHttpTransport,
  normalizeCloudOrigin,
} from "./cloud/cloudHttpTransport.js";
export type {
  CloudFetchLike,
  CloudHttpAuth,
  CloudHttpRequest,
  CloudHttpResponse,
  CloudHttpTransport,
  CloudHttpTransportOptions,
} from "./cloud/cloudHttpTransport.js";
export {
  CloudApiError,
  CloudResyncRequiredError,
  cloudAttachmentUnavailableError,
  cloudChannelNotAllowedError,
  cloudConfigurationError,
  cloudProtocolError,
  cloudTransportError,
  cloudValidationError,
  isCloudApiError,
  isCloudResyncRequiredError,
  normalizeCloudRpcError,
  readCloudErrorEnvelope,
} from "./cloud/cloudApiError.js";
export type { CloudApiErrorSource, CloudResyncReason } from "./cloud/cloudApiError.js";
export {
  CLOUD_SDK_ENDPOINT_SCHEMAS,
  CLOUD_SDK_QUERY_SCHEMAS,
  CLOUD_SDK_SUPPORTED_PROTOCOL_VERSIONS,
  assertSupportedCloudProtocolVersion,
  parseCloudRequestBody,
  parseCloudValue,
  parseCloudResponse,
} from "./cloud/cloudWireSchemas.js";
export type {
  CloudEndpointRequestBody,
  CloudEndpointResponse,
  CloudSdkEndpointId,
  CloudWriteEndpointId,
} from "./cloud/cloudWireSchemas.js";
