// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `interact.giveaways.*` (batch 7 decisions (a), (s), (t); ADR 0039 §1–§2). Off unless
 * `GIVEAWAYS_ENABLED`: then every procedure answers FORBIDDEN (`giveaways_disabled`).
 *
 * - `open` (owner, editors) draws a fresh seed and salt, publishes `commit(seed)` and keeps the seed
 *   sealed with `encryptSecret` until the draw. The commitment is audited and goes out in
 *   `channel.giveaway.begin`.
 * - `enter` is the shared `enterGiveaway` (the chat keyword runs the same function).
 * - `close` (or the timed job, or the next read after `closes_at`), then `draw`: entrants sorted by
 *   pseudonym, `draw` over them, ineligible winners (banned, deleted) skipped, the seed revealed
 *   (never the salt), winners written and notified in-app, `channel.giveaway.end` emitted.
 * - `verify` is public: commitment, seed, sorted pseudonyms and winners by index.
 *
 * The 0046 triggers are the backstop for every rule here: the commitment never changes, the seed
 * must hash to it and is revealed only after entries close, winners are append-only entrants, and
 * no entry lands after close.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Giveaway, GiveawayVerification } from "@commonair/contracts/dto";
import type { GiveawayEligibility } from "@commonair/contracts/shapes";
import { schema, uuidv7, type Executor } from "@commonair/db";
import { commit, draw, newSalt, newSeed, verifyReveal } from "@commonair/draw";
import {
  acceptsEntries,
  bannedFor,
  broadcasterFields,
  closeGiveawayInTx,
  emitEvent,
  enterGiveaway,
  entrantFacts,
  entryCount,
  giveawayIneligibility,
  pickWinners,
  sortEntries,
  type GiveawayIneligibleReason,
  type GiveawayRow,
} from "@commonair/interact";
import { decryptSecret, encryptSecret } from "@commonair/tokens";
import type { Deps } from "../../deps.ts";
import { audit } from "../../events/audit.ts";
import type { Caller } from "../../lib/access.ts";
import { apiError, badRequest, conflict, isUniqueViolation, notFound } from "../../lib/errors.ts";
import { actorTypeOf, authorityOn, channelBySlug, type ChannelRow } from "../polls/shared.ts";
import { giveawayCloseQueue } from "./queue.ts";

const { giveaways, giveawayEntries, giveawayWinners } = schema;

/** `encryptSecret` purpose for the sealed seed. */
export const SEED_PURPOSE = "giveaway-seed";

type Ctx = Deps;

/** FORBIDDEN with an i18n-ready reason while the instance has giveaways off (decision (a)). */
export function requireGiveawaysEnabled(ctx: Pick<Deps, "env">): void {
  if (!ctx.env.GIVEAWAYS_ENABLED)
    throw apiError("FORBIDDEN", "Giveaways are not enabled on this instance", { reason: "giveaways_disabled" });
}

// Bidirectional overrides and isolates, zero-width space and BOM: invisible text that can reorder
// or hide what a viewer reads. Joiners stay (emoji sequences need them).
const INVISIBLE = /[\p{Cc}​‪-‮⁦-⁩﻿]/gu;

// The giveaways_text column check, in code points as Postgres counts them.
const TITLE_MAX = 60;
const PRIZE_MAX = 200;
// Code points, not graphemes: a surrogate pair is one character to Postgres.
const codePoints = (s: string) => s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "_").length;

/** Streamer text shown to viewers: NFC, no control or direction-override characters, one line. */
export function scrubText(s: string): string {
  return s.normalize("NFC").replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
}

// ------------------------------------------------------------------ reads

async function winnersOf(db: Executor, giveawayId: string) {
  return db
    .select({
      rank: giveawayWinners.rank,
      index: giveawayWinners.drawIndex,
      userId: giveawayWinners.userId,
      pseudonym: giveawayEntries.pseudonym,
    })
    .from(giveawayWinners)
    .innerJoin(
      giveawayEntries,
      and(
        eq(giveawayEntries.giveawayId, giveawayWinners.giveawayId),
        eq(giveawayEntries.userId, giveawayWinners.userId),
      ),
    )
    .where(eq(giveawayWinners.giveawayId, giveawayId))
    .orderBy(asc(giveawayWinners.rank));
}

