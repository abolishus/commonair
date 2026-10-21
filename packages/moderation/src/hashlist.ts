// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Hash lists and the matcher. Operator files: one PDQ hex per line, optional trailing `,`-separated
 * fields or `# comment`, blank lines and `#` lines ignored; any other line is a parse error (the
 * caller keeps the last good list). Upper-case hex is accepted and normalized to lower case
 * (ThreatExchange exports use lower case; some tools write upper case). Duplicate entries count
 * once. An empty path is an empty list, which is valid. The local block list is read from
 * `local_hash_list` by the service and passed to `staticHashList`.
 *
 * Matching is a linear scan over packed 32-bit words: about a millisecond per 10k entries (see
 * the README for measurements), fine up to ~100k entries per list. Never log hashes or file
 * contents: errors carry line numbers and categories only.
 */
import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { HASH_LIST_CATEGORIES, type HashListCategory } from "@commonair/contracts/enums";
import { MODERATION_CONSTANTS } from "./constants.ts";
import { hashWords, PDQ_HEX, popcount32 } from "./pdq.ts";
import type { HashList, HashListProvider, HashMatch, HashMatcher, PdqHash } from "./types.ts";

export class HashListParseError extends Error {
  override name = "HashListParseError";
  constructor(readonly line: number) {
    super(`hash list line ${line} is not a PDQ hash`);
  }
}

const ANY_CASE_HEX = /^[0-9a-fA-F]{64}$/;

/** An immutable list over packed words. */
function packedList(
  category: HashListCategory,
  provider: HashListProvider,
  hashes: readonly string[],
  version: string,
): HashList {
  const unique = [...new Set(hashes)];
  const words = new Uint32Array(unique.length * 8);
  unique.forEach((h, i) => hashWords(h, words, i * 8));
  const size = unique.length;
  return Object.freeze({
    category,
    provider,
    version,
    size,
    nearest(hash: string): number | null {
      if (size === 0) return null;
      const q = hashWords(hash);
      const q0 = q[0] ?? 0,
        q1 = q[1] ?? 0,
        q2 = q[2] ?? 0,
        q3 = q[3] ?? 0;
      const q4 = q[4] ?? 0,
        q5 = q[5] ?? 0,
        q6 = q[6] ?? 0,
        q7 = q[7] ?? 0;
      let best = 257;
      for (let o = 0; o < words.length; o += 8) {
        const d =
          popcount32((q0 ^ (words[o] ?? 0)) >>> 0) +
          popcount32((q1 ^ (words[o + 1] ?? 0)) >>> 0) +
          popcount32((q2 ^ (words[o + 2] ?? 0)) >>> 0) +
          popcount32((q3 ^ (words[o + 3] ?? 0)) >>> 0) +
          popcount32((q4 ^ (words[o + 4] ?? 0)) >>> 0) +
          popcount32((q5 ^ (words[o + 5] ?? 0)) >>> 0) +
          popcount32((q6 ^ (words[o + 6] ?? 0)) >>> 0) +
          popcount32((q7 ^ (words[o + 7] ?? 0)) >>> 0);
        if (d < best) {
          best = d;
          if (d === 0) break;
        }
      }
      return best;
    },
  });
}

/** Parse a list file's text. `version` = `sha256:<hex of text>:<count>` (count of unique entries). */
export function parseHashList(text: string, category: HashListCategory): HashList {
  const hashes: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i] ?? "";
    if (line.endsWith("\r")) line = line.slice(0, -1);
    const hashAt = line.indexOf("#");
    if (hashAt !== -1) line = line.slice(0, hashAt);
    const field = (line.split(",")[0] ?? "").trim();
    if (field === "") {
      // Blank, comment-only, or a line with fields but no hash: only the first two are allowed.
      if (line.trim() !== "") throw new HashListParseError(i + 1);
      continue;
    }
    if (!ANY_CASE_HEX.test(field)) throw new HashListParseError(i + 1);
    hashes.push(field.toLowerCase());
  }
  const count = new Set(hashes).size;
  const sha = createHash("sha256").update(text).digest("hex");
  return packedList(category, "pdq:operator-list", hashes, `sha256:${sha}:${count}`);
}

/** Load a list file (empty path → an empty list with version `empty:0`). A missing file throws. */
export async function loadHashListFile(path: string, category: HashListCategory): Promise<HashList> {
  if (path === "") return packedList(category, "pdq:operator-list", [], "empty:0");
  return parseHashList(await Bun.file(path).text(), category);
}

