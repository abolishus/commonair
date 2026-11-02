// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-coop's API steps: every co-op row is protected, so all of it goes through the API signed in
 * as the seeded members and staff, the co-op test hook (`COOP_TEST_HOOKS`: membership sync,
 * council recompute, proposal and election ticks) and the batch 7 hook (`OPS_TEST_HOOKS`: the jury
 * draw and close). The API writes its own audit and outbox rows. Each user signs in once.
 *
 * Governance runs as one loop: each pass ticks the proposal and election jobs, reads every tracked
 * proposal and election, and starts whatever is due (a submission whose gate opened, comments, a
 * council response, the votes, ballots). Slow work runs in the background so a pass never waits on
 * it; the first failure stops the loop.
 */
import { DEMO_FIXTURES } from "@commonair/contracts/fixtures";
import { INTERNAL_ROUTES, INTERNAL_SECRET_HEADER } from "@commonair/contracts/internal";
import type { ApiClient } from "../../api/client.ts";
import { sharesByStatus } from "../../coop-actors.ts";
import { CoopHooks, CoopHooksOff } from "../../coop-io.ts";
import { type MemberClass, reached, tallyMismatches, expectedTally } from "../../coop.ts";
import type { HarnessEnv } from "../../env.ts";
import { ApiTreasurer } from "../../money-actors.ts";
import { apiError } from "../../safety.ts";
import { type SignedInUser, UserFactory } from "../../users.ts";
import { seedApiFactory } from "../clients.ts";
import { sleep } from "../../wait.ts";
import { sharedCase } from "../../w3/jury.ts";
import type { Rng } from "../prng.ts";
import type { SeededUser } from "../types.ts";
import {
  type ElectionSpec,
  type GovernancePlan,
  type MembershipPlan,
  type ProposalSpec,
  changeFor,
  planJuryVotes,
} from "./plan.ts";

type ProposalView = Awaited<ReturnType<ApiClient["coop"]["proposals"]["get"]>>;

const HOOK_TIMEOUT_MS = 75_000;
/** A long window: what an open state must have left to count as still open after the seed. */
const LONG_WINDOW_MS = 86_400_000;
const LOOP_PAUSE_MS = 1_500;
const PARALLEL = 8;

/** Run `fn` over `items`, at most `PARALLEL` at a time. */
export async function inBatches<T>(items: readonly T[], fn: (item: T) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < items.length; i += PARALLEL) await Promise.all(items.slice(i, i + PARALLEL).map(fn));
}

const describeError = (err: unknown) => {
  const e = apiError(err);
  return e.code ? `${e.code}${e.reason ? `/${e.reason}` : ""}: ${String((err as Error).message)}` : String(err);
};

/** Signs each seeded account in once and keeps the session. */
export class CoopSessions {
  private readonly cache = new Map<string, Promise<SignedInUser>>();
  private readonly factory: UserFactory;
  private readonly byHandle: Map<string, SeededUser>;

  constructor(
    env: HarnessEnv,
    private readonly password: string,
    users: readonly SeededUser[],
  ) {
    this.byHandle = new Map(users.map((u) => [u.handle, u]));
    this.factory = new UserFactory({
      apiUrl: env.HARNESS_API_URL,
      webOrigin: new URL(env.HARNESS_WEB_URL).origin,
      mailpitUrl: env.HARNESS_MAILPIT_URL,
      mailpitAuth: env.HARNESS_MAILPIT_AUTH,
      emailDomain: DEMO_FIXTURES.emailDomain,
      apiFactory: seedApiFactory(env, "coop"),
    });
  }

  user(handle: string): SeededUser {
    const u = this.byHandle.get(handle);
    if (!u) throw new Error(`seed-coop: no seeded user "${handle}"`);
    return u;
  }

  as(handle: string): Promise<SignedInUser> {
    let p = this.cache.get(handle);
    if (!p) {
      const u = this.user(handle);
      p = this.factory
        .signIn({
          username: u.username,
          displayName: u.username,
          email: u.email,
          password: this.password,
          birthDate: "",
        })
        .catch((err: unknown) => {
          throw new Error(`seed-coop: sign-in as ${handle} failed: ${String(err)}`);
        });
      this.cache.set(handle, p);
    }
    return p;
  }

  async warm(handles: Iterable<string>): Promise<void> {
    await inBatches([...new Set(handles)], (h) => this.as(h));
  }

