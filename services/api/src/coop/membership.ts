// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Memberships and member shares (docs/testing/e5-selectors.md "Membership flows", ADR 0020). A
 * share is bought through the manual adapter, confirmed by a treasurer (`confirmShareTx`, called
 * from `treasurer.confirm`), returned to `refund_pending` on exit and refunded by a treasurer.
 * Every state change posts to the ledger (when money moves), writes its audit row and outbox
 * event in one transaction; the share trigger (0021) refuses any transition without its payment
 * and posting. Lock order: payment → share → membership.
 */
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { type Executor, schema, uuidv7 } from "@commonair/db";
import {
  contributionWeightsOf,
  eligibleHoursByUser,
  loadSettings,
  membershipClassesOf,
  subscriptionQualifies,
} from "@commonair/governance";
import { loadMoneySettings, post, shareRefund, sharePurchase } from "@commonair/ledger";
import { createAdapter, manualInstructions } from "@commonair/payments";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { emit } from "../events/outbox.ts";
import { decodeCursor, encodeCursor, isKeyCursor, pageOf } from "../lib/cursor.ts";
import { iso, isoOrNull } from "../lib/dto.ts";
import { badRequest, conflict, notFound, precondition } from "../lib/errors.ts";
import { os, requireCaller } from "../lib/orpc.ts";
import { withCoopErrors, withCoopErrorsRetrying } from "./errors.ts";
import { MEMBER, STAFF, money, unknownUser, userPicks } from "./shared.ts";
import { eligibility, type MembershipViewDto } from "./views.ts";

const { memberships, membershipShares, payments, users } = schema;
type PaymentRow = typeof payments.$inferSelect;
type ShareRow = typeof membershipShares.$inferSelect;
type MembershipRow = typeof memberships.$inferSelect;

const DAY_MS = 86_400_000;
const OPEN_SHARE = ["pending", "held", "refund_pending"] as const;

async function shareEvent(tx: Executor, s: Pick<ShareRow, "id" | "userId" | "status" | "amountCents">, now: Date) {
  await emit(
    tx,
    "coop.share.update",
    null,
    { share_id: s.id, user_id: s.userId, status: s.status, amount_cents: s.amountCents },
    now,
  );
}

async function membershipEvent(
  tx: Executor,
  m: Pick<MembershipRow, "id" | "userId" | "class" | "status" | "basis">,
  now: Date,
) {
  await emit(
    tx,
    "coop.membership.update",
    null,
    { membership_id: m.id, user_id: m.userId, class: m.class, status: m.status, basis: m.basis },
    now,
  );
}

/** Insert an active membership unless one exists in that class (a concurrent sync may win). */
async function activate(
  tx: Executor,
  userId: string,
  cls: MembershipRow["class"],
  basis: MembershipRow["basis"],
  now: Date,
): Promise<MembershipRow | null> {
  const [row] = await tx
    .insert(memberships)
    .values({ id: uuidv7(), userId, class: cls, basis, joinedAt: now, lastEligibilityCheckAt: now })
    .onConflictDoNothing({ target: [memberships.userId, memberships.class], where: sql`status = 'active'` })
    .returning();
  return row ?? null;
}

