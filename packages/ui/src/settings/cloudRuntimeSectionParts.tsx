/**
 * 「Cloud 运行时」分组的共享结构件（specs/cloud-agent/04 §3.1）：
 * 分区外壳（标题 + 描述 + 卡片）与提示行。GitHub 与 Sandbox 两个分区共用，
 * 放独立文件避免分区组件互相 import 形成环。
 */
import type { ReactNode } from "react";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";

/** 控件区文案统一在这里取：错误只按 code 归类，不解析服务端文案（04 §6）。 */
export function describeCloudSettingsError(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function CloudSectionShell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="px-0.5">
        <h3 className="text-ui-base font-medium text-foreground">{title}</h3>
        <p className="mt-1 text-ui-base leading-6 text-foreground-subtle">{description}</p>
      </div>
      <SettingsGroupCard>{children}</SettingsGroupCard>
    </section>
  );
}

export function CloudSectionHint({
  tone,
  children,
}: {
  tone: "muted" | "warning";
  children: ReactNode;
}) {
  return (
    <p
      className={
        tone === "warning"
          ? "px-4 py-3 text-ui-base leading-6 text-destructive"
          : "px-4 py-3 text-ui-base leading-6 text-foreground-subtle"
      }
    >
      {children}
    </p>
  );
}
