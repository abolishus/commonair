// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Milestone E5, the co-op (docs/testing/e5-selectors.md, "Scenario `e5-coop`"):
 * 1 a viewer buys the share and a treasurer confirms it; two streamers qualify by streaming hours;
 * an admin appoints a worker. 2 the council seats both streamers. 3 a tip makes a surplus. 4 an
 * ordinary, creator-affecting proposal is discussed, reviewed by the council, voted, decided and
 * applied. 5 in parallel, a protected proposal passes member-wide but fails in the streamer class,
 * and the database refuses every way around that. 6 a patronage run needs a second approver and
 * explains each member's statement; the ledger balances. 7 `/transparency` shows the outcomes.
 * 8 every action has its audit and outbox row, and nothing leaks a ballot, a comment or an email.
 * 9 everyone exits and the share is refunded, so later runs start from a clean electorate; V then
 * subscribes, rejoins the viewer class on the subscription, exits as a member by subscription only,
 * is not re-enrolled by the sync, and rejoins (`membership-rejoin-viewer`, E7).
 *
 * Governance windows run on the database clock: every wait is on state (`coop.proposals.get`)
 * with a deadline, ticking `proposals-advance` through the test hook. `--set via=api` drives
 * everything through the API; the default drives the web flows the spec names. The stack must be
 * started with `harness/compose.e5-coop.yaml` on a database bootstrapped with short periods.
 */
import { join } from "node:path";
import type { Page } from "playwright";
import {
  type CoopDriver,
  type MembershipSnapshot,
  type TallyView,
  ApiCoop,
  WebCoop,
  activeIn,
  apiMembership,
  patronageIn,
} from "../src/coop-actors.ts";
import {
  DEFAULT_APP_ROLE,
  activeStreamerMembers,
  coopAuditRows,
  coopEventRows,
  coopLedgerSums,
  protectedBypassRefusals,
  settingRow,
} from "../src/coop-db.ts";
import { CoopHooks } from "../src/coop-io.ts";
import {
  API_PERIOD_UNIT_MS,
  WEB_PERIOD_UNIT_MS,
  type AuditExpectation,
  type CastVote,
  type Choice,
  type CoopStep,
  type EventExpectation,
  type MemberClass,
  type ObservedCount,
  COOP_STEPS,
  STREAMER_MAJORITY_NOT_MET,
  choosePatronagePeriod,
  commentText,
  councilSeatingProblem,
  councilSize,
  cutChange,
  expectedTally,
  governancePeriods,
  missed,
  missingAudit,
  minSubscriptionCents,
  missingEvents,
  parseCoopSteps,
  preflightGovernance,
  qualifyingTier,
  rankingChange,
  reached,
  rowLeaks,
  sameValue,
  scanCoopLog,
  summarizeLogLeaks,
  tallyMismatches,
  utcMonthOf,
  viewerState,
} from "../src/coop.ts";
import { ApiTreasurer, type Treasurer, WebTreasurer } from "../src/money-actors.ts";
import { grantRole } from "../src/money-db.ts";
import { parseReference, parseVia, unbalancedTransactions } from "../src/money.ts";
import { playerBundles } from "../src/player-server.ts";
import { DEFAULT_REPORT_DIR } from "../src/report.ts";
import { apiError, errorOf } from "../src/safety.ts";
import { containerLogs, internalSecret, serviceContainers } from "../src/safety-io.ts";
import { defineScenario, type ScenarioContext } from "../src/scenario.ts";
import type { WaitBudget } from "../src/social.ts";
import type { SignedInUser } from "../src/users.ts";
import type { Viewer } from "../src/viewer.ts";
import { waitFor } from "../src/wait.ts";
import { signInViaUi } from "../src/web/flows.ts";
import { ROUTES, TEST_IDS } from "../src/web/selectors.ts";
import { WebSession, byTestId } from "../src/web/session.ts";

const UI_TIMEOUT_MS = 20_000;
const ROLE_CLI_TIMEOUT_MS = 30_000;
/** Membership, council and settings reads after a tick: synchronous, this covers page loads. */
const SETTLE_MS = 30_000;
/** One or two recompute ticks: enough to confirm a seating the outlook doubts. */
const COUNCIL_SHORT_MS = 5_000;
/** Slack added to each governance window for ticks, the worker's 15 s schedule and page loads. */
const WINDOW_SLACK_MS = 60_000;
const TIP_CENTS = 1_000;
const DEFAULT_QUALIFY_SECONDS = 600;
const DEFAULT_VIEWERS_PER_STREAM = 2;
const NOTE = "harness e5-coop";

interface People {
  v: SignedInUser;
  s1: SignedInUser;
  s2: SignedInUser;
  w: SignedInUser;
  t1: SignedInUser;
  t2: SignedInUser;
  admin: SignedInUser;
}

/** Ids the run creates, filled step by step (the report carries these and nothing personal). */
interface Ids {
  sharePaymentId?: string;
  shareReference?: string;
  shareId?: string;
  viewerMembershipId?: string;
  streamerMembershipIds: Record<string, string>;
  workerMembershipId?: string;
  termId?: string;
  tipPaymentId?: string;
  proposalA?: string;
  proposalB?: string;
  commentIds: string[];
  periodId?: string;
  period?: { start: string; end: string };
}

interface Run {
  ctx: ScenarioContext;
  via: "web" | "api";
  driver: CoopDriver;
  treasurer: Treasurer;
  people: People;
  hooks: CoopHooks;
  databaseUrl: string;
  appRole: string;
  currency: string;
  runStart: Date;
  periods: ReturnType<typeof governancePeriods>;
  ui: WaitBudget;
  ids: Ids;
  emails: string[];
  comments: string[];
  audit: AuditExpectation[];
  events: EventExpectation[];
  /** Voters' ids and usernames (log needles for a choice tied to a user). */
  voters: Set<string>;
  check: ScenarioContext["check"];
  state: { cleanedUp: boolean };
}

export default defineScenario({
  name: "e5-coop",
  description:
    "co-op: share bought and confirmed, streamers qualify by hours, worker appointed → council seated → tip → ordinary proposal discussed, reviewed, voted, applied; protected proposal rejected in the streamer class and every DB bypass refused → patronage run + second approver + statements, ledger balanced → transparency → audit/outbox complete, no ballot or PII leaks → exits and share refund",
  needs: ["api", "web", "worker", "mail", "media", "origin", "ffmpeg", "browser", "podman"],
  // Needs the compose override and a database bootstrapped with short periods: `full` runs on the
  // harness stack, which has both (ADR 0021).
  inFull: true,
  timeoutMs: 45 * 60_000,
  async run(ctx) {
    const sessions: WebSession[] = [];
    const state = { finished: false, softFailed: false };
    ctx.defer(async () => {
      if (!state.finished || state.softFailed) await screenshotSessions(ctx, sessions);
      await Promise.allSettled(sessions.map((s) => s.close()));
    });
    const check: ScenarioContext["check"] = (name, condition, details) => {
      if (!condition) state.softFailed = true;
      return ctx.check(name, condition, details);
    };
    await e5Coop(ctx, sessions, check);
    state.finished = true;
  },
});

async function screenshotSessions(ctx: ScenarioContext, sessions: readonly WebSession[]): Promise<void> {
  const dir = join(ctx.env.HARNESS_REPORT_DIR ?? DEFAULT_REPORT_DIR, `${ctx.runId}-${ctx.name}`);
  const files = (await Promise.all(sessions.map((s) => s.screenshotAll(dir)))).flat();
  if (files.length > 0) ctx.data("screenshots", files);
}

function title(n: CoopStep, what: string): string {
  return `${n}. ${COOP_STEPS[n]}: ${what}`;
}

/** Poll `read` until `done`; on timeout return the last value so the assertions report it. */
/**
 * Re-read until `done`. `intervalMs` matters for page reads: each reload makes several API calls
 * as the viewer, whose default bucket allows 120 a minute.
 */
async function settle<V>(
  what: string,
  read: () => Promise<V>,
  done: (v: V) => boolean,
  b: WaitBudget,
  intervalMs = 3_000,
): Promise<V> {
  let last: { v: V } | null = null;
  try {
    return await waitFor(
      what,
      async () => {
        const v = await read();
        last = { v };
        return done(v) ? v : null;
      },
      { timeoutMs: b.timeoutMs, intervalMs, signal: b.signal },
    );
  } catch (err) {
    const seen = last as { v: V } | null;
    if (seen && !b.signal.aborted) return seen.v;
    throw err;
  }
}

