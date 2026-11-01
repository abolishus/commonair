// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Fair giveaways (batch 7 decisions (s), (t); ADR 0039 §1–§2). The rules live here once, for the
 * API (`interact.giveaways.*`), the chat keyword plugin and the worker's timed close:
 *
 * - **Eligibility** uses account age, follow age and verified-watch seconds only. The input is a
 *   `GiveawayEligibility` (a strict schema), so a subscription, points or payment criterion cannot
 *   be expressed.
 * - **Entries** are published as `pseudonym(salt, userId)` and ordered by pseudonym (UTF-16 code
 *   units, as `packages/draw` requires) for the draw.
 * - **Winners**: `draw` gives the whole permutation; ranks go to the first `winnerCount` drawn
 *   entrants still eligible at draw time (not banned, not deleted). A skipped entrant's index
 *   stays in the permutation, so the public re-run reproduces the skip.
 *
 * The pure functions come first; the database helpers below them are shared by the API, chat and
 * worker so no service re-implements a rule.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { KEYS, VerifiedWatchValue } from "@commonair/contracts/internal";
import type { GiveawayEligibility } from "@commonair/contracts/shapes";
import { schema, uuidv7, type Executor } from "@commonair/db";
import { isSortedUnique, pseudonym } from "@commonair/draw";

const DAY_MS = 86_400_000;

/** Why a member cannot enter (`Giveaway.me.reason`). */
export const GIVEAWAY_INELIGIBLE_REASONS = [
  "account_age",
  "follow_age",
  "not_following",
  "verified_watch",
  "banned",
] as const;
export type GiveawayIneligibleReason = (typeof GIVEAWAY_INELIGIBLE_REASONS)[number];

/** What eligibility is decided on, read at entry time. */
export interface EntrantFacts {
  accountCreatedAt: Date;
  /** The (non-excluded) follow's start; null when not following. */
  followedAt: Date | null;
  /** Verified-watch seconds on the channel's live broadcast (ADR 0015); 0 when offline or unknown. */
  verifiedWatchSeconds: number;
  /** Platform suspension, deletion, or an active ban or timeout in the channel. */
  banned: boolean;
}

/** Whole days elapsed from `since` to `now` reach `days` (exactly `days` × 24 h counts). */
const atLeastDays = (since: Date, now: Date, days: number) => now.getTime() - since.getTime() >= days * DAY_MS;

/**
 * The first rule the member fails, or null when they may enter. Checked in a fixed order so the
 * reason shown is stable: banned, account age, following, follow age, verified watch.
 */
export function giveawayIneligibility(
  rules: GiveawayEligibility,
  facts: EntrantFacts,
  now: Date,
): GiveawayIneligibleReason | null {
  if (facts.banned) return "banned";
  if (rules.minAccountAgeDays > 0 && !atLeastDays(facts.accountCreatedAt, now, rules.minAccountAgeDays))
    return "account_age";
  if (rules.minFollowDays !== null) {
    if (facts.followedAt === null) return "not_following";
    if (rules.minFollowDays > 0 && !atLeastDays(facts.followedAt, now, rules.minFollowDays)) return "follow_age";
  }
  if (rules.minVerifiedWatchSeconds > 0 && facts.verifiedWatchSeconds < rules.minVerifiedWatchSeconds)
    return "verified_watch";
  return null;
}

/** Pseudonyms in draw order: ascending by UTF-16 code unit (JavaScript's default sort), unique. */
export function sortEntries(pseudonyms: readonly string[]): string[] {
  const sorted = [...pseudonyms].sort();
  if (!isSortedUnique(sorted)) throw new Error("giveaway entries must have unique pseudonyms");
  return sorted;
}

export interface PickedWinner {
  /** 1-based. */
  rank: number;
  /** Index into the sorted entry list. */
  index: number;
}

/**
 * Ranks for the first `winnerCount` indices of the draw permutation `order` whose entrant is still
 * eligible; the ineligible ones met on the way are `skipped` (in drawn order). Because
 * `draw(k)` is a prefix of `draw(k + 1)`, this equals drawing again for each skipped winner.
 */
