// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Overhaul D6.1: `transparency.setNote` against Postgres. A treasurer sets, replaces and removes
 * the public note on a month; each change writes an audit row with the treasurer, the month and
 * the note's length only (never its text); everyone else is refused; and `coop.transparency`
 * carries the note on its month (`TransparencyMonth.note`).
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema } from "@commonair/db";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type Person = Awaited<ReturnType<typeof signUpAndSignIn>>;
type Month = { month: string; note: { body: string; updatedAt: string } | null };

const MONTH = "2026-08";
let api: TestApi;
let treasurer: Person;
let viewer: Person;
let admin: Person;
const db = () => api.db.db;

const setNote = (who: Person, month: string, body: string) =>
  who.client.call<{ ok: true }>("PUT", `/api/transparency/notes/${month}`, { body });

async function monthOf(month: string): Promise<Month | undefined> {
  const r = await client(api).call<Month[]>("GET", "/api/transparency?months=12");
  expect(r.status).toBe(200);
  return r.body.find((m) => m.month === month);
}

const audits = () =>
  db()
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.subjectType, "transparency_month"), eq(schema.auditLog.subjectId, MONTH)))
    .orderBy(schema.auditLog.createdAt, schema.auditLog.id);

beforeAll(async () => {
  api = await startApi();
  [treasurer, viewer, admin] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api), signUpAndSignIn(api)]);
  await db().update(schema.users).set({ role: "treasurer" }).where(eq(schema.users.id, treasurer.userId));
  await db().update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, admin.userId));
  api.deps.now = () => new Date("2026-09-10T12:00:00Z");
  // A cost in August gives the month ledger activity, so `coop.transparency` lists it.
  const cost = await treasurer.client.call("POST", "/api/treasurer/costs", {
    periodStart: "2026-08-01T00:00:00Z",
    periodEnd: "2026-09-01T00:00:00Z",
    category: "hosting",
    description: "servers",
    amountCents: 5000,
  });
  if (cost.status !== 200) throw new Error(`recordCost answered ${cost.status}`);
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

describe("transparency.setNote", () => {
  test("only a treasurer may write a note: signed out 401, a viewer and an admin 403", async () => {
    expect((await client(api).call("PUT", `/api/transparency/notes/${MONTH}`, { body: "x" })).status).toBe(401);
    expect((await setNote(viewer, MONTH, "x")).status).toBe(403);
    expect((await setNote(admin, MONTH, "x")).status).toBe(403);
    expect(await db().select().from(schema.transparencyNotes)).toEqual([]);
    expect(await audits()).toEqual([]);
  });

  test("the contract refuses a malformed month and a note over 2000 characters", async () => {
    expect((await setNote(treasurer, "2026-13", "x")).status).toBe(400);
    expect((await setNote(treasurer, "26-08", "x")).status).toBe(400);
    expect((await setNote(treasurer, MONTH, "x".repeat(2001))).status).toBe(400);
    expect(await db().select().from(schema.transparencyNotes)).toEqual([]);
  });

  test("set: the trimmed note is stored, audited by length only, and shown on its month", async () => {
    const body = "  A member donation of $500 covers this month's gap.  ";
    const r = await setNote(treasurer, MONTH, body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ ok: true });
    const rows = await db().select().from(schema.transparencyNotes);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ month: MONTH, body: body.trim(), updatedBy: treasurer.userId });

    const [row] = await audits();
    expect(row).toMatchObject({
      actorType: "admin",
      actorId: treasurer.userId,
      action: "transparency.note.set",
      subjectType: "transparency_month",
      subjectId: MONTH,
      details: { length: body.trim().length },
    });
    expect(JSON.stringify(row)).not.toContain("donation");

    const aug = await monthOf(MONTH);
    expect(aug?.note).toEqual({ body: body.trim(), updatedAt: rows[0]?.updatedAt.toISOString() });
  });

  test("replace: the same row takes the new text, with a second audit row", async () => {
    api.deps.now = () => new Date("2026-09-11T12:00:00Z");
    expect((await setNote(treasurer, MONTH, "Reserves from the founding shares cover the gap.")).status).toBe(200);
    const rows = await db().select().from(schema.transparencyNotes);
    expect(rows.map((r) => [r.month, r.body])).toEqual([[MONTH, "Reserves from the founding shares cover the gap."]]);
    expect(rows[0]?.updatedAt.toISOString()).toBe("2026-09-11T12:00:00.000Z");
    expect((await audits()).map((a) => a.action)).toEqual(["transparency.note.set", "transparency.note.set"]);
    expect((await monthOf(MONTH))?.note?.body).toBe("Reserves from the founding shares cover the gap.");
  });

  test("remove: a blank note deletes the row (audited once); the month's note is null again", async () => {
    expect((await setNote(treasurer, MONTH, "   ")).status).toBe(200);
    expect(await db().select().from(schema.transparencyNotes)).toEqual([]);
    const after = await audits();
    expect(after.map((a) => a.action)).toEqual([
      "transparency.note.set",
      "transparency.note.set",
      "transparency.note.remove",
    ]);
    expect(after[2]).toMatchObject({ actorId: treasurer.userId, details: { length: 0 } });
    expect((await monthOf(MONTH))?.note).toBeNull();
    // Removing a note that is not there changes nothing and audits nothing.
    expect((await setNote(treasurer, MONTH, "")).status).toBe(200);
    expect(await audits()).toHaveLength(3);
  });

  test("months without a note carry note: null; a note on a month not shown is not listed", async () => {
    expect((await setNote(treasurer, "2020-01", "An old note.")).status).toBe(200);
    const r = await client(api).call<Month[]>("GET", "/api/transparency?months=12");
    expect(r.body.length).toBeGreaterThan(0);
    for (const m of r.body) expect(m).toMatchObject({ note: null });
    expect(r.body.some((m) => m.month === "2020-01")).toBe(false);
  });
});