async function e5Coop(ctx: ScenarioContext, sessions: WebSession[], check: ScenarioContext["check"]): Promise<void> {
  const p = ctx.platform;
  const runStart = new Date();
  const steps = parseCoopSteps(ctx.param("steps", "all"));
  const via = parseVia(ctx.param("via", "web"));
  const appRole = ctx.param("appRole", DEFAULT_APP_ROLE);
  ctx.data("steps", steps);
  ctx.data("via", via);
  ctx.data("runStart", runStart.toISOString());

  const databaseUrl = ctx.env.DATABASE_URL;
  ctx.assert(
    "DATABASE_URL is set (role CLI and the database checks; run from the repo root so Bun loads .env)",
    databaseUrl !== undefined,
  );
  const secret = internalSecret(ctx.env);
  ctx.assert(
    "INTERNAL_API_SECRET is set (the co-op test hook; HARNESS_INTERNAL_API_SECRET or the repo .env)",
    secret !== undefined,
  );
  if (databaseUrl === undefined || secret === undefined) return;
  const hooks = new CoopHooks(ctx.env.HARNESS_API_URL, secret, ctx.signal);
  ctx.defer(() => ctx.data("ticks", summarizeTicks(hooks)));

  // ------------------------------------------------------------ preflight
  const anon = p.api().client;
  const settings = await ctx.step("preflight: governance settings are the e5 bootstrap", () => anon.coop.settings());
  const pre = preflightGovernance(settings);
  ctx.assert(pre.problem ?? "governance.ordinary.discussionSeconds ≤ 60", pre.ok);
  const periods = governancePeriods(settings);
  ctx.data("governance.periods", periods);
  await ctx.step("preflight: the co-op test hook answers (COOP_TEST_HOOKS=true)", () =>
    hooks.tickRan("membership-sync"),
  );
  const payoutRules = settings.find((s) => s.key === "payout.rules")?.value as { currency?: unknown } | undefined;
  const currency = typeof payoutRules?.currency === "string" ? payoutRules.currency : "usd";
  const viewerClass = (settings.find((s) => s.key === "membership.classes")?.value ?? {}) as {
    viewer?: { shareCents?: unknown };
  };
  const shareCents = typeof viewerClass.viewer?.shareCents === "number" ? viewerClass.viewer.shareCents : null;

  // ------------------------------------------------------------ people
  const [v, s1, s2, w, t1Account, t2Account, adminAccount] = await ctx.step(
    "sign up viewer V, streamers S1 and S2, worker W, treasurers T1 and T2, admin (API)",
    () =>
      Promise.all([
        p.signUp({ prefix: "e5_v" }),
        p.signUp({ prefix: "e5_s1" }),
        p.signUp({ prefix: "e5_s2" }),
        p.signUp({ prefix: "e5_w" }),
        p.signUp({ prefix: "e5_t1" }),
        p.signUp({ prefix: "e5_t2" }),
        p.signUp({ prefix: "e5_admin" }),
      ]),
  );
  await ctx.step("grant treasurer ×2 and admin (operator CLI)", async () => {
    for (const [u, role] of [
      [t1Account, "treasurer"],
      [t2Account, "treasurer"],
      [adminAccount, "admin"],
    ] as const)
      await grantRole(databaseUrl, u.username, role, ROLE_CLI_TIMEOUT_MS);
  });
  const [t1, t2, admin] = await ctx.step("staff: sign in again to pick up the roles", () =>
    Promise.all([p.users.signIn(t1Account), p.users.signIn(t2Account), p.users.signIn(adminAccount)]),
  );
  const people: People = { v, s1, s2, w, t1, t2, admin };
  ctx.data("users", Object.fromEntries(Object.entries(people).map(([k, u]) => [k, u.id])));

  // ------------------------------------------------------------ drivers
  const { probe } = via === "web" ? await playerBundles() : { probe: "" };
  const byUser = new Map<string, Promise<WebSession>>();
  const sessionFor = (user: SignedInUser): Promise<WebSession> => {
    let s = byUser.get(user.id);
    if (!s) {
      const label = Object.entries(people).find(([, u]) => u.id === user.id)?.[0] ?? user.username;
      s = (async () => {
        const session = await WebSession.open({
          fleet: p.fleet,
          engine: "chromium",
          webUrl: ctx.env.HARNESS_WEB_URL,
          probeScript: probe,
          label,
          log: ctx.log,
        });
        sessions.push(session);
        await ctx.step(`${label}: sign in through the web UI`, async () => {
          const page = await session.goto(ROUTES.signin);
          await signInViaUi(page, user, UI_TIMEOUT_MS, ctx.signal);
          await byTestId(page, TEST_IDS.navUser, { username: user.username }).waitFor({ timeout: UI_TIMEOUT_MS });
        });
        return session;
      })();
      byUser.set(user.id, s);
    }
    return s;
  };
  const openAs = async (user: SignedInUser, path: string): Promise<Page> => (await sessionFor(user)).goto(path);
  const driver: CoopDriver = via === "web" ? new WebCoop(openAs) : new ApiCoop();
  const treasurer: Treasurer =
    via === "web" ? new WebTreasurer((path) => openAs(t1, path), currency) : new ApiTreasurer(t1.api.client);

  const run: Run = {
    ctx,
    via,
    driver,
    treasurer,
    people,
    hooks,
    databaseUrl,
    appRole,
    currency,
    runStart,
    periods,
    ui: { timeoutMs: UI_TIMEOUT_MS, signal: ctx.signal },
    ids: { streamerMembershipIds: {}, commentIds: [] },
    emails: Object.values(people).map((u) => u.email),
    comments: [],
    audit: [],
    events: [],
    voters: new Set(),
    check,
    state: { cleanedUp: false },
  };
  ctx.defer(() => {
    ctx.data("ids", run.ids);
  });
  ctx.defer(() => cleanup(run));

  for (const n of steps) {
    switch (n) {
      case 1:
        await stepMembership(run, shareCents);
        break;
      case 2:
        await stepCouncil(run);
        break;
      case 3:
        await stepRevenue(run);
        break;
      case 4:
        // Step 5 runs in parallel with step 4 (same windows), so both are driven here.
        await stepGovernance(run, steps.includes(5));
        break;
      case 5:
        await stepProtectedRefusals(run);
        break;
      case 6:
        await stepPatronage(run);
        break;
      case 7:
        await stepTransparency(run);
        break;
      case 8:
        await stepAuditAndOutbox(run);
        break;
      case 9:
        await stepExit(run);
        break;
    }
  }
}

function summarizeTicks(hooks: CoopHooks): Record<string, { count: number; skipped: number; errors: number }> {
  const out: Record<string, { count: number; skipped: number; errors: number }> = {};
  for (const t of hooks.ticks) {
    const e = (out[t.job] ??= { count: 0, skipped: 0, errors: 0 });
    e.count++;
    if (t.result && (t.result.skipped ?? 0) > 0) e.skipped++;
    if (t.error) e.errors++;
  }
  return out;
}

const need = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`${what} is missing (an earlier step did not record it)`);
  return value;
};

// ---------------------------------------------------------------- 1. membership

