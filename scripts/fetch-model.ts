// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Download pinned model weights and verify their sha256. Never committed, never served to clients.
 *
 *   bun scripts/fetch-model.ts [--model moderation|captions] [--out <path>] [--force]
 *
 * - `moderation` (the default): the classifier (ADR 0006 Q2, ADR 0008), written to
 *   `DEFAULT_MODEL_PATH`, which the worker reads when MODERATION_CLASSIFIER_MODEL is empty. Its
 *   entry tolerates a null digest with a warning, so a first fetch can record it.
 * - `captions`: the whisper weights (ADR 0011 decision 1), written to
 *   `DEFAULT_CAPTIONS_MODEL_PATH`, which the whisper sidecar mounts. Its digest is required: a
 *   null digest or a mismatch is refused, never warned about.
 *
 * Operators without internet access copy the file and point the service at it.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { CAPTIONS_MODEL, captionsModelUrl, DEFAULT_CAPTIONS_MODEL_PATH } from "../packages/captions/src/model.ts";
import { DEFAULT_MODEL_PATH, MODEL, modelUrl } from "../packages/moderation/src/model.ts";

export const MODEL_NAMES = ["moderation", "captions"] as const;
export type ModelName = (typeof MODEL_NAMES)[number];

export interface ModelTarget {
  name: ModelName;
  sha256: string | null;
  /** True when a null digest is refused (captions); the classifier only warns. */
  digestRequired: boolean;
  url: string | null;
  defaultPath: string;
  /** Where to record a digest that is missing. */
  pinFile: string;
}

export function modelTarget(name: ModelName): ModelTarget {
  if (name === "captions")
    return {
      name,
      sha256: CAPTIONS_MODEL.sha256,
      digestRequired: true,
      url: captionsModelUrl(),
      defaultPath: DEFAULT_CAPTIONS_MODEL_PATH,
      pinFile: "packages/captions/src/model.ts",
    };
  return {
    name,
    sha256: MODEL.sha256,
    digestRequired: false,
    url: modelUrl(),
    defaultPath: DEFAULT_MODEL_PATH,
    pinFile: "packages/moderation/src/model.ts",
  };
}

export type DigestVerdict = { ok: true; warning?: string } | { ok: false; reason: string };

/** Whether a file with digest `sha` may be used. */
export function checkDigest(target: ModelTarget, sha: string): DigestVerdict {
  if (target.sha256 === null) {
    if (target.digestRequired)
      return { ok: false, reason: `no pinned sha256 for the ${target.name} model (${target.pinFile}); refusing it` };
    return { ok: true, warning: `sha256 ${sha}: no pinned digest yet; record it in ${target.pinFile}` };
  }
  return sha === target.sha256
    ? { ok: true }
    : { ok: false, reason: `sha256 mismatch (got ${sha}, want ${target.sha256})` };
}

export function parseModelArgs(argv: readonly string[]): { name: ModelName; out?: string; force: boolean } {
  const arg = (flag: string) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const name = arg("--model") ?? "moderation";
  if (!(MODEL_NAMES as readonly string[]).includes(name))
    throw new Error(`unknown --model ${name}; expected ${MODEL_NAMES.join(" or ")}`);
  return { name: name as ModelName, out: arg("--out"), force: argv.includes("--force") };
}

const digest = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function main(): Promise<number> {
  const args = parseModelArgs(process.argv.slice(2));
  const target = modelTarget(args.name);
  const out = args.out ?? target.defaultPath;

  if (existsSync(out) && !args.force) {
    const verdict = checkDigest(target, digest(readFileSync(out)));
    if (!verdict.ok) {
      console.error(`${out}: ${verdict.reason}; re-run with --force`);
      return 1;
    }
    if (verdict.warning) console.warn(verdict.warning);
    console.log(`${out} present and verified`);
    return 0;
  }
  // Refuse before downloading: an unpinned required digest can never pass.
  const unpinned = checkDigest(target, "");
  if (target.sha256 === null && !unpinned.ok) {
    console.error(unpinned.reason);
    return 1;
  }
  if (target.url === null) {
    console.error(`the ${target.name} model has no pinned revision (${target.pinFile}); nothing to fetch`);
    return 1;
  }

  const res = await fetch(target.url, { redirect: "follow", signal: AbortSignal.timeout(600_000) });
  if (!res.ok) {
    console.error(`download failed: HTTP ${res.status}`);
    return 1;
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const sha = digest(bytes);
  const verdict = checkDigest(target, sha);
  if (!verdict.ok) {
    console.error(`downloaded file refused: ${verdict.reason}; not saved`);
    return 1;
  }
  if (verdict.warning) console.warn(verdict.warning);
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.part`;
  await Bun.write(tmp, bytes);
  rmSync(out, { force: true });
  renameSync(tmp, out);
  console.log(`wrote ${out} (${bytes.length} bytes, sha256 ${sha})`);
  return 0;
}

if (import.meta.main) process.exit(await main());
