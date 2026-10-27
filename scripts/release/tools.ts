// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * CI and release tools, pinned to a version and the SHA-256 of each release asset (ADR 0022,
 * ADR 0023 §12). Workflows install them with this script instead of third-party installer
 * Actions, so every byte that runs is checked against a hash reviewed in git.
 *
 *   bun scripts/release/tools.ts install --dir <bin dir> cosign syft actionlint zizmor shellcheck
 *
 * Checksums were taken from each project's release (GitHub's asset digest, cross-checked
 * against the project's own checksums file where it publishes one). Bump a tool only to a
 * release at least 7 days old.
 */
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Host = "linux/amd64" | "linux/arm64" | "darwin/arm64";

export interface Tool {
  version: string;
  license: string;
  /** The binary's file name inside the archive (or the asset itself when `archive` is false). */
  binary: string;
  archive: boolean;
  assets: Record<Host, { url: string; sha256: string }>;
}

const gh = (repo: string, tag: string, asset: string) => `https://github.com/${repo}/releases/download/${tag}/${asset}`;

export const TOOLS = {
  cosign: {
    version: "3.1.3",
    license: "Apache-2.0",
    binary: "cosign",
    archive: false,
    assets: {
      "linux/amd64": {
        url: gh("sigstore/cosign", "v3.1.3", "cosign-linux-amd64"),
        sha256: "4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71",
      },
      "linux/arm64": {
        url: gh("sigstore/cosign", "v3.1.3", "cosign-linux-arm64"),
        sha256: "c5d324e091826b0d7a78eb16fef316450b4eb9aaec045611c08ba06f5e73220a",
      },
      "darwin/arm64": {
        url: gh("sigstore/cosign", "v3.1.3", "cosign-darwin-arm64"),
        sha256: "5cf948c2f4dfe59687bdd0b8523709067383e03982cc543475c8a7dc70e92a76",
      },
    },
  },
  syft: {
    version: "1.54.1",
    license: "Apache-2.0",
    binary: "syft",
    archive: true,
    assets: {
      "linux/amd64": {
        url: gh("anchore/syft", "v1.54.1", "syft_1.54.1_linux_amd64.tar.gz"),
        sha256: "c069905b391cc4c20a5ba65ad5c10be2a7ba074f8ea6ad203e24d14e303dad47",
      },
      "linux/arm64": {
        url: gh("anchore/syft", "v1.54.1", "syft_1.54.1_linux_arm64.tar.gz"),
        sha256: "dfdf0537610113edbefe1f1fc6548bc957b2d77439636ec824fcf0e10d46d054",
      },
      "darwin/arm64": {
        url: gh("anchore/syft", "v1.54.1", "syft_1.54.1_darwin_arm64.tar.gz"),
        sha256: "b4319c3abaa87a0170ab76ee83ea2260ca34b53aecfa3ab0dd5428d2319d744f",
      },
    },
  },
  actionlint: {
    version: "1.7.12",
    license: "MIT",
    binary: "actionlint",
    archive: true,
    assets: {
      "linux/amd64": {
        url: gh("rhysd/actionlint", "v1.7.12", "actionlint_1.7.12_linux_amd64.tar.gz"),
        sha256: "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
      },
      "linux/arm64": {
        url: gh("rhysd/actionlint", "v1.7.12", "actionlint_1.7.12_linux_arm64.tar.gz"),
        sha256: "325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6",
      },
      "darwin/arm64": {
        url: gh("rhysd/actionlint", "v1.7.12", "actionlint_1.7.12_darwin_arm64.tar.gz"),
        sha256: "aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f",
      },
    },
  },
  zizmor: {
    version: "1.30.1",
    license: "MIT",
    binary: "zizmor",
    archive: true,
    assets: {
      "linux/amd64": {
        url: gh("zizmorcore/zizmor", "v1.30.1", "zizmor-x86_64-unknown-linux-gnu.tar.gz"),
        sha256: "e65324f4430c2717591937edcec90ccbefaf14c174f8ec9415e03ca875b46e1a",
      },
      "linux/arm64": {
        url: gh("zizmorcore/zizmor", "v1.30.1", "zizmor-aarch64-unknown-linux-gnu.tar.gz"),
        sha256: "7ff1dce33bdd18fd2a4affe63bdd47efcccca97b2cec1c1863ec26e9e2647540",
      },
      "darwin/arm64": {
        url: gh("zizmorcore/zizmor", "v1.30.1", "zizmor-aarch64-apple-darwin.tar.gz"),
        sha256: "e28d22b087f9ebb8d99da6e740d348c930f559961c7c3f12badda54f882195a2",
      },
    },
  },
  shellcheck: {
    version: "0.11.0",
    license: "GPL-3.0-only",
    binary: "shellcheck",
    archive: true,
    assets: {
      "linux/amd64": {
        url: gh("koalaman/shellcheck", "v0.11.0", "shellcheck-v0.11.0.linux.x86_64.tar.gz"),
        sha256: "b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6",
      },
      "linux/arm64": {
        url: gh("koalaman/shellcheck", "v0.11.0", "shellcheck-v0.11.0.linux.aarch64.tar.gz"),
        sha256: "68a8133197a50beb8803f8d42f9908d1af1c5540d4bb05fdfca8c1fa47decefc",
      },
      "darwin/arm64": {
        url: gh("koalaman/shellcheck", "v0.11.0", "shellcheck-v0.11.0.darwin.aarch64.tar.gz"),
        sha256: "339b930feb1ea764467013cc1f72d09cd6b869ebf1013296ba9055ab2ffbd26f",
      },
    },
  },
  // OpenTofu for infra/tofu (check.sh). 1.13.2 (2026-10-21) was inside the cooldown when pinned.
  // Hashes from tofu_1.13.1_SHA256SUMS, whose cosign signature names the v1.13 release workflow.
  tofu: {
    version: "1.13.1",
    license: "MPL-2.0",
    binary: "tofu",
    archive: true,
    assets: {
      "linux/amd64": {
        url: gh("opentofu/opentofu", "v1.13.1", "tofu_1.13.1_linux_amd64.tar.gz"),
        sha256: "378ada19d4bc70c43732004e8159be771b23b9a5afdf059e5f8a2b3fa2c70a69",
      },
      "linux/arm64": {
        url: gh("opentofu/opentofu", "v1.13.1", "tofu_1.13.1_linux_arm64.tar.gz"),
        sha256: "9c1ef375aa1852db0b2888aa921b640c71f8140d4682aa4fec99378a64fa7dc3",
      },
      "darwin/arm64": {
        url: gh("opentofu/opentofu", "v1.13.1", "tofu_1.13.1_darwin_arm64.tar.gz"),
        sha256: "be78f659f04ef06a9dbd9b3934d46af95d787a3aa38396d459dea395261816a9",
      },
    },
  },
} as const satisfies Record<string, Tool>;
export type ToolName = keyof typeof TOOLS;

