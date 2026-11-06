// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** seed-coop: memberships, governance, proposals and votes, elections, council and patronage. Brief: `.claude/briefs/seed-full/seed-coop.md`. */
import { CoopHooksOff } from "../coop-io.ts";
import { type MemberClass, governancePeriods, minSubscriptionCents, preflightGovernance, rowLeaks } from "../coop.ts";
import { internalSecret } from "../safety-io.ts";
import {
  CoopSessions,
  type JuryResult,
  b7Tick,
  coopHooks,
  runGovernance,
  runJury,
  seatCouncil,
  setupMemberships,
} from "./coop/api.ts";
import { activeClassesByUser, birthDates, coopRowsSince, countRows, sampledCases, tierPrices } from "./coop/db.ts";
import {
  type CoopFacts,
  type ElectorateMember,
  type SubscriptionFact,
  forbiddenSamples,
  inRevenuePeriod,
  isAdult,
  juryInputProblems,
  patronageWindow,
  planGovernance,
  planMemberships,
  rulesOf,
  seatsOf,
} from "./coop/plan.ts";
import type { SeedUnit } from "./types.ts";

const TABLES = [
  "memberships",
  "membership_shares",
  "membership_history",
  "governance_applications",
  "governance_settings_history",
  "proposals",
  "proposal_comments",
  "proposal_electorate",
  "votes",
  "vote_history",
  "tallies",
  "council_terms",
  "council_members",
  "council_responses",
  "elections",
  "election_candidates",
  "election_ballots",
  "board_seats",
  "patronage_periods",
  "patronage_inputs",
  "patronage_allocations",
  // Batch 7: the advisory jury.
  "jury_optins",
  "jury_panels",
  "jury_seats",
  "jury_cases",
  "jury_votes",
  "jury_flags",
] as const;

/** What seed-coop publishes as `store.extra.coop` (the keys its brief names). */
export interface CoopExtra {
  /** A decided, tallied proposal with comments and a council response (`/coop/proposals/$id/`). */
  proposalId: string;
  /** member1's draft (`/coop/proposals/$id/edit`). */
  draftProposalId: string;
  /** The approved patronage period (`/coop/patronage/$periodId`). */
  patronagePeriodId: string;
}

const MEMBERSHIP_SETTLE_MS = 60_000;
/** Governance's own budget inside the unit's 5 minutes at `small`. */
const GOVERNANCE_BUDGET_MS = 270_000;

const stringList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** `store.extra.money.subscriptionsByUser`, keeping only well-formed entries. */
export function subscriptionsFromStore(v: unknown): Record<string, SubscriptionFact[]> {
  if (typeof v !== "object" || v === null) return {};
  const out: Record<string, SubscriptionFact[]> = {};
  for (const [handle, subs] of Object.entries(v as Record<string, unknown>)) {
    if (!Array.isArray(subs)) continue;
    out[handle] = subs.flatMap((s) => {
      const x = s as Partial<SubscriptionFact>;
      return typeof x.channelSlug === "string" && typeof x.tier === "number" && typeof x.status === "string"
        ? [{ channelSlug: x.channelSlug, tier: x.tier, status: x.status }]
        : [];
    });
  }
  return out;
}

