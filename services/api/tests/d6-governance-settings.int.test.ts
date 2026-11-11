// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Overhaul wave 4 (D6.2): `coop.settings` names the proposal that last changed each setting
 * (`updatedByProposalTitle`, "Changed by …"). A setting changes only through an applied proposal,
 * so the change goes through the real lifecycle (FAST_GOVERNANCE periods) as the app role.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { schema as s } from "@commonair/db";
import { FAST_GOVERNANCE, createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { advanceProposals } from "@commonair/governance";
import { settingsView } from "../src/coop/council.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 180_000 });

let t: TestDatabase;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  t = await createTestDatabase({ governance: FAST_GOVERNANCE });
});
afterAll(async () => {
  await t?.drop();
});

let n = 0;
async function member(cls: "streamer" | "viewer"): Promise<string> {
  n += 1;
  const username = `d6gov${n}${crypto.randomUUID().slice(0, 6)}`;
  const [u] = await t.app.db
    .insert(s.users)
    .values({ name: username, username, email: `${username}@example.test` })
    .returning({ id: s.users.id });
  if (!u) throw new Error("no user");
  await t.app.db
    .insert(s.memberships)
    .values({ userId: u.id, class: cls, basis: cls === "streamer" ? "streaming_hours" : "share" });
  return u.id;
}

/** Run the worker's step until the proposal is applied (the voting window is 2 s). */
async function untilApplied(id: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    await advanceProposals(t.app.db);
    const [p] = await t.app.db.select({ status: s.proposals.status }).from(s.proposals).where(eq(s.proposals.id, id));
    if (p?.status === "applied") return;
    if (p?.status === "rejected" || p?.status === "withdrawn") throw new Error(`proposal ${p.status}`);
    await sleep(250);
  }
  throw new Error("the proposal was not applied");
}

describe("coop.settings: updatedByProposalTitle", () => {
  test("a seeded setting has no proposal and no title", async () => {
    const view = await settingsView(t.app.db);
    expect(view.length).toBeGreaterThan(10);
    for (const row of view) expect(row).toMatchObject({ updatedByProposalId: null, updatedByProposalTitle: null });
    expect(view.map((r) => r.key)).toEqual(view.map((r) => r.key).toSorted());
  });

  test("an applied proposal's title is the setting's 'Changed by'", async () => {
    const [a, b, v] = [await member("streamer"), await member("streamer"), await member("viewer")];
    const [row] = await t.app.db
      .select({ value: s.governanceSettings.value })
      .from(s.governanceSettings)
      .where(eq(s.governanceSettings.key, "discovery.ranking"));
    const next = { ...(row?.value as Record<string, unknown>), spotlightSlots: 6 };
    const [p] = await t.app.db
      .insert(s.proposals)
      .values({
        authorId: a,
        title: "Six spotlight slots",
        body: "More room for small channels.",
        kind: "ordinary",
        affectsCreators: false,
        changes: [{ key: "discovery.ranking", value: next }],
      })
      .returning({ id: s.proposals.id });
    if (!p) throw new Error("no proposal");
    await t.app.db.update(s.proposals).set({ status: "discussion" }).where(eq(s.proposals.id, p.id));
    await sleep(20);
    // Open voting, then vote before the window closes.
    for (let i = 0; i < 40; i++) {
      await advanceProposals(t.app.db);
      const [cur] = await t.app.db
        .select({ status: s.proposals.status })
        .from(s.proposals)
        .where(eq(s.proposals.id, p.id));
      if (cur?.status === "voting") break;
      await sleep(100);
    }
    await t.app.db
      .insert(s.votes)
      .values([a, b, v].map((userId) => ({ proposalId: p.id, userId, choice: "yes" as const })));
    await untilApplied(p.id);

    const view = await settingsView(t.app.db);
    expect(view.find((r) => r.key === "discovery.ranking")).toMatchObject({
      value: next,
      updatedByProposalId: p.id,
      updatedByProposalTitle: "Six spotlight slots",
    });
    // The other settings are untouched by the join.
    expect(view.find((r) => r.key === "platform.cut")).toMatchObject({
      updatedByProposalId: null,
      updatedByProposalTitle: null,
    });
    const [count] = (await t.app.db.execute(sql`select count(*)::int as n from governance_settings`)) as unknown as {
      n: number;
    }[];
    expect(view).toHaveLength(count?.n ?? -1);
  });
});