export function currentHost(platform: string = process.platform, arch: string = process.arch): Host {
  const host = `${platform}/${arch === "x64" ? "amd64" : arch}`;
  if (host === "linux/amd64" || host === "linux/arm64" || host === "darwin/arm64") return host;
  throw new Error(`no pinned tool builds for ${host}`);
}

export function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** Throws unless the downloaded bytes hash to the pinned value. */
export function assertChecksum(name: string, bytes: Uint8Array, expected: string): void {
  const actual = sha256Hex(bytes);
  if (actual !== expected) throw new Error(`${name}: checksum mismatch (expected ${expected}, got ${actual})`);
}

function findFile(dir: string, name: string): string | null {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      const found = findFile(path, name);
      if (found) return found;
    } else if (entry === name) return path;
  }
  return null;
}

export async function install(name: ToolName, dir: string, host: Host = currentHost()): Promise<string> {
  const tool: Tool = TOOLS[name];
  const asset = tool.assets[host];
  const res = await fetch(asset.url);
  if (!res.ok) throw new Error(`${name}: download failed (${res.status}) ${asset.url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  assertChecksum(name, bytes, asset.sha256);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, tool.binary);
  if (!tool.archive) {
    await Bun.write(target, bytes);
  } else {
    const work = mkdtempSync(join(tmpdir(), `tool-${name}-`));
    try {
      const archive = join(work, "archive.tar.gz");
      await Bun.write(archive, bytes);
      const tar = Bun.spawnSync(["tar", "-xzf", archive, "-C", work]);
      if (tar.exitCode !== 0) throw new Error(`${name}: tar failed: ${tar.stderr.toString()}`);
      const binary = findFile(work, tool.binary);
      if (!binary) throw new Error(`${name}: ${tool.binary} not found in the archive`);
      copyFileSync(binary, target);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  chmodSync(target, 0o755);
  return target;
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const dirAt = rest.indexOf("--dir");
  const dir = dirAt >= 0 ? rest[dirAt + 1] : undefined;
  const names = rest.filter((_, i) => i !== dirAt && i !== dirAt + 1);
  if (cmd !== "install" || !dir || names.length === 0) {
    console.error(`usage: tools.ts install --dir <dir> <${Object.keys(TOOLS).join("|")}>...`);
    process.exit(2);
  }
  for (const n of names) {
    if (!(n in TOOLS)) {
      console.error(`unknown tool: ${n}`);
      process.exit(2);
    }
    const path = await install(n as ToolName, dir);
    console.log(`${n} ${TOOLS[n as ToolName].version} → ${path}`);
  }
}