async function stepMembership(run: Run, shareCents: number | null): Promise<void> {
  const { ctx, driver, people, ids, ui } = run;
  const p = ctx.platform;
  const t = (w: string) => title(1, w);

  // Viewer V: buy the share, the treasurer confirms it.
  const checkout = await ctx.step(t(`V buys the share (${run.via})`), () => driver.buyShare(people.v, ui));
  ids.sharePaymentId = checkout.paymentId;
  ids.shareReference = checkout.reference;
  ctx.assert(
    "the share's instructions carry a CA- reference",
    parseReference(checkout.reference) === checkout.reference,
    {
      paymentId: checkout.paymentId,
    },
  );
  run.check(
    "the share costs membership.classes.viewer.shareCents",
    shareCents === null || checkout.cents === shareCents,
    { cents: checkout.cents, shareCents },
  );
  const pending = await ctx.step(t("V's share is pending"), () => apiMembership(people.v.api.client));
  ctx.assert("V has a pending share", pending.share.status === "pending" && pending.share.id !== null, {
    share: pending.share.status,
  });
  ids.shareId = pending.share.id ?? undefined;
  const shareId = need(ids.shareId, "the share id");

  await ctx.step(
    t(`T1 confirms the share payment (${run.via === "web" ? "/treasury" : "treasurer.confirm"})`),
    async () => {
      const found = await waitFor(
        `treasurer finds ${checkout.reference}`,
        () => run.treasurer.find(checkout.reference, { ...ui, timeoutMs: 5_000 }),
        { timeoutMs: UI_TIMEOUT_MS, intervalMs: 500, signal: ctx.signal },
      );
      ctx.assert(
        "the share payment is listed pending",
        found.status === "pending" && found.kind === "membership_share",
        {
          status: found.status,
          kind: found.kind,
        },
      );
      await run.treasurer.confirm(checkout.reference, ui);
    },
  );
  const held = await ctx.step(t("V is a viewer member by share, the share is held"), () =>
    settle(
      "V's viewer membership",
      () => driver.membership(people.v, ui),
      (m) => activeIn(m, "viewer")?.basis === "share" && m.share.status === "held",
      { timeoutMs: SETTLE_MS, signal: ctx.signal },
    ),
  );
  ctx.assert("membership-row viewer/share is active", activeIn(held, "viewer")?.basis === "share", { rows: held.rows });
  ctx.assert("membership-share data-status=held", held.share.status === "held", { share: held.share.status });
  const vMembership = activeIn(await apiMembership(people.v.api.client), "viewer");
  ids.viewerMembershipId = vMembership?.id;
  const viewerMembershipId = need(ids.viewerMembershipId, "V's viewer membership id");
  run.audit.push(
    {
      action: "coop.share.request",
      actorType: "user",
      actorId: people.v.id,
      mentions: shareId,
      label: "V requests the share",
    },
    {
      action: "payment.confirm",
      actorType: "admin",
      actorId: people.t1.id,
      mentions: checkout.paymentId,
      label: "T1 confirms the share payment",
    },
    {
      action: "membership.activate",
      actorType: "admin",
      actorId: people.t1.id,
      mentions: viewerMembershipId,
      label: "V's viewer membership activates on confirm",
    },
  );
  run.events.push(
    { type: "coop.share.update", mentions: shareId, where: { status: "pending" }, label: "share pending" },
    { type: "coop.share.update", mentions: shareId, where: { status: "held" }, label: "share held" },
    { type: "coop.membership.update", mentions: viewerMembershipId, label: "V's viewer membership" },
  );

  // Streamers S1 and S2: stream with verified harness viewers until the streamer class is eligible.
  const viewersPerStream = Math.max(1, ctx.intParam("viewersPerStream", DEFAULT_VIEWERS_PER_STREAM));
  const qualifyMs = ctx.intParam("qualifySeconds", DEFAULT_QUALIFY_SECONDS) * 1_000;
  const streamers = [people.s1, people.s2];
  const running: { stop(): Promise<unknown> }[] = [];
  const stopAll = async () => {
    await Promise.allSettled(running.splice(0).map((r) => r.stop()));
  };
  ctx.defer(stopAll);
  const streamStarted = Date.now();
  await ctx.step(t(`S1 and S2 stream a test pattern, each with ${viewersPerStream} harness viewers`), async () => {
    for (const s of streamers) {
      const channel = s.me.channelSlug ?? s.username;
      const streamer = await p.streamerFor(s, { protocol: "rtmp", width: 640, height: 360, bitrateKbps: 800 });
      running.push(streamer);
      await streamer.start();
      await p.waitForLive(channel, true, 30_000);
      const viewers: Viewer[] = await p.openViewers(channel, { http: viewersPerStream });
      running.push(...viewers);
    }
  });
  const eligible = await ctx.step(
    t(`both streamers' streamer class is eligible (≤ ${qualifyMs / 1000} s: scoring + the stream-hours job)`),
    () =>
      waitFor(
        "coop.membership streamer eligibility for S1 and S2",
        async () => {
          // Run the stream-hours pass now instead of waiting for its 5-minute schedule (once
          // scoring has verified the viewers); a busy or slow tick just means the next poll.
          await run.hooks.tick("stream-hours").catch(() => undefined);
          const ms = await Promise.all(streamers.map((s) => apiMembership(s.api.client)));
          return ms.every((m) => m.eligibility.find((e) => e.class === "streamer")?.eligible === true) ? ms : null;
        },
        { timeoutMs: qualifyMs, intervalMs: 5_000, signal: ctx.signal },
      ),
  );
  ctx.metric("streamer_qualification", Date.now() - streamStarted, "ms");
  ctx.data(
    "streamer.progress",
    eligible.map((m) => m.eligibility.find((e) => e.class === "streamer") ?? null),
  );
  const synced = await ctx.step(t("a membership-sync tick makes both streamer members (streaming_hours)"), () =>
    run.hooks.tickUntil(
      "membership-sync",
      "active streamer memberships for S1 and S2",
      async () => {
        const ms = await Promise.all(streamers.map((s) => apiMembership(s.api.client)));
        return ms.every((m) => activeIn(m, "streamer")?.basis === "streaming_hours") ? ms : null;
      },
      { timeoutMs: SETTLE_MS * 2 },
    ),
  );
  await ctx.step(t("stop the streams and their viewers"), stopAll);
  for (const [i, s] of streamers.entries()) {
    const m = activeIn(synced[i] as MembershipSnapshot, "streamer");
    const id = need(m?.id, `S${i + 1}'s streamer membership id`);
    ids.streamerMembershipIds[s.id] = id;
    run.audit.push({
      action: "membership.activate",
      actorType: "system",
      actorId: null,
      mentions: id,
      label: `S${i + 1}'s streamer membership activates`,
    });
    run.events.push({ type: "coop.membership.update", mentions: id, label: `S${i + 1}'s streamer membership` });
  }
  if (run.via === "web") {
    const shown = await ctx.step(t("S1: /coop/membership shows the streamer class eligible"), () =>
      driver.membership(people.s1, ui),
    );
    run.check(
      "membership-eligibility[data-class=streamer] data-eligible=true",
      shown.eligibility.find((e) => e.class === "streamer")?.eligible === true,
      { eligibility: shown.eligibility },
    );
    run.check(
      "membership-row streamer/streaming_hours is active",
      activeIn(shown, "streamer")?.basis === "streaming_hours",
      {
        rows: shown.rows,
      },
    );
  }

  // Worker W: appointed by board decision.
  await ctx.step(t(`admin appoints W (${run.via === "web" ? "/admin/coop" : "coop.appointWorker"})`), () =>
    driver.appointWorker(people.admin, people.w.username, `board minute ${ctx.runId}`, ui),
  );
  const worker = await ctx.step(t("W has a worker membership by board appointment"), () =>
    settle(
      "W's worker membership",
      () => apiMembership(people.w.api.client),
      (m) => activeIn(m, "worker")?.basis === "board_appointment",
      { timeoutMs: SETTLE_MS, signal: ctx.signal },
    ),
  );
  ctx.assert(
    "W is an active worker member (board_appointment)",
    activeIn(worker, "worker")?.basis === "board_appointment",
    {
      rows: worker.rows,
    },
  );
  ids.workerMembershipId = activeIn(worker, "worker")?.id;
  const workerId = need(ids.workerMembershipId, "W's worker membership id");
  run.audit.push({
    action: "membership.appoint",
    actorType: "admin",
    actorId: people.admin.id,
    mentions: workerId,
    label: "admin appoints W",
  });
  run.events.push({ type: "coop.membership.update", mentions: workerId, label: "W's worker membership" });
}

// ---------------------------------------------------------------- 2. council

