// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The governance mailer (overhaul wave 5): "a vote is open" and "the result is in" by email, for
 * members who turned the governance email preference on (off by default, `NOTIFY_DEFAULTS`; the
 * governance unsubscribe link turns it off). One `NOTIFY_JOBS.governanceEmail` job is one page of
 * recipients for one `coop.proposal.update` event (enqueued by the outbox relay,
 * `notify/outbox-jobs.ts`): the proposal's frozen electorate when voting opens, every active
 * member when the result is published. Each (event, member) is claimed with a Valkey key
 * (`SET NX`, as the video-ready email does) before its send, so a retried or re-relayed page
 * never mails anyone twice; a failed send drops its claim and the page is retried.
 */
import { NOTIFY_JOBS, QUEUES, type GovernanceEmailJob } from "@commonair/contracts/internal";
import { NOTIFY_DEFAULTS, NOTIFY_RULES } from "@commonair/contracts/notify";
import { anchoredUser, schema } from "@commonair/db";
import { eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { WorkerContext } from "../../context.ts";
import { unsubscribeUrl } from "../email/prefs.ts";

/** Which mail an event asks for. */
export type GovernanceEmailKind = "vote_opened" | "result";

/** The part of a `coop.proposal.update` payload the mailer reads. */
const ProposalUpdate = z.object({ proposal_id: z.uuid(), status: z.string() });

/** The mail a `coop.proposal.update` status asks for: voting opened, or a decision; null otherwise. */
export function governanceEmailKind(status: string): GovernanceEmailKind | null {
  if (status === "voting") return "vote_opened";
  if (status === "passed" || status === "rejected") return "result";
  return null;
}

/** Whether an outbox event starts a governance mailing. */
export function startsGovernanceEmail(e: { type: string; payload: unknown }): boolean {
  if (e.type !== "coop.proposal.update") return false;
  const p = ProposalUpdate.safeParse(e.payload);
  return p.success && governanceEmailKind(p.data.status) !== null;
}

/** BullMQ ids may not hold `:`; deterministic, so a second enqueue of the same page is a no-op. */
export const governanceEmailJobId = (eventId: string, after: string | null): string =>
  after === null ? `governance-email-${eventId}` : `governance-email-${eventId}-${after}`;

/** Per (event, member): kept well past any retry or outbox redelivery. */
export const GOVERNANCE_EMAIL_CLAIM_SECONDS = 7 * 86_400;
export const governanceEmailClaimKey = (eventId: string, userId: string) =>
  `notify:governance-email:${eventId}:${userId}`;

/** The next page: only when this one came back full (`ids` in member-id order). */
export function nextGovernancePage(
  eventId: string,
  ids: readonly string[],
  pageSize: number,
): { name: string; data: GovernanceEmailJob; opts: { jobId: string } } | null {
  const last = ids.at(-1);
  if (ids.length < pageSize || last === undefined) return null;
  return {
    name: NOTIFY_JOBS.governanceEmail,
    data: { eventId, after: last },
    opts: { jobId: governanceEmailJobId(eventId, last) },
  };
}

/** Share of the eligible who voted, 0..1 (0 with nobody eligible). */
export function turnoutOf(t: { eligible: number; yes: number; no: number; abstain: number }): number {
  if (t.eligible <= 0) return 0;
  return Math.min(1, (t.yes + t.no + t.abstain) / t.eligible);
}

export interface GovernanceEmailResult {
  kind: GovernanceEmailKind | null;
  /** Recipients on this page (opted in, verified, human, not deleted). */
  recipients: number;
  sent: number;
  /** Already claimed by an earlier run. */
  skipped: number;
  failed: number;
  nextPage: boolean;
}

const EMPTY: GovernanceEmailResult = { kind: null, recipients: 0, sent: 0, skipped: 0, failed: 0, nextPage: false };

export interface GovernanceEmailOptions {
  /** Tests only: recipients per page (default `NOTIFY_RULES.fanoutPageSize`). */
  pageSize?: number;
}

interface Recipient {
  user_id: string;
  email: string;
  locale: string | null;
}

/**
 * One page of recipients after `after`: the source's members who get governance email (their own
 * default row, else the built-in default), filtered before the limit so pages stay full.
 */
export function recipientsQuery(source: SQL, after: string | null, pageSize: number): SQL {
  return sql`
    select users.id as user_id, users.email, users.locale
      from (${source}) r
      join users on users.id = r.user_id
     where users.account_type = 'human'
       and users.email_verified
       and users.deleted_at is null
       and users.pseudonymized_at is null
       and not ${anchoredUser()}
       and coalesce((select np.enabled from notification_preferences np
                      where np.user_id = users.id and np.type = 'governance' and np.medium = 'email'
                        and np.channel_id is null
                      limit 1), ${sql.raw(String(NOTIFY_DEFAULTS.governance.email))})
       ${after === null ? sql`` : sql`and users.id > ${after}::uuid`}
     order by users.id
     limit ${pageSize}`;
}

const electorateOf = (proposalId: string) =>
  sql`select user_id from proposal_electorate where proposal_id = ${proposalId}::uuid`;
const activeMembers = () => sql`select distinct user_id from memberships where status = 'active'`;

/** Send one page of `job`. Never throws for a missing event; throws (and is retried) when a send failed. */
export async function sendGovernanceEmailPage(
  ctx: WorkerContext,
  job: GovernanceEmailJob,
  opts: GovernanceEmailOptions = {},
): Promise<GovernanceEmailResult> {
  const { mailer, site } = ctx;
  if (!mailer || !site) return { ...EMPTY };
  const pageSize = opts.pageSize ?? NOTIFY_RULES.fanoutPageSize;
  const [event] = await ctx.db
    .select({ type: schema.events.type, payload: schema.events.payload })
    .from(schema.events)
    .where(eq(schema.events.id, job.eventId));
  const update = ProposalUpdate.safeParse(event?.payload);
  const kind =
    update.success && event?.type === "coop.proposal.update" ? governanceEmailKind(update.data.status) : null;
  if (!update.success || kind === null) {
    ctx.logger.warn("governance email: no vote opening or result to mail", { eventId: job.eventId });
    return { ...EMPTY };
  }
  const proposalId = update.data.proposal_id;
  const [proposal] = await ctx.db
    .select({
      title: schema.proposals.title,
      status: schema.proposals.status,
      votingEndsAt: schema.proposals.votingEndsAt,
    })
    .from(schema.proposals)
    .where(eq(schema.proposals.id, proposalId));
  if (!proposal) return { ...EMPTY, kind };
  // A late page for a vote that has closed since would ask members to vote when they no longer can.
  if (
    kind === "vote_opened" &&
    (proposal.status !== "voting" || !proposal.votingEndsAt || proposal.votingEndsAt <= ctx.now())
  )
    return { ...EMPTY, kind };
  let result: { outcome: "passed" | "rejected"; turnout: number } | null = null;
  if (kind === "result") {
    const [tally] = await ctx.db
      .select({ passed: schema.tallies.passed, breakdown: schema.tallies.breakdown })
      .from(schema.tallies)
      .where(eq(schema.tallies.proposalId, proposalId));
    if (!tally) {
      ctx.logger.warn("governance email: the result has no tally", { eventId: job.eventId, proposalId });
      return { ...EMPTY, kind };
    }
    result = { outcome: tally.passed ? "passed" : "rejected", turnout: turnoutOf(tally.breakdown.memberWide) };
  }

  const source = kind === "vote_opened" ? electorateOf(proposalId) : activeMembers();
  const rows = (await ctx.db.execute(recipientsQuery(source, job.after, pageSize))) as unknown as Recipient[];
  const base = site.publicUrl.replace(/\/+$/, "");
  const proposalUrl = `${base}/coop/proposals/${proposalId}`;
  const out: GovernanceEmailResult = { ...EMPTY, kind, recipients: rows.length };
  for (const r of rows) {
    const key = governanceEmailClaimKey(job.eventId, r.user_id);
    if ((await ctx.valkey.set(key, "1", "EX", GOVERNANCE_EMAIL_CLAIM_SECONDS, "NX")) !== "OK") {
      out.skipped++;
      continue;
    }
    try {
      const unsubscribe = await unsubscribeUrl(site.publicUrl, ctx.webhooks.authSecret, r.user_id, "governance");
      const locale = r.locale ?? undefined;
      if (result === null)
        await mailer.send(
          "governanceVoteOpened",
          {
            proposalTitle: proposal.title,
            // Checked above: a vote being mailed is open, so it has an end.
            closesAt: proposal.votingEndsAt ?? ctx.now(),
            voteUrl: proposalUrl,
            unsubscribeUrl: unsubscribe,
            locale,
          },
          r.email,
        );
      else
        await mailer.send(
          "governanceResultPublished",
          {
            proposalTitle: proposal.title,
            outcome: result.outcome,
            turnout: result.turnout,
            resultUrl: proposalUrl,
            unsubscribeUrl: unsubscribe,
            locale,
          },
          r.email,
        );
      out.sent++;
    } catch (err) {
      await ctx.valkey.del(key).catch(() => undefined);
      out.failed++;
      // Never the address.
      ctx.logger.warn("governance email failed", {
        eventId: job.eventId,
        userId: r.user_id,
        error: err instanceof Error ? err.name : "unknown",
      });
    }
  }
  const next = nextGovernancePage(
    job.eventId,
    rows.map((r) => r.user_id),
    pageSize,
  );
  if (next) await ctx.enqueue(QUEUES.notifications, next.name, next.data, next.opts);
  out.nextPage = next !== null;
  ctx.logger.info("governance email page", {
    eventId: job.eventId,
    kind,
    recipients: out.recipients,
    sent: out.sent,
    skipped: out.skipped,
    failed: out.failed,
  });
  // The retry re-reads the page; the claims skip everyone already mailed.
  if (out.failed > 0) throw new Error(`governance email: ${out.failed} sends failed`);
  return out;
}
