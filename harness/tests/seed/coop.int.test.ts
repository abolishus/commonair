// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-coop writes nothing directly (every co-op table is protected, so the API and the worker
 * write them). What runs against the database as the app role is its readers: the facts its plans
 * need (birth dates, tier prices, the active electorate), the row counts it reports, the rows its
 * privacy scan reads, and the jury sample check. This checks each one on a migrated database with a
 * minimal social fixture, and that the scan catches what must never reach the audit or outbox rows.
 * The API-driven steps are exercised by `seed full` live.
 */
import { schema, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { SEED_GOVERNANCE_BOOTSTRAP, governancePeriods, preflightGovernance, rowLeaks } from "../../src/coop.ts";
import { unit } from "../../src/seed/coop.ts";
import {
  activeClassesByUser,
  birthDates,
  coopRowsSince,
  countRows,
  sampledCases,
  tierPrices,
} from "../../src/seed/coop/db.ts";
import { isAdult, rulesOf, seatsOf } from "../../src/seed/coop/plan.ts";

let t: TestDatabase;
const ids = { member1: uuidv7(), council1: uuidv7(), v1: uuidv7(), minor: uuidv7() };
const channelId = uuidv7();
const since = new Date(Date.now() - 1_000);

beforeAll(async () => {
  // The seed overlay's database: migrated with its bootstrap (harness/compose.seed.yaml).
  t = await createTestDatabase({ governance: SEED_GOVERNANCE_BOOTSTRAP });
  const { db } = t.app;
  const user = (id: string, handle: string, birthDate: string | null) => ({
    id,
    name: handle,
    email: `demo_${handle}@demo-seed.invalid`,
    emailVerified: true,
    username: `demo_${handle}`,
    displayUsername: `demo_${handle}`,
    birthDate,
  });
  await db
    .insert(schema.users)
    .values([
      user(ids.member1, "member1", "1990-04-02"),
      user(ids.council1, "council1", "1985-01-20"),
      user(ids.v1, "v00001", "1999-12-31"),
      user(ids.minor, "v00002", "2012-06-01"),
    ]);
  await db
    .insert(schema.channels)
    .values({ id: channelId, ownerId: ids.council1, slug: "demo_council1", displayName: "Sly Kettle" });
  await db.insert(schema.channelSubTiers).values([
    { channelId, tier: 1, name: "Tier 1", priceCents: 499 },
    { channelId, tier: 2, name: "Tier 2", priceCents: 999 },
  ]);
  // As the API writes them (the membership triggers keep the history).
  await db.insert(schema.memberships).values([
    { id: uuidv7(), userId: ids.member1, class: "worker", basis: "board_appointment" },
    { id: uuidv7(), userId: ids.member1, class: "viewer", basis: "share" },
    { id: uuidv7(), userId: ids.council1, class: "streamer", basis: "streaming_hours" },
  ]);
  // Rows shaped like the API's co-op audit and outbox rows: ids and enums only.
  await db.insert(schema.auditLog).values({
    actorType: "user",
    actorId: ids.member1,
    action: "proposal.vote",
    subjectType: "proposal",
    subjectId: uuidv7(),
    details: { proposalId: uuidv7() },
  });
  await db.insert(schema.events).values({ id: uuidv7(), type: "coop.vote.cast", payload: { proposal_id: uuidv7() } });
  await db.insert(schema.events).values({ id: uuidv7(), type: "chat.message", payload: { body: "yes" } });
}, 120_000);

afterAll(async () => {
  await t?.drop();
});

describe("seed-coop readers as the app role", () => {
  test("the bootstrapped settings pass the preflight and give the plan's rules and seats", async () => {
    const settings = await t.app.db
      .select({ key: schema.governanceSettings.key, value: schema.governanceSettings.value })
      .from(schema.governanceSettings);
    expect(preflightGovernance(settings).ok).toBe(true);
    // The migration took the seed stack's shorter periods (the database checks them too).
    expect(governancePeriods(settings)).toEqual({
      discussionSeconds: 20,
      councilReviewSeconds: 20,
      votingSeconds: 30,
      protectedVotingSeconds: 30,
    });
    expect(rulesOf(settings).ordinary.quorum).toBe(0.01);
    expect(rulesOf(settings).protected.memberWideThreshold).toBeCloseTo(2 / 3);
    expect(seatsOf(settings)).toEqual({ streamer: 3, viewer: 3, worker: 1 });
  });

  test("birth dates come back by id and decide who is an adult", async () => {
    const births = await birthDates(t.app, Object.values(ids));
    expect(births.size).toBe(4);
    const now = new Date();
    expect(isAdult(births.get(ids.member1) ?? null, now)).toBe(true);
    expect(isAdult(births.get(ids.minor) ?? null, now)).toBe(false);
    expect((await birthDates(t.app, [])).size).toBe(0);
  });

  test("tier prices by channel slug", async () => {
    expect(await tierPrices(t.app)).toEqual({
      demo_council1: [
        { tier: 1, price: { cents: 499 } },
        { tier: 2, price: { cents: 999 } },
      ],
    });
  });

  test("the active electorate by user, classes sorted", async () => {
    const e = await activeClassesByUser(t.app);
    expect(e.get(ids.member1)).toEqual(["viewer", "worker"]);
    expect(e.get(ids.council1)).toEqual(["streamer"]);
    expect(e.has(ids.v1)).toBe(false);
  });

  test("row counts of every owned table; the triggers wrote the membership history", async () => {
    const n = await countRows(t.app, unit.tables);
    expect(Object.keys(n).sort()).toEqual([...unit.tables].sort());
    expect(n.memberships).toBe(3);
    expect(n.membership_history).toBeGreaterThanOrEqual(3);
    // The migration's own settings rows are history too, so the report counts the difference.
    expect(n.governance_settings_history).toBeGreaterThan(0);
    await expect(countRows(t.app, ["users; drop table users"])).rejects.toThrow(/bad table name/);
  });

  test("the privacy scan reads only co-op rows since the start, and finds no leak in API-shaped rows", async () => {
    const rows = await coopRowsSince(t.app, since);
    expect(rows.audit.map((r) => r.action)).toEqual(["proposal.vote"]);
    expect(rows.events.map((r) => r.type)).toEqual(["coop.vote.cast"]);
    const emails = ["demo_member1@demo-seed.invalid"];
    expect(rowLeaks(rows.audit, rows.events, { commentBodies: ["I support this"], emails })).toEqual([]);
    expect((await coopRowsSince(t.app, new Date(Date.now() + 60_000))).audit).toEqual([]);
  });

  test("the scan catches a ballot choice, a comment body or an email", () => {
    const leaks = rowLeaks(
      [
        {
          action: "proposal.vote",
          actorType: "user",
          actorId: ids.member1,
          subjectType: "proposal",
          subjectId: "p",
          details: { choice: "yes" },
        },
      ],
      [{ type: "coop.proposal.comment", payload: { body: "I support this", by: "demo_member1@demo-seed.invalid" } }],
      { commentBodies: ["I support this"], emails: ["demo_member1@demo-seed.invalid"] },
    );
    expect(leaks.map((l) => l.kind).sort()).toEqual(["comment-body", "email", "vote-choice"]);
  });

  test("the jury sample check runs as the app role", async () => {
    expect(await sampledCases(t.app, uuidv7())).toEqual([]);
  });
});
