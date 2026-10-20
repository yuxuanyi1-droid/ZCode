import { z } from "zod";

import { CLOUD_PROTOCOL_VERSION } from "./constants.js";

export const bootstrapConfigSchema = z
  .object({
    v: z.literal(CLOUD_PROTOCOL_VERSION),
    controlPlaneUrl: z.string().min(1),
    attachToken: z.string().min(16),
    runId: z.string().min(1),
    taskId: z.string().min(1),
    taskStableId: z.string().regex(/^[a-z0-9._-]+$/),
    generation: z.number().int().positive(),
    serverRoot: z.string().min(1),
    dataDir: z.string().min(1),
    workspacePath: z.string().min(1),
    /** 覆盖 daemon 启动命令；默认 <serverRoot>/bin/zcode。 */
    serverCommand: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

export type BootstrapConfig = z.infer<typeof bootstrapConfigSchema>;

export function parseBootstrapConfig(value: unknown): BootstrapConfig {
  return bootstrapConfigSchema.parse(value);
}
