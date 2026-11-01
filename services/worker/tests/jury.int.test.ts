// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The advisory jury's draw and close against a real database as the application role (ADR 0038):
 * the commitment is committed before selection, the draw is reproducible from the sealed seed,
 * the sample keeps out T0, NCII, minor-safety, minor, legal-hold and watch-room subjects, the
 * close reveals a seed the trigger checks and flags majority-disagree cases without ever touching
 * an outcome, and nothing is drawn while `jury.enabled` is false.
 */
import { schema as s, uuidv7, type Database } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { commit } from "@commonair/draw";
import { decryptSecret } from "@commonair/tokens";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import type { WorkerContext } from "../src/context.ts";
import { loadCandidates, loadPool, poolEntries } from "../src/jury/candidates.ts";
import { runClose } from "../src/jury/close.ts";
import { JURY_SEED_PURPOSE, juryCloseJobId, runDraw, selectPanel } from "../src/jury/draw.ts";
import { candidateEntries, candidateKey, PANEL_MS } from "../src/jury/sample.ts";
import { AUTH_SECRET, fastWebhooks, quietLogger } from "./fixtures.ts";

const NOW = new Date();
const DAY = 86_400_000;
const yearsAgo = (n: number) => `${NOW.getUTCFullYear() - n}-01-15`;
const ADULT = yearsAgo(30);
const MINOR = yearsAgo(15);

let t: TestDatabase;
let off: TestDatabase;
let app: Database;
let owner: Database;

interface Enqueued {
  name: string;
  data: unknown;
  opts?: { jobId?: string; delayMs?: number };
}
const enqueued: Enqueued[] = [];

function makeCtx(db: Database): WorkerContext {
  return {
    db,
    logger: quietLogger,
    webhooks: fastWebhooks(),
    enqueue: async (_q: string, name: string, data: unknown, opts?: Enqueued["opts"]) => {
      enqueued.push({ name, data, opts });
    },
    now: () => NOW,
  } as unknown as WorkerContext;
}

beforeAll(async () => {
  t = await createTestDatabase({
    governance: { "jury.enabled": { enabled: true }, "jury.casesPerPanel": { casesPerPanel: 100 } },
  });
  off = await createTestDatabase();
  app = t.app.db;
  owner = t.db;
});
afterAll(async () => {
  await t?.drop();
  await off?.drop();
});

