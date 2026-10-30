// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `money.treasurer.fraudFlags.*` (ADR 0036): the payment fraud floor's review flow. A treasurer
 * raises or reviews a flag; a different treasurer or an admin decides it (four eyes); only an
 * admin releases a confirmed one. Every change runs in one transaction with its audit row and its
 * internal `money.fraud.flag` event. The database (`payment_fraud_flags_guard`,
 * `payouts_fraud_guard`, migration 0038) enforces the rules; the checks here only give clear
 * errors first, and a refusal that still reaches a trigger is mapped to the contract's codes.
 */
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { z } from "zod";
import type { PaymentFraudFlag } from "@commonair/contracts/dto";
import { type Executor, schema } from "@commonair/db";
import {
  FRAUD_REVIEW_HOLD,
  type FraudAction,
  raiseFraudFlag,
  recordFraudFlag,
  releaseFraudHolds,
} from "@commonair/ledger";
import { decodeCursor, encodeCursor, isKeyCursor, pageOf } from "../lib/cursor.ts";
import { apiError, badRequest, conflict, forbidden, notFound, pgCode } from "../lib/errors.ts";
import { os, requireCaller } from "../lib/orpc.ts";

const { paymentFraudFlags: flags, payouts, users } = schema;
type FlagRow = typeof flags.$inferSelect;
type FlagDto = z.infer<typeof PaymentFraudFlag>;

/** The treasurer is platform staff; audit rows name them by id (as the other treasurer actions do). */
const ACTOR = "admin" as const;

const secondApprover = () =>
  apiError("FORBIDDEN", "A second treasurer or an admin must decide this flag", { reason: "second_approver" });

/** Flags as the contract shows them, with the people they name and the payee's held payouts. */
async function toDtos(db: Executor, rows: readonly FlagRow[]): Promise<FlagDto[]> {
  if (rows.length === 0) return [];
  const ids = new Set<string>();
  for (const r of rows)
    for (const id of [r.payeeUserId, r.raisedById, r.reviewedById, r.decidedById, r.releasedById]) if (id) ids.add(id);
  const people = new Map(
    (
      await db
        .select({ id: users.id, username: users.username, name: users.name })
        .from(users)
        .where(inArray(users.id, [...ids]))
    ).map((u) => [u.id, u]),
  );
  const payees = [...new Set(rows.map((r) => r.payeeUserId))];
  const held = new Map(
    (
      await db
        .select({ userId: payouts.userId, n: sql<number>`count(*)::int` })
        .from(payouts)
        .where(
          and(inArray(payouts.userId, payees), eq(payouts.status, "held"), eq(payouts.holdReason, FRAUD_REVIEW_HOLD)),
        )
        .groupBy(payouts.userId)
    ).map((r) => [r.userId, r.n]),
  );
  const ref = (id: string | null) => {
    const u = id ? people.get(id) : undefined;
    return u ? { id: u.id, username: u.username } : null;
  };
  return rows.map((r) => {
    const payee = people.get(r.payeeUserId);
    return {
      id: r.id,
      payee: {
        id: r.payeeUserId,
        username: payee?.username ?? "",
        displayName: payee?.name ?? "",
      },
      kind: r.kind,
      status: r.status,
      evidence: r.evidence,
      raisedAt: r.raisedAt.toISOString(),
      raisedBy: ref(r.raisedById),
      reviewedBy: ref(r.reviewedById),
      recommendation: r.recommendation,
      reviewedAt: r.reviewedAt?.toISOString() ?? null,
      decidedBy: ref(r.decidedById),
      decidedAt: r.decidedAt?.toISOString() ?? null,
      releasedBy: ref(r.releasedById),
      releasedAt: r.releasedAt?.toISOString() ?? null,
      note: r.note,
      heldPayouts: held.get(r.payeeUserId) ?? 0,
    };
  });
}

async function toDto(db: Executor, row: FlagRow): Promise<FlagDto> {
  const [dto] = await toDtos(db, [row]);
  if (!dto) throw new Error("flag disappeared");
  return dto;
}

async function lockedFlag(tx: Executor, id: string): Promise<FlagRow> {
  const [row] = await tx.select().from(flags).where(eq(flags.id, id)).for("update");
  if (!row) throw notFound("Fraud flag not found");
  return row;
}

/**
 * Run a flag change, mapping what still reaches the trigger: `42501` (a person the rule refuses)
 * to `onForbidden`, `23514` (a malformed change) to BAD_REQUEST. The trigger's text never leaves.
 */
async function guarded<T>(fn: () => Promise<T>, onForbidden: () => Error): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const code = pgCode(err);
    if (code === "42501") throw onForbidden();
    if (code === "23514") throw badRequest("The database refused this change to the flag");
    throw err;
  }
}

async function record(tx: Executor, flag: FlagRow, action: FraudAction, actorId: string, at: Date) {
  await recordFraudFlag(tx, { flag, action, actorType: ACTOR, actorId, at });
}

