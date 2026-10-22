// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The co-op over REST against a real database (FAST_GOVERNANCE, the API as the app role): shares,
 * memberships, proposals through discussion, council review, votes and a decision, the protected
 * decision the database refuses, elections, patronage with two-person approval, transparency, exit
 * and refund, and the test hook. The worker's steps (advancing proposals, deciding them) are played
 * here by direct writes as the app role, so every one of them passes the same triggers. The tests
 * share state and run in order.
 */
import { and, eq, sql } from "drizzle-orm";
import { Worker } from "bullmq";
import { Valkey } from "iovalkey";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { INTERNAL_ROUTES, INTERNAL_SECRET_HEADER, QUEUES } from "@commonair/contracts/internal";
import { type Database, schema } from "@commonair/db";
import { FAST_GOVERNANCE } from "@commonair/db/testing";
import { loadSettings, rulesFor } from "@commonair/governance";
import { closeCoopTickRunner } from "../src/coop/hooks.ts";
import { createApp } from "../src/index.ts";
import { VALKEY_URL, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type Account = Awaited<ReturnType<typeof signUpAndSignIn>>;
type Res<T = Record<string, unknown>> = { status: number; body: T };
interface Err {
  code: string;
  message: string;
  data?: Record<string, unknown>;
}
interface Proposal {
  id: string;
  status: string;
  kind: string;
  affectsCreators: boolean;
  changes: { key: string; from: unknown; to: unknown; protected: boolean }[];
  tally: {
    passed: boolean;
    reason: string;
    breakdown: { byClass: Record<string, { yes: number; no: number }> };
  } | null;
  participation: { voted: number; eligible: number } | null;
  myVote: string | null;
  canVote: boolean;
  councilResponse: { stance: string } | null;
  councilResponseMissed: boolean;
}
interface MembershipView {
  memberships: { id: string; class: string; status: string; basis: string }[];
  eligibility: { class: string; eligible: boolean; basis: string | null }[];
  share: { id: string; status: string; amount: { cents: number } } | null;
}

let api: TestApi;
let viewer: Account; // V: buys the share
let s1: Account; // streamer, seated on the council
let s2: Account; // streamer, not seated
let worker: Account; // W: appointed by the board
let outsider: Account; // never a member
let t1: Account; // treasurer: confirms, runs patronage
let t2: Account; // treasurer: approves
let admin: Account;
let prefix = "";

const owner = () => api.db.db;
/** Writes standing in for the worker run as the least-privilege app role, through every trigger. */
const app = (): Database => api.db.app.db;
const startedAt = new Date(Date.now() - 60_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  prefix = `test-coop-${crypto.randomUUID().slice(0, 8)}`;
  api = await startApi({
    governance: FAST_GOVERNANCE,
    env: { COOP_TEST_HOOKS: "true", WORKER_BULL_PREFIX: prefix },
  });
  [viewer, s1, s2, worker, outsider, t1, t2, admin] = await Promise.all([
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
  ]);
  for (const [a, role] of [
    [t1, "treasurer"],
    [t2, "treasurer"],
    [admin, "admin"],
  ] as const)
    await owner().update(schema.users).set({ role }).where(eq(schema.users.id, a.userId));
}, 240_000);
afterAll(async () => {
  if (api) await closeCoopTickRunner(api.deps);
  await api?.stop();
});