async function membershipView(deps: Deps, userId: string): Promise<MembershipViewDto> {
  const db = deps.db;
  const now = deps.now();
  const settings = await loadSettings(db);
  const rules = membershipClassesOf(settings);
  const cap = contributionWeightsOf(settings).dailyStreamingHourCap;
  const [rows, shares, hours, subs] = await Promise.all([
    db.select().from(memberships).where(eq(memberships.userId, userId)).orderBy(desc(memberships.createdAt)),
    db
      .select()
      .from(membershipShares)
      .where(eq(membershipShares.userId, userId))
      .orderBy(desc(membershipShares.createdAt))
      .limit(1),
    eligibleHoursByUser(db, new Date(now.getTime() - rules.streamer.windowDays * DAY_MS), now, cap),
    db
      .select({ s: schema.subscriptions, ownerId: schema.channels.ownerId })
      .from(schema.subscriptions)
      .innerJoin(schema.channels, eq(schema.channels.id, schema.subscriptions.channelId))
      .where(and(eq(schema.subscriptions.subscriberId, userId), eq(schema.subscriptions.status, "active"))),
  ]);
  // Current memberships first (every active one, then the latest ended one per class).
  const shown = new Map<string, MembershipRow>();
  for (const m of rows.toSorted((a, b) => Number(b.status === "active") - Number(a.status === "active")))
    if (!shown.has(m.class)) shown.set(m.class, m);
  const share = shares[0] ?? null;
  // A pending share shows its payment reference again, so a member who left the page can still pay.
  const [payment] =
    share?.status === "pending" && share.paymentId
      ? await db
          .select({ providerRef: schema.payments.providerRef, provider: schema.payments.provider })
          .from(schema.payments)
          .where(eq(schema.payments.id, share.paymentId))
      : [];
  const pending =
    share && payment?.provider === "manual"
      ? {
          paymentId: share.paymentId,
          reference: payment.providerRef,
          instructions: manualInstructions(
            deps.env.MANUAL_PAYMENT_INSTRUCTIONS,
            payment.providerRef,
            share.amountCents,
            share.currency,
          ),
        }
      : { paymentId: null, reference: null, instructions: null };
  return {
    memberships: [...shown.values()].map((m) => ({
      id: m.id,
      class: m.class,
      status: m.status,
      basis: m.basis,
      joinedAt: iso(m.joinedAt),
    })),
    eligibility: eligibility({
      rules,
      streamingHours: hours.get(userId) ?? 0,
      heldShareCents: share?.status === "held" ? share.amountCents : null,
      qualifyingSubscription: subs.some((r) =>
        subscriptionQualifies(
          {
            status: r.s.status,
            priceCents: r.s.priceCents,
            provider: r.s.provider,
            currentPeriodEnd: r.s.currentPeriodEnd,
            giftedById: r.s.giftedById,
            ownChannel: r.ownerId === userId,
          },
          now,
          rules,
        ),
      ),
      activeWorker: rows.some((m) => m.class === "worker" && m.status === "active"),
    }),
    share: share
      ? { id: share.id, status: share.status, amount: money(share.amountCents, share.currency), ...pending }
      : null,
  };
}

/**
 * Confirm a locked, pending `membership_share` payment in the caller's transaction: payment
 * `succeeded`, the `sharePurchase` posting, the share `held` (purchased when the money arrived),
 * and a viewer membership with basis `share` unless one is active, with audits and events. The
 * caller writes the `payment.confirm` audit row.
 */
export async function confirmShareTx(
  tx: Executor,
  p: PaymentRow,
  o: { receivedAt: Date; now: Date; actorId: string },
): Promise<void> {
  const { receivedAt, now } = o;
  const [share] = await tx.select().from(membershipShares).where(eq(membershipShares.paymentId, p.id)).for("update");
  if (!share) throw conflict("This payment has no member share");
  if (share.status !== "pending") throw conflict(`This share is ${share.status}, not pending`);
  const [paid] = await tx
    .update(payments)
    .set({ status: "succeeded", succeededAt: receivedAt, updatedAt: now })
    .where(and(eq(payments.id, p.id), eq(payments.status, "pending")))
    .returning({ id: payments.id });
  if (!paid) throw conflict("This payment is no longer pending");
  await post(
    tx,
    sharePurchase({
      shareId: share.id,
      userId: share.userId,
      provider: p.provider,
      settlement: "cash",
      amountCents: share.amountCents,
      currency: share.currency,
      occurredAt: receivedAt,
    }),
  );
  const [held] = await tx
    .update(membershipShares)
    .set({ status: "held", purchasedAt: receivedAt })
    .where(and(eq(membershipShares.id, share.id), eq(membershipShares.status, "pending")))
    .returning();
  if (!held) throw conflict("This share changed; reload and try again");
  await shareEvent(tx, held, now);
  const m = await activate(tx, share.userId, "viewer", "share", now);
  if (m) {
    await audit(tx, {
      actorType: STAFF,
      actorId: o.actorId,
      action: "membership.activate",
      subjectType: "membership",
      subjectId: m.id,
      details: { class: "viewer", basis: "share", userId: share.userId, shareId: share.id },
    });
    await membershipEvent(tx, m, now);
  }
}