  get signedIn(): number {
    return this.cache.size;
  }
}

/** The co-op hook client, failing loudly when the hooks are off. */
export function coopHooks(env: HarnessEnv, secret: string, signal: AbortSignal): CoopHooks {
  return new CoopHooks(env.HARNESS_API_URL, secret, signal);
}

/** One tick that only throws when the hooks are off (a slow or busy tick just means the next pass). */
async function softTick(hooks: CoopHooks, job: Parameters<CoopHooks["tick"]>[0]): Promise<void> {
  try {
    await hooks.tick(job);
  } catch (err) {
    if (err instanceof CoopHooksOff) throw err;
  }
}

/** The batch 7 hook (`OPS_TEST_HOOKS`): run a jury job now. */
export async function b7Tick(
  env: HarnessEnv,
  secret: string,
  job: "jury-draw" | "jury-close",
  data: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, number>> {
  const res = await fetch(new URL(INTERNAL_ROUTES.b7Tick, env.HARNESS_API_URL), {
    method: "POST",
    headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: secret },
    body: JSON.stringify({ job, data }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(HOOK_TIMEOUT_MS)]),
  });
  if (res.status === 404) throw new Error(`seed-coop: ${INTERNAL_ROUTES.b7Tick} answered 404: set OPS_TEST_HOOKS=true`);
  if (!res.ok) throw new Error(`seed-coop: ${INTERNAL_ROUTES.b7Tick} (${job}) answered HTTP ${String(res.status)}`);
  return (await res.json()) as Record<string, number>;
}

// ---------------------------------------------------------------- memberships

export interface MembershipResult {
  rows: { appointments: number; sharesBought: number; sharesConfirmed: number; sharesRefunded: number };
}

/**
 * Appointments, share purchases and the refunded share's exit. Shares are manual transfers the
 * treasurer confirms; on a Stripe stack the API allows that only under COOP_TEST_HOOKS.
 */
export async function setupMemberships(
  sessions: CoopSessions,
  plan: MembershipPlan,
  signal: AbortSignal,
): Promise<MembershipResult> {
  const admin = await sessions.as("admin");
  const result: MembershipResult = {
    rows: { appointments: 0, sharesBought: 0, sharesConfirmed: 0, sharesRefunded: 0 },
  };
  for (const h of plan.workers) {
    signal.throwIfAborted();
    try {
      await admin.api.client.coop.appointWorker({
        username: sessions.user(h).username,
        boardMinuteRef: plan.boardMinute,
      });
      result.rows.appointments++;
    } catch (err) {
      throw new Error(`seed-coop: admin appointing ${h} as a worker failed: ${describeError(err)}`);
    }
  }

  const treasurerSession = await sessions.as("treasurer");
  const treasurer = new ApiTreasurer(treasurerSession.api.client);
  const buy = async (h: string) => {
    const u = await sessions.as(h);
    const r = await u.api.client.coop.buyShare({ returnPath: "/coop/membership" });
    if (r.kind !== "instructions") throw new Error("coop.buyShare answered a redirect (manual adapter expected)");
    result.rows.sharesBought++;
    return r.reference;
  };
  const [first, ...restHeld] = plan.shares.held;
  if (first) {
    let ref: string;
    try {
      ref = await buy(first);
    } catch (err) {
      const e = apiError(err);
      if (e.code === "PRECONDITION_FAILED")
        throw new Error(
          "seed-coop: coop.buyShare refused a manual share: set COOP_TEST_HOOKS=true on the api (shares on a Stripe stack)",
        );
      throw new Error(`seed-coop: ${first} buying a share failed: ${describeError(err)}`);
    }
    await treasurer.confirm(ref);
    result.rows.sharesConfirmed++;
  }
  for (const h of restHeld) {
    await treasurer.confirm(await buy(h));
    result.rows.sharesConfirmed++;
  }
  await inBatches(plan.shares.pending, async (h) => {
    signal.throwIfAborted();
    try {
      await buy(h);
    } catch (err) {
      throw new Error(`seed-coop: ${h} buying a share failed: ${describeError(err)}`);
    }
  });
  for (const h of plan.shares.refunded) {
    const u = await sessions.as(h);
    await treasurer.confirm(await buy(h));
    result.rows.sharesConfirmed++;
    await u.api.client.coop.exit({ class: "viewer" });
    const waiting = await sharesByStatus(treasurerSession.api.client, "refund_pending");
    const share = waiting.find((s) => s.userId === u.id);
    if (!share) throw new Error(`seed-coop: ${h}'s share is not refund_pending after leaving the viewer class`);
    await treasurerSession.api.client.coop.shares.refund({
      shareId: share.id,
      sentAt: new Date(Date.now() - 5_000).toISOString(),
      note: "",
    });
    result.rows.sharesRefunded++;
  }
  return result;
}

