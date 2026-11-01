// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Decision (z) write sites, grep-backed: every write to `vods` / `clips` and every write that can
 * suspend or unsuspend a channel (the channel's `suspended_at`, its owner's ban) in this service's
 * source is listed here with its count. A tracked file runs those writes inside `withMediaState` /
 * `withSuspensionState` (`src/media-state.ts`); an untracked one says why it needs no
 * event. A new write site, or one more write in a listed file, fails until it is added here, which
 * means deciding whether it writes the event. Bumping a tracked file's count means its new write
 * is inside the helper and has an event test of its own: the count alone cannot tell a wrapped
 * write from an unwrapped one. `changedStates` is checked at the end.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { changedStates } from "../src/media-state.ts";

const ROOT = join(import.meta.dirname, "..");

type Site = { writes: number; tracked: true } | { writes: number; tracked: false; why: string };

const MEDIA_SITES: Record<string, Site> = {
  "src/deletion/account-deletion.ts": { writes: 3, tracked: true },
  "src/dmca/restore.ts": { writes: 3, tracked: true },
  // Retention (tracked) and the purge of clips already removed by their owner or creator.
  "src/housekeeping.ts": { writes: 2, tracked: true },
  "src/moderation/records.ts": { writes: 2, tracked: true },
  "src/vod/placement.ts": { writes: 1, tracked: false, why: "moves objects (storage_prefix); state unchanged" },
};

const SUSPENSION_SITES: Record<string, Site> = {
  "src/dmca/restore.ts": { writes: 1, tracked: true },
  "src/moderation/ban-expiry.ts": { writes: 1, tracked: true },
  "src/moderation/t0.ts": { writes: 2, tracked: true },
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
  return [...src.matchAll(re)].length + [...src.matchAll(RAW_MEDIA_WRITE)].length;
}

/** Raw SQL: `update vods`, `delete from clips`, `insert into "vods"`. */
const RAW_MEDIA_WRITE = /\b(?:update|delete\s+from|insert\s+into)\s+"?(?:vods|clips)\b/gi;

/** The text of the call whose `(` is at `open`, up to its matching `)`. */
function callBody(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

/**
 * Every `.set(…)` / `.values(…)` naming `suspendedAt`, `banned` or `banExpires`, whatever the value
 * (`now`, `ctx.now()`, `input.banned`, a ternary of objects), and the shared DMCA lifts in
 * `@commonair/db`. Select projections and type annotations are not writes and are not counted.
 */
function suspensionWrites(src: string): number {
  let n = 0;
  for (const m of src.matchAll(/\.(?:set|values)\(/g))
    if (/\b(?:suspendedAt|banned|banExpires)\s*:/.test(callBody(src, m.index + m[0].length - 1))) n++;
  return n + [...src.matchAll(/\b(?:liftDmcaSuspensionInTx|reconcileDmcaTerminationInTx)\(/g)].length;
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

  test("every suspension write site is listed", () => {
    expect(scan(suspensionWrites)).toEqual(counts(SUSPENSION_SITES));
    for (const f of trackedFiles(SUSPENSION_SITES))
      expect(readFileSync(join(ROOT, f), "utf8"), f).toContain("withSuspensionState(");
  });

  test("the scanner sees aliases and every kind of write", () => {
    const src = [
      "const { vods: vodsT, clips } = schema;",
      "const v = schema.vods;",
      'const t = kind === "vod" ? vods : clips;',
      "tx.update(vodsT); tx.delete(clips); tx.insert(v); tx.update(t); tx.update(s.vods); tx.update(users);",
      "x.set({ suspendedAt: now }); x.set({ banned: true }); liftDmcaSuspensionInTx(tx, id);",
      "x.select({ suspendedAt: channels.suspendedAt });",
      "x.set({ suspendedAt: ctx.now(), reason: f(a, b) }); x.set(on ? { banned: input.banned } : { banExpires: at });",
      "type C = { suspendedAt: Date | null }; x.set({ title: t });",
      "await sql`update vods set visibility = 'private'`; sql`DELETE FROM clips`; sql`insert into \"vods\" (id)`;",
    ].join("\n");
    expect(mediaWrites(src)).toBe(8);
    expect(suspensionWrites(src)).toBe(5);
  });
});

describe("changedStates", () => {
  const s = (channelId: string, on: boolean) => ({ channelId, on });
  test("only rows whose state changed, sorted by id; a row gone afterwards is off", () => {
    const before = new Map([
      ["b", s("c1", true)],
      ["a", s("c1", false)],
      ["c", s("c2", true)],
      ["d", s("c2", false)],
    ]);
    const after = new Map([
      ["a", s("c1", true)],
      ["b", s("c1", true)],
      ["d", s("c2", false)],
    ]);
    expect(changedStates(before, after)).toEqual([
      { id: "a", channelId: "c1", on: true },
      { id: "c", channelId: "c2", on: false },
    ]);
  });

  test("a recording VOD removed mid-broadcast is written off, though it never was public", () => {
    const before = new Map([
      ["removed", { channelId: "c", on: false, dvr: true }],
      ["gone", { channelId: "c", on: false, dvr: true }],
      ["finished", { channelId: "c", on: false, dvr: true }],
      ["private", { channelId: "c", on: false, dvr: true }],
      ["idle", { channelId: "c", on: false, dvr: false }],
    ]);
    const after = new Map([
      ["removed", { channelId: "c", on: false, removed: true }],
      ["finished", { channelId: "c", on: true, removed: false }],
      ["private", { channelId: "c", on: false, removed: false }],
      ["idle", { channelId: "c", on: false, removed: true }],
    ]);
    expect(changedStates(before, after)).toEqual([
      { id: "finished", channelId: "c", on: true },
      { id: "gone", channelId: "c", on: false },
      { id: "removed", channelId: "c", on: false },
    ]);
  });

  test("nothing before, nothing written", () => {
    expect(changedStates(new Map(), new Map([["a", s("c", true)]]))).toEqual([]);
  });
});