export const membershipHandlers = {
  membership: os.coop.membership.handler(async ({ context }) => {
    const caller = requireCaller(context);
    return membershipView(context.deps, caller.user.id);
  }),

  buyShare: os.coop.buyShare.handler(async ({ context }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    if (deps.env.PAYMENTS_PROVIDER !== "manual")
      throw precondition("manual_shares", "Member shares are paid by bank transfer on this instance");
    const settings = await loadSettings(deps.db);
    const shareCents = membershipClassesOf(settings).viewer.shareCents;
    if (shareCents <= 0) throw precondition("share_price", "This co-op has no member share to buy");
    const { payoutRules } = await loadMoneySettings(deps.db);
    const currency = payoutRules.currency;
    const adapter = createAdapter(deps.env);
    // A manual reference collision (`payments_provider_ref_uq`) mints a new one.
    return withCoopErrorsRetrying("payments_provider_ref_uq", () =>
      deps.db.transaction(async (tx) => {
        const now = deps.now();
        // Serializes this user's share purchases with the share trigger's own lock.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`commonair:share:${caller.user.id}`}))`);
        const [open] = await tx
          .select({ id: membershipShares.id })
          .from(membershipShares)
          .where(and(eq(membershipShares.userId, caller.user.id), inArray(membershipShares.status, [...OPEN_SHARE])))
          .limit(1);
        if (open) throw conflict("You already have a member share");
        const [viewer] = await tx
          .select({ id: memberships.id })
          .from(memberships)
          .where(
            and(
              eq(memberships.userId, caller.user.id),
              eq(memberships.class, "viewer"),
              eq(memberships.status, "active"),
              eq(memberships.basis, "share"),
            ),
          );
        if (viewer) throw conflict("You are already a viewer member");
        const paymentId = uuidv7();
        const shareId = uuidv7();
        const base = deps.env.PUBLIC_URL.replace(/\/+$/, "");
        const start = await adapter.startCheckout({
          paymentId,
          kind: "membership_share",
          amountCents: shareCents,
          currency,
          quantity: 1,
          recurring: false,
          payerUserId: caller.user.id,
          creatorUserId: null,
          successUrl: `${base}/coop/membership`,
          cancelUrl: `${base}/coop/membership`,
        });
        await tx.insert(payments).values({
          id: paymentId,
          provider: adapter.provider,
          providerRef: start.providerRef,
          kind: "membership_share",
          status: "pending",
          userId: caller.user.id,
          channelId: null,
          amountCents: shareCents,
          currency,
          quantity: 1,
          expiresAt: new Date(now.getTime() + deps.env.PAYMENT_PENDING_DAYS * DAY_MS),
        });
        const [share] = await tx
          .insert(membershipShares)
          .values({ id: shareId, userId: caller.user.id, amountCents: shareCents, currency, paymentId })
          .returning();
        if (!share) throw new Error("share insert returned nothing");
        await audit(tx, {
          actorType: MEMBER,
          actorId: caller.user.id,
          action: "coop.share.request",
          subjectType: "membership_share",
          subjectId: shareId,
          details: { shareId, paymentId, amountCents: shareCents, currency },
        });
        await shareEvent(tx, share, now);
        return {
          kind: "instructions" as const,
          paymentId,
          reference: start.providerRef,
          instructions:
            start.kind === "instructions"
              ? start.instructions
              : manualInstructions(deps.env.MANUAL_PAYMENT_INSTRUCTIONS, start.providerRef, shareCents, currency),
          amount: money(shareCents, currency),
        };
      }),
    );
  }),

  exit: os.coop.exit.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const userId = caller.user.id;
    await withCoopErrors(() =>
      deps.db.transaction(async (tx) => {
        const now = deps.now();
        const rules = membershipClassesOf(await loadSettings(tx));
        // Lock order: share before membership.
        const [share] =
          input.class === "viewer"
            ? await tx
                .select()
                .from(membershipShares)
                .where(and(eq(membershipShares.userId, userId), eq(membershipShares.status, "held")))
                .for("update")
            : [];
        const [m] = await tx
          .select()
          .from(memberships)
          .where(
            and(eq(memberships.userId, userId), eq(memberships.class, input.class), eq(memberships.status, "active")),
          )
          .for("update");
        if (!m) throw notFound("You are not an active member of that class");
        const [exited] = await tx
          .update(memberships)
          .set({ status: "exited", exitedAt: now })
          .where(and(eq(memberships.id, m.id), eq(memberships.status, "active")))
          .returning();
        if (!exited) throw conflict("Your membership changed; reload and try again");
        await audit(tx, {
          actorType: MEMBER,
          actorId: userId,
          action: "membership.exit",
          subjectType: "membership",
          subjectId: m.id,
          details: { class: m.class, basis: m.basis },
        });
        await membershipEvent(tx, exited, now);
        if (share && rules.viewer.shareRefundableOnExit) {
          const [pending] = await tx
            .update(membershipShares)
            .set({ status: "refund_pending" })
            .where(and(eq(membershipShares.id, share.id), eq(membershipShares.status, "held")))
            .returning();
          if (!pending) throw conflict("Your share changed; reload and try again");
          await audit(tx, {
            actorType: MEMBER,
            actorId: userId,
            action: "coop.share.refund_request",
            subjectType: "membership_share",
            subjectId: share.id,
            details: { shareId: share.id, amountCents: share.amountCents },
          });
          await shareEvent(tx, pending, now);
        }
      }),
    );
    return membershipView(deps, userId);
  }),

  appointWorker: os.coop.appointWorker.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const minute = input.boardMinuteRef.trim();
    if (!minute) throw badRequest("The board minute reference is required");
    await withCoopErrors(() =>
      deps.db.transaction(async (tx) => {
        const now = deps.now();
        const [u] = await tx
          .select({ id: users.id, banned: users.banned, deletedAt: users.deletedAt })
          .from(users)
          .where(eq(users.username, input.username.toLowerCase()));
        if (!u || u.deletedAt) throw notFound("No user with that name");
        if (u.banned) throw precondition("account_active", "A suspended account cannot be appointed");
        const m = await activate(tx, u.id, "worker", "board_appointment", now);
        if (!m) throw conflict("That user is already a worker member");
        await audit(tx, {
          actorType: STAFF,
          actorId: caller.user.id,
          action: "membership.appoint",
          subjectType: "membership",
          subjectId: m.id,
          reason: minute,
          details: { class: "worker", basis: "board_appointment", userId: u.id },
        });
        await membershipEvent(tx, m, now);
      }),
    );
    return { ok: true as const };
  }),

  shares: {
    list: os.coop.shares.list.handler(async ({ context, input }) => {
      const { deps } = context;
      const cur = decodeCursor(input.cursor, isKeyCursor);
      const rows = await deps.db
        .select()
        .from(membershipShares)
        .where(
          and(
            input.status ? eq(membershipShares.status, input.status) : undefined,
            cur ? lt(membershipShares.id, cur.id) : undefined,
          ),
        )
        .orderBy(desc(membershipShares.id))
        .limit(input.limit + 1);
      const people = await userPicks(
        deps.db,
        rows.map((r) => r.userId),
      );
      return pageOf(
        rows,
        input.limit,
        (r) => shareView(r, people),
        (last) => encodeCursor({ t: iso(last.createdAt), id: last.id }),
      );
    }),

    refund: os.coop.shares.refund.handler(async ({ context, input }) => {
      const { deps } = context;
      const caller = requireCaller(context);
      const sentAt = new Date(input.sentAt);
      const now = deps.now();
      if (sentAt.getTime() > now.getTime()) throw badRequest("The refund cannot be sent in the future");
      const note = (input.note ?? "").trim();
      const row = await withCoopErrors(() =>
        deps.db.transaction(async (tx) => {
          const [share] = await tx
            .select()
            .from(membershipShares)
            .where(eq(membershipShares.id, input.shareId))
            .for("update");
          if (!share) throw notFound("Share not found");
          if (share.status !== "refund_pending")
            throw conflict(`This share is ${share.status}, not waiting for a refund`);
          if (share.purchasedAt && sentAt.getTime() < share.purchasedAt.getTime())
            throw badRequest("The refund cannot be sent before the share was bought");
          const [p] = share.paymentId
            ? await tx.select({ provider: payments.provider }).from(payments).where(eq(payments.id, share.paymentId))
            : [];
          await post(
            tx,
            shareRefund({
              shareId: share.id,
              userId: share.userId,
              provider: p?.provider ?? "manual",
              settlement: "cash",
              amountCents: share.amountCents,
              currency: share.currency,
              occurredAt: sentAt,
            }),
          );
          const [refunded] = await tx
            .update(membershipShares)
            .set({ status: "refunded", refundedAt: sentAt })
            .where(and(eq(membershipShares.id, share.id), eq(membershipShares.status, "refund_pending")))
            .returning();
          if (!refunded) throw conflict("This share changed; reload and try again");
          await audit(tx, {
            actorType: STAFF,
            actorId: caller.user.id,
            action: "coop.share.refund",
            subjectType: "membership_share",
            subjectId: share.id,
            reason: note,
            details: { shareId: share.id, userId: share.userId, amountCents: share.amountCents, sentAt: iso(sentAt) },
          });
          await shareEvent(tx, refunded, now);
          return refunded;
        }),
      );
      return shareView(row, await userPicks(deps.db, [row.userId]));
    }),
  },
};

function shareView(r: ShareRow, people: Map<string, { id: string; username: string; displayName: string }>) {
  return {
    id: r.id,
    user: people.get(r.userId) ?? unknownUser(r.userId),
    status: r.status,
    amount: money(r.amountCents, r.currency),
    paymentId: r.paymentId,
    purchasedAt: isoOrNull(r.purchasedAt),
    refundedAt: isoOrNull(r.refundedAt),
    createdAt: iso(r.createdAt),
  };
}