async function stepCouncil(run: Run): Promise<void> {
  const { ctx, people, ui } = run;
  const t = (w: string) => title(2, w);
  const anon = ctx.platform.api().client;
  const wanted = [people.s1.id, people.s2.id];
  // On a long-lived stack other scenarios' streamers stay council candidates: say so plainly
  // instead of timing out when the seating cannot (or likely will not) include S1 and S2.
  const problem = await ctx.step(t("preflight: the next recompute can seat S1 and S2"), async () => {
    const [settings, council, streamers] = await Promise.all([
      anon.coop.settings(),
      anon.coop.council(),
      activeStreamerMembers(run.databaseUrl),
    ]);
    const input = {
      size: councilSize(settings),
      activeStreamers: streamers,
      seated: council.members.map((m) => m.user.id),
      wanted,
    };
    ctx.data("council.outlook", {
      size: input.size,
      activeStreamers: input.activeStreamers.length,
      seated: input.seated.length,
    });
    return councilSeatingProblem(input);
  });
  if (problem) ctx.log.warn("council seating in doubt; one short recompute before failing", { problem });
  const seated = await ctx.step(t("a council-recompute tick seats S1 and S2"), async () => {
    try {
      return await run.hooks.tickUntil(
        "council-recompute",
        "S1 and S2 seated in the current council term",
        async () => {
          const c = await anon.coop.council();
          const ids = new Set(c.members.map((m) => m.user.id));
          return wanted.every((id) => ids.has(id)) ? c : null;
        },
        { timeoutMs: problem ? COUNCIL_SHORT_MS : SETTLE_MS * 2 },
      );
    } catch (err) {
      if (problem) throw new Error(`S1 and S2 were not seated: ${problem}`, { cause: err });
      throw err;
    }
  });
  run.ids.termId = seated.termId ?? undefined;
  const termId = need(run.ids.termId, "the council term id");
  ctx.data("council", { termId, seats: seated.members.length });
  const shown = await ctx.step(
    t(`the council lists both (${run.via === "web" ? "/coop/council" : "coop.council"})`),
    // The page renders its wrapper (empty data-term-id) while it loads: wait for this term's seats.
    () =>
      settle(
        "the council page",
        () => run.driver.council(people.v, ui),
        (c) => c.termId === termId && wanted.every((id) => c.members.some((m) => m.userId === id)),
        { timeoutMs: SETTLE_MS, signal: ctx.signal },
      ),
  );
  const shownIds = new Set(shown.members.map((m) => m.userId));
  ctx.assert(
    "council-member rows include S1 and S2",
    wanted.every((id) => shownIds.has(id)),
    { termId: shown.termId, seats: shown.members.length },
  );
  run.check("council data-term-id is the current term", shown.termId === termId, { shown: shown.termId, termId });
  run.audit.push({
    action: "council.recompute",
    actorType: "system",
    actorId: null,
    mentions: termId,
    label: "council seated",
  });
  run.events.push({ type: "coop.council.recomputed", mentions: termId, label: "council seated" });
}

// ---------------------------------------------------------------- 3. revenue

async function stepRevenue(run: Run): Promise<void> {
  const { ctx, people, ui } = run;
  const t = (w: string) => title(3, w);
  const channel = people.s1.me.channelSlug ?? people.s1.username;
  const tip = await ctx.step(t(`V tips S1 ${TIP_CENTS} cents (manual adapter)`), () =>
    people.v.api.client.money.tip({
      channel,
      amountCents: TIP_CENTS,
      message: "",
      anonymous: false,
      returnPath: ROUTES.channel(channel),
    }),
  );
  ctx.assert("the tip gives manual instructions", tip.kind === "instructions", { kind: tip.kind });
  if (tip.kind !== "instructions") return;
  run.ids.tipPaymentId = tip.paymentId;
  await ctx.step(t("T1 confirms the tip"), async () => {
    await waitFor(
      `treasurer finds ${tip.reference}`,
      () => run.treasurer.find(tip.reference, { ...ui, timeoutMs: 5_000 }),
      { timeoutMs: UI_TIMEOUT_MS, intervalMs: 500, signal: ctx.signal },
    );
    await run.treasurer.confirm(tip.reference, ui);
  });
  run.audit.push({
    action: "payment.confirm",
    actorType: "admin",
    actorId: people.t1.id,
    mentions: tip.paymentId,
    label: "T1 confirms the tip",
  });
}

// ---------------------------------------------------------------- 4 + 5. governance

interface Tracked {
  label: "A" | "B";
  id: string;
  /** Who publishes the council response, and its stance. */
  responder: SignedInUser;
  stance: "support" | "oppose";
  responded: boolean;
  votes: { user: SignedInUser; classes: MemberClass[]; choice: Choice; web: boolean }[];
  voted: boolean;
  status: string;
}