// ---------------------------------------------------------------- governance loop

interface ProposalState {
  spec: ProposalSpec;
  id: string | null;
  view: ProposalView | null;
  submitted: boolean;
  commented: boolean;
  responded: boolean;
  voted: boolean;
  busy: boolean;
  done: boolean;
  /** Why an open target was not held (a timing miss), for the notes. */
  missed: string | null;
}

interface ElectionState {
  spec: ElectionSpec;
  id: string | null;
  status: string | null;
  nominated: boolean;
  balloted: boolean;
  busy: boolean;
  done: boolean;
  elected: number;
}

export interface GovernanceResult {
  proposalIds: Map<string, string>;
  electionIds: Map<string, string>;
  /** Board seats from the closed election. */
  elected: number;
  comments: string[];
  councilBodies: string[];
  counts: { votes: number; comments: number; councilResponses: number; ballots: number; candidates: number };
  notes: string[];
  /** Seconds from the first submission to the last state reached. */
  seconds: number;
}

export interface GovernanceOptions {
  sessions: CoopSessions;
  hooks: CoopHooks;
  plan: GovernancePlan;
  /** Who publishes council responses (seated council members, council1 first). */
  responders: readonly string[];
  settings: () => Promise<{ key: string; value: unknown }[]>;
  signal: AbortSignal;
  budgetMs: number;
  progress: (line: string) => void;
  /** Called once the jury proposal is applied (the jury runs beside the loop). */
  onApplied?: (ref: string) => void;
}

const councilBody = (stance: string) =>
  `The creator council ${stance === "support" ? "supports" : stance === "oppose" ? "opposes" : "has mixed views on"} this proposal after review.`;

