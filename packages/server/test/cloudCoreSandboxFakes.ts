/**
 * 沙箱侧测试替身：部署模板解析（01 §5.1 第 2 条）与执行/产物投影读取（CR-4）。
 * 拆出独立文件以保持单行数预算；不是测试文件（不匹配 `*.test.ts`）。
 */
import type { CloudExecutionProjection, CloudTaskArtifactRecord } from "@zcode/shared";
import type {
  ArtifactRead,
  ExecutionProjectionRead,
} from "../src/cloud/app/ports/projectionPort.js";

export function createFakeTemplateResolver(options: { defaults?: Record<string, string> } = {}) {
  const defaults: Record<string, string> = { e2b: "zcode-node24", ...options.defaults };
  return {
    setDefault(provider: string, ref: string | undefined): void {
      if (ref === undefined) delete defaults[provider];
      else defaults[provider] = ref;
    },
    async resolve(request: { provider: string; templateRef?: string }) {
      const ref = request.templateRef ?? defaults[request.provider];
      if (!ref || ref === "unknown-template") return null;
      return {
        imageRef: `img:${request.provider}:${ref}`,
        templateRevision: `rev:${ref}`,
      };
    },
  };
}

/** 执行投影读取 fake（CR-4）：默认返回 null，测试可写入。 */
export function createFakeExecutionProjections(): ExecutionProjectionRead & {
  set(taskId: string, value: CloudExecutionProjection | null): void;
} {
  let value: CloudExecutionProjection | null = null;
  return {
    set(next) {
      value = next;
    },
    async readTaskExecution() {
      return value;
    },
    async readRunExecution() {
      return value;
    },
  };
}

/** 产物投影读取 fake（CR-4）。 */
export function createFakeArtifacts(): ArtifactRead & {
  set(taskId: string, value: CloudTaskArtifactRecord | null): void;
} {
  let value: CloudTaskArtifactRecord | null = null;
  return {
    set(next) {
      value = next;
    },
    async read() {
      return value;
    },
  };
}