async function stepGovernance(run: Run, withProtected: boolean): Promise<void> {
  const { ctx, people, driver, ui } = run;
  const t = (w: string) => title(4, w);
  const anon = ctx.platform.api().client;
  const settings = await ctx.step(t("read discovery.ranking and platform.cut"), () => anon.coop.settings());
  const ranking = rankingChange(settings.find((s) => s.key === "discovery.ranking")?.value);
  const cutBefore = settings.find((s) => s.key === "platform.cut")?.value;
  const cut = cutChange(cutBefore);
  ctx.data("governance.change", {
    spotlightSlots: ranking.value.spotlightSlots,
    streamerShare: cut.value.streamerShare,
  });

  const a = await ctx.step(
    t(`S2 drafts and submits the ordinary proposal (${run.via === "web" ? "/coop/proposals/new" : "API"})`),
    () =>
      driver.draftAndSubmit(
        people.s2,
        {
          title: `Spotlight slots ${String(ranking.value.spotlightSlots)} (${run.ctx.runId})`,
          body: "Harness e5-coop: change the number of spotlight slots for small channels.",
          changes: [ranking],
          affectsCreators: true,
        },
        ui,
      ),
  );
  run.ids.proposalA = a.id;
  ctx.assert("A is ordinary and in discussion", a.kind === "ordinary" && a.status === "discussion", {
    kind: a.kind,
    status: a.status,
  });

  let b: { id: string; kind: string; status: string; affectsCreators: boolean } | null = null;
  if (withProtected) {
    b = await ctx.step(title(5, "W drafts and submits the protected proposal (platform.cut, API)"), async () => {
      const draft = await people.w.api.client.coop.proposals.create({
        title: `Streamer share ${String(cut.value.streamerShare)} (${run.ctx.runId})`,
        body: "Harness e5-coop: a protected decision that the streamer class rejects.",
        changes: [cut],
        affectsCreators: false,
      });
      const sub = await people.w.api.client.coop.proposals.submit({ id: draft.id });
      return { id: sub.id, kind: sub.kind, status: sub.status, affectsCreators: sub.affectsCreators };
    });
    run.ids.proposalB = b.id;
    ctx.assert(
      "B is protected, affects creators (forced) and in discussion",
      b.kind === "protected" && b.affectsCreators && b.status === "discussion",
      b,
    );
  }

  // V and W comment during discussion (the bodies are needles, never reported).
  for (const [who, user] of [
    ["V", people.v],
    ["W", people.w],
  ] as const) {
    const body = commentText(ctx.runId, who);
    run.comments.push(body);
    const c = await ctx.step(t(`${who} comments on A during discussion`), () =>
      user.api.client.coop.proposals.comment({ id: a.id, body }),
    );
    run.ids.commentIds.push(c.id);
    run.audit.push({
      action: "proposal.comment",
      actorType: "user",
      actorId: user.id,
      mentions: c.id,
      label: `${who} comments`,
    });
    run.events.push({ type: "coop.proposal.comment", mentions: c.id, label: `${who}'s comment` });
  }

  const tracked: Tracked[] = [
    {
      label: "A",
      id: a.id,
      responder: people.s1,
      stance: "support",
      responded: false,
      votes: [
        { user: people.v, classes: ["viewer"], choice: "yes", web: run.via === "web" },
        { user: people.w, classes: ["worker"], choice: "yes", web: false },
        { user: people.s1, classes: ["streamer"], choice: "yes", web: false },
        { user: people.s2, classes: ["streamer"], choice: "yes", web: false },
      ],
      voted: false,
      status: a.status,
    },
  ];
  if (b) {
    tracked.push({
      label: "B",
      id: b.id,
      responder: people.s2,
      stance: "oppose",
      responded: false,
      votes: [
        { user: people.v, classes: ["viewer"], choice: "yes", web: false },
        { user: people.w, classes: ["worker"], choice: "yes", web: false },
        { user: people.s2, classes: ["streamer"], choice: "yes", web: false },
        { user: people.s1, classes: ["streamer"], choice: "no", web: false },
      ],
      voted: false,
      status: b.status,
    });
  }
  // One list call per probe (newest first, so this run's proposals are on the first page), not a
  // get per proposal: the probes run twice per tick, and anonymous calls share one 120/min bucket.
  const read = async () => {
    const page = await anon.coop.proposals.list({ limit: 25 });
    for (const x of tracked) {
      const found = page.items.find((item) => item.id === x.id);
      x.status = found ? found.status : (await anon.coop.proposals.get({ id: x.id })).status;
    }
  };

  // Discussion → council review: publish each response as soon as its review opens.
  const reviewMs = (run.periods.discussionSeconds + run.periods.councilReviewSeconds) * 1_000 + WINDOW_SLACK_MS;
  await ctx.step(t("ticks move A (and B) to council review; S1 supports A, S2 opposes B"), () =>
    run.hooks.tickUntil(
      "proposals-advance",
      "every council response published",
      async () => {
        await read();
        for (const x of tracked) {
          if (x.responded) continue;
          if (missed(x.status, "council_review"))
            throw new Error(`${x.label} left council review (${x.status}) before the response was published`);
          if (x.status === "council_review") {
            const r = await x.responder.api.client.coop.proposals.councilRespond({
              id: x.id,
              stance: x.stance,
              body: `Council response (${x.stance}) from the harness.`,
            });
            run.check(
              `${x.label}: the council response is published (${x.stance})`,
              r.councilResponse?.stance === x.stance,
              {
                stance: r.councilResponse?.stance ?? null,
              },
            );
            x.responded = true;
          }
        }
        return tracked.every((x) => x.responded) ? true : null;
      },
      { timeoutMs: reviewMs, intervalMs: 2_000 },
    ),
  );

  // Council review → voting: vote at once (the window is judged by the database clock).
  const votingMs = run.periods.councilReviewSeconds * 1_000 + WINDOW_SLACK_MS;
  const voteStarted = new Map<string, number>();
  await ctx.step(t("ticks open voting; everyone votes at once"), () =>
    run.hooks.tickUntil(
      "proposals-advance",
      "every vote cast",
      async () => {
        await read();
        const open = tracked.filter((x) => !x.voted && x.status === "voting");
        for (const x of tracked)
          if (!x.voted && missed(x.status, "voting"))
            throw new Error(`${x.label} was decided (${x.status}) before the votes`);
        await Promise.all(open.map((x) => castVotes(run, x, voteStarted)));
        return tracked.every((x) => x.voted) ? true : null;
      },
      { timeoutMs: votingMs, intervalMs: 2_000 },
    ),
  );
  await secretBallotChecks(run, tracked);

  // Voting → decided.
  const decideMs = Math.max(run.periods.votingSeconds, run.periods.protectedVotingSeconds) * 1_000 + WINDOW_SLACK_MS;
  await ctx.step(t("after the window a tick decides A (and B)"), () =>
    run.hooks.tickUntil(
      "proposals-advance",
      "every proposal decided",
      async () => {
        await read();
        return tracked.every((x) => reached(x.status, "passed") || x.status === "rejected") ? true : null;
      },
      { timeoutMs: decideMs, intervalMs: 2_000 },
    ),
  );
  for (const x of tracked) {
    const started = voteStarted.get(x.id);
    if (started) ctx.metric(`proposal_${x.label}.votes_to_decided`, Date.now() - started, "ms");
  }

  const tallyA = await ctx.step(
    t(`A's tally (${run.via === "web" ? "/coop/proposals/$id" : "coop.proposals.get"})`),
    () =>
      settle(
        "A's tally",
        () => driver.tally(people.v, a.id, ui),
        (x) => x !== null,
        { timeoutMs: SETTLE_MS, signal: ctx.signal },
      ),
  );
  checkTally(run, tracked[0] as Tracked, tallyA, true, "passed");

  // Passed → applied.
  await ctx.step(t("the next tick applies A"), () =>
    run.hooks.tickUntil(
      "proposals-advance",
      "A applied",
      async () => ((await anon.coop.proposals.get({ id: a.id })).status === "applied" ? true : null),
      { timeoutMs: WINDOW_SLACK_MS },
    ),
  );
  const shownSettings = await ctx.step(
    t(`settings show discovery.ranking set by A (${run.via === "web" ? "/coop/settings" : "API"})`),
    () =>
      settle(
        "setting-row discovery.ranking updated by A",
        () => driver.settings(people.v, ui),
        (rows) => rows.find((r) => r.key === "discovery.ranking")?.updatedBy === a.id,
        { timeoutMs: SETTLE_MS, signal: ctx.signal },
      ),
  );
  ctx.assert(
    "setting-row[data-key=discovery.ranking] data-updated-by is A",
    shownSettings.find((r) => r.key === "discovery.ranking")?.updatedBy === a.id,
    { updatedBy: shownSettings.find((r) => r.key === "discovery.ranking")?.updatedBy ?? null },
  );
  const after = await anon.coop.settings();
  const rankingNow = after.find((s) => s.key === "discovery.ranking")?.value;
  ctx.assert("discovery.ranking now holds the proposed value", sameValue(rankingNow, ranking.value), {
    spotlightSlots: (rankingNow as { spotlightSlots?: unknown } | undefined)?.spotlightSlots ?? null,
  });
  pushProposalExpectations(run, tracked[0] as Tracked, people.s2, true);

  if (b) {
    const tb = tracked[1] as Tracked;
    const tallyB = await ctx.step(
      title(5, `B's tally (${run.via === "web" ? "/coop/proposals/$id" : "coop.proposals.get"})`),
      () =>
        settle(
          "B's tally",
          () => driver.tally(people.v, tb.id, ui),
          (x) => x !== null,
          {
            timeoutMs: SETTLE_MS,
            signal: ctx.signal,
          },
        ),
    );
    checkTally(run, tb, tallyB, false, STREAMER_MAJORITY_NOT_MET);
    ctx.assert("B is rejected", tb.status === "rejected", { status: tb.status });
    pushProposalExpectations(run, tb, people.w, false);
    const cutNow = after.find((s) => s.key === "platform.cut")?.value;
    ctx.assert("platform.cut is unchanged (API)", sameValue(cutNow, cutBefore), {
      before: cutBefore ?? null,
      now: cutNow ?? null,
    });
    ctx.data("platform.cut", cutBefore ?? null);
  }
}

async function castVotes(run: Run, x: Tracked, started: Map<string, number>): Promise<void> {
  const { ctx, ui } = run;
  started.set(x.id, Date.now());
  // The web vote runs alongside the API votes so all land early in the window.
  const results = await Promise.all(
    x.votes.map(async (vote) => {
      run.voters.add(vote.user.id);
      run.voters.add(vote.user.username);
      const r = vote.web
        ? await run.driver.vote(vote.user, x.id, vote.choice, ui)
        : await new ApiCoop().vote(vote.user, x.id, vote.choice);
      return { vote, myVote: r.myVote };
    }),
  );
  for (const { vote, myVote } of results) {
    const who = Object.entries(run.people).find(([, u]) => u.id === vote.user.id)?.[0] ?? "?";
    run.check(
      `${x.label}: ${who}'s myVote is their own choice${vote.web ? " (vote-panel)" : ""}`,
      myVote === vote.choice,
      {
        expected: vote.choice === myVote,
      },
    );
  }
  x.voted = true;
  ctx.data(`proposal_${x.label}.voters`, x.votes.length);
}

/** While voting: participation only, never a running tally; outsiders cannot vote. */
async function secretBallotChecks(run: Run, tracked: readonly Tracked[]): Promise<void> {
  const { ctx, people } = run;
  const x = tracked[0];
  if (!x) return;
  await ctx.step(title(4, "while voting: participation only, outsiders refused"), async () => {
    const seen = await people.t1.api.client.coop.proposals.get({ id: x.id });
    if (seen.status !== "voting") return;
    run.check("no tally while voting", seen.tally === null, { tally: seen.tally !== null });
    run.check(
      "participation counts are shown while voting",
      seen.participation !== null && seen.participation.voted >= x.votes.length,
      { participation: seen.participation },
    );
    run.check("a non-voter sees no myVote", seen.myVote === null);
    const err = await errorOf(() => people.t1.api.client.coop.proposals.vote({ id: x.id, choice: "yes" }));
    const e = apiError(err);
    run.check(
      "a non-member's vote is FORBIDDEN not_in_electorate",
      e.code === "FORBIDDEN" && e.reason === "not_in_electorate",
      e,
    );
  });
}

