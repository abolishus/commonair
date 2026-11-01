// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Revenue splits (ADR 0013, W2-splits). A split version names crew recipients and their basis
 * points of one revenue basis; the owner keeps the rest. Migration 0043 makes a version immutable
 * once a payment links to it, freezes shares once the version leaves `proposed`, caps the bps of
 * overlapping accepted versions per basis at 10,000, and checks every link against the payment's
 * `splitVersionId`. Ids only: no names, emails or payout details (ADR 0004).
 */
import { sql } from "drizzle-orm";
import { bigint, check, index, integer, pgTable, primaryKey, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.ts";
import { channels } from "./channels.ts";
import { ledgerTransactions } from "./ledger.ts";
import { createdAt, id, splitAcceptanceDecision, splitBasis, splitStatus, splitWriteoffStatus, ts } from "./_shared.ts";

export const revenueSplits = pgTable(
  "revenue_splits",
  {
    /** The split version id (`PaymentMetaV2.splitVersionId`). */
    id: id(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "restrict" }),
    /** 1, 2, … per channel; a change is a new version. */
    version: integer().notNull(),
    status: splitStatus().notNull().default("proposed"),
    basis: splitBasis().notNull(),
    /** Applies to payments succeeding in [starts_at, ends_at). */
    startsAt: ts().notNull().defaultNow(),
    /** Null until ended (or a fixed window); set on `end`, never in the past. */
    endsAt: ts(),
    createdAt: createdAt(),
    acceptedAt: ts(),
    rejectedAt: ts(),
    endedAt: ts(),
  },
  (t) => [
    uniqueIndex("revenue_splits_version_uq").on(t.channelId, t.version),
    // Posting resolves the version active at `succeededAt` for the payment's kind.
    index("revenue_splits_active_idx")
      .on(t.channelId, t.startsAt)
      .where(sql`${t.status} in ('accepted', 'ended')`),
    check("revenue_splits_version_positive", sql`${t.version} > 0`),
    check("revenue_splits_window", sql`${t.endsAt} is null or ${t.endsAt} >= ${t.startsAt}`),
  ],
);

export const revenueSplitShares = pgTable(
  "revenue_split_shares",
  {
    splitId: uuid()
      .notNull()
      .references(() => revenueSplits.id, { onDelete: "restrict" }),
    recipientUserId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    bps: integer().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.splitId, t.recipientUserId] }),
    index("revenue_split_shares_recipient_idx").on(t.recipientUserId),
    check("revenue_split_shares_bps", sql`${t.bps} between 1 and 9999`),
  ],
);

/** A recipient's answer to a proposed version; one per (version, recipient), never changed. */
export const revenueSplitAcceptances = pgTable(
  "revenue_split_acceptances",
  {
    splitId: uuid()
      .notNull()
      .references(() => revenueSplits.id, { onDelete: "restrict" }),
    recipientUserId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    decision: splitAcceptanceDecision().notNull(),
    decidedAt: ts().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.splitId, t.recipientUserId] })],
);

/**
 * The real foreign key behind `PaymentMetaV2.splitVersionId` (ADR 0013 decision 8), written in
 * the payment's posting transaction. Append-only.
 */
export const revenueSplitPostings = pgTable(
  "revenue_split_postings",
  {
    ledgerTransactionId: uuid()
      .primaryKey()
      .references(() => ledgerTransactions.id, { onDelete: "restrict" }),
    splitId: uuid()
      .notNull()
      .references(() => revenueSplits.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (t) => [index("revenue_split_postings_split_idx").on(t.splitId)],
);

/**
 * A proposal to write off an owner's split-shortfall suspense balance (ADR 0013 decision 6). The
 * 0043 trigger requires a treasurer or admin to propose, a different treasurer or admin to decide,
 * and an approval to name its `split_shortfall_writeoff` posting.
 */
export const splitWriteoffProposals = pgTable(
  "split_writeoff_proposals",
  {
    id: id(),
    ownerUserId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    currency: text().notNull(),
    amountCents: bigint({ mode: "number" }).notNull(),
    status: splitWriteoffStatus().notNull().default("proposed"),
    proposedById: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    proposedAt: ts().notNull().defaultNow(),
    decidedById: uuid().references(() => users.id, { onDelete: "restrict" }),
    decidedAt: ts(),
    /** The `split_shortfall_writeoff` posting, set exactly on approval. */
    ledgerTransactionId: uuid().references(() => ledgerTransactions.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("split_writeoff_proposals_owner_idx").on(t.ownerUserId, t.createdAt),
    uniqueIndex("split_writeoff_proposals_open_uq")
      .on(t.ownerUserId, t.currency)
      .where(sql`${t.status} = 'proposed'`),
    uniqueIndex("split_writeoff_proposals_tx_uq").on(t.ledgerTransactionId),
    check("split_writeoff_proposals_amount", sql`${t.amountCents} > 0`),
    check("split_writeoff_proposals_currency", sql`${t.currency} ~ '^[a-z]{3}$'`),
  ],
);
