// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Trust & safety runtime of the API (ADR 0006, docs/testing/e4c-selectors.md): the evidence
 * sealing key, the hash matcher (operator lists plus the database block list), the upload
 * classifier and the `QUEUES.moderation` producer. `initModeration` runs at startup and fails
 * closed: a bad key, an unreadable list or a classifier that will not load stops the service.
 * Nothing here can switch matching or classification off; only providers are swappable.
 *
 * The private evidence key is NOT loaded here: only `./evidence.ts` (the legal handlers) does.
 */
import { isNull, sql } from "drizzle-orm";
import { MODERATION_CATEGORIES, type HashListCategory, type ModerationCategory } from "@commonair/contracts/enums";
import { KEYS, ModerationScores } from "@commonair/contracts/internal";
import { schema } from "@commonair/db";
import {
  createHashMatcher,
  DEFAULT_MODEL_PATH,
  importSealingKey,
  loadHashListFile,
  scriptedClassifier,
  staticHashList,
  watchHashListFiles,
  type Classifier,
  type HashList,
  type HashMatch,
  type HashMatcher,
  type PdqHash,
  type SealingKey,
} from "@commonair/moderation";
import type { Deps } from "../deps.ts";
import { createModerationQueue, type ModerationQueue } from "./queue.ts";

export interface ModerationRuntime {
  sealing: SealingKey;
  classifier: Classifier;
  /** Categories the configured classifier does not score (`modq-not-scored`). */
  notScored: ModerationCategory[];
  /** Closest match across the operator lists and the database block list (CSAM first on a tie). */
  match(hash: PdqHash): Promise<HashMatch | null>;
  queue: ModerationQueue;
  testHooks: boolean;
  close(): Promise<void>;
}

export interface ModerationOverrides {
  classifier?: Classifier;
  queue?: ModerationQueue;
}

const runtimes = new WeakMap<Deps, Promise<ModerationRuntime>>();

/** The categories a classifier leaves unscored, in catalog order. */
export const notScoredBy = (scored: readonly ModerationCategory[]): ModerationCategory[] =>
  MODERATION_CATEGORIES.filter((c) => !scored.includes(c));

/** Pick the closer of two matches; CSAM wins a tie (the T0 action and the NCMEC draft follow it). */
export function closerMatch(a: HashMatch | null, b: HashMatch | null): HashMatch | null {
  if (!a) return b;
  if (!b) return a;
  if (a.distance !== b.distance) return a.distance < b.distance ? a : b;
  return a.category === "csam" ? a : b;
}

async function buildClassifier(deps: Deps): Promise<Classifier> {
  const env = deps.env;
  if (env.MODERATION_CLASSIFIER === "scripted") {
    // The env schema already refuses `scripted` without test hooks; this is the second lock.
    if (!env.MODERATION_TEST_HOOKS) throw new Error("the scripted classifier needs MODERATION_TEST_HOOKS=true");
    return scriptedClassifier(async (channelId) => {
      const raw = await deps.valkey.get(KEYS.moderationScript(channelId));
      if (!raw) return null;
      try {
        const parsed = ModerationScores.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    });
  }
  // The native addon loads only when the ONNX provider is configured.
  const { createOnnxClassifier } = await import("@commonair/moderation/onnx");
  return createOnnxClassifier({ modelPath: env.MODERATION_CLASSIFIER_MODEL || DEFAULT_MODEL_PATH });
}

/**
 * The database block list (`local_hash_list`), reloaded when its version changes. The version
 * query is one index-only aggregate, so every upload commit sees hashes confirmed a moment ago.
 */
function localLists(deps: Deps) {
  let version = "";
  let matcher: HashMatcher | null = null;
  return async (): Promise<HashMatcher> => {
    const t = schema.localHashList;
    const rows = await deps.db
      .select({ category: t.category, n: sql<number>`count(*)::int`, newest: sql<string>`max(${t.id}::text)` })
      .from(t)
      .where(isNull(t.revokedAt))
      .groupBy(t.category);
    const next = rows
      .map((r) => `${r.category}:${Number(r.n)}:${r.newest}`)
      .sort()
      .join("|");
    if (matcher && next === version) return matcher;
    const hashes = await deps.db.select({ category: t.category, pdq: t.pdq }).from(t).where(isNull(t.revokedAt));
    const lists: HashList[] = (["csam", "ncii"] as const satisfies readonly HashListCategory[]).map((category) => {
      const row = rows.find((r) => r.category === category);
      const v = row ? `local:${Number(row.n)}:${row.newest}` : "local:0:none";
      return staticHashList(
        category,
        "pdq:local",
        hashes.filter((h) => h.category === category).map((h) => h.pdq),
        v,
      );
    });
    matcher = createHashMatcher(lists);
    version = next;
    return matcher;
  };
}

export async function initModeration(deps: Deps, overrides: ModerationOverrides = {}): Promise<ModerationRuntime> {
  const existing = runtimes.get(deps);
  if (existing) return existing;
  const p = (async (): Promise<ModerationRuntime> => {
    const env = deps.env;
    const log = deps.logger.child({ component: "moderation" });
    if (env.MODERATION_TEST_HOOKS)
      log.warn("MODERATION_TEST_HOOKS is on: the scripted classifier and /internal/moderation/* are enabled", {
        testHooks: true,
      });
    const sealing = await importSealingKey(env.EVIDENCE_PUBLIC_KEY);
    const files = [
      { path: env.MODERATION_HASHLIST_CSAM, category: "csam" as const },
      { path: env.MODERATION_HASHLIST_NCII, category: "ncii" as const },
    ];
    const operator = createHashMatcher(await Promise.all(files.map((f) => loadHashListFile(f.path, f.category))));
    const watched = files.filter((f) => f.path !== "");
    const stopWatch =
      watched.length > 0
        ? watchHashListFiles(watched, operator, (err, category) =>
            log.error("hash list reload failed; keeping the last good list", { category, err: err.name }),
          )
        : () => {};
    for (const l of operator.lists())
      log.info("hash list loaded", { category: l.category, provider: l.provider, version: l.version, size: l.size });
    const local = localLists(deps);
    const classifier = overrides.classifier ?? (await buildClassifier(deps));
    const queue = overrides.queue ?? (await createModerationQueue(env.VALKEY_URL, env.WORKER_BULL_PREFIX));
    log.info("moderation ready", {
      provider: classifier.provider,
      providerVersion: classifier.providerVersion,
      testHooks: env.MODERATION_TEST_HOOKS,
    });
    return {
      sealing,
      classifier,
      notScored: notScoredBy(classifier.scored),
      async match(hash) {
        return closerMatch(operator.match(hash), (await local()).match(hash));
      },
      queue,
      testHooks: env.MODERATION_TEST_HOOKS,
      async close() {
        stopWatch();
        await queue.close();
      },
    };
  })();
  runtimes.set(deps, p);
  // A failed start is not cached, so the caller sees the error and nothing half-built lingers.
  p.catch(() => runtimes.delete(deps));
  return p;
}

/** The runtime for these deps (initialized on first use if startup did not already). */
export const moderationRuntime = (deps: Deps): Promise<ModerationRuntime> => initModeration(deps);

/** Close the runtime if one was started (shutdown and tests). */
export async function closeModeration(deps: Deps): Promise<void> {
  const p = runtimes.get(deps);
  if (!p) return;
  runtimes.delete(deps);
  await (await p.catch(() => null))?.close();
}