function observedCounts(view: TallyView): {
  memberWide: ObservedCount;
  byClass: Partial<Record<string, ObservedCount>>;
} {
  const toCount = (scope: string): ObservedCount | undefined => {
    const r = view.rows.find((x) => x.scope === scope);
    if (!r) return undefined;
    return { yes: r.yes ?? -1, no: r.no ?? -1, abstain: r.abstain ?? -1, eligible: r.eligible ?? -1 };
  };
  return {
    memberWide: toCount("member_wide") ?? { yes: -1, no: -1, abstain: -1, eligible: -1 },
    byClass: { streamer: toCount("streamer"), viewer: toCount("viewer"), worker: toCount("worker") },
  };
}

function checkTally(run: Run, x: Tracked, view: TallyView | null, passed: boolean, reason: string): void {
  const { ctx } = run;
  ctx.assert(`${x.label}: tally is shown once decided`, view !== null);
  if (!view) return;
  ctx.data(`proposal_${x.label}.tally`, view);
  ctx.assert(`${x.label}: tally data-passed=${passed}`, view.passed === passed, {
    passed: view.passed,
    reason: view.reason,
  });
  ctx.assert(`${x.label}: tally data-reason="${reason}"`, view.reason === reason, { reason: view.reason });
  const cast: CastVote[] = x.votes.map((v) => ({ classes: v.classes, choice: v.choice }));
  const mismatches = tallyMismatches(expectedTally(cast), observedCounts(view));
  ctx.assert(`${x.label}: tally-row per class matches the votes cast`, mismatches.length === 0, { mismatches });
  if (!passed)
    run.check(
      `${x.label}: tally-check streamer_class_majority failed`,
      view.checks.some((c) => c.rule === "streamer_class_majority" && !c.passed),
      { checks: view.checks },
    );
}

function pushProposalExpectations(run: Run, x: Tracked, author: SignedInUser, applied: boolean): void {
  const sys = (action: string) => ({
    action,
    actorType: "system",
    actorId: null,
    mentions: x.id,
    label: `${x.label}: ${action}`,
  });
  run.audit.push(
    { action: "proposal.create", actorType: "user", actorId: author.id, mentions: x.id, label: `${x.label}: drafted` },
    {
      action: "proposal.submit",
      actorType: "user",
      actorId: author.id,
      mentions: x.id,
      label: `${x.label}: submitted`,
    },
    sys("proposal.council_review"),
    {
      action: "council.respond",
      actorType: "user",
      actorId: x.responder.id,
      mentions: x.id,
      label: `${x.label}: council response`,
    },
    sys("proposal.open_vote"),
    ...x.votes.map((v) => ({
      action: "proposal.vote",
      actorType: "user",
      actorId: v.user.id,
      mentions: x.id,
      label: `${x.label}: a vote`,
    })),
    sys("proposal.decide"),
    ...(applied ? [sys("proposal.apply")] : []),
  );
  const statuses = [
    "discussion",
    "council_review",
    "voting",
    applied ? "passed" : "rejected",
    ...(applied ? ["applied"] : []),
  ];
  run.events.push(
    ...statuses.map((status) => ({
      type: "coop.proposal.update",
      mentions: x.id,
      where: { status },
      label: `${x.label}: ${status}`,
    })),
    { type: "coop.vote.cast", mentions: x.id, label: `${x.label}: votes` },
    { type: "coop.council.response", mentions: x.id, label: `${x.label}: council response` },
  );
}

// ---------------------------------------------------------------- 5. database refusals

async function stepProtectedRefusals(run: Run): Promise<void> {
  const { ctx } = run;
  const t = (w: string) => title(5, w);
  const proposalB = need(run.ids.proposalB, "proposal B");
  const anon = ctx.platform.api().client;
  const b = await anon.coop.proposals.get({ id: proposalB });
  ctx.assert("B is rejected with a recorded tally", b.status === "rejected" && b.tally !== null, { status: b.status });
  const change = b.changes.find((c) => c.key === "platform.cut");
  ctx.assert("B changes platform.cut", change !== undefined);
  const before = await settingRow(run.databaseUrl, "platform.cut");
  const results = await ctx.step(
    t(`as ${run.appRole}: B passed, a passed tally, its change applied (rolled back)`),
    () =>
      protectedBypassRefusals(
        run.databaseUrl,
        { proposalId: proposalB, breakdown: b.tally?.breakdown ?? {}, settingKey: "platform.cut", value: change?.to },
        run.appRole,
      ),
  );
  ctx.data(
    "protected.refusals",
    results.map((r) => ({ attempt: r.attempt, refused: r.refused, sqlState: r.sqlState })),
  );
  for (const r of results) {
    ctx.assert(`the database refuses ${r.attempt} for the rejected protected proposal`, r.refused, {
      rowCount: r.rowCount,
    });
  }
  const after = await settingRow(run.databaseUrl, "platform.cut");
  ctx.assert(
    "platform.cut is unchanged in the database",
    before !== null &&
      after !== null &&
      sameValue(before.value, after.value) &&
      before.updatedByProposalId === after.updatedByProposalId,
    { updatedBy: after?.updatedByProposalId ?? null },
  );
}

// ---------------------------------------------------------------- 6. patronage

async function stepPatronage(run: Run): Promise<void> {
  const { ctx, people, driver, ui } = run;
  const t = (w: string) => title(6, w);
  const existing = await people.t1.api.client.coop.patronage.periods();
  const unit = run.via === "web" ? WEB_PERIOD_UNIT_MS : API_PERIOD_UNIT_MS;
  const period = choosePatronagePeriod(run.runStart, new Date(), existing, unit);
  ctx.assert("a patronage period after every earlier one fits since the run started", period !== null, {
    runStart: run.runStart.toISOString(),
    latest: existing[0]?.periodEnd ?? null,
  });
  if (!period) return;
  run.ids.period = { start: period.start.toISOString(), end: period.end.toISOString() };
  const result = await ctx.step(
    t(`T1 runs patronage for [run start, now − 1 s) (${run.via === "web" ? "/treasury" : "API"})`),
    () => driver.runPatronage(people.t1, period.start, period.end, ui),
  );
  run.ids.periodId = result.periodId;
  ctx.data("patronage.run", result);
  ctx.assert("the run allocates to members", result.members > 0 && result.cents > 0, result);

  if (run.via === "web") {
    const rows = await ctx.step(t("T1: patronage-approve is disabled for the person who ran it"), () =>
      driver.periods(people.t1, ui),
    );
    const row = rows.find((r) => r.periodId === result.periodId);
    run.check(
      "patronage-period-row is computed, approve disabled for T1",
      row?.status === "computed" && row.approveDisabled === true,
      {
        status: row?.status ?? null,
        approveDisabled: row?.approveDisabled ?? null,
      },
    );
  }
  const refused = await ctx.step(t("coop.patronage.approve as T1 is refused (second_approver)"), () =>
    errorOf(() => people.t1.api.client.coop.patronage.approve({ periodId: result.periodId })),
  );
  const e = apiError(refused);
  ctx.assert(
    "T1's own approval is FORBIDDEN second_approver",
    e.code === "FORBIDDEN" && e.reason === "second_approver",
    e,
  );

  await ctx.step(t(`T2 approves (${run.via === "web" ? "/treasury" : "API"})`), () =>
    driver.approvePatronage(people.t2, result.periodId, ui),
  );
  const periods = await people.t2.api.client.coop.patronage.periods();
  const row = periods.find((p) => p.id === result.periodId);
  ctx.assert(
    "the period is approved, computed by T1 and approved by T2",
    row?.status === "approved" && row.computedBy?.id === people.t1.id && row.approvedBy?.id === people.t2.id,
    {
      status: row?.status ?? null,
    },
  );

  const statement = await ctx.step(
    t(`S1's statement (${run.via === "web" ? "/coop/patronage/$periodId" : "API"})`),
    () =>
      settle(
        "S1's statement",
        () => driver.statement(people.s1, result.periodId, ui),
        (s) => s.cents > 0 && s.lines.length > 0,
        { timeoutMs: SETTLE_MS, signal: ctx.signal },
      ),
  );
  ctx.data("patronage.statement", {
    cents: statement.cents,
    lines: statement.lines.map((l) => ({ component: l.component, cents: l.cents, capApplied: l.capApplied })),
  });
  ctx.assert("S1's statement has a positive data-cents", statement.cents > 0, { cents: statement.cents });
  ctx.assert("S1's statement has statement-lines", statement.lines.length > 0);
  run.check(
    "every statement-line is explained",
    statement.lines.every((l) => l.explained),
    {
      unexplained: statement.lines.filter((l) => !l.explained).map((l) => l.component),
    },
  );
  run.check("the statement is approved", statement.status === "approved", { status: statement.status });

  const ledger = await ctx.step(t("every ledger transaction of the run balances (read-only)"), () =>
    coopLedgerSums(run.databaseUrl, {
      refIds: [run.ids.shareId, run.ids.sharePaymentId, run.ids.tipPaymentId, result.periodId].filter(
        (x): x is string => x !== undefined,
      ),
      period: { start: period.start.toISOString(), end: period.end.toISOString(), currency: run.currency },
    }),
  );
  ctx.data(
    "ledger.transactions",
    ledger.map((r) => ({ kind: r.kind, currency: r.currency, sum: r.sum })),
  );
  const kinds = new Set(ledger.map((r) => r.kind));
  for (const kind of ["share_purchase", "period_close", "patronage_allocation"]) {
    ctx.assert(`a ${kind} transaction was posted`, kinds.has(kind), { kinds: [...kinds] });
  }
  ctx.assert(
    "the tip reached the ledger",
    ledger.some((r) => r.refId === run.ids.tipPaymentId),
  );
  const unbalanced = unbalancedTransactions(ledger);
  ctx.assert("every transaction sums to zero per currency", unbalanced.length === 0, {
    unbalanced: unbalanced.map((r) => ({ kind: r.kind, sum: r.sum })),
  });
  run.audit.push(
    {
      action: "patronage.run",
      actorType: "admin",
      actorId: people.t1.id,
      mentions: result.periodId,
      label: "T1 runs patronage",
    },
    {
      action: "patronage.approve",
      actorType: "admin",
      actorId: people.t2.id,
      mentions: result.periodId,
      label: "T2 approves patronage",
    },
  );
  run.events.push(
    {
      type: "coop.patronage.update",
      mentions: result.periodId,
      where: { status: "computed" },
      label: "patronage computed",
    },
    {
      type: "coop.patronage.update",
      mentions: result.periodId,
      where: { status: "approved" },
      label: "patronage approved",
    },
  );
}

