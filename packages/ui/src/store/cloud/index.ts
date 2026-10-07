/**
 * Cloud 投影 store 公开入口（specs/cloud-agent/W8 §3/§5、04 §3.4）。
 *
 * 这些 store **只缓存控制面投影 + 客户端 optimistic overlay**：没有第二份
 * Task/Run 权威状态，也不建 admitted 队列（W8 §5）。
 */
export { useCloudProjectsStore, type CloudProjectsStatus } from "./cloudProjectsStore.js";
export {
  selectCloudTasksForProject,
  useCloudTasksStore,
  type CloudTaskDetailCacheEntry,
  type CloudTasksStatus,
} from "./cloudTasksStore.js";
export {
  useCloudTaskHistoryStore,
  type CloudTaskHistoryEntry,
  type CloudTaskHistoryStatus,
} from "./cloudTaskHistoryStore.js";
export {
  CLOUD_CONVERSATION_TOPIC,
  canApplyCloudConversationSnapshot,
  createEmptyCloudConversationFold,
  foldCloudConversationItems,
  type CloudConversationFold,
  type CloudConversationWatermark,
} from "./cloudConversationFold.js";
export {
  createMemoryCloudDraftLocalStores,
  resetCloudDraftStoresForTests,
  useCloudDraftStore,
  type CloudDraftLocalStores,
  type CloudDraftRecord,
  type CloudSubmitAttempt,
  type CloudSubmitPhase,
  type CloudSubmitRequest,
  type CloudSubmitSettlement,
} from "./cloudDraftStore.js";
export {
  buildCloudLocalKey,
  createCloudLocalStore,
  createMemoryCloudLocalStore,
  type CloudLocalStore,
} from "./cloudLocalPersistence.js";