const call = <T = Record<string, unknown>>(as: Account | null, method: string, path: string, body?: unknown) =>
  (as
    ? as.client.call<T>(method, path, body)
    : fetch(`${api.url}${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }).then(async (res) => ({
        status: res.status,
        body: (await res.json().catch(() => null)) as T,
        res,
      }))) as Promise<Res<T>>;

async function auditOf(action: string, subjectId?: string) {
  return owner()
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.action, action), subjectId ? eq(schema.auditLog.subjectId, subjectId) : undefined));
}
async function eventsOf(type: string, match: Record<string, unknown> = {}) {
  const rows = await owner().select().from(schema.events).where(eq(schema.events.type, type));
  return rows.filter((r) => Object.entries(match).every(([k, v]) => (r.payload as Record<string, unknown>)[k] === v));
}
async function expectLedgerBalanced() {
  const off = await owner().execute<{ transaction_id: string }>(sql`
    select transaction_id from ledger_entries group by transaction_id, currency having sum(amount_cents) <> 0`);
  expect([...off]).toEqual([]);
}
async function expectRefused(p: PromiseLike<unknown>, pattern: RegExp) {
  const err = await Promise.resolve(p).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, "expected the database to refuse").toBeInstanceOf(Error);
  const e = err as Error & { cause?: Error };
  expect(e.cause?.message ?? e.message).toMatch(pattern);
}

// Membership and shares -------------------------------------------------------------------------

let share: { paymentId: string; reference: string; amount: { cents: number; currency: string } };

describe("shares and memberships", () => {
  test("buying a share returns manual instructions and records it pending", async () => {
    const r = await call<typeof share & { kind: string; instructions: string }>(viewer, "POST", "/api/coop/shares", {
      returnPath: "/coop/membership",
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: "instructions", amount: { cents: 500 } });
    expect(r.body.instructions).toContain(r.body.reference);
    share = r.body;
    const [p] = await owner().select().from(schema.payments).where(eq(schema.payments.id, share.paymentId));
    expect(p).toMatchObject({ kind: "membership_share", status: "pending", channelId: null, amountCents: 500 });
    const [s] = await owner()
      .select()
      .from(schema.membershipShares)
      .where(eq(schema.membershipShares.paymentId, share.paymentId));
    expect(s).toMatchObject({ status: "pending", userId: viewer.userId, amountCents: 500 });
    expect(await auditOf("coop.share.request", s?.id)).toHaveLength(1);
    expect(await eventsOf("coop.share.update", { share_id: s?.id, status: "pending" })).toHaveLength(1);
  });

  test("a second share is refused while one is open", async () => {
    const r = await call<Err>(viewer, "POST", "/api/coop/shares", { returnPath: "/coop/membership" });
    expect(r.status).toBe(409);
  });

  test("a reference collision mints a fresh reference instead of a conflict", async () => {
    const buyer = await signUpAndSignIn(api);
    // The bytes `manualReference` turns into the reference already taken by the first share.
    const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let bits = 0n;
    for (const ch of share.reference.slice(3)) bits = (bits << 5n) | BigInt(ALPHABET.indexOf(ch));
    const taken = Uint8Array.from({ length: 5 }, (_, i) => Number((bits >> BigInt((4 - i) * 8)) & 0xffn));
    const real = crypto.getRandomValues.bind(crypto);
    let forced = 0;
    const spy = vi.spyOn(crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(a: T): T => {
      if (forced === 0 && a instanceof Uint8Array && a.length === 5) {
        forced++;
        a.set(taken);
        return a;
      }
      return real(a as Uint8Array) as unknown as T;
    });
    try {
      const r = await call<typeof share>(buyer, "POST", "/api/coop/shares", { returnPath: "/coop/membership" });
      expect(forced).toBe(1);
      expect(r.status).toBe(200);
      expect(r.body.reference).toMatch(/^CA-/);
      expect(r.body.reference).not.toBe(share.reference);
    } finally {
      spy.mockRestore();
    }
    const rows = await owner()
      .select()
      .from(schema.membershipShares)
      .where(eq(schema.membershipShares.userId, buyer.userId));
    expect(rows).toHaveLength(1);
    expect(await auditOf("coop.share.request", rows[0]?.id)).toHaveLength(1);
  });

  test("with Stripe configured, shares are refused (manual only in E5)", async () => {
    const stripe = createApp({ ...api.deps, env: { ...api.deps.env, PAYMENTS_PROVIDER: "stripe" } });
    const res = await stripe.fetch(
      new Request(`${api.url}/api/coop/shares`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
          cookie: outsider.client.jar.header(),
        },
        body: JSON.stringify({ returnPath: "/coop/membership" }),
      }),
    );
    expect(res.status).toBe(412);
    expect(((await res.json()) as Err).data).toEqual({ requirement: "manual_shares" });
  });

  test("the treasurer's confirm makes the share held and the buyer a viewer member, with a balanced posting", async () => {
    const r = await call(t1, "POST", `/api/treasurer/payments/${share.paymentId}/confirm`, {
      receivedAt: new Date().toISOString(),
    });
    expect(r.status).toBe(200);
    const [s] = await owner()
      .select()
      .from(schema.membershipShares)
      .where(eq(schema.membershipShares.paymentId, share.paymentId));
    expect(s).toMatchObject({ status: "held" });
    expect(s?.purchasedAt).not.toBeNull();
    const [p] = await owner().select().from(schema.payments).where(eq(schema.payments.id, share.paymentId));
    expect(p?.status).toBe("succeeded");
    const posting = await owner()
      .select()
      .from(schema.ledgerTransactions)
      .where(eq(schema.ledgerTransactions.idempotencyKey, `share-purchase:${s?.id}`));
    expect(posting).toHaveLength(1);
    await expectLedgerBalanced();

    const view = await call<MembershipView>(viewer, "GET", "/api/coop/membership");
    expect(view.body.memberships).toEqual([
      expect.objectContaining({ class: "viewer", status: "active", basis: "share" }),
    ]);
    expect(view.body.share).toMatchObject({ status: "held", amount: { cents: 500 } });
    expect(view.body.eligibility.find((e) => e.class === "viewer")).toMatchObject({ eligible: true, basis: "share" });

    expect(await auditOf("payment.confirm", share.paymentId)).toHaveLength(1);
    const membershipId = view.body.memberships[0]?.id ?? "";
    const [activate] = await auditOf("membership.activate", membershipId);
    expect(activate?.details).toMatchObject({ class: "viewer", basis: "share" });
    expect(await eventsOf("coop.share.update", { share_id: s?.id, status: "held" })).toHaveLength(1);
    expect(await eventsOf("coop.membership.update", { membership_id: membershipId, status: "active" })).toHaveLength(1);
  });

  test("confirming twice, or buying again as a member, is refused", async () => {
    const again = await call(t1, "POST", `/api/treasurer/payments/${share.paymentId}/confirm`, {
      receivedAt: new Date().toISOString(),
    });
    expect(again.status).toBe(409);
    expect((await call(viewer, "POST", "/api/coop/shares", { returnPath: "/coop/membership" })).status).toBe(409);
  });

  test("the database refuses a share held without its posting", async () => {
    const [u] = await app()
      .insert(schema.users)
      .values({ name: "sharetest", username: "sharetest", email: "sharetest@test.invalid" })
      .returning();
    const [s] = await app()
      .insert(schema.membershipShares)
      .values({ userId: u!.id, amountCents: 500, currency: "usd" })
      .returning();
    await expectRefused(
      app()
        .update(schema.membershipShares)
        .set({ status: "held", purchasedAt: new Date() })
        .where(eq(schema.membershipShares.id, s!.id)),
      /held only once its payment succeeded/,
    );
  });

  test("an admin appoints a worker member once; others cannot", async () => {
    const body = { username: worker.username, boardMinuteRef: "Board minute 2026-10-21 item 4" };
    expect((await call(outsider, "POST", "/api/coop/workers", body)).status).toBe(403);
    expect((await call(admin, "POST", "/api/coop/workers", body)).status).toBe(200);
    expect((await call(admin, "POST", "/api/coop/workers", body)).status).toBe(409);
    const view = await call<MembershipView>(worker, "GET", "/api/coop/membership");
    const m = view.body.memberships.find((x) => x.class === "worker");
    expect(m).toMatchObject({ status: "active", basis: "board_appointment" });
    const [a] = await auditOf("membership.appoint", m?.id);
    expect(a?.reason).toBe("Board minute 2026-10-21 item 4");
    expect(JSON.stringify(a?.details)).not.toContain("Board minute");
    expect(await eventsOf("coop.membership.update", { membership_id: m?.id })).toHaveLength(1);
  });

  test("streamers (the sync's job) and a seated council", async () => {
    await app()
      .insert(schema.memberships)
      .values(
        [s1, s2].map((s) => ({ userId: s.userId, class: "streamer" as const, basis: "streaming_hours" as const })),
      );
    await app().transaction(async (tx) => {
      const [term] = await tx
        .insert(schema.councilTerms)
        .values({
          startsAt: new Date(Date.now() - 60_000),
          endsAt: new Date(Date.now() + 86_400_000),
          method: { version: "test", size: 1 },
        })
        .returning();
      await tx
        .insert(schema.councilMembers)
        .values({ termId: term!.id, userId: s1.userId, rank: 1, contributionScore: 1 });
    });
    const council = await call<{ termId: string; members: { user: { id: string }; rank: number }[] }>(
      null,
      "GET",
      "/api/coop/council",
    );
    expect(council.body.termId).not.toBeNull();
    expect(council.body.members).toEqual([
      expect.objectContaining({ user: expect.objectContaining({ id: s1.userId }), rank: 1 }),
    ]);
  });
});

// Proposals --------------------------------------------------------------------------------------

let ordinary: Proposal; // S2: discovery.ranking, affects creators
let protectedP: Proposal; // W: platform.cut

async function rankingWith(spotlightSlots: number) {
  const settings = await loadSettings(owner());
  return { ...(settings["discovery.ranking"] as Record<string, unknown>), spotlightSlots };
}

async function openVoting(id: string) {
  const [p] = await app().select().from(schema.proposals).where(eq(schema.proposals.id, id));
  const rules = rulesFor(p!.kind, await loadSettings(app()), { affectsCreators: p!.affectsCreators });
  await app()
    .update(schema.proposals)
    // Long enough for the voting test's calls under parallel test load (6 s was flaky).
    .set({ status: "voting", rules, votingEndsAt: sql`clock_timestamp() + interval '15 seconds'` })
    .where(eq(schema.proposals.id, id));
}

/** Sleep until every proposal's voting window has closed by the database clock. */
async function waitForWindowsToClose(ids: string[]) {
  const [r] = await app().execute<{ ms: string | null }>(sql`
    select ceil(extract(epoch from (max(voting_ends_at) - clock_timestamp())) * 1000)::text as ms
    from proposals where id in ${sql.raw(`(${ids.map((i) => `'${i}'`).join(",")})`)}`);
  const ms = Number(r?.ms ?? 0);
  if (ms > 0) await sleep(ms + 300);
}

/** What the worker records: the database's own tally as the tallies row. */
async function tallyRow(id: string) {
  const [r] = await app().execute<{
    passed: boolean;
    reason: string;
    mw: unknown;
    s: unknown;
    v: unknown;
    w: unknown;
  }>(sql`
    select t.passed, t.reason,
           commonair_tally_counts(${id}::uuid, null) as mw,
           commonair_tally_counts(${id}::uuid, 'streamer') as s,
           commonair_tally_counts(${id}::uuid, 'viewer') as v,
           commonair_tally_counts(${id}::uuid, 'worker') as w
      from commonair_governance_tally(${id}::uuid) t`);
  if (!r) throw new Error("no tally");
  type Count = { eligible: number; yes: number; no: number; abstain: number };
  return {
    proposalId: id,
    passed: r.passed,
    reason: r.reason,
    breakdown: {
      memberWide: r.mw as Count,
      byClass: { streamer: r.s as Count, viewer: r.v as Count, worker: r.w as Count },
      checks: [],
    },
  };
}

describe("proposals", () => {
  test("non-members cannot draft", async () => {
    const r = await call<Err>(outsider, "POST", "/api/coop/proposals", {
      title: "Not a member",
      body: "x",
      changes: [],
      affectsCreators: false,
    });
    expect(r.status).toBe(412);
    expect(r.body.data).toEqual({ requirement: "membership" });
  });

  test("members draft; drafts are visible only to their author", async () => {
    const a = await call<Proposal>(s2, "POST", "/api/coop/proposals", {
      title: "More spotlight slots",
      body: "Let more small channels in.",
      changes: [{ key: "discovery.ranking", value: await rankingWith(4) }],
      affectsCreators: true,
    });
    expect(a.status).toBe(200);
    ordinary = a.body;
    expect(ordinary).toMatchObject({ status: "draft", kind: "ordinary", affectsCreators: true });
    expect(ordinary.changes[0]).toMatchObject({ key: "discovery.ranking", protected: false });

    const b = await call<Proposal>(worker, "POST", "/api/coop/proposals", {
      title: "Lower the streamer share",
      body: "Fund the co-op.",
      changes: [{ key: "platform.cut", value: { streamerShare: 0.85, coopShare: 0.15 } }],
      affectsCreators: false,
    });
    expect(b.status).toBe(200);
    protectedP = b.body;
    expect(protectedP).toMatchObject({ kind: "protected", affectsCreators: true });
    expect(protectedP.changes[0]).toMatchObject({ protected: true, from: { streamerShare: 0.9, coopShare: 0.1 } });

    expect((await call(outsider, "GET", `/api/coop/proposals/${ordinary.id}`)).status).toBe(404);
    expect((await call(null, "GET", `/api/coop/proposals/${ordinary.id}`)).status).toBe(404);
    expect((await call(s2, "GET", `/api/coop/proposals/${ordinary.id}`)).status).toBe(200);
    const anon = await call<{ items: Proposal[] }>(null, "GET", "/api/coop/proposals");
    expect(anon.body.items.map((p) => p.id)).not.toContain(ordinary.id);
    const mine = await call<{ items: Proposal[] }>(s2, "GET", "/api/coop/proposals?status=draft");
    expect(mine.body.items.map((p) => p.id)).toEqual([ordinary.id]);

    const [audit] = await auditOf("proposal.create", ordinary.id);
    expect(audit?.details).toMatchObject({ kind: "ordinary", affectsCreators: true });
    // The public event starts at submit: a draft's title never leaves the platform.
    expect(await eventsOf("coop.proposal.update", { proposal_id: ordinary.id })).toHaveLength(0);
  });

  test("bad changes are refused", async () => {
    const unknown = await call(s2, "POST", "/api/coop/proposals", {
      title: "Unknown key",
      body: "x",
      changes: [{ key: "no.such.setting", value: 1 }],
      affectsCreators: false,
    });
    expect(unknown.status).toBe(400);
    const malformed = await call(s2, "POST", "/api/coop/proposals", {
      title: "Malformed value",
      body: "x",
      changes: [{ key: "discovery.ranking", value: { spotlightSlots: 4 } }],
      affectsCreators: false,
    });
    expect(malformed.status).toBe(400);
  });

  test("only the author edits and submits", async () => {
    const edit = {
      title: "More spotlight slots, please",
      body: "Let more small channels in.",
      changes: [{ key: "discovery.ranking", value: await rankingWith(4) }],
      affectsCreators: true,
    };
    expect((await call(s1, "PATCH", `/api/coop/proposals/${ordinary.id}`, edit)).status).toBe(404);
    const ok = await call<Proposal>(s2, "PATCH", `/api/coop/proposals/${ordinary.id}`, edit);
    expect(ok.status).toBe(200);
    expect(await auditOf("proposal.update", ordinary.id)).toHaveLength(1);
    expect(await eventsOf("coop.proposal.update", { proposal_id: ordinary.id })).toHaveLength(0);

    expect((await call(s1, "POST", `/api/coop/proposals/${ordinary.id}/submit`)).status).toBe(404);
    for (const [who, p] of [
      [s2, ordinary],
      [worker, protectedP],
    ] as const) {
      const r = await call<Proposal>(who, "POST", `/api/coop/proposals/${p.id}/submit`);
      expect(r.status).toBe(200);
      expect(r.body.status).toBe("discussion");
      expect(await auditOf("proposal.submit", p.id)).toHaveLength(1);
      expect(await eventsOf("coop.proposal.update", { proposal_id: p.id, status: "discussion" })).toHaveLength(1);
    }
    expect((await call(s1, "PATCH", `/api/coop/proposals/${ordinary.id}`, edit)).status).toBe(403);
    expect((await call(s2, "POST", `/api/coop/proposals/${ordinary.id}/submit`)).status).toBe(409);
    expect((await call(s1, "POST", `/api/coop/proposals/${ordinary.id}/withdraw`)).status).toBe(403);
  });

  test("withdraw before voting", async () => {
    const d = await call<Proposal>(viewer, "POST", "/api/coop/proposals", {
      title: "Withdrawn idea",
      body: "x",
      changes: [],
      affectsCreators: false,
    });
    const w = await call<Proposal>(viewer, "POST", `/api/coop/proposals/${d.body.id}/withdraw`);
    expect(w.body.status).toBe("withdrawn");
    expect(await auditOf("proposal.withdraw", d.body.id)).toHaveLength(1);
    // Discarding a draft never publishes it: still the author's only, and no public event.
    for (const who of [null, outsider, s1]) {
      expect((await call(who, "GET", `/api/coop/proposals/${d.body.id}`)).status).toBe(404);
      expect((await call(who, "GET", `/api/coop/proposals/${d.body.id}/comments`)).status).toBe(404);
      for (const q of ["", "?status=withdrawn"]) {
        const l = await call<{ items: Proposal[] }>(who, "GET", `/api/coop/proposals${q}`);
        expect(l.body.items.map((p) => p.id)).not.toContain(d.body.id);
      }
    }
    expect((await call(viewer, "GET", `/api/coop/proposals/${d.body.id}`)).status).toBe(200);
    const own = await call<{ items: Proposal[] }>(viewer, "GET", "/api/coop/proposals?status=withdrawn");
    expect(own.body.items.map((p) => p.id)).toContain(d.body.id);
    expect(await eventsOf("coop.proposal.update", { proposal_id: d.body.id })).toHaveLength(0);
  });

  test("members comment during discussion; others cannot", async () => {
    const c = await call<{ id: string; author: { id: string } }>(
      viewer,
      "POST",
      `/api/coop/proposals/${ordinary.id}/comments`,
      { body: "Yes, good for small channels." },
    );
    expect(c.status).toBe(200);
    expect(c.body.author.id).toBe(viewer.userId);
    const no = await call<Err>(outsider, "POST", `/api/coop/proposals/${ordinary.id}/comments`, { body: "Hi" });
    expect(no.status).toBe(412);
    const list = await call<{ items: { id: string }[] }>(null, "GET", `/api/coop/proposals/${ordinary.id}/comments`);
    expect(list.body.items.map((x) => x.id)).toEqual([c.body.id]);
    const [a] = await auditOf("proposal.comment", ordinary.id);
    expect(a?.details).toEqual({ proposalId: ordinary.id, commentId: c.body.id });
    expect(await eventsOf("coop.proposal.comment", { comment_id: c.body.id })).toHaveLength(1);
  });

  test("council review: only a seated member responds, once", async () => {
    for (const p of [ordinary, protectedP])
      await app().update(schema.proposals).set({ status: "council_review" }).where(eq(schema.proposals.id, p.id));
    const body = { stance: "support", body: "The council supports this." };
    expect((await call(s2, "POST", `/api/coop/proposals/${ordinary.id}/council-response`, body)).status).toBe(403);
    expect((await call(viewer, "POST", `/api/coop/proposals/${ordinary.id}/council-response`, body)).status).toBe(403);
    const r = await call<Proposal>(s1, "POST", `/api/coop/proposals/${ordinary.id}/council-response`, body);
    expect(r.status).toBe(200);
    expect(r.body.councilResponse).toMatchObject({ stance: "support" });
    expect((await call(s1, "POST", `/api/coop/proposals/${ordinary.id}/council-response`, body)).status).toBe(409);
    const [a] = await auditOf("council.respond", ordinary.id);
    expect(a?.details).toMatchObject({ stance: "support" });
    expect(await eventsOf("coop.council.response", { proposal_id: ordinary.id })).toHaveLength(1);
  });

  test("voting: electorate only, a change updates the voter's own row, never a running tally", async () => {
    await sleep(1200); // council review (1 s) must end before voting opens
    await openVoting(ordinary.id);
    await openVoting(protectedP.id);

    const view = await call<Proposal>(null, "GET", `/api/coop/proposals/${protectedP.id}`);
    expect(view.body).toMatchObject({ status: "voting", councilResponse: null, councilResponseMissed: true });

    const no = await call<Err>(outsider, "POST", `/api/coop/proposals/${ordinary.id}/vote`, { choice: "yes" });
    expect(no.status).toBe(403);
    expect(no.body.data).toEqual({ reason: "not_in_electorate" });

    // Concurrent votes and changes by one member: always exactly one row.
    const burst = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        call(worker, "POST", `/api/coop/proposals/${ordinary.id}/vote`, { choice: i % 2 ? "no" : "yes" }),
      ),
    );
    expect(burst.map((r) => r.status)).toEqual(Array(8).fill(200));
    const rows = await owner()
      .select()
      .from(schema.votes)
      .where(and(eq(schema.votes.proposalId, ordinary.id), eq(schema.votes.userId, worker.userId)));
    expect(rows).toHaveLength(1);

    for (const who of [viewer, worker, s1, s2])
      expect((await call(who, "POST", `/api/coop/proposals/${ordinary.id}/vote`, { choice: "yes" })).status).toBe(200);
    for (const [who, choice] of [
      [viewer, "yes"],
      [worker, "yes"],
      [s2, "yes"],
      [s1, "no"],
    ] as const) {
      const r = await call<Proposal>(who, "POST", `/api/coop/proposals/${protectedP.id}/vote`, { choice });
      expect(r.status).toBe(200);
      expect(r.body.myVote).toBe(choice);
      expect(r.body.tally).toBeNull();
    }
    const asS1 = await call<Proposal>(s1, "GET", `/api/coop/proposals/${protectedP.id}`);
    expect(asS1.body).toMatchObject({ myVote: "no", canVote: true, participation: { voted: 4, eligible: 4 } });
    expect(asS1.body.tally).toBeNull();
    const anon = await call<Proposal>(null, "GET", `/api/coop/proposals/${protectedP.id}`);
    expect(anon.body).toMatchObject({ myVote: null, canVote: false, participation: { voted: 4, eligible: 4 } });

    // Secret ballot: audit rows and events carry the proposal id only.
    for (const a of await auditOf("proposal.vote", protectedP.id))
      expect(a.details).toEqual({ proposalId: protectedP.id });
    for (const e of await eventsOf("coop.vote.cast")) expect(Object.keys(e.payload as object)).toEqual(["proposal_id"]);
    expect(await auditOf("proposal.vote", protectedP.id)).toHaveLength(4);
  });

  test("after the window, votes are refused (API and database)", async () => {
    await waitForWindowsToClose([ordinary.id, protectedP.id]);
    const r = await call<Err>(viewer, "POST", `/api/coop/proposals/${ordinary.id}/vote`, { choice: "no" });
    expect(r.status).toBe(409);
    expect(r.body.data).toEqual({ reason: "voting_closed" });
    await expectRefused(
      app()
        .update(schema.votes)
        .set({ choice: "no" })
        .where(and(eq(schema.votes.proposalId, ordinary.id), eq(schema.votes.userId, viewer.userId))),
      /voting is not open/,
    );
  });

  test("the protected decision cannot be recorded as passed; rejected, it shows the tally", async () => {
    const id = protectedP.id;
    await expectRefused(
      app().update(schema.proposals).set({ status: "passed" }).where(eq(schema.proposals.id, id)),
      /did not pass/,
    );
    const t = await tallyRow(id);
    expect(t).toMatchObject({ passed: false, reason: "streamer-class majority not met" });
    await expectRefused(
      app()
        .insert(schema.tallies)
        .values({ ...t, passed: true }),
      /decided proposal/,
    );
    await app().transaction(async (tx) => {
      await tx.update(schema.proposals).set({ status: "rejected" }).where(eq(schema.proposals.id, id));
      await tx.insert(schema.tallies).values(t);
    });
    await expectRefused(
      app()
        .update(schema.governanceSettings)
        .set({ value: { streamerShare: 0.85, coopShare: 0.15 }, updatedByProposalId: id })
        .where(eq(schema.governanceSettings.key, "platform.cut")),
      /passed proposal|passed, unapplied|protected decision/,
    );
    const v = await call<Proposal>(null, "GET", `/api/coop/proposals/${id}`);
    expect(v.body).toMatchObject({ status: "rejected", participation: { voted: 4, eligible: 4 } });
    expect(v.body.tally).toMatchObject({ passed: false, reason: "streamer-class majority not met" });
    expect(v.body.tally?.breakdown.byClass.streamer).toMatchObject({ yes: 1, no: 1 });
    const settings = await call<
      { key: string; value: unknown; protected: boolean; updatedByProposalId: string | null }[]
    >(null, "GET", "/api/coop/settings");
    expect(settings.body.find((s) => s.key === "platform.cut")).toMatchObject({
      value: { streamerShare: 0.9, coopShare: 0.1 },
      protected: true,
      updatedByProposalId: null,
    });
  });

  test("the ordinary decision passes through the views with its tally", async () => {
    const t = await tallyRow(ordinary.id);
    expect(t.passed).toBe(true);
    await app().transaction(async (tx) => {
      await tx.update(schema.proposals).set({ status: "passed" }).where(eq(schema.proposals.id, ordinary.id));
      await tx.insert(schema.tallies).values(t);
    });
    const v = await call<Proposal>(viewer, "GET", `/api/coop/proposals/${ordinary.id}`);
    expect(v.body).toMatchObject({ status: "passed", myVote: "yes", canVote: false, councilResponseMissed: false });
    expect(v.body.tally).toMatchObject({ passed: true });
    expect(v.body.tally?.breakdown.byClass).toMatchObject({
      streamer: { yes: 2 },
      viewer: { yes: 1 },
      worker: { yes: 1 },
    });
    expect((await call(viewer, "POST", `/api/coop/proposals/${ordinary.id}/comments`, { body: "late" })).status).toBe(
      409,
    );
  });
});

// Elections ----------------------------------------------------------------------------------------

describe("elections", () => {
  let electionId = "";
  test("an admin schedules one; members of the class stand and vote once", async () => {
    const now = Date.now();
    const body = {
      class: "viewer",
      nominationsCloseAt: new Date(now + 60_000).toISOString(),
      votingEndsAt: new Date(now + 120_000).toISOString(),
    };
    expect((await call(viewer, "POST", "/api/coop/elections", body)).status).toBe(403);
    const e = await call<{ id: string; seats: number; status: string }>(admin, "POST", "/api/coop/elections", body);
    expect(e.status).toBe(200);
    expect(e.body).toMatchObject({ seats: 3, status: "nominating" });
    electionId = e.body.id;
    expect(await auditOf("election.create", electionId)).toHaveLength(1);
    expect(await eventsOf("coop.election.update", { election_id: electionId })).not.toHaveLength(0);

    expect((await call(worker, "POST", `/api/coop/elections/${electionId}/candidates`, { statement: "" })).status).toBe(
      403,
    );
    expect(
      (await call(viewer, "POST", `/api/coop/elections/${electionId}/candidates`, { statement: "Me" })).status,
    ).toBe(200);
    expect(
      (await call(viewer, "POST", `/api/coop/elections/${electionId}/candidates`, { statement: "Me" })).status,
    ).toBe(409);
    const ballot = { candidateIds: [viewer.userId] };
    expect((await call(viewer, "POST", `/api/coop/elections/${electionId}/ballot`, ballot)).status).toBe(409);

    await app().update(schema.elections).set({ status: "voting" }).where(eq(schema.elections.id, electionId));
    expect((await call(worker, "POST", `/api/coop/elections/${electionId}/ballot`, ballot)).status).toBe(403);
    expect(
      (await call(viewer, "POST", `/api/coop/elections/${electionId}/ballot`, { candidateIds: [s1.userId] })).status,
    ).toBe(400);
    expect((await call(viewer, "POST", `/api/coop/elections/${electionId}/ballot`, ballot)).status).toBe(200);
    expect((await call(viewer, "POST", `/api/coop/elections/${electionId}/ballot`, ballot)).status).toBe(409);
    const [a] = await auditOf("election.vote", electionId);
    expect(a?.details).toEqual({ electionId });

    const list = await call<{ id: string; candidates: { votes: number | null }[] }[]>(
      null,
      "GET",
      "/api/coop/elections",
    );
    expect(list.body.find((x) => x.id === electionId)?.candidates).toEqual([expect.objectContaining({ votes: null })]);
  });
});

// Patronage ----------------------------------------------------------------------------------------

describe("patronage", () => {
  let periodId = "";
  let periodEnd = new Date();

  test("revenue for the period: a confirmed tip", async () => {
    const tip = await call<{ paymentId: string }>(viewer, "POST", `/api/channels/${s1.username}/tips`, {
      amountCents: 1000,
      returnPath: `/${s1.username}`,
    });
    expect(tip.status).toBe(200);
    const ok = await call(t1, "POST", `/api/treasurer/payments/${tip.body.paymentId}/confirm`, {
      receivedAt: new Date().toISOString(),
    });
    expect(ok.status).toBe(200);
    await sleep(1100);
    periodEnd = new Date(Date.now() - 500);
  });

  test("validation and a surplus the ledger does not hold", async () => {
    const future = await call(t1, "POST", "/api/coop/patronage/run", {
      periodStart: startedAt.toISOString(),
      periodEnd: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(future.status).toBe(400);
    const tooMuch = await call<Err>(t1, "POST", "/api/coop/patronage/run", {
      periodStart: startedAt.toISOString(),
      periodEnd: periodEnd.toISOString(),
      surplusCents: 10_000_000,
    });
    expect(tooMuch.status).toBe(412);
    expect(tooMuch.body.data).toEqual({ requirement: "surplus" });
    expect(
      (
        await call(viewer, "POST", "/api/coop/patronage/run", {
          periodStart: startedAt.toISOString(),
          periodEnd: periodEnd.toISOString(),
        })
      ).status,
    ).toBe(403);
  });

  test("a treasurer runs the period over all available surplus", async () => {
    const r = await call<{ periodId: string; members: number; total: { cents: number }; surplus: { cents: number } }>(
      t1,
      "POST",
      "/api/coop/patronage/run",
      { periodStart: startedAt.toISOString(), periodEnd: periodEnd.toISOString() },
    );
    expect(r.status).toBe(200);
    expect(r.body.surplus.cents).toBeGreaterThan(0);
    expect(r.body.total.cents).toBeGreaterThan(0);
    expect(r.body.members).toBeGreaterThan(0);
    periodId = r.body.periodId;
    const [a] = await auditOf("patronage.run", periodId);
    expect(a?.actorId).toBe(t1.userId);
    expect(await eventsOf("coop.patronage.update", { period_id: periodId, status: "computed" })).toHaveLength(1);
    await expectLedgerBalanced();
  });

  test("an overlapping period is refused", async () => {
    const r = await call(t1, "POST", "/api/coop/patronage/run", {
      periodStart: new Date(startedAt.getTime() - 60_000).toISOString(),
      periodEnd: new Date(startedAt.getTime() + 1000).toISOString(),
    });
    expect(r.status).toBe(409);
  });

  test("the runner cannot approve (API and database); a second treasurer can, once", async () => {
    const self = await call<Err>(t1, "POST", `/api/coop/patronage/${periodId}/approve`);
    expect(self.status).toBe(403);
    expect(self.body.data).toEqual({ reason: "second_approver" });
    await expectRefused(
      app()
        .update(schema.patronagePeriods)
        .set({ status: "approved", approvedById: t1.userId, approvedAt: new Date() })
        .where(eq(schema.patronagePeriods.id, periodId)),
      /someone other than the person who ran it/,
    );
    expect((await call(viewer, "POST", `/api/coop/patronage/${periodId}/approve`)).status).toBe(403);
    const ok = await call(t2, "POST", `/api/coop/patronage/${periodId}/approve`);
    expect(ok.status).toBe(200);
    expect((await call(t2, "POST", `/api/coop/patronage/${periodId}/approve`)).status).toBe(409);
    const [p] = await owner().select().from(schema.patronagePeriods).where(eq(schema.patronagePeriods.id, periodId));
    expect(p).toMatchObject({ status: "approved", computedById: t1.userId, approvedById: t2.userId });
    const posting = await owner()
      .select()
      .from(schema.ledgerTransactions)
      .where(eq(schema.ledgerTransactions.idempotencyKey, `patronage-allocation:${periodId}`));
    expect(posting).toHaveLength(1);
    await expectLedgerBalanced();
    expect(await auditOf("patronage.approve", periodId)).toHaveLength(1);
    expect(await eventsOf("coop.patronage.update", { period_id: periodId, status: "approved" })).toHaveLength(1);

    const periods = await call<{ id: string; computedBy: { id: string }; approvedBy: { id: string } }[]>(
      admin,
      "GET",
      "/api/coop/patronage-periods",
    );
    expect(periods.body.find((x) => x.id === periodId)).toMatchObject({
      computedBy: { id: t1.userId },
      approvedBy: { id: t2.userId },
    });
    expect((await call(viewer, "GET", "/api/coop/patronage-periods")).status).toBe(403);
  });

  test("members read their statements line by line; others get not found", async () => {
    const list = await call<{ periodId: string; total: { cents: number } }[]>(s1, "GET", "/api/coop/patronage");
    expect(list.body.map((x) => x.periodId)).toContain(periodId);
    const st = await call<{
      total: { cents: number };
      lines: { component: string; explanation: string }[];
      inputs: { revenueCents: number };
    }>(s1, "GET", `/api/coop/patronage/${periodId}`);
    expect(st.status).toBe(200);
    expect(st.body.total.cents).toBeGreaterThan(0);
    expect(st.body.lines.length).toBeGreaterThan(0);
    expect(st.body.lines.every((l) => l.explanation.length > 0)).toBe(true);
    expect(st.body.inputs.revenueCents).toBeGreaterThan(0);
    expect((await call(outsider, "GET", `/api/coop/patronage/${periodId}`)).status).toBe(404);
  });

  test("transparency shows the decisions and the distribution this month", async () => {
    const months = await call<
      {
        month: string;
        patronageDistributed: { cents: number };
        governance: { proposalId: string; passed: boolean | null; kind: string; reason: string | null }[];
      }[]
    >(null, "GET", "/api/transparency?months=2");
    const month = new Date().toISOString().slice(0, 7);
    const m = months.body.find((x) => x.month === month);
    expect(m?.patronageDistributed.cents).toBeGreaterThan(0);
    expect(m?.governance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ proposalId: ordinary.id, passed: true, kind: "ordinary" }),
        expect.objectContaining({
          proposalId: protectedP.id,
          passed: false,
          kind: "protected",
          reason: "streamer-class majority not met",
        }),
      ]),
    );
  });
});

// Exit and refund ----------------------------------------------------------------------------------

describe("exit and refund", () => {
  let shareId = "";
  test("exiting the viewer class asks for the share back", async () => {
    expect((await call(outsider, "POST", "/api/coop/membership/viewer/exit")).status).toBe(404);
    const r = await call<MembershipView>(viewer, "POST", "/api/coop/membership/viewer/exit");
    expect(r.status).toBe(200);
    expect(r.body.memberships.find((m) => m.class === "viewer")).toMatchObject({ status: "exited" });
    expect(r.body.share).toMatchObject({ status: "refund_pending" });
    shareId = r.body.share?.id ?? "";
    expect(await auditOf("membership.exit")).not.toHaveLength(0);
    expect(await auditOf("coop.share.refund_request", shareId)).toHaveLength(1);
    expect(await eventsOf("coop.share.update", { share_id: shareId, status: "refund_pending" })).toHaveLength(1);
  });

  test("a treasurer records the refund once, with a balanced posting", async () => {
    const body = { sentAt: new Date().toISOString(), note: "Sent by bank transfer" };
    expect((await call(viewer, "POST", `/api/coop/shares/${shareId}/refund`, body)).status).toBe(403);
    const r = await call<{ status: string; refundedAt: string }>(
      t1,
      "POST",
      `/api/coop/shares/${shareId}/refund`,
      body,
    );
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("refunded");
    expect((await call(t1, "POST", `/api/coop/shares/${shareId}/refund`, body)).status).toBe(409);
    const posting = await owner()
      .select()
      .from(schema.ledgerTransactions)
      .where(eq(schema.ledgerTransactions.idempotencyKey, `share-refund:${shareId}`));
    expect(posting).toHaveLength(1);
    await expectLedgerBalanced();
    const [a] = await auditOf("coop.share.refund", shareId);
    expect(a?.reason).toBe("Sent by bank transfer");
    const list = await call<{ items: { id: string; status: string }[] }>(t1, "GET", "/api/coop/shares?status=refunded");
    expect(list.body.items.map((s) => s.id)).toContain(shareId);
    expect((await call(viewer, "GET", "/api/coop/shares")).status).toBe(403);
  });
});

// Test hook ----------------------------------------------------------------------------------------

describe("coop test hook", () => {
  const tick = (a: { fetch: (r: Request) => Promise<Response> }, body: unknown, secret = api.internalSecret) =>
    a.fetch(
      new Request(`${api.url}${INTERNAL_ROUTES.coopTick}`, {
        method: "POST",
        headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: secret },
        body: JSON.stringify(body),
      }),
    );

  test("404 when the hooks are off, even with the secret", async () => {
    const off = createApp({ ...api.deps, env: { ...api.deps.env, COOP_TEST_HOOKS: false } });
    expect((await tick(off, { job: "membership-sync" })).status).toBe(404);
  });

  test("on: the secret is required and the body validated", async () => {
    expect((await tick(api.app, { job: "membership-sync" }, "wrong")).status).toBe(401);
    expect((await tick(api.app, { job: "nope" })).status).toBe(400);
  });

  test("on: enqueues the job on the worker's queue and returns its result (real BullMQ, stub processor)", async () => {
    const conn = new Valkey(VALKEY_URL, { maxRetriesPerRequest: null });
    const seen: string[] = [];
    const w = new Worker(
      QUEUES.coop,
      async (job) => {
        seen.push(job.name);
        return { ran: 1 };
      },
      { connection: conn, prefix },
    );
    try {
      await w.waitUntilReady();
      const res = await tick(api.app, { job: "proposals-advance" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ran: 1 });
      expect(seen).toEqual(["proposals-advance"]);
    } finally {
      await w.close();
      conn.disconnect();
    }
  });
});
