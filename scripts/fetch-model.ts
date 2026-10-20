// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Download the default moderation classifier's weights (ADR 0006 Q2, ADR 0008) at the pinned
 * revision and verify their sha256. The worker refuses to start without a matching file.
 *
 *   bun scripts/fetch-model.ts [--out <path>] [--force]
 *
 * Default path: `DEFAULT_MODEL_PATH` (`.cache/models/…`), which the worker reads when
 * MODERATION_CLASSIFIER_MODEL is empty. Operators without internet access copy the file and set
 * MODERATION_CLASSIFIER_MODEL. The weights are never committed and never served to clients.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_MODEL_PATH, MODEL, modelUrl } from "../packages/moderation/src/model.ts";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const out = arg("--out") ?? DEFAULT_MODEL_PATH;
const force = process.argv.includes("--force");
const digest = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function check(sha: string): boolean {
  if (MODEL.sha256 === null) {
    console.warn(`sha256 ${sha}: no pinned digest yet; record it as MODEL.sha256 in packages/moderation/src/model.ts`);
    return true;
  }
  return sha === MODEL.sha256;
}

if (existsSync(out) && !force) {
  const sha = digest(readFileSync(out));
  if (!check(sha)) {
    console.error(`${out} does not match the pinned sha256 (got ${sha}); re-run with --force`);
    process.exit(1);
  }
  console.log(`${out} present and verified`);
  process.exit(0);
}

const res = await fetch(modelUrl(), { redirect: "follow", signal: AbortSignal.timeout(600_000) });
if (!res.ok) {
  console.error(`download failed: HTTP ${res.status}`);
  process.exit(1);
}
const bytes = new Uint8Array(await res.arrayBuffer());
const sha = digest(bytes);
if (!check(sha)) {
  console.error(`downloaded file does not match the pinned sha256 (got ${sha}, want ${MODEL.sha256}); not saved`);
  process.exit(1);
}
mkdirSync(dirname(out), { recursive: true });
const tmp = `${out}.part`;
await Bun.write(tmp, bytes);
rmSync(out, { force: true });
renameSync(tmp, out);
console.log(`wrote ${out} (${bytes.length} bytes, sha256 ${sha})`);