let seq = 0;
async function newUser(
  db: Database = app,
  v: { birthDate?: string | null; role?: "user" | "moderator" | "legal" } = {},
): Promise<string> {
  const name = `jy${++seq}${crypto.randomUUID().slice(0, 6)}`;
  const [u] = await db
    .insert(s.users)
    .values({
      name,
      email: `${name}@example.test`,
      username: name,
      birthDate: v.birthDate === undefined ? ADULT : v.birthDate,
      role: v.role ?? "user",
    })
    .returning({ id: s.users.id });
  return u!.id;
}
async function juror(db: Database = app, v: { optIn?: boolean; member?: boolean } = {}): Promise<string> {
  const u = await newUser(db);
  if (v.member !== false) await db.insert(s.memberships).values({ userId: u, class: "viewer", basis: "share" });
  if (v.optIn !== false) await db.insert(s.juryOptins).values({ userId: u });
  return u;
}
async function channel(birthDate: string | null = ADULT): Promise<{ channelId: string; ownerId: string }> {
  const ownerId = await newUser(app, { birthDate });
  const [c] = await app
    .insert(s.channels)
    .values({ ownerId, slug: `c${ownerId.slice(-12)}`, displayName: "Channel" })
    .returning({ id: s.channels.id });
  return { channelId: c!.id, ownerId };
}
async function closedCase(v: Partial<typeof s.moderationCases.$inferInsert> = {}): Promise<string> {
  const { status = "actioned", resolvedAt = new Date(NOW.getTime() - DAY), resolvedById, ...rest } = v;
  const ch = rest.channelId ? null : await channel();
  const [c] = await owner
    .insert(s.moderationCases)
    .values({
      tier: "t1",
      origin: "classifier",
      category: "graphic_violence",
      subjectType: "broadcast",
      subjectId: uuidv7(),
      channelId: ch?.channelId,
      userId: ch?.ownerId,
      ruleRef: "safety.graphic-violence@1",
      ...rest,
    })
    .returning({ id: s.moderationCases.id });
  await owner
    .update(s.moderationCases)
    .set({ status, resolvedAt, resolvedById })
    .where(eq(s.moderationCases.id, c!.id));
  return c!.id;
}
async function resolvedReport(v: Partial<typeof s.reports.$inferInsert> = {}): Promise<string> {
  const [r] = await owner
    .insert(s.reports)
    .values({
      subjectType: "user",
      subjectId: await newUser(),
      reporterId: await newUser(),
      reason: "spam",
      status: "actioned",
      resolvedAt: new Date(NOW.getTime() - DAY),
      ...v,
    })
    .returning({ id: s.reports.id });
  return r!.id;
}
const refused = async (p: PromiseLike<unknown>): Promise<string | undefined> => {
  try {
    await p;
    return undefined;
  } catch (e) {
    for (let x: unknown = e; x; x = (x as { cause?: unknown }).cause) {
      const code = (x as { code?: unknown }).code;
      if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    }
    return "unknown";
  }
};
/** A db whose `n`th transaction throws before running (an injected crash). */
function crashingAt(db: Database, n: number): Database {
  let count = 0;
  return new Proxy(db, {
    get(target, prop, recv) {
      if (prop === "transaction")
        return (...args: Parameters<Database["transaction"]>) => {
          if (++count === n) throw new Error("injected crash");
          return target.transaction(...args);
        };
      return Reflect.get(target, prop, recv);
    },
  });
}

describe("jury.enabled false", () => {
  test("no panel is drawn", async () => {
    await juror(off.app.db);
    const r = await runDraw(makeCtx(off.app.db), NOW);
    expect(r).toEqual({ disabled: 1, closed: 0 });
    expect(await off.app.db.select().from(s.juryPanels)).toEqual([]);
  });
});

