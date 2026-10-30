// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `money.paymentBreakdown(s)` (feature-wins §4.1): where a payment's money went, built from the
 * payment's own ledger postings (`buildBreakdown` in `@commonair/ledger`). Only the payer and the
 * owner of the payee channel may read one; anyone else gets NOT_FOUND, never FORBIDDEN, because
 * payment ids are time-ordered and guessable, so authorization is the guard.
 */
import { type SQL, and, desc, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import type { PaymentBreakdown } from "@commonair/contracts/dto";
import { schema } from "@commonair/db";
import { BreakdownError, type BreakdownTransaction, buildBreakdown, loadMoneySettings } from "@commonair/ledger";
import type { z } from "zod";
import type { Deps } from "../deps.ts";
import { decodeCursor, encodeCursor, pageOf } from "../lib/cursor.ts";
import { notFound } from "../lib/errors.ts";
import { os, requireCaller } from "../lib/orpc.ts";
import { apiMetrics } from "../metrics.ts";
import { isMicroKeyCursor, visiblePayer } from "./reports-lib.ts";

const { payments, tips, users, channels, ledgerTransactions, ledgerEntries, ledgerAccounts } = schema;
const { governanceSettingsHistory: history } = schema;

type Breakdown = z.infer<typeof PaymentBreakdown>;
type Role = Breakdown["viewerRole"];

/** A payment row as the breakdown needs it (one select for the single read and the page). */
const paymentFields = {
  id: payments.id,
  kind: payments.kind,
  userId: payments.userId,
  currency: payments.currency,
  succeededAt: payments.succeededAt,
  /** Microsecond key for the cursor (a JS Date would truncate to milliseconds). */
  tKey: sql<string>`to_char(${payments.succeededAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  anonymous: tips.anonymous,
  payerUsername: users.username,
  payerName: users.name,
  channelSlug: channels.slug,
  channelName: channels.displayName,
  channelOwnerId: channels.ownerId,
};

function paymentQuery(deps: Deps, where: SQL | undefined) {
  return deps.db
    .select(paymentFields)
    .from(payments)
    .innerJoin(channels, eq(channels.id, payments.channelId))
    .leftJoin(users, eq(users.id, payments.userId))
    .leftJoin(tips, eq(tips.id, payments.tipId))
    .where(
      and(
        // Only payments that succeeded have a posting; membership shares are not channel payments.
        isNotNull(payments.succeededAt),
        ne(payments.kind, "membership_share"),
        where,
      ),
    );
}
type PaymentRow = Awaited<ReturnType<typeof paymentQuery>>[number];

/** Every transaction of these payments with its entries, in one query. */
async function transactionsOf(deps: Deps, paymentIds: readonly string[]): Promise<Map<string, BreakdownTransaction[]>> {
  const out = new Map<string, BreakdownTransaction[]>();
  if (paymentIds.length === 0) return out;
  const rows = await deps.db
    .select({
      id: ledgerTransactions.id,
      refId: ledgerTransactions.refId,
      kind: ledgerTransactions.kind,
      occurredAt: ledgerTransactions.occurredAt,
      metadata: ledgerTransactions.metadata,
      code: ledgerAccounts.code,
      amountCents: ledgerEntries.amountCents,
      memo: ledgerEntries.memo,
    })
    .from(ledgerTransactions)
    .innerJoin(ledgerEntries, eq(ledgerEntries.transactionId, ledgerTransactions.id))
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .where(and(eq(ledgerTransactions.refType, "payment"), inArray(ledgerTransactions.refId, [...paymentIds])));
  const byTx = new Map<string, BreakdownTransaction & { entries: BreakdownTransaction["entries"][number][] }>();
  for (const r of rows) {
    if (!r.refId) continue;
    let tx = byTx.get(r.id);
    if (!tx) {
      tx = { id: r.id, kind: r.kind, occurredAt: r.occurredAt, metadata: r.metadata, entries: [] };
      byTx.set(r.id, tx);
      const list = out.get(r.refId) ?? [];
      list.push(tx);
      out.set(r.refId, list);
    }
    tx.entries.push({ code: r.code, amountCents: r.amountCents, memo: r.memo });
  }
  return out;
}

interface CutRow {
  id: string;
  changedAt: Date;
  proposalId: string | null;
}

async function cutRows(deps: Deps, ids: readonly string[]): Promise<Map<string, CutRow>> {
  if (ids.length === 0) return new Map();
  const rows = await deps.db
    .select({ id: history.id, changedAt: history.changedAt, proposalId: history.proposalId })
    .from(history)
    .where(inArray(history.id, [...ids]));
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Build the DTOs for `rows` as `viewer` sees them. A payment whose postings cannot be read as v2
 * is logged and left out (never shown half-built); the nightly reconciliation counts it.
 */
async function breakdowns(
  deps: Deps,
  rows: readonly PaymentRow[],
  roleOf: (r: PaymentRow) => Role,
): Promise<Map<string, Breakdown>> {
  const out = new Map<string, Breakdown>();
  if (rows.length === 0) return out;
  const [txs, settings] = await Promise.all([
    transactionsOf(
      deps,
      rows.map((r) => r.id),
    ),
    loadMoneySettings(deps.db),
  ]);
  const built = new Map<string, ReturnType<typeof buildBreakdown>>();
  for (const r of rows) {
    if (!r.succeededAt) continue;
    try {
      built.set(
        r.id,
        buildBreakdown(
          { id: r.id, kind: r.kind, currency: r.currency, succeededAt: r.succeededAt },
          txs.get(r.id) ?? [],
          settings.payoutRules.holdDays,
        ),
      );
    } catch (err) {
      if (!(err instanceof BreakdownError)) throw err;
      deps.logger.error("payment breakdown unreadable", { paymentId: r.id, error: err.message });
    }
  }
  const cuts = await cutRows(deps, [
    ...new Set([...built.values()].map((b) => b.cut.historyId).filter((id): id is string => id !== null)),
  ]);
  for (const r of rows) {
    const b = built.get(r.id);
    if (!b) continue;
    const role = roleOf(r);
    const user =
      r.userId && r.payerUsername
        ? { id: r.userId, username: r.payerUsername, displayName: r.payerName ?? r.payerUsername }
        : null;
    const cut = b.cut.historyId ? cuts.get(b.cut.historyId) : undefined;
    out.set(r.id, {
      paymentId: b.paymentId,
      kind: b.kind,
      channel: { slug: r.channelSlug, displayName: r.channelName },
      viewerRole: role,
      // The payer always sees themselves; the payee sees an anonymous tipper as nobody (fails closed).
      payer: role === "payer" ? user : visiblePayer({ kind: r.kind, anonymous: r.anonymous, user }),
      gross: b.gross,
      succeededAt: b.succeededAt,
      lines: b.lines,
      holdReleasesAt: b.holdReleasesAt,
      holdReleasedAt: b.holdReleasedAt,
      cutSource: {
        historyId: b.cut.historyId,
        changedAt: cut ? cut.changedAt.toISOString() : null,
        proposalId: cut?.proposalId ?? null,
        streamerShare: b.cut.streamerShare,
        coopShare: b.cut.coopShare,
      },
      timeline: b.timeline,
    });
  }
  return out;
}

export const breakdownHandlers = {
  paymentBreakdown: os.money.paymentBreakdown.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const me = caller.user.id;
    const [row] = await paymentQuery(
      deps,
      and(eq(payments.id, input.paymentId), or(eq(payments.userId, me), eq(channels.ownerId, me))),
    ).limit(1);
    if (!row) throw notFound("Payment not found");
    // The owner cannot pay their own channel, so the two roles never meet on one payment.
    const b = (await breakdowns(deps, [row], (r) => (r.userId === me ? "payer" : "payee"))).get(row.id);
    if (!b) throw notFound("Payment not found");
    apiMetrics.breakdownViews.add(1, { role: b.viewerRole });
    return b;
  }),

  paymentBreakdowns: os.money.paymentBreakdowns.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const me = caller.user.id;
    const cur = decodeCursor(input.cursor, isMicroKeyCursor);
    const rows = await paymentQuery(
      deps,
      and(
        input.role === "payer" ? eq(payments.userId, me) : eq(channels.ownerId, me),
        cur ? sql`(${payments.succeededAt}, ${payments.id}) < (${cur.t}::timestamptz, ${cur.id}::uuid)` : undefined,
      ),
    )
      .orderBy(desc(payments.succeededAt), desc(payments.id))
      .limit(input.limit + 1);
    // Build only the page (the extra row decides whether there is a next page).
    const page = rows.slice(0, input.limit);
    const built = await breakdowns(deps, page, () => input.role);
    const result = pageOf(
      rows,
      input.limit,
      (r) => built.get(r.id) ?? null,
      (last) => encodeCursor({ t: last.tKey, id: last.id }),
    );
    const items = result.items.filter((b): b is Breakdown => b !== null);
    return { items, nextCursor: result.nextCursor };
  }),
};
