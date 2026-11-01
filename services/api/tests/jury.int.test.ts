// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `jury.*` against the running API (ADR 0038): opt-in states, a seated juror's cases (pseudonyms,
 * clause titles, no reporter, conflicts left out), one final vote per case, the public results
 * with k-suppression, the staff flag list, and the refusals. Panels are seeded directly here; the
 * worker's draw and close are covered by its own integration tests.
 */
import { schema, uuidv7 } from "@commonair/db";
import { commit, newSeed } from "@commonair/draw";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type Account = Awaited<ReturnType<typeof signUpAndSignIn>>;
interface Status {
  enabled: boolean;
  eligible: boolean;
  optedIn: boolean;
  optedInAt: string | null;
  seat: { panelId: string; period: string } | null;
}
interface Case {
  id: string;
  subjectKind: string;
  ruleRef: string | null;
  clauseTitle: string | null;
  tier: string | null;
  outcome: string;
  automated: boolean;
  subjectPseudonym: string;
  evidence: { kind: string; value: string; contentWarning: boolean }[];
  myVote: { vote: string; reasonCode: string } | null;
}
type Count = { suppressed: true } | { suppressed: false; value: number };
interface Results {
  period: string;
  panelSize: number;
  seedCommitment: string | null;
  seed: string | null;
  rows: { clauseId: string; clauseTitle: string; tier: string | null; agree: Count; disagree: Count; unsure: Count }[];
}

let api: TestApi;
let off: TestApi;
let alice: Account;
let bob: Account;
let admin: Account;
const PERIOD = new Date().toISOString().slice(0, 7);
const DAY = 86_400_000;

const owner = () => api.db.db;
const app = () => api.db.app.db;

beforeAll(async () => {
  [api, off] = await Promise.all([startApi({ governance: { "jury.enabled": { enabled: true } } }), startApi()]);
  [alice, bob, admin] = await Promise.all([
    signUpAndSignIn(api),
    signUpAndSignIn(api, { birthDate: `${new Date().getUTCFullYear() - 16}-01-01` }),
    signUpAndSignIn(api),
  ]);
  await owner().update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, admin.userId));
}, 120_000);
afterAll(async () => {
  await api?.stop();
  await off?.stop();
});

let seq = 0;
async function rowUser(): Promise<string> {
  const name = `jr${++seq}${crypto.randomUUID().slice(0, 6)}`;
  const [u] = await app()
    .insert(schema.users)
    .values({ name, email: `${name}@example.test`, username: name, birthDate: "1985-03-03" })
    .returning({ id: schema.users.id });
  return u!.id;
}
const member = (userId: string) => app().insert(schema.memberships).values({ userId, class: "viewer", basis: "share" });

describe("opt-in", () => {
  test("while jury.enabled is false, opting in is refused", async () => {
    const carol = await signUpAndSignIn(off);
    await off.db.app.db.insert(schema.memberships).values({ userId: carol.userId, class: "viewer", basis: "share" });
    const st = await carol.client.call<Status>("GET", "/api/jury/status");
    expect(st.body).toMatchObject({ enabled: false, eligible: true, optedIn: false, seat: null });
    const r = await carol.client.call<{ data: unknown }>("PUT", "/api/jury/opt-in");
    expect([r.status, r.body.data]).toEqual([412, { requirement: "jury_disabled" }]);
  });

  test("a non-member and a minor are not eligible; an active adult member opts in and out", async () => {
    const notMember = await alice.client.call<Status>("GET", "/api/jury/status");
    expect(notMember.body).toMatchObject({ enabled: true, eligible: false, optedIn: false });
    const refused = await alice.client.call<{ data: unknown }>("PUT", "/api/jury/opt-in");
    expect([refused.status, refused.body.data]).toEqual([412, { requirement: "jury_ineligible" }]);

    await member(bob.userId);
    expect((await bob.client.call<Status>("GET", "/api/jury/status")).body.eligible).toBe(false);

    await member(alice.userId);
    const on = await alice.client.call<Status>("PUT", "/api/jury/opt-in");
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ eligible: true, optedIn: true });
    expect(on.body.optedInAt).not.toBeNull();
    // Idempotent.
    expect((await alice.client.call<Status>("PUT", "/api/jury/opt-in")).body.optedIn).toBe(true);
    const out = await alice.client.call<Status>("DELETE", "/api/jury/opt-in");
    expect(out.body).toMatchObject({ optedIn: false, optedInAt: null });
    expect((await alice.client.call<Status>("PUT", "/api/jury/opt-in")).body.optedIn).toBe(true);

    const audits = await owner()
      .select({ action: schema.auditLog.action, details: schema.auditLog.details })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actorId, alice.userId));
    expect(audits.map((a) => a.action).sort()).toEqual(["jury.opt_in", "jury.opt_in", "jury.opt_out"]);
    for (const a of audits) expect(a.details).toEqual({});
  });

  test("staff are not eligible", async () => {
    await member(admin.userId);
    const st = await admin.client.call<Status>("GET", "/api/jury/status");
    expect(st.body.eligible).toBe(false);
  });
});

