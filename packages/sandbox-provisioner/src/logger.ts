import type { ProvisionerLogger } from "./providers/types.js";

/**
 * 结构化单行日志。
 *
 * 不用 console.log 直接拼字符串：provisioner 是可被 systemd/docker 收走的常驻进程，
 * 每行一条 JSON 才能被日志系统按字段检索（provider、sandboxId）。
 */
export function createConsoleLogger(): ProvisionerLogger {
  return {
    info(message, fields) {
      emit("info", message, fields);
    },
    warn(message, fields) {
      emit("warn", message, fields);
    },
  };
}

function emit(level: "info" | "warn", message: string, fields?: Record<string, unknown>): void {
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    message,
    ...fields,
  });

  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}
