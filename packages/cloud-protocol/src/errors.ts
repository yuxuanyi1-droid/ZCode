import { CLOUD_ERROR_CODES } from "./constants.js";

export type CloudErrorCode = (typeof CLOUD_ERROR_CODES)[number];

const DEFAULT_STATUS: Record<CloudErrorCode, number> = {
  unauthorized: 401,
  not_found: 404,
  invalid_request: 400,
  conflict: 409,
  task_stopping: 409,
  recovery_required: 409,
  attachment_unavailable: 503,
  provider_unavailable: 503,
  internal: 500,
};

export class CloudError extends Error {
  public readonly status: number;

  public constructor(
    public readonly code: CloudErrorCode,
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = "CloudError";
    this.status = status ?? DEFAULT_STATUS[code];
  }
}

export function toCloudErrorBody(error: unknown): {
  status: number;
  body: { error: { code: string; message: string } };
} {
  if (error instanceof CloudError) {
    return { status: error.status, body: { error: { code: error.code, message: error.message } } };
  }
  return {
    status: 500,
    body: {
      error: {
        code: "internal",
        message: error instanceof Error ? error.message : "Internal error",
      },
    },
  };
}