export async function runGovernance(o: GovernanceOptions): Promise<GovernanceResult> {
  const { sessions, hooks, plan, signal } = o;
  const started = Date.now();
  const states = plan.proposals.map((spec): ProposalState => ({
    spec,
    id: null,
    view: null,
    submitted: false,
    commented: false,
    responded: false,
    voted: false,
    busy: false,
    done: false,
    missed: null,
  }));
  const byRef = new Map(states.map((s) => [s.spec.ref, s]));
  const elections = plan.elections.map((spec): ElectionState => ({
    spec,
    id: null,
    status: null,
    nominated: false,
    balloted: false,
    busy: false,
    done: false,
    elected: 0,
  }));
  const counts = { votes: 0, comments: 0, councilResponses: 0, ballots: 0, candidates: 0 };
  const councilBodies: string[] = [];
  const failures: Error[] = [];
  const admin = await sessions.as("admin");

  const background = (st: { busy: boolean }, what: string, fn: () => Promise<void>) => {
    st.busy = true;
    fn()
      .catch((err: unknown) => failures.push(new Error(`seed-coop: ${what} failed: ${describeError(err)}`)))
      .finally(() => {
        st.busy = false;
      });
  };

  const refresh = async () => {
    const seen = new Map<string, ProposalView>();
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const page = await admin.api.client.coop.proposals.list({ limit: 100, ...(cursor ? { cursor } : {}) });
      for (const p of page.items) seen.set(p.id, p);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    for (const st of states) {
      if (!st.id || st.spec.target === "draft") continue;
      st.view =
        seen.get(st.id) ?? (await (await sessions.as(st.spec.author)).api.client.coop.proposals.get({ id: st.id }));
    }
    const list = await admin.api.client.coop.elections.list();
    for (const e of elections) {
      if (!e.id) continue;
      const v = list.find((x) => x.id === e.id);
      e.status = v?.status ?? e.status;
      if (v && v.status === "closed") e.elected = v.candidates.filter((c) => c.elected).length;
    }
  };

  const gateOpen = (st: ProposalState, now: number): boolean => {
    const g = st.spec.gate;
    if (g.after === "start") return true;
    const ref = byRef.get(g.ref);
    const status = ref?.view?.status;
    if (!status) return false;
    if (g.after === "status") return reached(status, g.status);
    if (g.after === "applied") return status === "applied" || status === "rejected";
    if (status !== "voting") return reached(status, "passed") || status === "rejected";
    const ends = ref.view?.timeline.votingEndsAt;
    return ends !== null && ends !== undefined && new Date(ends).getTime() - now <= g.seconds * 1_000;
  };

  const submit = (st: ProposalState) =>
    background(st, `submitting proposal ${st.spec.ref}`, async () => {
      const author = await sessions.as(st.spec.author);
      const changes = st.spec.change ? [changeFor(st.spec.change, await o.settings())] : [];
      const draft = await author.api.client.coop.proposals.create({
        title: st.spec.title,
        body: st.spec.body,
        changes,
        affectsCreators: st.spec.affectsCreators,
      });
      st.id = draft.id;
      if (st.spec.target === "draft") {
        st.done = true;
        return;
      }
      const p = await author.api.client.coop.proposals.submit({ id: draft.id });
      st.view = p;
      if (st.spec.target === "withdrawn") {
        st.view = await author.api.client.coop.proposals.withdraw({ id: draft.id });
      }
      for (const c of st.spec.comments) {
        const who = await sessions.as(c.author);
        await who.api.client.coop.proposals.comment({ id: draft.id, body: c.body });
        counts.comments++;
      }
      st.commented = true;
    });

  const respond = (st: ProposalState, id: string, stance: NonNullable<ProposalSpec["councilStance"]>) =>
    background(st, `council response to ${st.spec.ref}`, async () => {
      let last: unknown = null;
      for (const h of o.responders) {
        try {
          const who = await sessions.as(h);
          const body = councilBody(stance);
          await who.api.client.coop.proposals.councilRespond({ id, stance, body });
          councilBodies.push(body);
          counts.councilResponses++;
          st.responded = true;
          return;
        } catch (err) {
          last = err;
        }
      }
      throw last ?? new Error("no seated council member to respond");
    });

  const castVotes = (st: ProposalState, id: string) =>
    background(st, `votes on ${st.spec.ref}`, async () => {
      await inBatches(st.spec.votes, async (v) => {
        const who = await sessions.as(v.handle);
        try {
          await who.api.client.coop.proposals.vote({ id, choice: v.choice });
        } catch (err) {
          throw new Error(`${v.handle} voting: ${describeError(err)}`);
        }
        counts.votes++;
      });
      st.voted = true;
    });

  const checkDecided = (st: ProposalState) => {
    const v = st.view;
    if (!v) return;
    const status = v.status;
    if (status !== "applied" && status !== "rejected" && status !== "passed") return;
    if (status === "passed") return; // applying next
    if (status !== st.spec.target)
      throw new Error(
        `seed-coop: proposal ${st.spec.ref} ended ${status} (${v.tally?.reason ?? "no tally"}), planned ${st.spec.target}`,
      );
    if (!v.tally) throw new Error(`seed-coop: proposal ${st.spec.ref} is ${status} without a tally`);
    if (st.spec.reason && v.tally.reason !== st.spec.reason)
      throw new Error(`seed-coop: proposal ${st.spec.ref} tallied "${v.tally.reason}", planned "${st.spec.reason}"`);
    const b = v.tally.breakdown;
    const mismatches = tallyMismatches(expectedTally(st.spec.votes), {
      memberWide: b.memberWide,
      byClass: b.byClass,
    });
    if (mismatches.length > 0)
      throw new Error(
        `seed-coop: proposal ${st.spec.ref}'s tally differs from the votes cast: ${JSON.stringify(mismatches)}`,
      );
    st.done = true;
    o.onApplied?.(st.spec.ref);
  };

  const checkOpen = (st: ProposalState, now: number) => {
    const v = st.view;
    if (!v) return;
    const t = st.spec.target;
    const ends =
      t === "discussion"
        ? v.timeline.discussionEndsAt
        : t === "council_review"
          ? v.timeline.councilReviewEndsAt
          : t === "voting"
            ? v.timeline.votingEndsAt
            : null;
    if (t === "withdrawn") {
      if (v.status === "withdrawn" && st.commented) st.done = true;
      return;
    }
    if (v.status === t) {
      const long = ends !== null && new Date(ends).getTime() - now > LONG_WINDOW_MS;
      const finished =
        (t !== "council_review" || st.responded) &&
        (t !== "voting" || st.voted) &&
        (t !== "discussion" || st.commented);
      if (!long) {
        st.missed = `proposal ${st.spec.ref} reached ${t} with a short window (it ends ${ends ?? "never"}), so it moves on after the seed`;
        if (finished) st.done = true;
      } else if (finished) st.done = true;
      return;
    }
    if (reached(v.status, t as Parameters<typeof reached>[1]) || v.status === "rejected" || v.status === "withdrawn") {
      st.missed = `proposal ${st.spec.ref} moved past ${t} (now ${v.status}) before the seed could hold it there`;
      st.done = true;
    }
  };

  const stepProposal = (st: ProposalState, now: number) => {
    if (st.done || st.busy) return;
    if (!st.submitted) {
      if (!gateOpen(st, now)) return;
      st.submitted = true;
      submit(st);
      return;
    }
    const v = st.view;
    if (!st.id || !v || !st.commented) return;
    if (v.status === "council_review" && st.spec.councilStance && !st.responded) {
      respond(st, st.id, st.spec.councilStance);
      return;
    }
    if (v.status === "voting" && !st.voted) {
      if (st.spec.votes.length === 0) st.voted = true;
      else {
        castVotes(st, st.id);
        return;
      }
    }
    if (st.spec.target === "applied" || st.spec.target === "rejected") checkDecided(st);
    else checkOpen(st, now);
  };

  const stepElection = (e: ElectionState, now: number) => {
    if (e.done || e.busy) return;
    if (!e.id) {
      background(e, `the ${e.spec.cls} election`, async () => {
        const created = await admin.api.client.coop.elections.create({
          class: e.spec.cls,
          nominationsCloseAt: new Date(now + e.spec.nominationsSeconds * 1_000).toISOString(),
          votingEndsAt: new Date(now + e.spec.votingSeconds * 1_000).toISOString(),
        });
        e.id = created.id;
        e.status = created.status;
        for (const c of e.spec.candidates) {
          const who = await sessions.as(c.handle);
          await who.api.client.coop.elections.nominate({ id: created.id, statement: c.statement });
          counts.candidates++;
        }
        e.nominated = true;
      });
      return;
    }
    if (!e.nominated) return;
    if (e.spec.target === "nominating") {
      if (e.status === "nominating") e.done = true;
      return;
    }
    if (e.status === "voting" && !e.balloted) {
      const id = e.id;
      background(e, `ballots in the ${e.spec.cls} election`, async () => {
        await inBatches(e.spec.ballots, async (b) => {
          const who = await sessions.as(b.voter);
          await who.api.client.coop.elections.vote({
            id,
            candidateIds: b.approve.map((h) => sessions.user(h).id),
          });
          counts.ballots++;
        });
        e.balloted = true;
      });
      return;
    }
    if (e.spec.target === "voting" && e.status === "voting" && e.balloted) e.done = true;
    if (e.spec.target === "closed" && e.status === "closed") e.done = true;
  };

  let pass = 0;
  let lastProgress = Date.now();
  for (;;) {
    signal.throwIfAborted();
    if (failures.length > 0) throw failures[0];
    await softTick(hooks, "proposals-advance");
    if (pass % 3 === 0 && elections.some((e) => !e.done)) await softTick(hooks, "elections-advance");
    await refresh();
    const now = Date.now();
    for (const st of states) stepProposal(st, now);
    for (const e of elections) stepElection(e, now);
    if (failures.length > 0) throw failures[0];
    const open = [
      ...states.filter((s) => !s.done).map((s) => s.spec.ref),
      ...elections.filter((e) => !e.done).map((e) => `election:${e.spec.cls}`),
    ];
    if (open.length === 0 && ![...states, ...elections].some((s) => s.busy)) break;
    if (Date.now() - started > o.budgetMs)
      throw new Error(
        `seed-coop: governance did not finish within ${o.budgetMs / 1000} s; still open: ${open.join(", ")}`,
      );
    if (Date.now() - lastProgress > 10_000) {
      o.progress(`governance: ${open.length} open (${open.slice(0, 6).join(", ")})`);
      lastProgress = Date.now();
    }
    pass++;
    await sleep(LOOP_PAUSE_MS, signal);
  }

  return {
    proposalIds: new Map(states.flatMap((s) => (s.id ? [[s.spec.ref, s.id] as const] : []))),
    electionIds: new Map(elections.flatMap((e) => (e.id ? [[e.spec.cls, e.id] as const] : []))),
    elected: elections.reduce((n, e) => n + e.elected, 0),
    comments: plan.proposals.flatMap((p) => p.comments.map((c) => c.body)),
    councilBodies,
    counts,
    notes: states.flatMap((s) => (s.missed ? [`seed-coop: ${s.missed}`] : [])),
    seconds: Math.round((Date.now() - started) / 1000),
  };
}

