/**
 * 沙箱资产目录（specs/cloud-agent/01 §6.1、W3 §4「对 W5：资产分发端点（版本/hash 校验，
 * 失败不回退未校验旧包）」）。
 *
 * 分发端点（W5 的 `GET /api/cloud/assets/:assetId`）只通过本目录读取资产：
 * - 只服务清单里列出的资产（不在清单里 = 不存在，不回退目录扫描/旧文件）；
 * - 每次读取都按 manifest 的 sha256 与长度校验，不符即拒绝（fail-closed）；
 * - 校验失败**不**回落未校验的旧包，也不返回部分内容。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CloudAdapterError } from "../adapterError.js";
import {
  assetKey,
  computeAssetDigest,
  parseAssetManifest,
  resolveAssetEntry,
  type SandboxAssetEntry,
  type SandboxAssetManifest,
} from "./manifest.js";

/** 清单文件名（构建脚本与目录读取共用同一常量）。 */
export const SANDBOX_ASSET_MANIFEST_FILE = "manifest.json";

export interface SandboxAssetPayload {
  /** `name@version`（分发端点的 assetId 形态）。 */
  assetId: string;
  name: string;
  version: string;
  sha256: string;
  contentType: string;
  bytes: Uint8Array;
  /** 生成该资产的构建标识（客户端可据此对齐版本，见 10 §7）。 */
  buildId: string;
}

export interface SandboxAssetCatalog {
  manifest(): SandboxAssetManifest;
  listAssets(): SandboxAssetEntry[];
  /** 读取并校验资产；未知 assetId → not_found，摘要/长度不符 → validation_failed。 */
  readAsset(assetId: string): Promise<SandboxAssetPayload>;
}

export function createSandboxAssetCatalog(options: {
  /** 资产目录（构建产物目录；清单与资产文件同目录）。 */
  directory: string;
  manifest: SandboxAssetManifest;
}): SandboxAssetCatalog {
  const { directory, manifest } = options;
  return {
    manifest: () => manifest,
    listAssets: () => [...manifest.assets],
    async readAsset(assetId: string): Promise<SandboxAssetPayload> {
      const entry = resolveAssetEntry(manifest, assetId);
      if (!entry) {
        throw new CloudAdapterError("not_found", "sandbox asset not found in manifest", {
          assetIdLen: assetId.length,
        });
      }
      const bytes = await readFile(join(directory, entry.name)).catch((error: unknown) => {
        // 清单声明了但文件缺失 = 部署不完整：明确失败，不回落旧包。
        throw new CloudAdapterError("validation_failed", "sandbox asset file is missing", {
          asset: assetKey(entry),
          cause: error instanceof Error ? error.name : "read-error",
        });
      });
      const digest = computeAssetDigest(bytes);
      if (digest !== entry.sha256 || bytes.byteLength !== entry.bytes) {
        // 摘要/长度不符：拒绝服务（01 §6.1 版本不兼容 fail-closed）。
        throw new CloudAdapterError("validation_failed", "sandbox asset digest mismatch", {
          asset: assetKey(entry),
          expectedBytes: entry.bytes,
          actualBytes: bytes.byteLength,
        });
      }
      return {
        assetId: assetKey(entry),
        name: entry.name,
        version: entry.version,
        sha256: entry.sha256,
        contentType: entry.contentType,
        bytes,
        buildId: manifest.buildId,
      };
    },
  };
}

/** 从目录加载清单并构造目录对象（清单缺失/不合法 → 抛错，不猜默认值）。 */
export async function loadSandboxAssetCatalog(options: {
  directory: string;
  manifestFile?: string;
}): Promise<SandboxAssetCatalog> {
  const manifestPath = join(options.directory, options.manifestFile ?? SANDBOX_ASSET_MANIFEST_FILE);
  const raw = await readFile(manifestPath, "utf8").catch((error: unknown) => {
    throw new CloudAdapterError("validation_failed", "sandbox asset manifest is not readable", {
      cause: error instanceof Error ? error.name : "read-error",
    });
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CloudAdapterError("validation_failed", "sandbox asset manifest is not valid JSON");
  }
  return createSandboxAssetCatalog({
    directory: options.directory,
    manifest: parseAssetManifest(parsed),
  });
}