async function meOf(ctx: Ctx, db: Executor, row: GiveawayRow, userId: string, won: boolean): Promise<Giveaway["me"]> {
  const [entry] = await db
    .select({ pseudonym: giveawayEntries.pseudonym })
    .from(giveawayEntries)
    .where(and(eq(giveawayEntries.giveawayId, row.id), eq(giveawayEntries.userId, userId)));
  if (entry) return { entered: true, pseudonym: entry.pseudonym, eligible: true, reason: null, won };
  const now = ctx.now();
  if (!acceptsEntries(row, now)) return { entered: false, pseudonym: null, eligible: false, reason: null, won: false };
  const facts = await entrantFacts(db, ctx.valkey, row, userId, now);
  const reason: GiveawayIneligibleReason | null = facts ? giveawayIneligibility(row.eligibility, facts, now) : "banned";
  return { entered: false, pseudonym: null, eligible: reason === null, reason, won: false };
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

export async function giveawayDto(
  ctx: Ctx,
  db: Executor,
  row: GiveawayRow,
  channelSlug: string,
  userId: string | null,
): Promise<Giveaway> {
  const winners = await winnersOf(db, row.id);
  return {
    id: row.id,
    channelSlug,
    title: row.title,
    prize: row.prize,
    winnerCount: row.winnerCount,
    keyword: row.keyword,
    status: row.status,
    eligibility: row.eligibility,
    seedCommitment: row.seedCommitment,
    opensAt: row.opensAt.toISOString(),
    closesAt: iso(row.closesAt),
    drawnAt: iso(row.drawnAt),
    entries: await entryCount(db, row.id),
    me:
      userId === null
        ? null
        : await meOf(
            ctx,
            db,
            row,
            userId,
            winners.some((w) => w.userId === userId),
          ),
    winners: winners.map((w) => ({ rank: w.rank, pseudonym: w.pseudonym })),
  };
}

/** A giveaway still `open` after its `closes_at` (the timed job has not run yet) is closed now. */
async function settleDue(ctx: Ctx, row: GiveawayRow): Promise<GiveawayRow> {
  const now = ctx.now();
  if (row.status !== "open" || row.closesAt === null || now < row.closesAt) return row;
  const closed = await ctx.db.transaction((tx) =>
    closeGiveawayInTx(tx, row.id, now, { type: "system", id: null, trigger: "timed" }),
  );
  if (closed) return closed;
  const [fresh] = await ctx.db.select().from(giveaways).where(eq(giveaways.id, row.id));
  return fresh ?? row;
}

async function inChannel(db: Executor, channel: ChannelRow, id: string): Promise<GiveawayRow> {
  const [row] = await db
    .select()
    .from(giveaways)
    .where(and(eq(giveaways.id, id), eq(giveaways.channelId, channel.id)));
  if (!row) throw notFound("Giveaway not found");
  return row;
}

/** The open giveaway, else the most recent one; null when the channel never had one. */
export async function currentGiveaway(ctx: Ctx, slug: string, caller: Caller | null): Promise<Giveaway | null> {
  requireGiveawaysEnabled(ctx);
  const channel = await channelBySlug(ctx.db, slug);
  const [row] = await ctx.db
    .select()
    .from(giveaways)
    .where(eq(giveaways.channelId, channel.id))
    .orderBy(desc(sql`${giveaways.status} = 'open'`), desc(giveaways.createdAt), desc(giveaways.id))
    .limit(1);
  if (!row) return null;
  return giveawayDto(ctx, ctx.db, await settleDue(ctx, row), channel.slug, caller?.user.id ?? null);
}

// ------------------------------------------------------------------ writes

export interface OpenInput {
  title: string;
  prize: string;
  winnerCount: number;
  keyword: string | null;
  durationMinutes: number | null;
  eligibility: GiveawayEligibility;
}

async function actorOf(db: Executor, caller: Caller, channel: ChannelRow) {
  const authority = await authorityOn(db, caller, channel);
  // The procedure's access check admitted the caller as owner or editor.
  return { actorType: actorTypeOf(authority ?? "owner"), actorId: caller.user.id };
}

export async function openGiveaway(ctx: Ctx, caller: Caller, channel: ChannelRow, input: OpenInput): Promise<Giveaway> {
  requireGiveawaysEnabled(ctx);
  const title = scrubText(input.title);
  const prize = scrubText(input.prize);
  if (title.length === 0) throw badRequest("The title is empty");
  if (prize.length === 0) throw badRequest("The prize is empty");
  // NFC can lengthen text past the column check (giveaways_text): refuse it as a 400, not a 500.
  if (codePoints(title) > TITLE_MAX) throw badRequest(`The title is longer than ${TITLE_MAX} characters`);
  if (codePoints(prize) > PRIZE_MAX) throw badRequest(`The prize is longer than ${PRIZE_MAX} characters`);

  // An expired giveaway still marked open would hold the one-open index.
  const [stale] = await ctx.db
    .select()
    .from(giveaways)
    .where(and(eq(giveaways.channelId, channel.id), eq(giveaways.status, "open")));
  if (stale) await settleDue(ctx, stale);

  const now = ctx.now();
  const seed = newSeed();
  const seedCommitment = await commit(seed);
  const sealedSeed = await encryptSecret(ctx.env.AUTH_SECRET, SEED_PURPOSE, seed);
  const closesAt = input.durationMinutes === null ? null : new Date(now.getTime() + input.durationMinutes * 60_000);
  const { actorType, actorId } = await actorOf(ctx.db, caller, channel);
  const busy = () => conflict("This channel already has an open giveaway");
  let row: GiveawayRow;
  try {
    row = await ctx.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(giveaways)
        .values({
          id: uuidv7(now.getTime()),
          channelId: channel.id,
          title,
          prize,
          eligibility: input.eligibility,
          winnerCount: input.winnerCount,
          keyword: input.keyword,
          status: "open",
          seedCommitment,
          sealedSeed,
          salt: newSalt(),
          opensAt: now,
          closesAt,
          createdById: caller.user.id,
          createdAt: now,
        })
        .returning();
      if (!inserted) throw new Error("giveaway insert returned nothing");
      await audit(tx, {
        actorType,
        actorId,
        action: "giveaway.open",
        subjectType: "giveaway",
        subjectId: inserted.id,
        channelId: channel.id,
        details: {
          seedCommitment,
          winnerCount: inserted.winnerCount,
          keyword: inserted.keyword !== null,
          durationMinutes: input.durationMinutes,
          minAccountAgeDays: input.eligibility.minAccountAgeDays,
          minFollowDays: input.eligibility.minFollowDays,
          minVerifiedWatchSeconds: input.eligibility.minVerifiedWatchSeconds,
        },
      });
      await emitEvent(
        tx,
        "channel.giveaway.begin",
        channel.id,
        {
          ...broadcasterFields(channel),
          id: inserted.id,
          title: inserted.title,
          winner_count: inserted.winnerCount,
          keyword: inserted.keyword,
          seed_commitment: seedCommitment,
          started_at: inserted.opensAt.toISOString(),
          closes_at: iso(inserted.closesAt),
        },
        now,
      );
      return inserted;
    });
  } catch (err) {
    // `giveaways_channel_open_uq`: one open giveaway per channel.
    if (isUniqueViolation(err)) throw busy();
    throw err;
  }
  if (row.closesAt) {
    // Best effort: the trigger and `settleDue` close it on time without the job.
    await giveawayCloseQueue(ctx)
      .schedule(row.id, row.closesAt, now)
      .catch((err: unknown) =>
        ctx.logger.warn("giveaway close not scheduled", {
          giveawayId: row.id,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
  }
  return giveawayDto(ctx, ctx.db, row, channel.slug, caller.user.id);
}

/** The API errors for a refused entry; `data.reason` carries the i18n code. */
function entryRefusal(r: Exclude<Awaited<ReturnType<typeof enterGiveaway>>, { ok: true }>): never {
  switch (r.code) {
    case "not_found":
      throw notFound("Giveaway not found");
    case "closed":
      throw apiError("CONFLICT", "This giveaway is closed to entries", { reason: "closed" });
    case "already_entered":
      throw apiError("CONFLICT", "You already entered this giveaway", { reason: "already_entered" });
    case "ineligible":
      throw apiError("FORBIDDEN", "You are not eligible for this giveaway", { reason: r.reason });
  }
}

export async function enterGiveawayAs(ctx: Ctx, caller: Caller, id: string): Promise<Giveaway> {
  requireGiveawaysEnabled(ctx);
  const [found] = await ctx.db.select().from(giveaways).where(eq(giveaways.id, id));
  if (!found) throw notFound("Giveaway not found");
  await settleDue(ctx, found);
  const r = await enterGiveaway(ctx.db, ctx.valkey, { giveawayId: id, userId: caller.user.id, now: ctx.now() });
  if (!r.ok) entryRefusal(r);
  const [channel] = await ctx.db
    .select({ slug: schema.channels.slug })
    .from(schema.channels)
    .where(eq(schema.channels.id, r.giveaway.channelId));
  const [row] = await ctx.db.select().from(giveaways).where(eq(giveaways.id, id));
  if (!row || !channel) throw notFound("Giveaway not found");
  return giveawayDto(ctx, ctx.db, row, channel.slug, caller.user.id);
}

export async function closeGiveaway(ctx: Ctx, caller: Caller, channel: ChannelRow, id: string): Promise<Giveaway> {
  requireGiveawaysEnabled(ctx);
  const row = await settleDue(ctx, await inChannel(ctx.db, channel, id));
  if (row.status !== "open") throw conflict("Only an open giveaway can be closed");
  const { actorType } = await actorOf(ctx.db, caller, channel);
  const closed = await ctx.db.transaction((tx) =>
    closeGiveawayInTx(tx, row.id, ctx.now(), {
      type: actorType,
      id: caller.user.id,
      trigger: "manual",
    }),
  );
  if (!closed) throw conflict("Only an open giveaway can be closed");
  return giveawayDto(ctx, ctx.db, closed, channel.slug, caller.user.id);
}

async function lockRow(tx: Executor, id: string): Promise<GiveawayRow | null> {
  const [row] = await tx.select().from(giveaways).where(eq(giveaways.id, id)).for("update");
  return row ?? null;
}

/**
 * Winners from the revealed seed; an ineligible winner (platform-banned, deleted, or permanently
 * banned in the channel; a timeout does not count) is skipped for the next. `draw(k)` is a prefix of
 * `draw(k + 1)`, so only as much of the permutation as the winners need is computed (one HMAC per
 * drawn index), growing geometrically while winners are skipped: the row lock is held briefly
 * even with many entrants.
 */
export async function computeWinners(
  tx: Executor,
  row: GiveawayRow,
  seed: string,
  now: Date,
): Promise<{
  entries: { userId: string; pseudonym: string }[];
  winners: { rank: number; index: number }[];
  skipped: number[];
}> {
  const rows = await tx
    .select({ userId: giveawayEntries.userId, pseudonym: giveawayEntries.pseudonym })
    .from(giveawayEntries)
    .where(eq(giveawayEntries.giveawayId, row.id));
  const sorted = sortEntries(rows.map((r) => r.pseudonym));
  const byPseudonym = new Map(rows.map((r) => [r.pseudonym, r.userId]));
  const entries = sorted.map((p) => ({ pseudonym: p, userId: byPseudonym.get(p) as string }));
  // Eligibility only for the candidates the draw reaches, in drawn order.
  const ok = new Map<number, boolean>();
  let found = 0;
  let checked = 0;
  let count = Math.min(row.winnerCount, sorted.length);
  let order: number[] = [];
  for (;;) {
    order = await draw(seed, sorted, count);
    for (; checked < order.length && found < row.winnerCount; checked++) {
      const i = order[checked] as number;
      const entrant = entries[i];
      const eligible =
        entrant !== undefined && !(await bannedFor(tx, row.channelId, entrant.userId, now, { includeTimeouts: false }));
      ok.set(i, eligible);
      if (eligible) found++;
    }
    if (found >= row.winnerCount || count >= sorted.length) break;
    count = Math.min(sorted.length, count + Math.max(row.winnerCount - found, count));
  }
  const { winners, skipped } = pickWinners(order, (i) => ok.get(i) ?? false, row.winnerCount);
  return { entries, winners, skipped };
}

export async function drawGiveaway(ctx: Ctx, caller: Caller, channel: ChannelRow, id: string): Promise<Giveaway> {
  requireGiveawaysEnabled(ctx);
  await inChannel(ctx.db, channel, id);
  const { actorType } = await actorOf(ctx.db, caller, channel);
  const now = ctx.now();
  const drawn = await ctx.db.transaction(async (tx) => {
    let row = await lockRow(tx, id);
    if (!row) throw notFound("Giveaway not found");
    // Drawing an open giveaway closes its entries first (audited as a manual close).
    if (row.status === "open")
      row =
        (await closeGiveawayInTx(tx, row.id, now, { type: actorType, id: caller.user.id, trigger: "manual" })) ?? row;
    if (row.status !== "closed") throw conflict("Only a closed giveaway can be drawn");
    const seed = await decryptSecret(ctx.env.AUTH_SECRET, SEED_PURPOSE, row.sealedSeed);
    // The trigger would refuse a mismatch too; fail loudly before writing anything.
    if (!(await verifyReveal(seed, row.seedCommitment)))
      throw new Error("sealed giveaway seed does not match its commitment");
    const { entries, winners, skipped } = await computeWinners(tx, row, seed, now);
    const [updated] = await tx
      .update(giveaways)
      .set({ seed, status: "drawn", drawnAt: now })
      .where(eq(giveaways.id, row.id))
      .returning();
    if (!updated) throw new Error("giveaway draw update returned nothing");
    for (const w of winners) {
      const entrant = entries[w.index];
      if (!entrant) throw new Error("drawn index outside the entry list");
      await tx
        .insert(giveawayWinners)
        .values({ giveawayId: row.id, userId: entrant.userId, rank: w.rank, drawIndex: w.index, createdAt: now });
      await tx
        .insert(schema.notifications)
        .values({
          userId: entrant.userId,
          type: "system",
          payload: { kind: "giveaway_won", giveawayId: row.id, channel: channel.slug, rank: w.rank },
          dedupeKey: `giveaway-won-${row.id}`,
          createdAt: now,
        })
        .onConflictDoNothing();
    }
    await audit(tx, {
      actorType,
      actorId: caller.user.id,
      action: "giveaway.draw",
      subjectType: "giveaway",
      subjectId: row.id,
      channelId: channel.id,
      details: {
        seed,
        seedCommitment: row.seedCommitment,
        entries: entries.length,
        winners: winners.length,
        winnerIndices: winners.map((w) => w.index),
        skippedIndices: skipped,
      },
    });
    await emitEvent(
      tx,
      "channel.giveaway.end",
      channel.id,
      {
        ...broadcasterFields(channel),
        id: row.id,
        title: row.title,
        status: "drawn",
        entries: entries.length,
        winners: winners.length,
        seed,
        started_at: row.opensAt.toISOString(),
        ended_at: now.toISOString(),
      },
      now,
    );
    return updated;
  });
  return giveawayDto(ctx, ctx.db, drawn, channel.slug, caller.user.id);
}

export async function cancelGiveaway(ctx: Ctx, caller: Caller, channel: ChannelRow, id: string): Promise<Giveaway> {
  requireGiveawaysEnabled(ctx);
  await inChannel(ctx.db, channel, id);
  const { actorType } = await actorOf(ctx.db, caller, channel);
  const now = ctx.now();
  const cancelled = await ctx.db.transaction(async (tx) => {
    const row = await lockRow(tx, id);
    if (!row) throw notFound("Giveaway not found");
    if (row.status !== "open" && row.status !== "closed")
      throw conflict("Only an open or closed giveaway can be cancelled");
    const [updated] = await tx
      .update(giveaways)
      .set({ status: "cancelled", cancelledAt: now, closedAt: row.closedAt ?? now })
      .where(eq(giveaways.id, row.id))
      .returning();
    if (!updated) throw new Error("giveaway cancel update returned nothing");
    const entries = await entryCount(tx, row.id);
    await audit(tx, {
      actorType,
      actorId: caller.user.id,
      action: "giveaway.cancel",
      subjectType: "giveaway",
      subjectId: row.id,
      channelId: channel.id,
      details: { from: row.status, entries },
    });
    await emitEvent(
      tx,
      "channel.giveaway.end",
      channel.id,
      {
        ...broadcasterFields(channel),
        id: row.id,
        title: row.title,
        status: "cancelled",
        entries,
        winners: 0,
        seed: null,
        started_at: row.opensAt.toISOString(),
        ended_at: now.toISOString(),
      },
      now,
    );
    return updated;
  });
  return giveawayDto(ctx, ctx.db, cancelled, channel.slug, caller.user.id);
}

/** Public: everything needed to re-run the draw. The salt never leaves the database. */
export async function verifyGiveaway(ctx: Ctx, slug: string, id: string): Promise<GiveawayVerification> {
  requireGiveawaysEnabled(ctx);
  const channel = await channelBySlug(ctx.db, slug);
  const row = await settleDue(ctx, await inChannel(ctx.db, channel, id));
  const pseudonyms = await ctx.db
    .select({ pseudonym: giveawayEntries.pseudonym })
    .from(giveawayEntries)
    .where(eq(giveawayEntries.giveawayId, row.id));
  const winners = await winnersOf(ctx.db, row.id);
  return {
    id: row.id,
    channelSlug: channel.slug,
    title: row.title,
    status: row.status,
    seedCommitment: row.seedCommitment,
    seed: row.seed,
    entries: sortEntries(pseudonyms.map((p) => p.pseudonym)),
    winnerCount: row.winnerCount,
    // No winner has opted in to showing a username (none can yet): the pseudonym only.
    winners: winners.map((w) => ({ rank: w.rank, index: w.index, pseudonym: w.pseudonym, username: null })),
    drawnAt: iso(row.drawnAt),
  };
}
