// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Decision (z) write sites, grep-backed: every write to `vods` / `clips` in this service's source
 * is listed here with its count, and there is no suspension write (media never suspends). A
 * tracked file runs those writes inside `withMediaState` (`src/media-state.ts`); an untracked one
 * says why it needs no event. A new write site, or one more write in a listed file, fails until it
 * is added here, which means deciding whether it writes the event.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vite-plus/test";

const ROOT = join(import.meta.dirname, "..");

type Site = { writes: number; tracked: true } | { writes: number; tracked: false; why: string };

const MEDIA_SITES: Record<string, Site> = {
  // The ready transition (tracked); a T0 removal and a failure of a clip still `processing`.
  "src/clips.ts": { writes: 3, tracked: true },
  "src/lifecycle.ts": { writes: 1, tracked: false, why: "inserts the VOD as `recording`, never public" },
  // Ready (tracked); the claim, T0 removal and failure of a VOD still `recording` / `processing`.
  "src/vod/finalize.ts": { writes: 4, tracked: true },
  "src/vod/reconcile.ts": { writes: 1, tracked: false, why: "fails a stalled VOD still `recording` / `processing`" },
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** `.update(` / `.delete(` / `.insert(` of `vods` or `clips`, under any alias the file gives them. */
function mediaWrites(src: string): number {
  const names = new Set(["vods", "clips"]);
  for (const m of src.matchAll(/const \{([^}]*)\}\s*=\s*schema\b/g))
    for (const d of (m[1] ?? "").matchAll(/\b(vods|clips)\s*:\s*(\w+)/g)) if (d[2]) names.add(d[2]);
  for (const m of src.matchAll(/const (\w+)\s*=\s*(?:schema\.)?(?:vods|clips)\s*;/g)) if (m[1]) names.add(m[1]);
  for (const m of src.matchAll(/const (\w+)\s*=[^;\n]*\?\s*(?:vods|clips)\s*:\s*(?:vods|clips)\s*;/g))
    if (m[1]) names.add(m[1]);
  const re = new RegExp(
    `\\.(?:update|delete|insert)\\(\\s*(?:(?:${[...names].join("|")})|\\w+\\.(?:vods|clips))\\s*\\)`,
    "g",
  );
  return [...src.matchAll(re)].length;
}

/** Writes of `suspended_at`, of a user's ban, and the shared DMCA lifts in `@commonair/db`. */
function suspensionWrites(src: string): number {
  const re =
    /suspendedAt:\s*(?:now\b|null\b|sql`)|\bbanned:\s*(?:true|false)\b|\b(?:liftDmcaSuspensionInTx|reconcileDmcaTerminationInTx)\(/g;
  return [...src.matchAll(re)].length;
}

function scan(count: (src: string) => number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of sourceFiles(join(ROOT, "src")).sort()) {
    const n = count(readFileSync(f, "utf8"));
    if (n > 0) out[relative(ROOT, f)] = n;
  }
  return out;
}

const trackedFiles = (sites: Record<string, Site>) =>
  Object.entries(sites)
    .filter(([, s]) => s.tracked)
    .map(([f]) => f);

const counts = (sites: Record<string, Site>) =>
  Object.fromEntries(Object.entries(sites).map(([f, s]) => [f, s.writes]));

describe("decision (z) write sites", () => {
  test("every VOD and clip write site is listed", () => {
    expect(scan(mediaWrites)).toEqual(counts(MEDIA_SITES));
    for (const f of trackedFiles(MEDIA_SITES))
      expect(readFileSync(join(ROOT, f), "utf8"), f).toContain("withMediaState(");
  });

  test("media writes no suspension", () => {
    expect(scan(suspensionWrites)).toEqual({});
  });

  test("the scanner sees aliases and every kind of write", () => {
    const src = [
      "const { vods: vodsT, clips } = schema;",
      "const v = schema.vods;",
      'const t = kind === "vod" ? vods : clips;',
      "tx.update(vodsT); tx.delete(clips); tx.insert(v); tx.update(t); tx.update(s.vods); tx.update(users);",
      "x.set({ suspendedAt: now }); x.set({ banned: true }); liftDmcaSuspensionInTx(tx, id);",
      "x.select({ suspendedAt: channels.suspendedAt });",
    ].join("\n");
    expect(mediaWrites(src)).toBe(5);
    expect(suspensionWrites(src)).toBe(3);
  });
});