describe("a seated juror", () => {
  const seed = newSeed();
  let panelId = "";
  let seatId = "";
  const caseIds: Record<string, string> = {};
  let reporterId = "";

  beforeAll(async () => {
    const [p] = await app()
      .insert(schema.juryPanels)
      .values({ period: PERIOD, seedCommitment: await commit(seed), sealedSeed: "sealed" })
      .returning({ id: schema.juryPanels.id });
    panelId = p!.id;
    const [s] = await app()
      .insert(schema.jurySeats)
      .values({ panelId, userId: alice.userId })
      .returning({ id: schema.jurySeats.id });
    seatId = s!.id;

    const ownerId = await rowUser();
    const [ch] = await app()
      .insert(schema.channels)
      .values({ ownerId, slug: `ch${ownerId.slice(-10)}`, displayName: "Channel" })
      .returning({ id: schema.channels.id });
    const modOwner = await rowUser();
    const [modCh] = await app()
      .insert(schema.channels)
      .values({ ownerId: modOwner, slug: `mc${modOwner.slice(-10)}`, displayName: "Modded" })
      .returning({ id: schema.channels.id });
    await app().insert(schema.channelRoles).values({ channelId: modCh!.id, userId: alice.userId, role: "moderator" });

    const kase = async (channelId: string, userId: string) => {
      const [c] = await owner()
        .insert(schema.moderationCases)
        .values({
          tier: "t1",
          origin: "classifier",
          category: "weapons",
          subjectType: "broadcast",
          subjectId: uuidv7(),
          channelId,
          userId,
          ruleRef: "safety.weapons@1",
        })
        .returning({ id: schema.moderationCases.id });
      await owner()
        .update(schema.moderationCases)
        .set({ status: "actioned", resolvedAt: new Date(Date.now() - DAY) })
        .where(eq(schema.moderationCases.id, c!.id));
      return c!.id;
    };
    reporterId = await rowUser();
    const subject = await rowUser();
    const [rp] = await owner()
      .insert(schema.reports)
      .values({
        subjectType: "user",
        subjectId: subject,
        reporterId,
        reason: "spam",
        status: "dismissed",
        evidence: { body: "buy followers at example dot test" },
        resolvedAt: new Date(Date.now() - DAY),
      })
      .returning({ id: schema.reports.id });
    const [own] = await owner()
      .insert(schema.reports)
      .values({
        subjectType: "user",
        subjectId: await rowUser(),
        reporterId: alice.userId,
        reason: "harassment",
        status: "actioned",
        resolvedAt: new Date(Date.now() - DAY),
      })
      .returning({ id: schema.reports.id });
    const sampled = {
      weapons: await kase(ch!.id, ownerId),
      spam: rp!.id,
      moderated: await kase(modCh!.id, modOwner),
      reported: own!.id,
    };
    for (const [k, id] of Object.entries(sampled)) {
      const kind = k === "spam" || k === "reported" ? "report" : "moderation_case";
      const [jc] = await app()
        .insert(schema.juryCases)
        .values({
          panelId,
          subjectKind: kind,
          subjectId: id,
          ruleRef: kind === "report" ? (k === "spam" ? "honesty.spam@1" : "decency.harassment@1") : "safety.weapons@1",
          pseudonymMap: { subject: `P${k.toUpperCase().slice(0, 7)}` },
        })
        .returning({ id: schema.juryCases.id });
      caseIds[k] = jc!.id;
    }
  });

  test("status and panel show the seat; conflicted cases are left out", async () => {
    const st = await alice.client.call<Status>("GET", "/api/jury/status");
    expect(st.body.seat).toEqual({ panelId, period: PERIOD });
    const p = await alice.client.call<{ id: string; seats: number; cases: number; seed: string | null }>(
      "GET",
      "/api/jury/panel",
    );
    expect(p.body).toMatchObject({ id: panelId, seats: 1, cases: 2, seed: null });
    expect((await bob.client.call("GET", "/api/jury/panel")).body).toBeNull();
  });

  test("cases carry the clause, outcome and pseudonyms, never the reporter or a username", async () => {
    const r = await alice.client.call<Case[]>("GET", "/api/jury/cases");
    expect(r.status).toBe(200);
    const byText = (a: string | undefined, b: string | undefined) => String(a).localeCompare(String(b));
    expect(r.body.map((c) => c.id).sort(byText)).toEqual([caseIds.weapons, caseIds.spam].sort(byText));
    const weapons = r.body.find((c) => c.id === caseIds.weapons)!;
    expect(weapons).toMatchObject({
      subjectKind: "moderation_case",
      ruleRef: "safety.weapons@1",
      tier: "t1",
      outcome: "actioned",
      automated: true,
      subjectPseudonym: "PWEAPONS",
      myVote: null,
    });
    expect(weapons.clauseTitle).toBeTruthy();
    const spam = r.body.find((c) => c.id === caseIds.spam)!;
    expect(spam).toMatchObject({ subjectKind: "report", tier: null, outcome: "dismissed", automated: false });
    expect(spam.evidence).toEqual([
      { kind: "text", value: "buy followers at example dot test", contentWarning: false },
    ]);
    const text = JSON.stringify(r.body);
    expect(text).not.toContain(reporterId);
    expect(text).not.toContain(alice.username);
  });

  test("one final vote per case; a conflicted case and a non-seat are refused", async () => {
    const v = await alice.client.call<Case>("POST", `/api/jury/cases/${caseIds.weapons}/vote`, {
      vote: "disagree",
      reasonCode: "action_too_severe",
    });
    expect(v.status).toBe(200);
    expect(v.body.myVote).toEqual({ vote: "disagree", reasonCode: "action_too_severe" });
    const again = await alice.client.call("POST", `/api/jury/cases/${caseIds.weapons}/vote`, {
      vote: "agree",
      reasonCode: "clause_fits",
    });
    expect(again.status).toBe(409);
    const conflicted = await alice.client.call("POST", `/api/jury/cases/${caseIds.moderated}/vote`, {
      vote: "agree",
      reasonCode: "clause_fits",
    });
    expect(conflicted.status).toBe(404);
    const notSeated = await bob.client.call<{ data: unknown }>("POST", `/api/jury/cases/${caseIds.spam}/vote`, {
      vote: "agree",
      reasonCode: "clause_fits",
    });
    expect([notSeated.status, notSeated.body.data]).toEqual([412, { requirement: "jury_not_seated" }]);
    const free = await alice.client.call("POST", `/api/jury/cases/${caseIds.spam}/vote`, {
      vote: "agree",
      reasonCode: "anything I like",
    });
    expect(free.status).toBe(400);
    const [audit] = await owner()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "jury.vote"), eq(schema.auditLog.subjectId, caseIds.weapons!)));
    expect(audit).toMatchObject({ actorId: alice.userId, details: { panelId } });
  });

  test("a report whose set sender is under a legal hold is hidden until the close withdraws it", async () => {
    const sender = await rowUser();
    const [rp] = await owner()
      .insert(schema.reports)
      .values({
        subjectType: "message_set",
        subjectId: uuidv7(),
        reporterId: await rowUser(),
        reason: "spam",
        status: "actioned",
        evidence: { messages: [{ id: uuidv7(), userId: sender, body: "spam spam" }] },
        resolvedAt: new Date(Date.now() - DAY),
      })
      .returning({ id: schema.reports.id });
    const [jc] = await app()
      .insert(schema.juryCases)
      .values({ panelId, subjectKind: "report", subjectId: rp!.id, ruleRef: "honesty.spam@1" })
      .returning({ id: schema.juryCases.id });
    const visible = async () =>
      (await alice.client.call<Case[]>("GET", "/api/jury/cases")).body.some((c) => c.id === jc!.id);
    expect(await visible()).toBe(true);
    await owner().insert(schema.legalHolds).values({ userId: sender, reason: "litigation", reasonCode: "litigation" });
    expect(await visible()).toBe(false);
    const vote = await alice.client.call("POST", `/api/jury/cases/${jc!.id}/vote`, {
      vote: "agree",
      reasonCode: "clause_fits",
    });
    expect(vote.status).toBe(404);
  });

  test("results: only the commitment while open; at close, per clause with cells under k suppressed", async () => {
    const anon = client(api);
    const open = await anon.call<Results>("GET", `/api/transparency/jury?period=${PERIOD}`);
    expect(open.body).toMatchObject({ period: PERIOD, panelSize: 1, seed: null, rows: [] });
    expect(open.body.seedCommitment).toBe(await commit(seed));
    expect((await anon.call<Results>("GET", "/api/transparency/jury?period=1999-01")).body).toEqual({
      period: "1999-01",
      panelSize: 0,
      seedCommitment: null,
      seed: null,
      rows: [],
    });

    // Ten more jurors agree on the spam report: 10 + alice's vote there would be 11.
    for (let i = 0; i < 10; i++) {
      const u = await rowUser();
      await member(u);
      await app().insert(schema.juryOptins).values({ userId: u });
      const [s] = await app()
        .insert(schema.jurySeats)
        .values({ panelId, userId: u })
        .returning({ id: schema.jurySeats.id });
      await app()
        .insert(schema.juryVotes)
        .values({ caseId: caseIds.spam!, seatId: s!.id, vote: "agree", reasonCode: "clause_fits" });
    }
    await app()
      .insert(schema.juryVotes)
      .values({ caseId: caseIds.spam!, seatId, vote: "agree", reasonCode: "clause_fits" });
    await app().update(schema.juryPanels).set({ seed, closedAt: new Date() }).where(eq(schema.juryPanels.id, panelId));

    const closed = await anon.call<Results>("GET", `/api/transparency/jury?period=${PERIOD}`);
    expect(closed.body).toMatchObject({ period: PERIOD, panelSize: 11, seed });
    const spam = closed.body.rows.find((r) => r.clauseId === "honesty.spam")!;
    expect(spam).toMatchObject({
      tier: null,
      agree: { suppressed: false, value: 11 },
      disagree: { suppressed: false, value: 0 },
      unsure: { suppressed: false, value: 0 },
    });
    expect(spam.clauseTitle).toBeTruthy();
    const weapons = closed.body.rows.find((r) => r.clauseId === "safety.weapons")!;
    expect(weapons).toMatchObject({
      tier: "t1",
      agree: { suppressed: true },
      disagree: { suppressed: true },
      unsure: { suppressed: true },
    });
    // A closed panel takes no votes, and is no longer the juror's panel.
    expect((await alice.client.call("GET", "/api/jury/panel")).body).toBeNull();
  });

  test("staff list the re-review flags with their counts; members cannot", async () => {
    await app().insert(schema.juryFlags).values({ caseId: caseIds.weapons! });
    const r = await admin.client.call<{ items: { caseId: string; disagree: number; votes: number }[] }>(
      "GET",
      "/api/admin/jury/flags",
    );
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([
      expect.objectContaining({ caseId: caseIds.weapons, panelId, disagree: 1, votes: 1 }),
    ]);
    expect((await alice.client.call("GET", "/api/admin/jury/flags")).status).toBe(403);
  });

  test("the jury never wrote an outcome", async () => {
    const [c] = await owner()
      .select({ status: schema.moderationCases.status })
      .from(schema.moderationCases)
      .innerJoin(schema.juryCases, eq(schema.juryCases.subjectId, schema.moderationCases.id))
      .where(eq(schema.juryCases.id, caseIds.weapons!));
    expect(c!.status).toBe("actioned");
    expect(await owner().select().from(schema.modActions)).toEqual([]);
  });
});