// ---------------------------------------------------------------- 7. transparency

async function stepTransparency(run: Run): Promise<void> {
  const { ctx, people, driver, ui, ids } = run;
  const t = (w: string) => title(7, w);
  const a = need(ids.proposalA, "proposal A");
  const now = new Date();
  const view = await ctx.step(
    t(`${run.via === "web" ? "/transparency" : "coop.transparency"} shows the outcomes`),
    () =>
      settle(
        "transparency governance and patronage",
        () => driver.transparency(people.v, ui),
        (x) =>
          x.governance.some((g) => g.proposalId === a) &&
          (ids.proposalB === undefined || x.governance.some((g) => g.proposalId === ids.proposalB)) &&
          (ids.periodId === undefined || patronageIn(x, now) > 0),
        { timeoutMs: SETTLE_MS, signal: ctx.signal },
      ),
  );
  const rowA = view.governance.find((g) => g.proposalId === a);
  ctx.assert("transparency-governance A data-passed=true", rowA?.passed === true, { row: rowA ?? null });
  if (ids.proposalB) {
    const rowB = view.governance.find((g) => g.proposalId === ids.proposalB);
    ctx.assert("transparency-governance B data-passed=false", rowB?.passed === false, { row: rowB ?? null });
    run.check("B is listed as protected", rowB?.kind === "protected", { kind: rowB?.kind ?? null });
  }
  if (ids.periodId) {
    const cents = patronageIn(view, now);
    ctx.assert(`transparency-patronage for ${utcMonthOf(now)} has data-cents > 0`, cents > 0, { cents });
  }
}

// ---------------------------------------------------------------- 8. audit and outbox

async function stepAuditAndOutbox(run: Run): Promise<void> {
  const t = (w: string) => title(8, w);
  await verifyRows(run, t, "steps 1–7");
  await scanLogs(run, t("service logs carry no ballot, comment or email (podman logs since the run began)"));
}

/** Check every recorded expectation against the rows, and the rows for leaks. */
async function verifyRows(run: Run, t: (w: string) => string, scope: string): Promise<void> {
  const { ctx } = run;
  const [audit, events] = await ctx.step(t(`read audit_log and events since the run began (${scope})`), () =>
    Promise.all([coopAuditRows(run.databaseUrl, run.runStart), coopEventRows(run.databaseUrl, run.runStart)]),
  );
  ctx.data(`audit.${scope}`, {
    audit: audit.length,
    events: events.length,
    expected: run.audit.length + run.events.length,
  });
  const missingA = missingAudit(run.audit, audit);
  ctx.assert(`${scope}: every action has its audit_log row (action, actor type)`, missingA.length === 0, {
    missing: missingA.map((m) => m.label),
  });
  const missingE = missingEvents(run.events, events);
  ctx.assert(`${scope}: every action has its events row`, missingE.length === 0, {
    missing: missingE.map((m) => m.label),
  });
  const a = run.ids.proposalA;
  if (a) {
    const drafts = events.filter(
      (e) =>
        e.type === "coop.proposal.update" &&
        JSON.stringify(e.payload).includes(a) &&
        (e.payload as { status?: unknown } | null)?.status === "draft",
    );
    run.check("a draft emits no coop.proposal.update", drafts.length === 0, { draftEvents: drafts.length });
  }
  const leaks = rowLeaks(audit, events, { commentBodies: run.comments, emails: run.emails });
  ctx.assert(
    `${scope}: no audit details or event payload holds a vote choice, a comment body or an email`,
    leaks.length === 0,
    {
      leaks,
    },
  );
}

async function scanLogs(run: Run, name: string): Promise<void> {
  const { ctx } = run;
  const leaks = await ctx.step(name, async () => {
    const containers = await serviceContainers(ctx.env.HARNESS_CONTAINER_PREFIX);
    ctx.assert(
      `service containers found for log scanning (prefix ${ctx.env.HARNESS_CONTAINER_PREFIX})`,
      containers.length > 0,
    );
    const all = [];
    for (const c of containers) {
      all.push(
        ...scanCoopLog(c.service, await containerLogs(c.name, run.runStart), {
          voters: [...run.voters],
          commentBodies: run.comments,
          emails: run.emails,
        }),
      );
    }
    ctx.data("logs", { containers: containers.map((c) => c.service), leaks: summarizeLogLeaks(all) });
    return all;
  });
  ctx.assert(
    "service logs tie no vote choice to a user and carry no comment body or email",
    leaks.length === 0,
    summarizeLogLeaks(leaks),
  );
}

// ---------------------------------------------------------------- 9. exit and refund

async function stepExit(run: Run): Promise<void> {
  const { ctx, people, driver, ui, ids } = run;
  const t = (w: string) => title(9, w);
  const shareId = need(ids.shareId, "the share id");
  const viewerMembershipId = need(ids.viewerMembershipId, "V's viewer membership id");

  await ctx.step(t("V exits the viewer class"), () => people.v.api.client.coop.exit({ class: "viewer" }));
  const pendingRefund = await apiMembership(people.v.api.client);
  ctx.assert("V's share is refund_pending", pendingRefund.share.status === "refund_pending", {
    share: pendingRefund.share.status,
  });
  await ctx.step(t(`T1 refunds the share (${run.via === "web" ? "/treasury" : "coop.shares.refund"})`), () =>
    driver.refundShare(people.t1, shareId, `${NOTE} refund`, ui),
  );
  const refunded = await settle(
    "V's share refunded",
    () => apiMembership(people.v.api.client),
    (m) => m.share.status === "refunded",
    { timeoutMs: SETTLE_MS, signal: ctx.signal },
  );
  ctx.assert("V's share is refunded", refunded.share.status === "refunded", { share: refunded.share.status });
  const ledger = await ctx.step(t("the share refund posting balances (read-only)"), () =>
    coopLedgerSums(run.databaseUrl, { refIds: [shareId] }),
  );
  ctx.assert(
    "a share_refund transaction was posted",
    ledger.some((r) => r.kind === "share_refund"),
    {
      kinds: ledger.map((r) => r.kind),
    },
  );
  ctx.assert("the share's transactions sum to zero", unbalancedTransactions(ledger).length === 0);

  await stepRejoin(run);

  const leavers: [string, SignedInUser, MemberClass][] = [
    ["S1", people.s1, "streamer"],
    ["S2", people.s2, "streamer"],
    ["W", people.w, "worker"],
  ];
  for (const [who, user, cls] of leavers) {
    const m = await ctx.step(t(`${who} exits the ${cls} class`), () => user.api.client.coop.exit({ class: cls }));
    const left = m.memberships.filter((x) => x.class === cls).some((x) => x.status === "active");
    ctx.assert(`${who} has no active ${cls} membership`, !left);
  }
  run.state.cleanedUp = true;

  run.audit.push(
    {
      action: "membership.exit",
      actorType: "user",
      actorId: people.v.id,
      mentions: viewerMembershipId,
      label: "V exits",
    },
    {
      action: "coop.share.refund_request",
      actorType: "user",
      actorId: people.v.id,
      mentions: shareId,
      label: "refund requested",
    },
    {
      action: "coop.share.refund",
      actorType: "admin",
      actorId: people.t1.id,
      mentions: shareId,
      label: "T1 refunds the share",
    },
  );
  for (const [who, user, cls] of leavers) {
    const id = cls === "worker" ? ids.workerMembershipId : ids.streamerMembershipIds[user.id];
    if (id)
      run.audit.push({
        action: "membership.exit",
        actorType: "user",
        actorId: user.id,
        mentions: id,
        label: `${who} exits`,
      });
  }
  run.events.push(
    {
      type: "coop.share.update",
      mentions: shareId,
      where: { status: "refund_pending" },
      label: "share refund_pending",
    },
    { type: "coop.share.update", mentions: shareId, where: { status: "refunded" }, label: "share refunded" },
    { type: "coop.membership.update", mentions: viewerMembershipId, where: { status: "exited" }, label: "V exited" },
  );
  // Every expectation so far, now including the exits and the refund.
  await verifyRows(run, t, "steps 1–9");
  await scanLogs(run, t("service logs stay clean through the exits"));
}

