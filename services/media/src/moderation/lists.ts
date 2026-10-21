// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Hash lists media matches against: the operator files (`MODERATION_HASHLIST_CSAM`/`_NCII`, empty
 * = an empty list) and the database block list (`local_hash_list`, always loaded, one list per
 * category). At startup every list must load or the service refuses to start. Afterwards the
 * operator files reload on SIGHUP/change and the local list on a cheap version check; a failed
 * reload keeps the last good list. Logs carry categories, providers, versions, sizes and line
 * numbers, never hashes.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { HASH_LIST_CATEGORIES, type HashListCategory } from "@commonair/contracts/enums";
import { schema, type Database } from "@commonair/db";
import {
  createHashMatcher,
  HashListParseError,
  loadHashListFile,
  staticHashList,
  watchHashListFiles,
  type HashList,
  type HashMatcher,
} from "@commonair/moderation";
import type { Logger } from "@commonair/observability";

export interface ListSources {
  csamPath: string;
  nciiPath: string;
}

/** The list functions, injectable so unit tests run without unit A's implementations. */
export interface ListTools {
  loadFile: (path: string, category: HashListCategory) => Promise<HashList>;
  staticList: typeof staticHashList;
  createMatcher: (lists: readonly HashList[]) => HashMatcher;
  watchFiles: typeof watchHashListFiles;
}

export const defaultListTools: ListTools = {
  loadFile: loadHashListFile,
  staticList: staticHashList,
  createMatcher: createHashMatcher,
  watchFiles: watchHashListFiles,
};

export const localListVersion = (count: number, newestId: string | null) => `local:${count}:${newestId ?? "none"}`;

/** Versions of the active local block list per category (one cheap aggregate query). */
export async function localListVersions(db: Database): Promise<Record<HashListCategory, string>> {
  const t = schema.localHashList;
  const rows = await db
    .select({
      category: t.category,
      count: sql<number>`count(*)::int`,
      // uuidv7 text sorts by time, so the max is the newest row.
      newest: sql<string | null>`max(${t.id}::text)`,
    })
    .from(t)
    .where(isNull(t.revokedAt))
    .groupBy(t.category);
  const out = Object.fromEntries(HASH_LIST_CATEGORIES.map((c) => [c, localListVersion(0, null)])) as Record<
    HashListCategory,
    string
  >;
  for (const r of rows) out[r.category] = localListVersion(r.count, r.newest);
  return out;
}

/** Load one category of the local block list. */
export async function loadLocalList(db: Database, tools: ListTools, category: HashListCategory): Promise<HashList> {
  const t = schema.localHashList;
  // Read hashes and version in one statement so the version describes exactly these rows.
  const rows = await db
    .select({ id: t.id, pdq: t.pdq })
    .from(t)
    .where(and(isNull(t.revokedAt), eq(t.category, category)));
  const newest = rows.reduce<string | null>((m, r) => (m === null || r.id > m ? r.id : m), null);
  return tools.staticList(
    category,
    "pdq:local",
    rows.map((r) => r.pdq),
    localListVersion(rows.length, newest),
  );
}

export const describeList = (l: HashList) => ({
  category: l.category,
  provider: l.provider,
  version: l.version,
  size: l.size,
});

export interface LoadedLists {
  matcher: HashMatcher;
  /** Reload the local block list if its version changed (keeps the last good list on error). */
  refreshLocal(): Promise<void>;
  /** Stop watching the operator files. */
  stop(): void;
}

/**
 * Load every list. Throws (the caller refuses to start) when an operator file cannot be read or
 * parsed or the local list cannot be read.
 */
export async function loadLists(opts: {
  db: Database;
  sources: ListSources;
  logger: Logger;
  tools?: ListTools;
}): Promise<LoadedLists> {
  const tools = opts.tools ?? defaultListTools;
  const log = opts.logger.child({ component: "moderation-lists" });
  const files: { path: string; category: HashListCategory }[] = [
    { path: opts.sources.csamPath, category: "csam" },
    { path: opts.sources.nciiPath, category: "ncii" },
  ];
  const operator = await Promise.all(
    files.map(async (f) => {
      try {
        return await tools.loadFile(f.path, f.category);
      } catch (err) {
        // The line number is safe to log; the path, the line and the hashes are not logged.
        const line = err instanceof HashListParseError ? err.line : undefined;
        log.fatal("operator hash list failed to load; refusing to start", { category: f.category, line });
        throw new Error(`operator hash list (${f.category}) failed to load`, { cause: err });
      }
    }),
  );
  const local = await Promise.all(HASH_LIST_CATEGORIES.map((c) => loadLocalList(opts.db, tools, c)));
  const matcher = tools.createMatcher([...operator, ...local]);
  log.info("moderation hash lists loaded", { lists: matcher.lists().map(describeList) });

  const watched = files.filter((f) => f.path !== "");
  const stopWatch =
    watched.length > 0
      ? tools.watchFiles(watched, matcher, (err, category) => {
          const line = err instanceof HashListParseError ? err.line : undefined;
          log.error("operator hash list reload failed; keeping the last good list", { category, line });
        })
      : () => {};

  let refreshing: Promise<void> | null = null;
  const refreshLocal = async () => {
    const versions = await localListVersions(opts.db);
    for (const c of HASH_LIST_CATEGORIES) {
      const current = matcher.lists().find((l) => l.provider === "pdq:local" && l.category === c);
      if (current?.version === versions[c]) continue;
      const next = await loadLocalList(opts.db, tools, c);
      matcher.replace(next);
      log.info("local block list reloaded", describeList(next));
    }
  };
  return {
    matcher,
    async refreshLocal() {
      // One refresh at a time; concurrent callers share it.
      refreshing ??= refreshLocal()
        .catch((err: unknown) => {
          log.warn("local block list reload failed; keeping the last good list", {
            error: err instanceof Error ? err.name : "unknown",
          });
        })
        .finally(() => {
          refreshing = null;
        });
      await refreshing;
    },
    stop: stopWatch,
  };
}
