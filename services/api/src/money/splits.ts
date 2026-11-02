// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Revenue splits (ADR 0013, batch 6 decisions (a), (i)): `money.splits.*` (versioned splits and
 * their acceptances), `money.treasurer.splits.*` (the split-shortfall write-off and the suspense
 * release and forfeit), and `postPaymentWithSplit`, which both payment-posting sites call to post a
 * payment under the version active for its kind and link it in the same transaction.
 *
 * Versioning: a change is a new version and applies to future revenue only. A payment resolves
 * the accepted version whose window holds its `succeededAt`, accepted by then, whose basis covers
 * its kind (the newest such version if several do). Accepting a version ends every accepted
 * version it supersedes (same basis, or any basis when it covers `all`), so at most one version
 * covers a kind at any time; a narrower proposal while an `all` version runs is refused. Ending
 * takes effect for payments after now, never backdated, and notifies the crew.
 *
 * The database (`0043_w2_protections.sql`) enforces the rules (immutable once linked, frozen
 * shares, the 10,000 bps cap, the link, the suspense audit and the two-person write-off); the
 * checks here give clear errors first, and what still reaches a trigger is mapped. Every change
 * writes `audit_log` and the internal `channel.split.update` event in its transaction. Ids, enums
 * and amounts only in either (ADR 0004).
 */
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { z } from "zod";
import type { RevenueSplit as RevenueSplitDto, SplitWriteOff as SplitWriteOffDto } from "@commonair/contracts/dto";
import { type SplitBasis, SPLIT_RULES } from "@commonair/contracts/enums";
import { type Executor, schema, uuidv7 } from "@commonair/db";
import {
  type PaymentSplit,
  type PaymentSucceededInput,
  type PostResult,
  accounts,
  creatorBalances,
  loadMoneySettings,
  lockCreator,
  lockCreators,
  paymentSucceeded,
  post,
  recipientWithheld,
  splitShortfallWriteOff,
  splitSuspenseByOwner,
  splitSuspenseForfeit,
  splitSuspenseRelease,
  storedCode,
} from "@commonair/ledger";
import { audit } from "../events/audit.ts";
import { emit } from "../events/outbox.ts";
import { decodeCursor, encodeCursor, isKeyCursor, pageOf } from "../lib/cursor.ts";
import { apiError, badRequest, conflict, forbidden, notFound, pgCode, precondition } from "../lib/errors.ts";
import { type Ctx, os, requireCaller, requireChannel } from "../lib/orpc.ts";

const {
  revenueSplits: splits,
  revenueSplitShares: shares,
  revenueSplitAcceptances: answers,
  revenueSplitPostings: links,
  splitWriteoffProposals: writeOffs,
  users,
  channels,
  payoutAccounts,
} = schema;
type SplitRow = typeof splits.$inferSelect;
type ChannelRow = typeof channels.$inferSelect;
type WriteOffRow = typeof writeOffs.$inferSelect;
type Dto = z.infer<typeof RevenueSplitDto>;
type WriteOffDto = z.infer<typeof SplitWriteOffDto>;

const DAY_MS = 86_400_000;
/** The treasurer is platform staff; audit rows name them by id (as the other treasurer actions do). */
const STAFF = "admin" as const;

// Resolution and posting -----------------------------------------------------------------------

/** The bases that cover a payment kind. */
const basesFor = (kind: "tip" | "subscription"): SplitBasis[] => [kind === "tip" ? "tips" : "subs", "all"];

/**
 * The split version that applies to a payment of `kind` to the channel succeeding at `at`, with its
 * crew, or null. Only an accepted version (ended ones keep covering payments before their end),
 * accepted by `at`, whose window holds `at`; the newest version wins if several do.
 */
export async function activeSplit(
  tx: Executor,
  channelId: string,
  kind: "tip" | "subscription",
  at: Date,
): Promise<PaymentSplit | null> {
  const iso = at.toISOString();
  const [v] = await tx
    .select({ id: splits.id })
    .from(splits)
    .where(
      and(
        eq(splits.channelId, channelId),
        inArray(splits.status, ["accepted", "ended"]),
        inArray(splits.basis, basesFor(kind)),
        sql`${splits.acceptedAt} is not null and ${splits.acceptedAt} <= ${iso}::timestamptz`,
        sql`${splits.startsAt} <= ${iso}::timestamptz`,
        sql`(${splits.endsAt} is null or ${splits.endsAt} > ${iso}::timestamptz)`,
      ),
    )
    .orderBy(desc(splits.version))
    .limit(1);
  if (!v) return null;
  const crew = await tx
    .select({ userId: shares.recipientUserId, bps: shares.bps })
    .from(shares)
    .where(eq(shares.splitId, v.id));
  return crew.length > 0 ? { versionId: v.id, crew } : null;
}

