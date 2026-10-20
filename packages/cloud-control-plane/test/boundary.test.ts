import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const PACKAGES_ROOT = resolve(import.meta.dirname, "../..");

const ALLOWED_DEPENDENCIES: Record<string, Set<string>> = {
  "cloud-protocol": new Set(["zod"]),
  "cloud-bridge": new Set(["@zcode/cloud-protocol", "ws"]),
  "cloud-control-plane": new Set([
    "@zcode/client",
    "@zcode/cloud-protocol",
    "@zcode/rpc",
    "@zcode/shared",
    "ws",
    "zod",
  ]),
};

const FORBIDDEN_IMPORTS: Record<string, RegExp[]> = {
  "cloud-protocol": [/^@zcode\/(?!cloud-protocol)/u],
  "cloud-bridge": [/^@zcode\/(?!cloud-protocol)/u],
  "cloud-control-plane": [
    /^@zcode\/(server|services|desktop|web|zcode-cli|zcode-server-cli)(\/|$)/u,
    /^@zcode\/cloud-web(\/|$)/u,
  ],
};

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.isFile() && /\.(ts|tsx)$/u.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /(?:^|\n)\s*import\s+(?:type\s+)?(?:[^"'`]*?\sfrom\s+)?["']([^"']+)["']/gu,
    /(?:^|\n)\s*export\s+(?:type\s+)?(?:[^"'`]*?\sfrom\s+)["']([^"']+)["']/gu,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

describe("cloud module boundaries", () => {
  it("declares only allowed package dependencies", async () => {
    for (const [name, allowed] of Object.entries(ALLOWED_DEPENDENCIES)) {
      const manifest = JSON.parse(
        await readFile(join(PACKAGES_ROOT, name, "package.json"), "utf8"),
      ) as { dependencies?: Record<string, string> };
      for (const dependency of Object.keys(manifest.dependencies ?? {})) {
        const external =
          dependency.startsWith("@zcode/") ||
          dependency === "ws" ||
          dependency === "zod" ||
          dependency === "react" ||
          dependency === "react-dom";
        if (!external) continue;
        expect(allowed.has(dependency), `${name} must not depend on ${dependency}`).toBe(true);
      }
    }
  });

  it("never imports forbidden ZCode internals", async () => {
    for (const [name, patterns] of Object.entries(FORBIDDEN_IMPORTS)) {
      const files = await walk(join(PACKAGES_ROOT, name, "src"));
      for (const file of files) {
        const source = await readFile(file, "utf8");
        for (const specifier of importSpecifiers(source)) {
          for (const pattern of patterns) {
            expect(pattern.test(specifier), `${file} must not import ${specifier}`).toBe(false);
          }
        }
      }
    }
  });

  it("keeps the bridge free of business packages", async () => {
    const files = await walk(join(PACKAGES_ROOT, "cloud-bridge", "src"));
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        expect(
          /^@zcode\/(?!cloud-protocol)/u.test(specifier),
          `${file} must not import ${specifier}`,
        ).toBe(false);
      }
    }
  });
});