// ---------------------------------------------------------------- jury

export interface JuryResult {
  panelId: string | null;
  optIns: number;
  seated: number;
  sampled: string[];
  votes: number;
  flagged: number;
  publishedRows: number;
  shownRows: number;
  seconds: number;
}

export interface JuryOptions {
  sessions: CoopSessions;
  env: HarnessEnv;
  secret: string;
  optIns: readonly string[];
  rng: Rng;
  signal: AbortSignal;
  /** The panel's sampled cases from the database (checked against the exclusions by the caller). */
  sampled: (panelId: string) => Promise<string[]>;
}

/** Opt-ins, the draw, the votes (all disagree on one shared case) and the close. */
export async function runJury(o: JuryOptions): Promise<JuryResult> {
  const started = Date.now();
  const members = await Promise.all(o.optIns.map((h) => o.sessions.as(h)));
  for (const [i, m] of members.entries()) {
    const st = await m.api.client.jury.optIn().catch((err: unknown) => {
      throw new Error(`seed-coop: ${o.optIns[i] ?? "?"} opting in to the jury failed: ${describeError(err)}`);
    });
    if (!st.optedIn || !st.eligible) throw new Error(`seed-coop: ${o.optIns[i] ?? "?"} is not an eligible juror`);
  }
  const drawn = await b7Tick(o.env, o.secret, "jury-draw", {}, o.signal);
  if ((drawn.drawn ?? 0) < 1) throw new Error(`seed-coop: the jury draw seated no panel (${JSON.stringify(drawn)})`);
  const seated: SignedInUser[] = [];
  let panelId: string | null = null;
  for (const m of members) {
    const st = await m.api.client.jury.status();
    if (st.seat) {
      seated.push(m);
      panelId = st.seat.panelId;
    }
  }
  if (!panelId) throw new Error("seed-coop: the jury draw seated none of the opted-in members");
  const sampled = await o.sampled(panelId);
  const lists = await Promise.all(seated.map((m) => m.api.client.jury.cases()));
  const target = sharedCase(lists.map((l) => l.map((c) => c.id)));
  const planned = planJuryVotes(
    o.rng,
    lists.map((l) => l.map((c) => c.id)),
    target,
  );
  for (const v of planned) {
    const juror = seated[v.juror] as SignedInUser;
    await juror.api.client.jury.vote({ id: v.caseId, vote: v.vote, reasonCode: v.reasonCode });
  }
  const closed = await b7Tick(o.env, o.secret, "jury-close", { panelId }, o.signal);
  if ((closed.closed ?? 0) < 1)
    throw new Error(`seed-coop: the jury close did not close the panel (${JSON.stringify(closed)})`);
  const period = new Date().toISOString().slice(0, 7);
  const results = await (await o.sessions.as("member1")).api.client.jury.results({ period });
  return {
    panelId,
    optIns: members.length,
    seated: seated.length,
    sampled,
    votes: planned.length,
    flagged: closed.flagged ?? 0,
    publishedRows: results.rows.length,
    shownRows: results.rows.filter((r) => !r.agree.suppressed || !r.disagree.suppressed || !r.unsure.suppressed).length,
    seconds: Math.round((Date.now() - started) / 1000),
  };
}

// ---------------------------------------------------------------- council

/** Tick the recompute until a council term with members is seated; returns the seated user ids. */
export async function seatCouncil(hooks: CoopHooks, sessions: CoopSessions, timeoutMs: number): Promise<string[]> {
  const viewer = await sessions.as("member1");
  const council = await hooks.tickUntil(
    "council-recompute",
    "a seated creator council",
    async () => {
      const c = await viewer.api.client.coop.council();
      return c.termId && c.members.length > 0 ? c : null;
    },
    { timeoutMs },
  );
  return council.members.map((m) => m.user.id);
}

export type { MemberClass };