/**
 * Post a payment under the split version active for its kind at `occurredAt`, and link the version
 * in the same transaction (ADR 0013 decisions 3, 8). Both posting sites (the manual adapter's
 * confirmation and Stripe's renewals) call this inside their own transaction.
 */
export async function postPaymentWithSplit(
  tx: Executor,
  input: Omit<PaymentSucceededInput, "split"> & { channelId: string },
): Promise<PostResult & { splitVersionId: string | null }> {
  const { channelId, ...rest } = input;
  const split = await activeSplit(tx, channelId, input.paymentKind, input.occurredAt);
  const r = await post(tx, paymentSucceeded({ ...rest, split }));
  if (split && r.created) {
    await tx.insert(links).values({ ledgerTransactionId: r.transactionId, splitId: split.versionId });
  }
  return { ...r, splitVersionId: split?.versionId ?? null };
}

// DTOs -------------------------------------------------------------------------------------------

async function toDtos(db: Executor, rows: readonly SplitRow[], viewerId: string): Promise<Dto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const shareRows = await db
    .select({
      splitId: shares.splitId,
      userId: shares.recipientUserId,
      bps: shares.bps,
      username: users.username,
      name: users.name,
    })
    .from(shares)
    .innerJoin(users, eq(users.id, shares.recipientUserId))
    .where(inArray(shares.splitId, ids));
  const answerRows = await db.select().from(answers).where(inArray(answers.splitId, ids));
  const slugs = new Map(
    (
      await db
        .select({ id: channels.id, slug: channels.slug })
        .from(channels)
        .where(
          inArray(
            channels.id,
            rows.map((r) => r.channelId),
          ),
        )
    ).map((c) => [c.id, c.slug]),
  );
  const answerOf = new Map(answerRows.map((a) => [`${a.splitId}:${a.recipientUserId}`, a]));
  return rows.map((r) => {
    const mine = shareRows
      .filter((s) => s.splitId === r.id)
      .sort((a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1 : 0));
    const out = mine.map((s) => {
      const a = answerOf.get(`${r.id}:${s.userId}`);
      return {
        recipient: { id: s.userId, username: s.username, displayName: s.name },
        bps: s.bps,
        decision: a?.decision ?? null,
        decidedAt: a ? a.decidedAt.toISOString() : null,
      };
    });
    return {
      id: r.id,
      channelSlug: slugs.get(r.channelId) ?? "",
      version: r.version,
      status: r.status,
      basis: r.basis,
      startsAt: r.startsAt.toISOString(),
      endsAt: r.endsAt ? r.endsAt.toISOString() : null,
      shares: out,
      createdAt: r.createdAt.toISOString(),
      acceptedAt: r.acceptedAt ? r.acceptedAt.toISOString() : null,
      endedAt: r.endedAt ? r.endedAt.toISOString() : null,
      awaitingYou: r.status === "proposed" && out.some((s) => s.recipient.id === viewerId && s.decision === null),
    };
  });
}

async function toDto(db: Executor, row: SplitRow, viewerId: string): Promise<Dto> {
  const [dto] = await toDtos(db, [row], viewerId);
  if (!dto) throw new Error("split disappeared");
  return dto;
}

// Shared checks ----------------------------------------------------------------------------------

/** The owner itself, not an editor: a split sends the owner's money to others. */
function requireOwner(ctx: Pick<Ctx, "caller" | "channel">): ChannelRow {
  const caller = requireCaller(ctx);
  const channel = requireChannel(ctx);
  if (channel.ownerId !== caller.user.id) throw forbidden("Only the channel owner manages its revenue splits");
  return channel;
}

/**
 * Decision (i): a recipient needs a payout profile (the manual adapter counts) and an account at
 * least `splitRecipientMinAccountAgeDays` old, at propose and again at accept.
 */
async function checkRecipient(
  tx: Executor,
  u: { id: string; createdAt: Date },
  now: Date,
  minAgeDays: number,
): Promise<void> {
  if (u.createdAt.getTime() > now.getTime() - minAgeDays * DAY_MS) {
    throw precondition(
      "split_recipient_account_age",
      `A split recipient's account must be at least ${minAgeDays} days old`,
    );
  }
  const [acct] = await tx.select({ id: payoutAccounts.id }).from(payoutAccounts).where(eq(payoutAccounts.userId, u.id));
  if (!acct) throw precondition("split_recipient_payout_account", "A split recipient needs a payout account first");
}

