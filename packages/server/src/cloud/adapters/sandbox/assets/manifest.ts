/**
 * 沙箱资产清单（specs/cloud-agent/01 §6.1、10 §7「runtime 资产使用固定版本与摘要
 * 校验，禁止任务启动时无限追最新」）。
 *
 * 事实源：**构建期**由 `buildAssets.mjs` 生成的 manifest.json（bundle + 版本 + sha256）。
 * 消费方（控制面入口 W5 的 `GET /api/cloud/assets/:assetId`、沙箱侧自举校验）只信清单
 * 里的摘要：**校验失败即拒绝，绝不回退到未校验的旧包**（fail-closed）。
 *
 * 本文件不含 IO：解析与校验是纯函数，读取在 assets/catalog.ts。
 */
import { createHash } from "node:crypto";

/** 清单格式版本：消费方不匹配即整份拒绝，不按旧字段猜测解析。 */
export const SANDBOX_ASSET_MANIFEST_VERSION = 1 as const;

/**
 * 资产种类：
 * - `bootstrap`：镜像内 supervisor / runtime stub bundle（自举通道用）；
 * - `runtime`：沙箱内运行的 zcode-server / Agent CLI 产物（构建期从既有构建复制）。
 */
export const SANDBOX_ASSET_KINDS = ["bootstrap", "runtime"] as const;
export type SandboxAssetKind = (typeof SANDBOX_ASSET_KINDS)[number];

export interface SandboxAssetEntry {
  /** 稳定资产名（如 `supervisor.bundle.mjs`）；分发路径用它，不用绝对路径。 */
  name: string;
  /** 内容版本（构建期冻结；禁止 latest/漂移，01 §5.1 第 2 条）。 */
  version: string;
  /** 小写十六进制 sha256。 */
  sha256: string;
  bytes: number;
  kind: SandboxAssetKind;
  /** HTTP 响应用的媒体类型（分发端点直接复用，避免各端自己猜）。 */
  contentType: string;
}

export interface SandboxAssetManifest {
  manifestVersion: typeof SANDBOX_ASSET_MANIFEST_VERSION;
  /** 构建标识：同一次构建的资产集合版本（分发端点用它做版本语义）。 */
  buildId: string;
  /** 构建时间（ISO 8601，仅诊断用，不参与校验）。 */
  generatedAt: string;
  assets: SandboxAssetEntry[];
}

/** 内容摘要（小写十六进制）。 */
export function computeAssetDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 资产键：`name@version`（清单内的唯一键，也是分发端点的 assetId 形式）。 */
export function assetKey(entry: SandboxAssetEntry): string {
  return `${entry.name}@${entry.version}`;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * 严格解析清单：任何字段缺失/类型不符/重复键都拒绝（不猜测、不补默认值）。
 * 抛出的是普通 Error——清单来自构建产物，解析失败属于部署错误而非 provider 错误。
 */
export function parseAssetManifest(value: unknown): SandboxAssetManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("asset manifest must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  if (record["manifestVersion"] !== SANDBOX_ASSET_MANIFEST_VERSION) {
    throw new Error(
      `unsupported asset manifest version: ${String(record["manifestVersion"])} (expected ${SANDBOX_ASSET_MANIFEST_VERSION})`,
    );
  }
  const buildId = requireString(record["buildId"], "buildId");
  const generatedAt = requireString(record["generatedAt"], "generatedAt");
  const rawAssets = record["assets"];
  if (!Array.isArray(rawAssets) || rawAssets.length === 0) {
    throw new Error("asset manifest must list at least one asset");
  }
  const seen = new Set<string>();
  const assets = rawAssets.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("asset entry must be an object");
    }
    const entry = item as Record<string, unknown>;
    const name = requireString(entry["name"], "asset.name");
    if (name.includes("/") || name.includes("\\") || name === "." || name === "..") {
      throw new Error(`asset name must be a plain file name: ${name}`);
    }
    const version = requireString(entry["version"], "asset.version");
    const sha256 = requireString(entry["sha256"], "asset.sha256");
    if (!SHA256_PATTERN.test(sha256)) {
      throw new Error(`asset ${name} has an invalid sha256`);
    }
    const bytes = entry["bytes"];
    if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0) {
      throw new Error(`asset ${name} has an invalid byte length`);
    }
    const kind = entry["kind"];
    if (typeof kind !== "string" || !(SANDBOX_ASSET_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`asset ${name} has an unsupported kind: ${String(kind)}`);
    }
    const contentType = requireString(entry["contentType"], "asset.contentType");
    const parsed: SandboxAssetEntry = {
      name,
      version,
      sha256,
      bytes,
      kind: kind as SandboxAssetKind,
      contentType,
    };
    const key = assetKey(parsed);
    if (seen.has(key)) {
      throw new Error(`duplicate asset entry: ${key}`);
    }
    seen.add(key);
    return parsed;
  });
  return { manifestVersion: SANDBOX_ASSET_MANIFEST_VERSION, buildId, generatedAt, assets };
}

/**
 * 按 assetId 解析条目：接受 `name` 或 `name@version`。
 * `name` 形式只在清单内该 name 唯一时可用（多个版本必须显式点名，不隐式取「最新」）。
 */
export function resolveAssetEntry(
  manifest: SandboxAssetManifest,
  assetId: string,
): SandboxAssetEntry | undefined {
  const trimmed = assetId.trim();
  if (trimmed === "") return undefined;
  const at = trimmed.lastIndexOf("@");
  if (at > 0) {
    const name = trimmed.slice(0, at);
    const version = trimmed.slice(at + 1);
    return manifest.assets.find((entry) => entry.name === name && entry.version === version);
  }
  const matches = manifest.assets.filter((entry) => entry.name === trimmed);
  return matches.length === 1 ? matches[0] : undefined;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`asset manifest field ${field} must be a non-empty string`);
  }
  return value;
}