export const treasurerFraudHandlers = {
  list: os.money.treasurer.fraudFlags.list.handler(async ({ context, input }) => {
    const { db } = context.deps;
    const cur = decodeCursor(input.cursor, isKeyCursor);
    const rows = await db
      .select()
      .from(flags)
      .where(
        and(
          input.status ? eq(flags.status, input.status) : undefined,
          cur
            ? or(lt(flags.raisedAt, new Date(cur.t)), and(eq(flags.raisedAt, new Date(cur.t)), lt(flags.id, cur.id)))
            : undefined,
        ),
      )
      .orderBy(desc(flags.raisedAt), desc(flags.id))
      .limit(input.limit + 1);
    const page = pageOf(
      rows,
      input.limit,
      (r) => r,
      (r) => encodeCursor({ t: r.raisedAt.toISOString(), id: r.id }),
    );
    return { items: await toDtos(db, page.items), nextCursor: page.nextCursor };
  }),

  raise: os.money.treasurer.fraudFlags.raise.handler(async ({ context, input }) => {
    const caller = requireCaller(context);
    const { deps } = context;
    const at = deps.now();
    const row = await deps.db.transaction(async (tx) => {
      const [payee] = await tx.select({ id: users.id }).from(users).where(eq(users.username, input.username));
      if (!payee) throw notFound("No user with that name");
      const r = await raiseFraudFlag(tx, {
        payeeUserId: payee.id,
        kind: "manual",
        evidence: {},
        raisedById: caller.user.id,
        note: input.note.trim(),
        actorType: ACTOR,
        at,
      });
      if (!r) throw conflict("An undecided manual flag already holds this payee's payouts");
      return r.flag;
    });
    return toDto(deps.db, row);
  }),

  review: os.money.treasurer.fraudFlags.review.handler(async ({ context, input }) => {
    const caller = requireCaller(context);
    const { deps } = context;
    const at = deps.now();
    const row = await guarded(
      () =>
        deps.db.transaction(async (tx) => {
          const flag = await lockedFlag(tx, input.id);
          if (flag.status !== "open") throw conflict(`This flag is ${flag.status}, not open`);
          if (flag.payeeUserId === caller.user.id) throw forbidden("Nobody reviews a flag on their own payouts");
          const note = input.note.trim();
          const [updated] = await tx
            .update(flags)
            .set({
              status: "reviewed",
              reviewedById: caller.user.id,
              recommendation: input.recommendation,
              reviewedAt: at,
              ...(note ? { note } : {}),
            })
            .where(eq(flags.id, flag.id))
            .returning();
          if (!updated) throw notFound("Fraud flag not found");
          await record(tx, updated, "money.fraud.review", caller.user.id, at);
          return updated;
        }),
      () => forbidden("Only a treasurer or an admin other than the payee reviews a flag"),
    );
    return toDto(deps.db, row);
  }),

  decide: os.money.treasurer.fraudFlags.decide.handler(async ({ context, input }) => {
    const caller = requireCaller(context);
    const { deps } = context;
    const at = deps.now();
    const row = await guarded(
      () =>
        deps.db.transaction(async (tx) => {
          const flag = await lockedFlag(tx, input.id);
          if (flag.status !== "reviewed") throw conflict(`This flag is ${flag.status}, not reviewed`);
          const me = caller.user.id;
          if (me === flag.reviewedById || me === flag.raisedById || me === flag.payeeUserId) throw secondApprover();
          const note = input.note.trim();
          const [updated] = await tx
            .update(flags)
            .set({
              status: input.decision === "clear" ? "cleared" : "confirmed",
              decidedById: me,
              decision: input.decision,
              decidedAt: at,
              ...(note ? { note } : {}),
            })
            .where(eq(flags.id, flag.id))
            .returning();
          if (!updated) throw notFound("Fraud flag not found");
          // After the flag update: the payout trigger reads the flag's new status.
          if (updated.status === "cleared") await releaseFraudHolds(tx, updated.payeeUserId);
          await record(tx, updated, "money.fraud.decide", me, at);
          return updated;
        }),
      secondApprover,
    );
    return toDto(deps.db, row);
  }),

  release: os.money.treasurer.fraudFlags.release.handler(async ({ context, input }) => {
    const caller = requireCaller(context);
    const { deps } = context;
    const at = deps.now();
    const row = await guarded(
      () =>
        deps.db.transaction(async (tx) => {
          const flag = await lockedFlag(tx, input.id);
          if (flag.status !== "confirmed" || flag.releasedAt !== null)
            throw conflict("Only a confirmed flag that was not released yet can be released");
          if (flag.payeeUserId === caller.user.id) throw forbidden("Nobody releases a flag on their own payouts");
          const [updated] = await tx
            .update(flags)
            .set({ releasedById: caller.user.id, releasedAt: at })
            .where(eq(flags.id, flag.id))
            .returning();
          if (!updated) throw notFound("Fraud flag not found");
          await releaseFraudHolds(tx, updated.payeeUserId);
          await record(tx, updated, "money.fraud.release", caller.user.id, at);
          return updated;
        }),
      () => forbidden("Only an admin other than the payee releases a confirmed flag"),
    );
    return toDto(deps.db, row);
  }),
};