/** Run a split change, mapping what still reaches a trigger. The trigger's text never leaves. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const code = pgCode(err);
    const cause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
    const text = `${err instanceof Error ? err.message : ""} ${cause instanceof Error ? cause.message : ""}`;
    if (code === "23514" && /exceed 10000 basis points/.test(text)) {
      throw conflict(
        "Together with the splits that overlap it, the crew shares would exceed 100% of this revenue; end the current split first",
      );
    }
    if (code === "23514" || code === "42501") throw conflict("The split changed meanwhile; reload and try again");
    if (code === "23505") throw conflict("Another split change for this channel happened at the same time");
    throw err;
  }
}

async function record(
  tx: Executor,
  row: SplitRow,
  action: string,
  actorId: string,
  now: Date,
  recipients?: readonly string[],
): Promise<void> {
  const crew =
    recipients ??
    (await tx.select({ id: shares.recipientUserId }).from(shares).where(eq(shares.splitId, row.id))).map((r) => r.id);
  await audit(tx, {
    actorType: "user",
    actorId,
    action,
    subjectType: "revenue_split",
    subjectId: row.id,
    channelId: row.channelId,
    details: { version: row.version, status: row.status, basis: row.basis, recipients: crew.length },
  });
  await emit(
    tx,
    "channel.split.update",
    row.channelId,
    {
      channel_id: row.channelId,
      split_id: row.id,
      version: row.version,
      status: row.status,
      basis: row.basis,
      recipient_user_ids: [...crew].sort(),
    },
    now,
  );
}

/**
 * The end of a version ended at `now`: payments after it are not split. The same clock as the
 * payments' `succeededAt` and the version's `startsAt` (the app's), never before the start, never
 * after a preset end; 0043 refuses it if the app clock runs more than a minute behind the database.
 */
/**
 * When a version ends: never before now (no backdating) or its own start, never after its preset
 * end, and, when a successor takes over, not before the successor starts, so no payment in between
 * falls outside every version (ADR 0013 decision 8).
 */
const endAt = (now: Date, successorStartsAt: Date = now) =>
  sql`least(${splits.endsAt}, greatest(${now.toISOString()}::timestamptz, ${successorStartsAt.toISOString()}::timestamptz, ${splits.startsAt}))`;

/** Tell a version's crew it ended (ADR 0013 decision 8); returns who was told. */
async function notifyEnded(
  tx: Executor,
  sp: SplitRow,
  channelSlug: string,
  reason: "ended" | "superseded",
): Promise<string[]> {
  const crew = await tx.select({ id: shares.recipientUserId }).from(shares).where(eq(shares.splitId, sp.id));
  if (crew.length > 0) {
    await tx.insert(schema.notifications).values(
      crew.map((c) => ({
        userId: c.id,
        type: "payout" as const,
        payload: { kind: "split_ended", reason, splitId: sp.id, channel: channelSlug, version: sp.version },
      })),
    );
  }
  return crew.map((c) => c.id);
}

async function lockedSplit(tx: Executor, id: string): Promise<SplitRow> {
  const [row] = await tx.select().from(splits).where(eq(splits.id, id)).for("update");
  if (!row) throw notFound("Split not found");
  return row;
}

/** Bases a version of `basis` supersedes when accepted: its own, and every basis when it covers all. */
const superseded = (basis: SplitBasis): SplitBasis[] => (basis === "all" ? ["tips", "subs", "all"] : [basis]);

/** Every accepted version of the channel in effect now (or later) whose basis overlaps `basis`. */
async function runningVersions(tx: Executor, channelId: string, basis: SplitBasis, at: Date, exceptId?: string) {
  const overlapping: SplitBasis[] = basis === "all" ? ["tips", "subs", "all"] : [basis, "all"];
  return tx
    .select()
    .from(splits)
    .where(
      and(
        eq(splits.channelId, channelId),
        eq(splits.status, "accepted"),
        inArray(splits.basis, overlapping),
        sql`(${splits.endsAt} is null or ${splits.endsAt} > ${at.toISOString()}::timestamptz)`,
        exceptId ? sql`${splits.id} <> ${exceptId}` : undefined,
      ),
    );
}

// money.splits.* ---------------------------------------------------------------------------------