export function pickWinners(
  order: readonly number[],
  eligible: (index: number) => boolean,
  winnerCount: number,
): { winners: PickedWinner[]; skipped: number[] } {
  const winners: PickedWinner[] = [];
  const skipped: number[] = [];
  for (const index of order) {
    if (winners.length >= winnerCount) break;
    if (eligible(index)) winners.push({ rank: winners.length + 1, index });
    else skipped.push(index);
  }
  return { winners, skipped };
}

/**
 * Does a published result follow from the draw permutation? Ranks run 1…k with k ≤ `winnerCount`,
 * and the winners, by rank, are the permutation in order with only passed-over (ineligible)
 * entries between them. Fewer than `winnerCount` winners means every other entry was passed over.
 * `skipped` counts the passed-over entries.
 */
export function winnersMatchDraw(
  order: readonly number[],
  winners: readonly PickedWinner[],
  winnerCount: number,
): { match: boolean; skipped: number } {
  const byRank = [...winners].sort((a, b) => a.rank - b.rank);
  if (byRank.length > winnerCount || byRank.some((w, i) => w.rank !== i + 1)) return { match: false, skipped: 0 };
  let pos = 0;
  let skipped = 0;
  for (const w of byRank) {
    while (pos < order.length && order[pos] !== w.index) {
      pos++;
      skipped++;
    }
    if (pos >= order.length) return { match: false, skipped };
    pos++;
  }
  if (byRank.length < winnerCount) skipped = order.length - byRank.length;
  return { match: true, skipped };
}

// ------------------------------------------------------------------ database helpers

export type GiveawayRow = typeof schema.giveaways.$inferSelect;

/** What the shared helpers read from Valkey (the API's and chat's clients apply the key prefix). */
export interface ValkeyReader {
  get(key: string): Promise<string | null>;
}

/** The verified-watch seconds for `userId` on `liveBroadcastId`; a key for another broadcast is stale. */
export async function verifiedWatchSeconds(
  valkey: ValkeyReader,
  channelId: string,
  liveBroadcastId: string | null,
  userId: string,
): Promise<number> {
  if (liveBroadcastId === null) return 0;
  const raw = await valkey.get(KEYS.verifiedWatch(channelId, userId));
  if (raw === null) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 0;
  }
  const v = VerifiedWatchValue.safeParse(parsed);
  return v.success && v.data.b === liveBroadcastId ? v.data.s : 0;
}

/** Platform suspension or deletion, or an active channel ban or timeout. */
export async function bannedFor(db: Executor, channelId: string, userId: string, now: Date): Promise<boolean> {
  const [u] = await db
    .select({ banned: schema.users.banned, banExpires: schema.users.banExpires, deletedAt: schema.users.deletedAt })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  if (!u || u.deletedAt !== null) return true;
  if (u.banned && (u.banExpires === null || u.banExpires > now)) return true;
  const bans = await db
    .select({ expiresAt: schema.chatBans.expiresAt })
    .from(schema.chatBans)
    .where(
      and(
        eq(schema.chatBans.channelId, channelId),
        eq(schema.chatBans.userId, userId),
        isNull(schema.chatBans.liftedAt),
      ),
    );
  return bans.some((b) => b.expiresAt === null || b.expiresAt > now);
}

/** Read the facts eligibility needs. Valkey is read only when the giveaway requires verified watching. */
export async function entrantFacts(
  db: Executor,
  valkey: ValkeyReader,
  g: Pick<GiveawayRow, "channelId" | "eligibility">,
  userId: string,
  now: Date,
): Promise<EntrantFacts | null> {
  const [u] = await db
    .select({ createdAt: schema.users.createdAt })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  if (!u) return null;
  const [f] = await db
    .select({ createdAt: schema.follows.createdAt })
    .from(schema.follows)
    .where(
      and(
        eq(schema.follows.followerId, userId),
        eq(schema.follows.channelId, g.channelId),
        isNull(schema.follows.excludedAt),
      ),
    );
  let seconds = 0;
  if (g.eligibility.minVerifiedWatchSeconds > 0) {
    const [c] = await db
      .select({ live: schema.channels.liveBroadcastId })
      .from(schema.channels)
      .where(eq(schema.channels.id, g.channelId));
    try {
      seconds = await verifiedWatchSeconds(valkey, g.channelId, c?.live ?? null, userId);
    } catch {
      // Fail closed: an unreadable standing never admits an entry.
      seconds = 0;
    }
  }
  return {
    accountCreatedAt: u.createdAt,
    followedAt: f?.createdAt ?? null,
    verifiedWatchSeconds: seconds,
    banned: await bannedFor(db, g.channelId, userId, now),
  };
}

