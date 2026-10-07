/**
 * W7 控制面端点的调用表（specs/cloud-agent/W7 §6）：每个 SDK 已实现端点一行，
 * 供 round-trip / 错误 / 未知字段三组用例统一遍历。端点 id 与路径由 shared 冻结矩阵
 * 反查，这里只声明「怎么调」。
 */
import type { CloudControlPlaneClient } from "../src/cloud/cloudControlPlaneClient.js";
import type { CloudSdkEndpointId } from "../src/cloud/cloudWireSchemas.js";
import { COMMAND_ID, COMMAND_ID_2, OPERATION_ID, PROJECT_ID, TASK_ID } from "./cloudFixtures.js";

// ── 端点调用表（覆盖 SDK 全部实现端点）──

export interface CloudSdkInvocation {
  readonly endpointId: CloudSdkEndpointId;
  readonly expectedSearch?: string;
  readonly invoke: (client: CloudControlPlaneClient) => Promise<unknown>;
}

export const CLOUD_SDK_INVOCATIONS: readonly CloudSdkInvocation[] = [
  { endpointId: "capabilities", invoke: (client) => client.getCapabilities() },
  { endpointId: "repositories", invoke: (client) => client.listRepositories() },
  {
    endpointId: "repositoryBranches",
    invoke: (client) => client.listRepositoryBranches(42),
  },
  {
    endpointId: "listProjects",
    expectedSearch: "?limit=25",
    invoke: (client) => client.listProjects({ limit: 25 }),
  },
  {
    endpointId: "createProject",
    invoke: (client) => client.createProject({ repositoryId: 42, creationKey: "project-key-1" }),
  },
  {
    endpointId: "patchProject",
    invoke: (client) =>
      client.patchProject(PROJECT_ID, { displayName: "新名字", expectedRevision: 0 }),
  },
  { endpointId: "deleteProject", invoke: (client) => client.deleteProject(PROJECT_ID) },
  { endpointId: "projectTasks", invoke: (client) => client.listProjectTasks(PROJECT_ID) },
  {
    endpointId: "createTask",
    invoke: (client) =>
      client.createTask({ projectId: PROJECT_ID, title: "示例任务", creationKey: "task-key-1" }),
  },
  { endpointId: "taskDetail", invoke: (client) => client.getTask(TASK_ID) },
  {
    endpointId: "patchTask",
    invoke: (client) => client.patchTask(TASK_ID, { title: "新标题", expectedRevision: 0 }),
  },
  {
    endpointId: "submitInput",
    invoke: (client) =>
      client.submitInput(TASK_ID, {
        intent: "append",
        commandId: COMMAND_ID,
        prompt: "继续处理",
        expectedRunGeneration: 1,
      }),
  },
  { endpointId: "listInputs", invoke: (client) => client.listInputs(TASK_ID) },
  { endpointId: "getInput", invoke: (client) => client.getInput(TASK_ID, COMMAND_ID) },
  { endpointId: "cancelInput", invoke: (client) => client.cancelInput(TASK_ID, COMMAND_ID) },
  {
    endpointId: "reopenTask",
    invoke: (client) =>
      client.reopenTask(TASK_ID, {
        commandId: COMMAND_ID_2,
        prompt: "重开任务",
        provider: "e2b",
        resume: { mode: "checkpoint" },
        expectedTaskRevision: 1,
      }),
  },
  { endpointId: "stopTask", invoke: (client) => client.stopTask(TASK_ID) },
  {
    endpointId: "forceStopTask",
    invoke: (client) =>
      client.forceStopTask(TASK_ID, {
        lossAcknowledgement: true,
        expectedRevision: 1,
        operationId: OPERATION_ID,
      }),
  },
  { endpointId: "extendTask", invoke: (client) => client.extendTask(TASK_ID) },
  { endpointId: "completeTask", invoke: (client) => client.completeTask(TASK_ID) },
  { endpointId: "archiveTask", invoke: (client) => client.archiveTask(TASK_ID) },
  { endpointId: "reactivateTask", invoke: (client) => client.reactivateTask(TASK_ID) },
  { endpointId: "restoreTask", invoke: (client) => client.restoreTask(TASK_ID) },
  {
    endpointId: "taskHistory",
    expectedSearch: "?topic=conversation",
    invoke: (client) => client.getTaskHistory(TASK_ID, { topic: "conversation" }),
  },
  { endpointId: "taskEvents", invoke: (client) => client.getTaskEvents(TASK_ID) },
  { endpointId: "taskSnapshot", invoke: (client) => client.getTaskSnapshot(TASK_ID) },
  {
    endpointId: "uploadAttachment",
    invoke: (client) => client.uploadAttachment(new Blob(["fixture"])),
  },
];