export const splitHandlers = {
  list: os.money.splits.list.handler(async ({ context, input }) => {
    const caller = requireCaller(context);
    const { db } = context.deps;
    const cur = decodeCursor(input.cursor, isKeyCursor);
    const after = cur
      ? or(lt(splits.createdAt, new Date(cur.t)), and(eq(splits.createdAt, new Date(cur.t)), lt(splits.id, cur.id)))
      : undefined;
    let where;
    if (input.channel) {
      const [c] = await db.select().from(channels).where(eq(channels.slug, input.channel)).limit(1);
      if (!c) throw notFound("Channel not found");
      if (c.ownerId !== caller.user.id) throw forbidden("Only the channel owner sees its revenue splits");
      where = and(eq(splits.channelId, c.id), after);
    } else {
      const mine = db.select({ id: shares.splitId }).from(shares).where(eq(shares.recipientUserId, caller.user.id));
      where = and(inArray(splits.id, mine), after);
    }
    const rows = await db
      .select()
      .from(splits)
      .where(where)
      .orderBy(desc(splits.createdAt), desc(splits.id))
      .limit(input.limit + 1);
    const page = pageOf(
      rows,
      input.limit,
      (r) => r,
      (last) => encodeCursor({ t: last.createdAt.toISOString(), id: last.id }),
    );
    return { items: await toDtos(db, page.items, caller.user.id), nextCursor: page.nextCursor };
  }),

  propose: os.money.splits.propose.handler(async ({ context, input }) => {
    const caller = requireCaller(context);
    const channel = requireOwner(context);
    const { deps } = context;
    const now = deps.now();
    const startsAt = input.startsAt ? new Date(input.startsAt) : now;
    const endsAt = input.endsAt ? new Date(input.endsAt) : null;
    if (startsAt.getTime() < now.getTime() - 60_000) throw badRequest("A split cannot start in the past");
    if (endsAt && endsAt <= startsAt) throw badRequest("A split ends after it starts");
    const usernames = input.shares.map((s) => s.username.toLowerCase());
    if (usernames.length > SPLIT_RULES.maxRecipients) throw badRequest("Too many recipients");
    const row = await guarded(() =>
      deps.db.transaction(async (tx) => {
        const { payoutRules } = await loadMoneySettings(tx);
        const people = await tx
          .select({ id: users.id, username: users.username, createdAt: users.createdAt, deletedAt: users.deletedAt })
          .from(users)
          .where(inArray(users.username, usernames));
        const byName = new Map(people.filter((p) => p.deletedAt === null).map((p) => [p.username, p]));
        const recipients = input.shares.map((s) => {
          const u = byName.get(s.username.toLowerCase());
          if (!u) throw notFound(`No user named ${s.username}`);
          if (u.id === channel.ownerId) {
            throw precondition("split_owner_is_crew", "The channel owner is never a crew recipient");
          }
          return { user: u, bps: s.bps };
        });
        for (const r of recipients) await checkRecipient(tx, r.user, now, payoutRules.splitRecipientMinAccountAgeDays);
        // Serialize with other changes to this channel's splits (the trigger takes the same lock).
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`revenue-splits:${channel.id}`}))`);
        const [open] = await tx
          .select({ id: splits.id })
          .from(splits)
          .where(and(eq(splits.channelId, channel.id), eq(splits.status, "proposed")))
          .limit(1);
        if (open) throw conflict("This channel already has a proposed split; end or wait for it first");
        if (input.basis !== "all") {
          const wider = (await runningVersions(tx, channel.id, input.basis, now)).filter((v) => v.basis === "all");
          if (wider.length > 0) {
            throw conflict("A split covering all revenue is running; end it, or propose a new version covering all");
          }
        }
        const [v] = await tx
          .select({ n: sql<number>`coalesce(max(${splits.version}), 0)::int` })
          .from(splits)
          .where(eq(splits.channelId, channel.id));
        const [created] = await tx
          .insert(splits)
          .values({
            id: uuidv7(now.getTime()),
            channelId: channel.id,
            version: (v?.n ?? 0) + 1,
            basis: input.basis,
            startsAt,
            endsAt,
          })
          .returning();
        if (!created) throw new Error("split insert returned nothing");
        await tx
          .insert(shares)
          .values(recipients.map((r) => ({ splitId: created.id, recipientUserId: r.user.id, bps: r.bps })));
        await record(
          tx,
          created,
          "money.split.propose",
          caller.user.id,
          now,
          recipients.map((r) => r.user.id),
        );
        return created;
      }),
    );
    return toDto(deps.db, row, caller.user.id);
  }),

  accept: os.money.splits.accept.handler(async ({ context, input }) => {
    const caller = requireCaller(context);
    const { deps } = context;
    const now = deps.now();
    const row = await guarded(() =>
      deps.db.transaction(async (tx) => {
        const sp = await lockedSplit(tx, input.id);
        const crew = await tx.select().from(shares).where(eq(shares.splitId, sp.id));
        if (!crew.some((s) => s.recipientUserId === caller.user.id)) throw notFound("Split not found");
        if (sp.status !== "proposed") throw conflict(`This split is ${sp.status}, not proposed`);
        const [answered] = await tx
          .select()
          .from(answers)
          .where(and(eq(answers.splitId, sp.id), eq(answers.recipientUserId, caller.user.id)));
        if (answered) throw conflict("You already answered this split");
        const [me] = await tx
          .select({ id: users.id, createdAt: users.createdAt })
          .from(users)
          .where(eq(users.id, caller.user.id));
        const { payoutRules } = await loadMoneySettings(tx);
        if (me) await checkRecipient(tx, me, now, payoutRules.splitRecipientMinAccountAgeDays);
        await tx.insert(answers).values({ splitId: sp.id, recipientUserId: caller.user.id, decision: "accepted" });
        const accepted = await tx
          .select({ id: answers.recipientUserId })
          .from(answers)
          .where(and(eq(answers.splitId, sp.id), eq(answers.decision, "accepted")));
        const all = crew.every((s) => accepted.some((a) => a.id === s.recipientUserId));
        if (!all) {
          await record(tx, sp, "money.split.answer", caller.user.id, now);
          return sp;
        }
        // Supersede what this version replaces, then accept it (future revenue only).
        const bases = superseded(sp.basis);
        const [ch] = await tx.select({ slug: channels.slug }).from(channels).where(eq(channels.id, sp.channelId));
        for (const old of await runningVersions(tx, sp.channelId, sp.basis, now, sp.id)) {
          if (!bases.includes(old.basis)) continue;
          const [ended] = await tx
            .update(splits)
            .set({
              status: "ended",
              endedAt: now,
              endsAt: endAt(now, sp.startsAt),
            })
            .where(eq(splits.id, old.id))
            .returning();
          if (ended) {
            const told = await notifyEnded(tx, ended, ch?.slug ?? "", "superseded");
            await record(tx, ended, "money.split.supersede", caller.user.id, now, told);
          }
        }
        const [done] = await tx
          .update(splits)
          .set({ status: "accepted", acceptedAt: now })
          .where(eq(splits.id, sp.id))
          .returning();
        if (!done) throw notFound("Split not found");
        await record(tx, done, "money.split.accept", caller.user.id, now);
        return done;
      }),
    );
    return toDto(deps.db, row, caller.user.id);
  }),

  reject: os.money.splits.reject.handler(async ({ context, input }) => {
    const caller = requireCaller(context);
    const { deps } = context;
    const now = deps.now();
    const row = await guarded(() =>
      deps.db.transaction(async (tx) => {
        const sp = await lockedSplit(tx, input.id);
        const [mine] = await tx
          .select()
          .from(shares)
          .where(and(eq(shares.splitId, sp.id), eq(shares.recipientUserId, caller.user.id)));
        if (!mine) throw notFound("Split not found");
        if (sp.status !== "proposed") throw conflict(`This split is ${sp.status}, not proposed`);
        const [answered] = await tx
          .select()
          .from(answers)
          .where(and(eq(answers.splitId, sp.id), eq(answers.recipientUserId, caller.user.id)));
        if (answered) throw conflict("You already answered this split");
        await tx.insert(answers).values({ splitId: sp.id, recipientUserId: caller.user.id, decision: "rejected" });
        const [done] = await tx
          .update(splits)
          .set({ status: "rejected", rejectedAt: now })
          .where(eq(splits.id, sp.id))
          .returning();
        if (!done) throw notFound("Split not found");
        await record(tx, done, "money.split.reject", caller.user.id, now);
        return done;
      }),
    );
    return toDto(deps.db, row, caller.user.id);
  }),

  end: os.money.splits.end.handler(async ({ context, input }) => {
    const caller = requireCaller(context);
    const channel = requireOwner(context);
    const { deps } = context;
    const now = deps.now();
    const row = await guarded(() =>
      deps.db.transaction(async (tx) => {
        const sp = await lockedSplit(tx, input.id);
        if (sp.channelId !== channel.id) throw notFound("Split not found");
        if (sp.status !== "accepted" && sp.status !== "proposed") {
          throw conflict(`This split is ${sp.status} and cannot be ended`);
        }
        const [done] = await tx
          .update(splits)
          .set({
            status: "ended",
            endedAt: now,
            endsAt: endAt(now),
          })
          .where(eq(splits.id, sp.id))
          .returning();
        if (!done) throw notFound("Split not found");
        const told = await notifyEnded(tx, sp, channel.slug, "ended");
        await record(tx, done, "money.split.end", caller.user.id, now, told);
        return done;
      }),
    );
    return toDto(deps.db, row, caller.user.id);
  }),
};

// money.treasurer.splits.* -------------------------------------------------------------------------

const secondApprover = () =>
  apiError("FORBIDDEN", "A second treasurer or an admin must decide this write-off", { reason: "second_approver" });

async function userByName(tx: Executor, username: string) {
  const [u] = await tx.select().from(users).where(eq(users.username, username.toLowerCase())).limit(1);
  if (!u) throw notFound("No user with that name");
  return u;
}

/** Deleted, or permanently terminated: a live `dmca_termination`, or a ban with no end. */
async function permanentlyGone(tx: Executor, userId: string): Promise<boolean> {
  const rows = await tx.execute<{ gone: boolean }>(sql`
    select (
      exists (select 1 from users u where u.id = ${userId}
                and (u.deleted_at is not null or (u.banned and u.ban_expires is null)))
      or exists (select 1 from account_actions x where x.user_id = ${userId}
                   and x.action = 'dmca_termination' and x.reversed_at is null)
    ) as gone`);
  return rows[0]?.gone === true;
}

/** When the owner last earned (a credit to `liability:creator:<owner>`), or null if never. */
async function lastOwnerCredit(tx: Executor, ownerId: string, currency: string): Promise<Date | null> {
  const rows = await tx.execute<{ at: string | Date | null }>(sql`
    select max(t.occurred_at) as at
    from ledger_entries e
    join ledger_accounts a on a.id = e.account_id
    join ledger_transactions t on t.id = e.transaction_id
    where a.code = ${storedCode(accounts.creator(ownerId), currency)} and e.amount_cents < 0`);
  const at = rows[0]?.at;
  return at ? new Date(at) : null;
}

async function writeOffDtos(db: Executor, rows: readonly WriteOffRow[]): Promise<WriteOffDto[]> {
  if (rows.length === 0) return [];
  const ids = new Set<string>();
  for (const r of rows) for (const id of [r.ownerUserId, r.proposedById, r.decidedById]) if (id) ids.add(id);
  const people = new Map(
    (
      await db
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(inArray(users.id, [...ids]))
    ).map((u) => [u.id, u]),
  );
  const ref = (id: string) => ({ id, username: people.get(id)?.username ?? "" });
  return rows.map((r) => ({
    id: r.id,
    owner: ref(r.ownerUserId),
    amount: { cents: r.amountCents, currency: r.currency },
    status: r.status,
    proposedBy: ref(r.proposedById),
    proposedAt: r.proposedAt.toISOString(),
    approvedBy: r.decidedById ? ref(r.decidedById) : null,
    approvedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
  }));
}

async function writeOffDto(db: Executor, row: WriteOffRow): Promise<WriteOffDto> {
  const [dto] = await writeOffDtos(db, [row]);
  if (!dto) throw new Error("write-off disappeared");
  return dto;
}

/** Map a write-off trigger refusal: `42501` (a person the rule refuses), `23514` (a malformed change). */
async function guardedWriteOff<T>(fn: () => Promise<T>, onForbidden: () => Error): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const code = pgCode(err);
    if (code === "42501") throw onForbidden();
    if (code === "23514") throw conflict("The database refused this write-off");
    if (code === "23505") throw conflict("An undecided write-off for this owner already exists");
    throw err;
  }
}

/** Post a suspense release or forfeit with its audit row (0043 refuses a suspense debit without it). */
async function suspenseAction(
  ctx: Ctx,
  username: string,
  kind: "release" | "forfeit",
): Promise<{ cents: number; currency: string }> {
  const caller = requireCaller(ctx);
  const { deps } = ctx;
  const currency = deps.env.CURRENCY;
  const now = deps.now();
  return deps.db.transaction(async (tx) => {
    const u = await userByName(tx, username);
    const peek = await splitSuspenseByOwner(tx, u.id, currency);
    // Lock order: every recipient this posting touches, sorted (ADR 0013 decision 4).
    const locked = kind === "release" ? [u.id] : [u.id, ...peek.map((o) => o.ownerUserId)];
    await lockCreators(tx, locked);
    // A lot withheld between the peek and the lock may name an owner whose lock this never took;
    // a forfeit credits only owners it holds, and leaves the rest for the next forfeit. (Nothing
    // can be added once the recipient's own lock is held: every suspense credit takes it.)
    const lockedOwners = new Set(locked.map((id) => id.toLowerCase()));
    const byOwner = (await splitSuspenseByOwner(tx, u.id, currency)).filter(
      (o) => kind === "release" || lockedOwners.has(o.ownerUserId.toLowerCase()),
    );
    const cents = byOwner.reduce((s, o) => s + o.cents, 0);
    if (cents === 0) throw precondition("split_nothing_withheld", "Nothing of this user's is withheld");
    if (kind === "release" && (await recipientWithheld(tx, u.id, now))) {
      throw precondition("split_still_restricted", "This user is still suspended, terminated or under a legal hold");
    }
    if (kind === "forfeit" && !(await permanentlyGone(tx, u.id))) {
      throw precondition(
        "split_not_terminated",
        "Only a deleted or permanently terminated user's shares are forfeited",
      );
    }
    const actionId = uuidv7(now.getTime());
    const input = { actionId, recipientUserId: u.id, byOwner, currency, occurredAt: now };
    const r = await post(tx, kind === "release" ? splitSuspenseRelease(input) : splitSuspenseForfeit(input));
    await audit(tx, {
      actorType: STAFF,
      actorId: caller.user.id,
      action: `money.split.suspense.${kind}`,
      subjectType: "ledger_transaction",
      subjectId: r.transactionId,
      details: { recipientUserId: u.id, amountCents: cents, owners: byOwner.length },
    });
    return { cents, currency };
  });
}

export const treasurerSplitHandlers = {
  writeOffs: os.money.treasurer.splits.writeOffs.handler(async ({ context, input }) => {
    const { db } = context.deps;
    const cur = decodeCursor(input.cursor, isKeyCursor);
    const rows = await db
      .select()
      .from(writeOffs)
      .where(
        and(
          input.status ? eq(writeOffs.status, input.status) : undefined,
          cur
            ? or(
                lt(writeOffs.proposedAt, new Date(cur.t)),
                and(eq(writeOffs.proposedAt, new Date(cur.t)), lt(writeOffs.id, cur.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(writeOffs.proposedAt), desc(writeOffs.id))
      .limit(input.limit + 1);
    const page = pageOf(
      rows,
      input.limit,
      (r) => r,
      (last) => encodeCursor({ t: last.proposedAt.toISOString(), id: last.id }),
    );
    return { items: await writeOffDtos(db, page.items), nextCursor: page.nextCursor };
  }),

  proposeWriteOff: os.money.treasurer.splits.proposeWriteOff.handler(async ({ context, input }) => {
    const caller = requireCaller(context);
    const { deps } = context;
    const currency = deps.env.CURRENCY;
    const now = deps.now();
    const row = await guardedWriteOff(
      () =>
        deps.db.transaction(async (tx) => {
          const u = await userByName(tx, input.username);
          if (u.id === caller.user.id) throw forbidden("Nobody proposes writing off their own shortfall");
          const { payoutRules } = await loadMoneySettings(tx);
          const balance = (await creatorBalances(tx, u.id, currency)).splitShortfallCents;
          if (balance <= 0) throw precondition("split_nothing_to_write_off", "This owner has no split shortfall");
          // ADR 0013 decision 6: only after N days without owner earnings, or the owner is gone for good.
          const last = await lastOwnerCredit(tx, u.id, currency);
          // OPS_TEST_HOOKS (harness only, never public): the quiet window cannot pass in real time, so
          // the seed waives it; the two-person rule and the shortfall itself still hold.
          const quiet =
            deps.env.OPS_TEST_HOOKS ||
            !last ||
            last.getTime() <= now.getTime() - payoutRules.splitShortfallWriteOffDays * DAY_MS;
          if (!quiet && !(await permanentlyGone(tx, u.id))) {
            throw precondition(
              "split_write_off_not_due",
              `A split shortfall is written off only after ${payoutRules.splitShortfallWriteOffDays} days without owner earnings, or once the owner is deleted or terminated`,
            );
          }
          const [created] = await tx
            .insert(writeOffs)
            .values({
              id: uuidv7(now.getTime()),
              ownerUserId: u.id,
              currency,
              amountCents: balance,
              proposedById: caller.user.id,
              proposedAt: now,
            })
            .returning();
          if (!created) throw new Error("write-off insert returned nothing");
          await audit(tx, {
            actorType: STAFF,
            actorId: caller.user.id,
            action: "money.split.writeoff.propose",
            subjectType: "split_writeoff",
            subjectId: created.id,
            details: { ownerUserId: u.id, amountCents: balance, currency },
          });
          return created;
        }),
      () => forbidden("Only a treasurer or an admin other than the owner proposes a write-off"),
    );
    return writeOffDto(deps.db, row);
  }),

  approveWriteOff: os.money.treasurer.splits.approveWriteOff.handler(async ({ context, input }) => {
    const caller = requireCaller(context);
    const { deps } = context;
    const now = deps.now();
    const row = await guardedWriteOff(
      () =>
        deps.db.transaction(async (tx) => {
          const [p] = await tx.select().from(writeOffs).where(eq(writeOffs.id, input.id)).for("update");
          if (!p) throw notFound("Write-off not found");
          if (p.status !== "proposed") throw conflict(`This write-off is ${p.status}, not proposed`);
          if (p.proposedById === caller.user.id || p.ownerUserId === caller.user.id) throw secondApprover();
          let ledgerTransactionId: string | null = null;
          if (input.approve) {
            await lockCreator(tx, p.ownerUserId);
            const balance = (await creatorBalances(tx, p.ownerUserId, p.currency)).splitShortfallCents;
            if (balance < p.amountCents) {
              throw conflict("The owner's split shortfall changed since the proposal; reject it and propose again");
            }
            const r = await post(
              tx,
              splitShortfallWriteOff({
                proposalId: p.id,
                ownerUserId: p.ownerUserId,
                amountCents: p.amountCents,
                currency: p.currency,
                occurredAt: now,
              }),
            );
            ledgerTransactionId = r.transactionId;
          }
          const [done] = await tx
            .update(writeOffs)
            .set({
              status: input.approve ? "approved" : "rejected",
              decidedById: caller.user.id,
              decidedAt: now,
              ledgerTransactionId,
            })
            .where(and(eq(writeOffs.id, p.id), eq(writeOffs.status, "proposed")))
            .returning();
          if (!done) throw conflict("This write-off was decided meanwhile");
          await audit(tx, {
            actorType: STAFF,
            actorId: caller.user.id,
            action: input.approve ? "money.split.writeoff.approve" : "money.split.writeoff.reject",
            subjectType: "split_writeoff",
            subjectId: p.id,
            details: { ownerUserId: p.ownerUserId, amountCents: p.amountCents, ledgerTransactionId },
          });
          return done;
        }),
      secondApprover,
    );
    return writeOffDto(deps.db, row);
  }),

  suspense: os.money.treasurer.splits.suspense.handler(async ({ context }) => {
    requireCaller(context);
    const { deps } = context;
    const currency = deps.env.CURRENCY;
    // Every `liability:split-suspense:<user>` account (`accounts.splitSuspense`) in the currency.
    const prefix = "liability:split-suspense:%";
    const rows = await deps.db.execute<{ code: string; total: string }>(sql`
      select a.code, sum(e.amount_cents)::text as total
      from ledger_accounts a join ledger_entries e on e.account_id = a.id
      where a.code like ${prefix} and a.currency = ${currency}
      group by a.code
      having sum(e.amount_cents) <> 0
      order by a.code`);
    const held = rows.flatMap((r) => {
      const id = /([0-9a-f-]{36})@[a-z]{3}$/.exec(r.code)?.[1];
      // A liability holds a credit (negative entries): the withheld amount is its negation.
      return id ? [{ id, cents: -Number(r.total) }] : [];
    });
    if (held.length === 0) return { items: [] };
    const people = new Map(
      (
        await deps.db
          .select({ id: users.id, username: users.username })
          .from(users)
          .where(
            inArray(
              users.id,
              held.map((h) => h.id),
            ),
          )
      ).map((u) => [u.id, u.username]),
    );
    const now = deps.now();
    const items = [];
    for (const h of held) {
      items.push({
        recipient: { id: h.id, username: people.get(h.id) ?? "" },
        withheld: { cents: h.cents, currency },
        restricted: await recipientWithheld(deps.db, h.id, now),
        forfeitable: await permanentlyGone(deps.db, h.id),
      });
    }
    return { items };
  }),

  releaseSuspense: os.money.treasurer.splits.releaseSuspense.handler(async ({ context, input }) => {
    const r = await suspenseAction(context, input.username, "release");
    return { released: r };
  }),

  forfeitSuspense: os.money.treasurer.splits.forfeitSuspense.handler(async ({ context, input }) => {
    const r = await suspenseAction(context, input.username, "forfeit");
    return { forfeited: r };
  }),
};