/** A list from hashes already in memory (the database's local block list). Invalid hashes throw. */
export function staticHashList(
  category: HashListCategory,
  provider: HashListProvider,
  hashes: readonly string[],
  version: string,
): HashList {
  const normalized = hashes.map((h) => {
    const l = h.toLowerCase();
    if (!PDQ_HEX.test(l)) throw new TypeError("staticHashList: malformed PDQ hash");
    return l;
  });
  return packedList(category, provider, normalized, version);
}

const categoryRank = (c: HashListCategory) => HASH_LIST_CATEGORIES.indexOf(c);

/**
 * Nearest match across lists. Ties go to the earlier category in `HASH_LIST_CATEGORIES` (CSAM
 * before NCII, so the stricter legal path wins), then to the list added first.
 */
export function createHashMatcher(lists: readonly HashList[]): HashMatcher {
  let current: readonly HashList[] = Object.freeze([...lists]);
  const key = (l: HashList) => `${l.category}\u0000${l.provider}`;
  return {
    match(hash: PdqHash): HashMatch | null {
      if (!(hash.quality >= MODERATION_CONSTANTS.PDQ_MIN_QUALITY)) return null;
      if (!PDQ_HEX.test(hash.hash)) throw new TypeError("match: malformed PDQ hash");
      const snapshot = current;
      let best: HashMatch | null = null;
      for (const list of snapshot) {
        const d = list.nearest(hash.hash);
        if (d === null || d > MODERATION_CONSTANTS.PDQ_MATCH_DISTANCE) continue;
        if (
          best === null ||
          d < best.distance ||
          (d === best.distance && categoryRank(list.category) < categoryRank(best.category))
        ) {
          best = {
            category: list.category,
            provider: list.provider,
            listVersion: list.version,
            distance: d,
            quality: hash.quality,
          };
        }
      }
      return best;
    },
    replace(list: HashList) {
      const k = key(list);
      const i = current.findIndex((l) => key(l) === k);
      const next = [...current];
      if (i === -1) next.push(list);
      else next[i] = list;
      // One assignment: a concurrent `match` sees the old or the new set, never a mix.
      current = Object.freeze(next);
    },
    lists: () => current,
  };
}

const RELOAD_DEBOUNCE_MS = 250;

/**
 * Reload the operator lists on SIGHUP and on file change; on a parse error keep the last good
 * list and call `onError` (ids and line numbers only). Returns a stop function. The directory is
 * watched rather than the file, so replacing the file by rename (editors, config mounts) is seen.
 */
export function watchHashListFiles(
  files: { path: string; category: HashListCategory }[],
  matcher: HashMatcher,
  onError: (err: Error, category: HashListCategory) => void,
): () => void {
  const active = files.filter((x) => x.path !== "");
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const watchers: FSWatcher[] = [];
  let stopped = false;
  // Serialize reloads per file so an older read never replaces a newer one.
  const chains = new Map<string, Promise<void>>();

  const reload = (file: { path: string; category: HashListCategory }) => {
    const prev = chains.get(file.path) ?? Promise.resolve();
    const next = prev.then(async () => {
      if (stopped) return;
      try {
        const list = await loadHashListFile(file.path, file.category);
        if (!stopped) matcher.replace(list);
      } catch (err) {
        onError(err instanceof Error ? err : new Error("hash list reload failed"), file.category);
      }
    });
    chains.set(file.path, next);
    return next;
  };

  const schedule = (file: { path: string; category: HashListCategory }) => {
    if (stopped) return;
    const t = timers.get(file.path);
    if (t) clearTimeout(t);
    timers.set(
      file.path,
      setTimeout(() => {
        timers.delete(file.path);
        void reload(file);
      }, RELOAD_DEBOUNCE_MS),
    );
  };

  const onHup = () => {
    for (const file of active) schedule(file);
  };
  process.on("SIGHUP", onHup);

  for (const file of active) {
    try {
      const name = basename(file.path);
      const w = watch(dirname(file.path), (_event, changed) => {
        if (changed === null || changed === name) schedule(file);
      });
      w.on("error", (err) => onError(err, file.category));
      watchers.push(w);
    } catch (err) {
      // No watch (e.g. the directory vanished): SIGHUP still reloads.
      onError(err instanceof Error ? err : new Error("hash list watch failed"), file.category);
    }
  }

  return () => {
    stopped = true;
    process.off("SIGHUP", onHup);
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    for (const w of watchers) w.close();
  };
}