export const unit: SeedUnit = {
  name: "coop",
  // money: viewer members by subscription, and the revenue patronage distributes. safety: the
  // jury samples its closed cases and resolved reports (safety runs after media, whose stream
  // hours make the streamer members and seat the council).
  after: ["social", "money", "safety"],
  tables: TABLES,
  // membership_shares: under COOP_TEST_HOOKS a share is a manual transfer on any provider, so the
  // seed's stripe-mock stack has them too.
  pending: [],
  async run(ctx) {
    const started = Date.now();
    const unitStart = new Date();
    const progress = (line: string) => ctx.log.info(`seed-coop: ${line}`);
    const notes: string[] = [];

    // ------------------------------------------------------------ flags
    const secret = internalSecret(ctx.env);
    if (!secret) throw new Error("seed-coop: INTERNAL_API_SECRET is not set (the co-op and batch 7 test hooks)");
    const hooks = coopHooks(ctx.env, secret, ctx.signal);
    try {
      await hooks.tickRan("membership-sync");
    } catch (err) {
      if (err instanceof CoopHooksOff) throw new Error("seed-coop: set COOP_TEST_HOOKS=true on the api and the worker");
      throw err;
    }
    // OPS_TEST_HOOKS (the jury draw and close): with the jury still off, a draw draws nothing.
    const probe = await b7Tick(ctx.env, secret, "jury-draw", {}, ctx.signal);
    if ((probe.drawn ?? 0) > 0) throw new Error("seed-coop: a jury panel was drawn before the seed turned the jury on");
    const sessions = new CoopSessions(ctx.env, ctx.password, ctx.store.users);
    const member1 = await sessions.as("member1");
    const settings = () => member1.api.client.coop.settings();
    const initial = await settings();
    const pre = preflightGovernance(initial);
    if (!pre.ok)
      throw new Error(
        `seed-coop: ${pre.problem ?? "short governance periods missing"} (the seed overlay sets GOVERNANCE_BOOTSTRAP_JSON to SEED_GOVERNANCE_BOOTSTRAP)`,
      );
    const periods = governancePeriods(initial);
    const before = await countRows(ctx.db, TABLES);

    // ------------------------------------------------------------ facts and memberships
    const ids = ctx.store.users.map((u) => u.id);
    const births = await birthDates(ctx.db, ids);
    const money = ctx.store.extra.money ?? {};
    const safety = ctx.store.extra.safety ?? {};
    const facts: CoopFacts = {
      users: ctx.store.users,
      channels: ctx.store.channels,
      adults: new Set(ctx.store.users.filter((u) => isAdult(births.get(u.id) ?? null, ctx.now)).map((u) => u.handle)),
      subscriptionsByUser: subscriptionsFromStore(money.subscriptionsByUser),
      tierPrices: await tierPrices(ctx.db),
      minSubscriptionCents: minSubscriptionCents(initial),
      restrictedUserIds: new Set(
        Array.isArray(safety["restrictedUserIds"])
          ? safety["restrictedUserIds"].filter((x): x is string => typeof x === "string")
          : [],
      ),
    };
    if (Object.keys(facts.subscriptionsByUser).length === 0)
      notes.push("seed-coop: store.extra.money.subscriptionsByUser is empty, so no viewer joins on a subscription");
    const memberPlan = planMemberships(ctx.rng.fork("memberships"), ctx.scale, facts);
    await sessions.warm(["admin", "treasurer", ...memberPlan.workers]);
    progress(`appointing ${memberPlan.workers.length} workers and buying shares`);
    const membership = await setupMemberships(sessions, memberPlan, ctx.signal);
    await hooks.tickRan("membership-sync");
    const byId = new Map(ctx.store.users.map((u) => [u.id, u.handle]));
    const readElectorate = async (): Promise<ElectorateMember[]> =>
      [...(await activeClassesByUser(ctx.db))].flatMap(([id, classes]) => {
        const handle = byId.get(id);
        return handle ? [{ handle, classes }] : [];
      });
    let electorate = await readElectorate();
    const isIn = (h: string, c: MemberClass) => electorate.some((m) => m.handle === h && m.classes.includes(c));
    // Sync activations are synchronous, but a scheduled run may hold the lock: re-read briefly.
    const deadline = Date.now() + MEMBERSHIP_SETTLE_MS;
    while (!(isIn("council1", "streamer") && isIn("council2", "streamer")) && Date.now() < deadline) {
      await hooks.tickRan("membership-sync");
      electorate = await readElectorate();
    }
    for (const h of ["council1", "council2"])
      if (!isIn(h, "streamer"))
        throw new Error(
          `seed-coop: ${h} is not a streamer member after membership-sync; seed-media must give it eligible stream_hours in the last 90 days`,
        );
    const viewerMembers = electorate.filter((m) => m.classes.includes("viewer")).map((m) => m.handle);
    const missingViewers = memberPlan.expectedViewerMembers.filter(
      (h) => !viewerMembers.includes(h) && !memberPlan.shares.refunded.includes(h),
    );
    if (missingViewers.length > 0)
      notes.push(
        `seed-coop: ${missingViewers.length} expected viewer members did not join on the sync (their subscriptions did not qualify on the stack)`,
      );

    // ------------------------------------------------------------ council
    const seated = await seatCouncil(hooks, sessions, MEMBERSHIP_SETTLE_MS);
    const seatedHandles = seated.flatMap((id) => {
      const h = byId.get(id);
      return h ? [h] : [];
    });
    for (const h of ["council1", "council2"])
      if (!seatedHandles.includes(h))
        notes.push(`seed-coop: ${h} was not seated on the council (more streamer members than council.config.size)`);
    const responders = [
      ...["council1", "council2"].filter((h) => seatedHandles.includes(h)),
      ...seatedHandles.filter((h) => h !== "council1" && h !== "council2"),
    ];

    // ------------------------------------------------------------ governance and jury
    const plan = planGovernance(ctx.rng.fork("governance"), ctx.scale, {
      electorate,
      seats: seatsOf(initial),
      rules: rulesOf(initial),
      discussionSeconds: periods.discussionSeconds,
    });
    const juryCaseIds = stringList(safety.juryCaseIds);
    const juryReportIds = stringList(safety.juryReportIds);
    for (const p of juryInputProblems({
      caseIds: juryCaseIds,
      reportIds: juryReportIds,
      optIns: memberPlan.juryOptIns,
    }))
      notes.push(`seed-coop: jury: ${p}`);
    const voters = plan.proposals.flatMap((p) => [
      p.author,
      ...p.comments.map((c) => c.author),
      ...p.votes.map((v) => v.handle),
    ]);
    const candidates = plan.elections.flatMap((e) => [
      ...e.candidates.map((c) => c.handle),
      ...e.ballots.map((b) => b.voter),
    ]);
    await sessions.warm([...voters, ...candidates, ...responders.slice(0, 3)]);
    progress(
      `governance: ${plan.proposals.length} proposals, ${plan.elections.length} elections, periods ${JSON.stringify(periods)}`,
    );

    let jury: Promise<JuryResult> | null = null;
    let forbidden: string[] = [];
    const startJury = () => {
      jury = runJury({
        sessions,
        env: ctx.env,
        secret,
        optIns: memberPlan.juryOptIns,
        rng: ctx.rng.fork("jury-votes"),
        signal: ctx.signal,
        sampled: async (panelId) => {
          const rows = await sampledCases(ctx.db, panelId);
          forbidden = forbiddenSamples(rows);
          return rows.map((r) => r.subjectId);
        },
      });
      // Surfaced when awaited below; never an unhandled rejection meanwhile.
      jury.catch(() => undefined);
    };
    const governance = await runGovernance({
      sessions,
      hooks,
      plan,
      responders,
      settings,
      signal: ctx.signal,
      budgetMs: GOVERNANCE_BUDGET_MS,
      progress,
      onApplied: (ref) => {
        if (ref === "juryOn" && !jury) startJury();
      },
    });
    notes.push(...governance.notes);
    if (!jury) throw new Error("seed-coop: the jury proposal never applied");
    const juryResult = await (jury as Promise<JuryResult>);
    if (forbidden.length > 0)
      throw new Error(`seed-coop: the jury sampled ${forbidden.length} T0, hash-list or NCII cases`);
    if (juryResult.flagged < 1)
      notes.push("seed-coop: the jury close flagged no case (no case was seen by every juror)");
    if (juryResult.shownRows === 0)
      notes.push("seed-coop: every published jury row is suppressed (fewer than k = 10 votes per clause and tier)");
    progress(
      `jury: ${juryResult.seated} seated, ${juryResult.sampled.length} cases, ${juryResult.votes} votes, ${juryResult.flagged} flagged in ${juryResult.seconds} s`,
    );

    // ------------------------------------------------------------ patronage
    const treasurer = await sessions.as("treasurer");
    const admin = await sessions.as("admin");
    const existing = await treasurer.api.client.coop.patronage.periods();
    const window = patronageWindow(ctx.now, new Date(), existing);
    if (!window) throw new Error("seed-coop: no patronage window is left after the existing periods");
    const revenuePeriod = typeof money.revenuePeriod === "string" ? money.revenuePeriod : null;
    if (!inRevenuePeriod(window, revenuePeriod))
      notes.push(`seed-coop: the patronage period does not lie inside money's revenue period ${revenuePeriod ?? ""}`);
    const run = await treasurer.api.client.coop.patronage.run({
      periodStart: window.start.toISOString(),
      periodEnd: window.end.toISOString(),
    });
    await admin.api.client.coop.patronage.approve({ periodId: run.periodId });
    const statement = await member1.api.client.coop.patronage.statement({ periodId: run.periodId });
    if (statement.status !== "approved" && statement.status !== "distributed")
      throw new Error(`seed-coop: the patronage period is ${statement.status} after approval`);
    if (run.total.cents === 0)
      notes.push("seed-coop: the patronage period distributes nothing (no retained surplus in the ledger yet)");

    // ------------------------------------------------------------ privacy and report
    const caused = await coopRowsSince(ctx.db, unitStart);
    const leaks = rowLeaks(caused.audit, caused.events, {
      commentBodies: [...new Set([...governance.comments, ...governance.councilBodies])],
      emails: ctx.store.users.map((u) => u.email),
    });
    if (leaks.length > 0) throw new Error(`seed-coop: ballot, comment or email leaks: ${JSON.stringify(leaks)}`);

    const after = await countRows(ctx.db, TABLES);
    const rows = Object.fromEntries(TABLES.map((t) => [t, (after[t] ?? 0) - (before[t] ?? 0)]));
    const empty = TABLES.filter((t) => (rows[t] ?? 0) === 0);
    if (empty.length > 0) notes.push(`seed-coop: no rows written to ${empty.join(", ")}`);

    const proposalId = governance.proposalIds.get(plan.showcase);
    const draftProposalId = governance.proposalIds.get(plan.draft);
    if (!proposalId || !draftProposalId) throw new Error("seed-coop: the showcase or draft proposal was not created");
    const extra: CoopExtra = { proposalId, draftProposalId, patronagePeriodId: run.periodId };
    ctx.store.extra.coop = { ...extra };

    const seconds = Math.round((Date.now() - started) / 1000);
    return {
      rows,
      notes: [
        ...notes,
        `seed-coop: finished in ${seconds} s (governance ${governance.seconds} s, jury ${juryResult.seconds} s beside it)`,
        "seed-coop: every co-op row went through the API and the worker, so all of them carry today's times; /coop and /transparency show this month's governance only",
        "seed-coop: the run restores the default governance periods through two passed proposals (one protected), so the open proposals keep their council review, vote and discussion for days; the e5-coop scenario's preflight (short periods) fails on a seeded database",
        "seed-coop: every qualifying subscriber becomes a viewer member on the membership sync (the product enrols them all, not a 30% sample)",
        "seed-coop: governance_applications holds one row per applied setting change: it is written by the settings trigger, not by an admin review, so it has no pending or rejected rows",
        "seed-coop: 'passed' is transient (a passed proposal applies at once), so the passed proposals show as applied",
        `seed-coop: ${governance.counts.votes} votes, ${governance.counts.comments} comments, ${governance.counts.councilResponses} council responses, ${governance.counts.ballots} ballots; ${governance.elected} board seats from the closed election`,
        `seed-coop: ${membership.rows.appointments} workers appointed; shares: ${membership.rows.sharesBought} bought, ${membership.rows.sharesConfirmed} confirmed, ${membership.rows.sharesRefunded} refunded`,
        `seed-coop: patronage period ${window.start.toISOString()}..${window.end.toISOString()} for ${run.members} members, ${run.total.cents} cents (run by treasurer, approved by admin)`,
        `seed-coop: ${sessions.signedIn} accounts signed in through the API`,
      ],
    };
  },
};