describe("draw and close", () => {
  const ids: Record<string, string> = {};
  const jurors: string[] = [];
  let panelId = "";

  beforeAll(async () => {
    for (let i = 0; i < 9; i++) jurors.push(await juror());
    // Not in the pool: no opt-in, no membership, staff, a minor, opted out.
    ids.notOptedIn = await juror(app, { optIn: false });
    ids.notMember = await juror(app, { member: false });
    const staff = await newUser(app, { role: "moderator" });
    await app.insert(s.memberships).values({ userId: staff, class: "viewer", basis: "share" });
    await app.insert(s.juryOptins).values({ userId: staff });
    ids.staff = staff;
    const out = await juror();
    await app.update(s.juryOptins).set({ optedOutAt: NOW }).where(eq(s.juryOptins.userId, out));
    ids.optedOut = out;

    ids.ok1 = await closedCase();
    ids.ok2 = await closedCase({ tier: "t2", status: "cleared", ruleRef: "mature.unlabelled@1" });
    ids.ok3 = await resolvedReport();
    ids.ok4 = await resolvedReport({ status: "dismissed", reason: "harassment" });
    ids.t0 = await closedCase({
      tier: "t0",
      origin: "hash_list",
      listCategory: "csam",
      status: "confirmed",
      resolvedById: await newUser(app, { role: "legal" }),
    });
    ids.ncii = await closedCase({ origin: "human", ruleRef: "decency.intimate-images@1" });
    ids.nciiReport = await resolvedReport({ reason: "ncii" });
    ids.minorCase = await closedCase({ channelId: (await channel(MINOR)).channelId, userId: null });
    ids.minorReporter = await resolvedReport({ reporterId: await newUser(app, { birthDate: MINOR }) });
    ids.watchRoom = await resolvedReport({ subjectType: "watch_room", subjectId: uuidv7() });
    const held = await newUser();
    await owner.insert(s.legalHolds).values({ userId: held, reason: "litigation", reasonCode: "litigation" });
    ids.held = await resolvedReport({ subjectId: held });
    ids.old = await closedCase({ resolvedAt: new Date(NOW.getTime() - 31 * DAY) });
    ids.open = await closedCase({ status: "labelled", tier: "t2" });
  });

  test("the commitment is committed before selection; a crash in selection leaves it, and a rerun draws", async () => {
    const crashed = makeCtx(crashingAt(app, 2));
    await expect(runDraw(crashed, NOW)).rejects.toThrow("injected crash");
    const [p] = await app.select().from(s.juryPanels);
    expect(p).toBeDefined();
    panelId = p!.id;
    expect(p!.seed).toBeNull();
    expect(await commit(await decryptSecret(AUTH_SECRET, JURY_SEED_PURPOSE, p!.sealedSeed))).toBe(p!.seedCommitment);
    const commitAudit = await app
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.subjectId, panelId), eq(s.auditLog.action, "jury.panel.commit")));
    expect(commitAudit).toHaveLength(1);
    expect(commitAudit[0]!.details).toEqual({ period: p!.period, seedCommitment: p!.seedCommitment });
    expect(await app.select().from(s.jurySeats)).toEqual([]);

    const r = await runDraw(makeCtx(app), NOW);
    expect(r).toMatchObject({ drawn: 1, seats: 7, pool: 9, refused: 0, closed: 0 });
    // The same panel, the same commitment: nothing new was committed.
    const panels = await app.select().from(s.juryPanels);
    expect(panels.map((x) => [x.id, x.seedCommitment])).toEqual([[panelId, p!.seedCommitment]]);
    expect(enqueued.at(-1)).toMatchObject({
      name: "jury-close",
      data: { panelId },
      opts: { jobId: juryCloseJobId(panelId) },
    });
    expect(enqueued.at(-1)!.opts!.delayMs).toBeGreaterThan(PANEL_MS - 60_000);
    const events = await app.select().from(s.events).where(eq(s.events.type, "jury.panel.drawn"));
    expect(events.map((e) => e.payload)).toEqual([{ panel_id: panelId }]);

    // A second run in the month does nothing.
    expect(await runDraw(makeCtx(app), NOW)).toEqual({ exists: 1, closed: 0 });
  });

  test("seats are from the pool only, and the sample keeps out every excluded subject", async () => {
    const seats = await app.select().from(s.jurySeats).where(eq(s.jurySeats.panelId, panelId));
    expect(seats).toHaveLength(7);
    for (const st of seats) expect(jurors).toContain(st.userId);
    const cases = await app.select().from(s.juryCases).where(eq(s.juryCases.panelId, panelId));
    const byText = (a: string | undefined, b: string | undefined) => String(a).localeCompare(String(b));
    expect(cases.map((c) => c.subjectId).sort(byText)).toEqual([ids.ok1, ids.ok2, ids.ok3, ids.ok4].sort(byText));
    for (const c of cases) {
      expect(c.pseudonymMap.subject).toMatch(/^[0-9A-F]{8}$/);
      expect(c.ruleRef).not.toBeNull();
    }
    // Reporters are never named in a pseudonym map.
    const [r3] = await app.select().from(s.reports).where(eq(s.reports.id, ids.ok3!));
    const c3 = cases.find((c) => c.subjectId === ids.ok3)!;
    expect(Object.keys(c3.pseudonymMap)).not.toContain(r3!.reporterId);
    expect(c3.ruleRef).toBe("honesty.spam@1");
  });

  test("the draw is reproducible from the seed and the same pool", async () => {
    const [p] = await app.select().from(s.juryPanels).where(eq(s.juryPanels.id, panelId));
    const seed = await decryptSecret(AUTH_SECRET, JURY_SEED_PURPOSE, p!.sealedSeed);
    const pool = poolEntries(await loadPool(app), NOW);
    const entries = candidateEntries(await loadCandidates(app, NOW), NOW);
    const again = await selectPanel(seed, pool, entries, { panelSize: 7, casesPerPanel: 100 });
    const seats = await app.select().from(s.jurySeats).where(eq(s.jurySeats.panelId, panelId));
    expect(again.seats).toEqual(seats.map((x) => x.userId).sort());
    const cases = await app.select().from(s.juryCases).where(eq(s.juryCases.panelId, panelId));
    expect([...again.cases].sort()).toEqual(
      cases.map((c) => candidateKey({ kind: c.subjectKind, id: c.subjectId })).sort(),
    );
  });

  test("the triggers refuse what the draw never writes", async () => {
    const seat = (userId: string) => app.insert(s.jurySeats).values({ panelId, userId });
    expect(await refused(seat(ids.notMember!))).toBe("23514");
    expect(await refused(seat(ids.staff!))).toBe("23514");
    expect(await refused(seat(ids.notOptedIn!))).toBe("23514");
    const add = (kind: "moderation_case" | "report", id: string) =>
      app.insert(s.juryCases).values({ panelId, subjectKind: kind, subjectId: id });
    expect(await refused(add("moderation_case", ids.t0!))).toBe("23514");
    expect(await refused(add("moderation_case", ids.ncii!))).toBe("23514");
    expect(await refused(add("report", ids.held!))).toBe("23514");
    // A vote from someone without a seat on this panel.
    const [other] = await app
      .insert(s.juryPanels)
      .values({ period: "2001-01", seedCommitment: await commit("ab".repeat(32)), sealedSeed: "x" })
      .returning({ id: s.juryPanels.id });
    const [foreign] = await app
      .insert(s.jurySeats)
      .values({ panelId: other!.id, userId: jurors[0]! })
      .returning({ id: s.jurySeats.id });
    const [jc] = await app.select().from(s.juryCases).where(eq(s.juryCases.panelId, panelId)).limit(1);
    expect(
      await refused(
        app
          .insert(s.juryVotes)
          .values({ caseId: jc!.id, seatId: foreign!.id, vote: "agree", reasonCode: "clause_fits" }),
      ),
    ).toBe("23514");
    // A wrong reveal.
    expect(
      await refused(
        app
          .update(s.juryPanels)
          .set({ seed: "cd".repeat(32) })
          .where(eq(s.juryPanels.id, panelId)),
      ),
    ).toBe("23514");
  });

  test("close reveals the committed seed, withdraws a newly held case, flags majority disagree, changes no outcome", async () => {
    const seats = await app.select().from(s.jurySeats).where(eq(s.jurySeats.panelId, panelId));
    const cases = await app.select().from(s.juryCases).where(eq(s.juryCases.panelId, panelId));
    const byId = (id: string) => cases.find((c) => c.subjectId === id)!;
    const vote = (caseId: string, seatId: string, v: "agree" | "disagree" | "unsure") =>
      app.insert(s.juryVotes).values({ caseId, seatId, vote: v, reasonCode: "other" });
    // ok1: 4 disagree of 7 → flagged. ok2: 3-3 with one unsure → not. ok3: tie 2-2 → not.
    for (const [i, st] of seats.entries()) {
      await vote(byId(ids.ok1!).id, st.id, i < 4 ? "disagree" : "agree");
      await vote(byId(ids.ok2!).id, st.id, i < 3 ? "disagree" : i < 6 ? "agree" : "unsure");
      if (i < 4) await vote(byId(ids.ok3!).id, st.id, i < 2 ? "disagree" : "agree");
    }
    // ok4 turns ineligible: a legal hold on its reporter after sampling, and all disagree.
    const [r4] = await app.select().from(s.reports).where(eq(s.reports.id, ids.ok4!));
    for (const st of seats) await vote(byId(ids.ok4!).id, st.id, "disagree");
    await owner
      .insert(s.legalHolds)
      .values({ userId: r4!.reporterId!, reason: "litigation", reasonCode: "litigation" });

    const outcomeIds = [ids.ok1!, ids.ok2!];
    const reportIds = [ids.ok3!, ids.ok4!];
    const before = {
      cases: await owner.select().from(s.moderationCases).where(inArray(s.moderationCases.id, outcomeIds)),
      reports: await owner.select().from(s.reports).where(inArray(s.reports.id, reportIds)),
      actions: await owner.select().from(s.modActions),
      statements: await owner.select().from(s.enforcementStatements),
    };

    // Not due yet: nothing closes without a panel id.
    expect(await runClose(makeCtx(app), {}, NOW)).toEqual({ closed: 0, withdrawn: 0, flagged: 0 });
    expect(await runClose(makeCtx(app), { panelId }, NOW)).toEqual({ closed: 1, withdrawn: 1, flagged: 1 });
    // Closing again is a no-op.
    expect(await runClose(makeCtx(app), { panelId }, NOW)).toEqual({ closed: 0, withdrawn: 0, flagged: 0 });

    const [p] = await app.select().from(s.juryPanels).where(eq(s.juryPanels.id, panelId));
    expect(p!.closedAt).not.toBeNull();
    expect(await commit(p!.seed!)).toBe(p!.seedCommitment);
    const reveal = await app
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.subjectId, panelId), eq(s.auditLog.action, "jury.panel.reveal")));
    expect(reveal[0]!.details).toMatchObject({ seed: p!.seed, seedCommitment: p!.seedCommitment });

    const flags = await app.select().from(s.juryFlags);
    expect(flags.map((f) => f.caseId)).toEqual([byId(ids.ok1!).id]);
    const flagAudit = await app.select().from(s.auditLog).where(eq(s.auditLog.action, "jury.case.flag"));
    expect(flagAudit).toHaveLength(1);
    expect(flagAudit[0]).toMatchObject({ actorType: "system", subjectId: byId(ids.ok1!).id });
    expect(flagAudit[0]!.details).toMatchObject({ disagree: 4, votes: 7 });
    const [w] = await app
      .select()
      .from(s.juryCases)
      .where(eq(s.juryCases.id, byId(ids.ok4!).id));
    expect(w!.withdrawnReason).toBe("legal_hold");

    // Advisory: every outcome table is exactly as it was.
    expect(await owner.select().from(s.moderationCases).where(inArray(s.moderationCases.id, outcomeIds))).toEqual(
      before.cases,
    );
    expect(await owner.select().from(s.reports).where(inArray(s.reports.id, reportIds))).toEqual(before.reports);
    expect(await owner.select().from(s.modActions)).toEqual(before.actions);
    expect(await owner.select().from(s.enforcementStatements)).toEqual(before.statements);

    // Votes are refused once the panel is closed.
    expect(await refused(vote(byId(ids.ok3!).id, seats[6]!.id, "agree"))).toBe("23514");
  });

  test("a draw closes a panel whose 14 days are up", async () => {
    const [p] = await owner
      .insert(s.juryPanels)
      .values({
        period: "2002-02",
        seedCommitment: await commit("ef".repeat(32)),
        sealedSeed: await (
          await import("@commonair/tokens")
        ).encryptSecret(AUTH_SECRET, JURY_SEED_PURPOSE, "ef".repeat(32)),
        openedAt: new Date(NOW.getTime() - PANEL_MS - 1),
      })
      .returning({ id: s.juryPanels.id });
    const r = await runDraw(makeCtx(app), NOW);
    expect(r).toMatchObject({ closed: 1 });
    const [after] = await app.select().from(s.juryPanels).where(eq(s.juryPanels.id, p!.id));
    expect(after!.seed).toBe("ef".repeat(32));
  });
});