/** Entries are accepted while open and before `closes_at` (the 0046 trigger enforces the same). */
export const acceptsEntries = (g: Pick<GiveawayRow, "status" | "closesAt">, now: Date) =>
  g.status === "open" && (g.closesAt === null || now < g.closesAt);

export type EnterResult =
  | { ok: true; pseudonym: string; giveaway: GiveawayRow }
  | { ok: false; code: "not_found" | "closed" | "already_entered"; giveaway: GiveawayRow | null }
  | { ok: false; code: "ineligible"; reason: GiveawayIneligibleReason; giveaway: GiveawayRow };

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";

function pgCode(err: unknown): string | undefined {
  let e: unknown = err;
  for (let depth = 0; e && depth < 5; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Enter `userId` (a button press or the chat keyword): one entry per account, free, refused with
 * a reason when ineligible. The flag (`GIVEAWAYS_ENABLED`) is the caller's check.
 */
export async function enterGiveaway(
  db: Executor,
  valkey: ValkeyReader,
  input: { giveawayId: string; userId: string; now: Date },
): Promise<EnterResult> {
  const { giveawayId, userId, now } = input;
  const [g] = await db.select().from(schema.giveaways).where(eq(schema.giveaways.id, giveawayId));
  if (!g) return { ok: false, code: "not_found", giveaway: null };
  const [mine] = await db
    .select({ pseudonym: schema.giveawayEntries.pseudonym })
    .from(schema.giveawayEntries)
    .where(and(eq(schema.giveawayEntries.giveawayId, g.id), eq(schema.giveawayEntries.userId, userId)));
  if (mine) return { ok: false, code: "already_entered", giveaway: g };
  if (!acceptsEntries(g, now)) return { ok: false, code: "closed", giveaway: g };
  const facts = await entrantFacts(db, valkey, g, userId, now);
  if (!facts) return { ok: false, code: "not_found", giveaway: g };
  const reason = giveawayIneligibility(g.eligibility, facts, now);
  if (reason) return { ok: false, code: "ineligible", reason, giveaway: g };
  const p = await pseudonym(g.salt, userId);
  try {
    const inserted = await db
      .insert(schema.giveawayEntries)
      .values({ giveawayId: g.id, userId, pseudonym: p, createdAt: now })
      .onConflictDoNothing()
      .returning({ userId: schema.giveawayEntries.userId });
    if (inserted.length === 0) return { ok: false, code: "already_entered", giveaway: g };
  } catch (err) {
    // The trigger: closed (or past closes_at) between the read and the insert.
    if (pgCode(err) === CHECK_VIOLATION) return { ok: false, code: "closed", giveaway: g };
    if (pgCode(err) === UNIQUE_VIOLATION) return { ok: false, code: "already_entered", giveaway: g };
    throw err;
  }
  return { ok: true, pseudonym: p, giveaway: g };
}

export async function entryCount(db: Executor, giveawayId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.giveawayEntries)
    .where(eq(schema.giveawayEntries.giveawayId, giveawayId));
  return r?.n ?? 0;
}

/**
 * Close entries (manual, or `closes_at` passed) and write the audit row in the same transaction.
 * Returns the closed row, or null when it was not open.
 */
export async function closeGiveawayInTx(
  tx: Executor,
  giveawayId: string,
  now: Date,
  actor: { type: "user" | "moderator" | "system"; id: string | null; trigger: "manual" | "timed" },
): Promise<GiveawayRow | null> {
  const [row] = await tx
    .update(schema.giveaways)
    .set({ status: "closed", closedAt: now })
    .where(and(eq(schema.giveaways.id, giveawayId), eq(schema.giveaways.status, "open")))
    .returning();
  if (!row) return null;
  await tx.insert(schema.auditLog).values({
    id: uuidv7(now.getTime()),
    actorType: actor.type,
    actorId: actor.id,
    action: "giveaway.close",
    subjectType: "giveaway",
    subjectId: row.id,
    channelId: row.channelId,
    details: { trigger: actor.trigger, entries: await entryCount(tx, row.id) },
    createdAt: now,
  });
  return row;
}