/**
 * E7 (docs/testing/e7-selectors.md, `e5-coop`): V, whose share was refunded, subscribes to S1 and
 * rejoins the viewer class on the subscription. As a member by subscription only, V exits
 * (`membership-exit-viewer`), a membership-sync tick does not re-enrol V (the exit is respected),
 * and `membership-rejoin-viewer` (`coop.join` with `--set via=api`) makes the viewer row active by
 * subscription again. V leaves once more (API) so later runs start clean.
 */
async function stepRejoin(run: Run): Promise<void> {
  const { ctx, people, driver, ui } = run;
  const t = (w: string) => title(9, w);
  const v = people.v;
  const how = (web: string, api: string) => (run.via === "web" ? web : api);
  const channel = people.s1.me.channelSlug ?? people.s1.username;
  const min = minSubscriptionCents(await ctx.platform.api().client.coop.settings());
  const tiers = await v.api.client.money.tiers({ channel });
  const tier = qualifyingTier(tiers, min);
  ctx.assert(`S1 has a subscription tier of at least ${min} cents`, tier !== null, {
    tiers: tiers.map((x) => ({ tier: x.tier, cents: x.price.cents })),
  });
  if (tier === null) return;
  const sub = await ctx.step(t(`V subscribes to S1 (tier ${tier}, manual adapter)`), () =>
    v.api.client.money.subscribe({ channel, tier, returnPath: ROUTES.channel(channel) }),
  );
  ctx.assert("the subscription gives manual instructions", sub.kind === "instructions", { kind: sub.kind });
  if (sub.kind !== "instructions") return;
  await ctx.step(t("T1 confirms V's subscription"), async () => {
    await waitFor(
      `treasurer finds ${sub.reference}`,
      () => run.treasurer.find(sub.reference, { ...ui, timeoutMs: 5_000 }),
      { timeoutMs: UI_TIMEOUT_MS, intervalMs: 500, signal: ctx.signal },
    );
    await run.treasurer.confirm(sub.reference, ui);
  });
  const qualified = await settle(
    "V qualifies for the viewer class by subscription",
    () => apiMembership(v.api.client),
    (m) => m.eligibility.find((e) => e.class === "viewer")?.basis === "subscription",
    { timeoutMs: SETTLE_MS, signal: ctx.signal },
  );
  ctx.assert(
    "V's subscription qualifies for the viewer class",
    qualified.eligibility.find((e) => e.class === "viewer")?.basis === "subscription",
    { eligibility: qualified.eligibility.find((e) => e.class === "viewer") },
  );

  const syncKeepsExit = async (label: string, expected: string) => {
    await ctx.step(t(`a membership-sync tick does not re-enrol V (${label})`), () =>
      run.hooks.tickRan("membership-sync"),
    );
    const state = viewerState((await apiMembership(v.api.client)).rows);
    ctx.assert(`V's viewer row stays ${expected} after the sync (${label})`, state === expected, { state });
  };
  // V's latest viewer row is the share exit above.
  await syncKeepsExit("the share exit", "exited/share");

  const rejoin = async (label: string): Promise<string> => {
    await ctx.step(t(`V rejoins on the subscription, ${label} (${how("membership-rejoin-viewer", "coop.join")})`), () =>
      driver.rejoinViewer(v, ui),
    );
    const m = await apiMembership(v.api.client);
    const state = viewerState(m.rows);
    ctx.assert(`V's viewer row is active with basis subscription (${label})`, state === "active/subscription", {
      state,
    });
    const id = activeIn(m, "viewer")?.id ?? "";
    run.audit.push({
      action: "membership.join",
      actorType: "user",
      actorId: v.id,
      mentions: id,
      label: `V rejoins (${label})`,
    });
    run.events.push({
      type: "coop.membership.update",
      mentions: id,
      where: { status: "active", basis: "subscription" },
      label: `V rejoined (${label})`,
    });
    return id;
  };

  const first = await rejoin("first");
  await ctx.step(t(`V, a member by subscription only, exits (${how("membership-exit-viewer", "coop.exit")})`), () =>
    driver.exit(v, "viewer", ui),
  );
  const left = viewerState((await apiMembership(v.api.client)).rows);
  ctx.assert("V's viewer row is exited (subscription)", left === "exited/subscription", { state: left });
  run.audit.push({
    action: "membership.exit",
    actorType: "user",
    actorId: v.id,
    mentions: first,
    label: "V exits (subscription)",
  });
  await syncKeepsExit("the subscription exit", "exited/subscription");

  const second = await rejoin("again");
  ctx.assert("the rejoin is a new membership row", second !== "" && second !== first, { first, second });
  await ctx.step(t("V leaves the viewer class again (API, clean electorate)"), () =>
    v.api.client.coop.exit({ class: "viewer" }),
  );
  run.audit.push({
    action: "membership.exit",
    actorType: "user",
    actorId: v.id,
    mentions: second,
    label: "V exits again",
  });
  run.audit.push({
    action: "payment.confirm",
    actorType: "admin",
    actorId: people.t1.id,
    mentions: sub.paymentId,
    label: "T1 confirms V's subscription",
  });
}

/**
 * Best effort when step 9 did not run (a prefix, or a failure): exit every class the run's members
 * hold and refund V's share, so later runs start from a clean electorate. Errors are reported only.
 */
async function cleanup(run: Run): Promise<void> {
  if (run.state.cleanedUp || run.ctx.param("cleanup", "on") === "off") return;
  const { people } = run;
  const done: string[] = [];
  const failed: string[] = [];
  for (const [who, user] of [
    ["v", people.v],
    ["s1", people.s1],
    ["s2", people.s2],
    ["w", people.w],
  ] as const) {
    try {
      const m = await apiMembership(user.api.client);
      for (const cls of ["streamer", "viewer", "worker"] as const) {
        if (activeIn(m, cls)) {
          await user.api.client.coop.exit({ class: cls });
          done.push(`${who}:${cls}`);
        }
      }
    } catch (err) {
      failed.push(`${who}: ${err instanceof Error ? err.name : "error"}`);
    }
  }
  try {
    const shareId = run.ids.shareId;
    if (shareId) {
      const m = await apiMembership(people.v.api.client);
      if (m.share.status === "refund_pending") {
        await people.t1.api.client.coop.shares.refund({
          shareId,
          sentAt: new Date(Date.now() - 5_000).toISOString(),
          note: NOTE,
        });
        done.push("v:share-refund");
      }
    }
  } catch (err) {
    failed.push(`share refund: ${err instanceof Error ? err.name : "error"}`);
  }
  run.ctx.data("cleanup", { done, failed });
}
