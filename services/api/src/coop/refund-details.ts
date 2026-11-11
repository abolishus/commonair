// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Share refunds arranged before an account is deleted (overhaul wave 5, ADR 0042 decisions 5 and
 * 6). `coop.shares.askRefundDetails` has the platform email the member (`shareRefundDetails`) to
 * write to the instance's contact with where to send their share back: the treasurer never sees
 * the address, and the request is audited by share id. Allowed for a share waiting for its refund
 * (`refund_pending`) or held by a member whose deletion is scheduled; at most once a day per share.
 *
 * The mail is sent inside the transaction that records the request, so a send that fails leaves
 * nothing recorded (the treasurer can ask again at once). No outbox row: nothing else consumes it.
 */
import { and, desc, eq } from "drizzle-orm";
import { type Executor, schema } from "@commonair/db";
import { loadSettings, membershipClassesOf } from "@commonair/governance";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { conflict, notFound, precondition } from "../lib/errors.ts";
import { STAFF } from "./shared.ts";

const { accountDeletions, membershipShares, payments, users } = schema;
type ShareRow = typeof membershipShares.$inferSelect;

/** How often one share's member may be asked (`coop.shares.askRefundDetails`). */
export const REFUND_DETAILS_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** What the member quotes: the manual payment's bank-transfer reference, else the share id. */
export function shareReference(
  share: { id: string },
  payment: { provider: string; providerRef: string | null } | undefined,
): string {
  return payment?.provider === "manual" && payment.providerRef ? payment.providerRef : share.id;
}

async function referenceOf(db: Executor, share: Pick<ShareRow, "id" | "paymentId">): Promise<string> {
  const [p] = share.paymentId
    ? await db
        .select({ provider: payments.provider, providerRef: payments.providerRef })
        .from(payments)
        .where(eq(payments.id, share.paymentId))
    : [];
  return shareReference(share, p);
}

/**
 * The member's held share that comes back on exit (the bylaws decide, ADR 0020), for the
 * scheduled-deletion email; null when there is none or it is not refundable.
 */
export async function refundableShareOf(
  db: Executor,
  userId: string,
): Promise<{ amountCents: number; currency: string; reference: string } | null> {
  const [share] = await db
    .select()
    .from(membershipShares)
    .where(and(eq(membershipShares.userId, userId), eq(membershipShares.status, "held")))
    .limit(1);
  if (!share) return null;
  if (membershipClassesOf(await loadSettings(db)).viewer.shareRefundableOnExit !== true) return null;
  return { amountCents: share.amountCents, currency: share.currency, reference: await referenceOf(db, share) };
}

/** Under the share's lock: check, record, audit and send. Returns the updated share and the date. */
export async function askRefundDetails(
  deps: Pick<Deps, "db" | "mailer" | "now">,
  actorId: string,
  shareId: string,
): Promise<{ share: ShareRow; deletionScheduledFor: Date | null }> {
  const now = deps.now();
  return deps.db.transaction(async (tx) => {
    const [share] = await tx.select().from(membershipShares).where(eq(membershipShares.id, shareId)).for("update");
    if (!share) throw notFound("Share not found");
    const [deletion] = await tx
      .select({ at: accountDeletions.scheduledFor })
      .from(accountDeletions)
      .where(and(eq(accountDeletions.userId, share.userId), eq(accountDeletions.status, "scheduled")))
      .orderBy(desc(accountDeletions.requestedAt))
      .limit(1);
    const leaving = share.status === "held" && deletion !== undefined;
    if (share.status !== "refund_pending" && !leaving)
      throw conflict(`This share is ${share.status}, and its member has no deletion scheduled`);
    const last = share.refundDetailsRequestedAt;
    if (last && now.getTime() - last.getTime() < REFUND_DETAILS_COOLDOWN_MS)
      throw conflict("The member was asked less than 24 hours ago");
    const [member] = await tx
      .select({
        email: users.email,
        locale: users.locale,
        accountType: users.accountType,
        deletedAt: users.deletedAt,
        pseudonymizedAt: users.pseudonymizedAt,
      })
      .from(users)
      .where(eq(users.id, share.userId));
    // A deleted account has no address left: the member claims the refund by quoting the reference.
    if (!member || member.deletedAt || member.pseudonymizedAt || member.accountType !== "human")
      throw precondition("member_reachable", "This member can't be emailed; they can claim it by the share reference");
    const [updated] = await tx
      .update(membershipShares)
      .set({ refundDetailsRequestedAt: now })
      .where(eq(membershipShares.id, share.id))
      .returning();
    if (!updated) throw conflict("This share changed; reload and try again");
    await audit(tx, {
      actorType: STAFF,
      actorId,
      action: "coop.share.refund_details_requested",
      subjectType: "membership_share",
      subjectId: share.id,
      details: { shareId: share.id, userId: share.userId, amountCents: share.amountCents },
    });
    await deps.mailer.send(
      "shareRefundDetails",
      {
        amountCents: share.amountCents,
        currency: share.currency,
        reference: await referenceOf(tx, share),
        deleteAt: deletion?.at ?? null,
        locale: member.locale,
      },
      member.email,
    );
    return { share: updated, deletionScheduledFor: deletion?.at ?? null };
  });
}
