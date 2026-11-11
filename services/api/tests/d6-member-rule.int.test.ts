// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Wave 2 leftover (overhaul D6): the Support dialog's member line against the real API. The web's
 * `apiSupportClient.memberRule` (apps/web/src/components/support/support-dialog.tsx) calls exactly
 * `coop.settings()` and `coop.membership()`, then reads:
 *
 * - from settings, the `membership.classes` row's `value.viewer.activeSubscriptionQualifies`
 *   (boolean) and `value.viewer.minSubscriptionCents` (whole cents; `subMemberRule` in
 *   member-notice.tsx);
 * - from the membership view, `memberships[]` with `class`, `status` and `joinedAt`
 *   (`subMemberRuleFor`: an active viewer membership, or a latest one that was exited, drops the line).
 *
 * This test calls the same routes with the same (empty) input and asserts those fields, so a
 * contract or settings drift breaks here instead of silently dropping the "$3+ sub makes you a
 * member" line.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import { schema } from "@commonair/db";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type Person = Awaited<ReturnType<typeof signUpAndSignIn>>;

/** The client's parse (`SubRule` in member-notice.tsx), strict about the fields it reads. */
const ClientSubRule = z.object({
  viewer: z.object({
    activeSubscriptionQualifies: z.boolean(),
    minSubscriptionCents: z.number().int().min(0),
  }),
});
const ClientSetting = z.object({ key: z.string(), value: z.unknown() });
const ClientMembershipView = z.object({
  memberships: z.array(
    z.object({ class: z.string(), status: z.enum(["active", "lapsed", "exited"]), joinedAt: z.string() }),
  ),
});

let api: TestApi;
let viewer: Person;
const db = () => api.db.db;

beforeAll(async () => {
  api = await startApi();
  viewer = await signUpAndSignIn(api);
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

async function memberRuleCalls(who: Person) {
  const [settings, view] = await Promise.all([
    who.client.call<unknown>("GET", "/api/coop/settings"),
    who.client.call<unknown>("GET", "/api/coop/membership"),
  ]);
  expect(settings.status).toBe(200);
  expect(view.status).toBe(200);
  return { settings: z.array(ClientSetting).parse(settings.body), view: ClientMembershipView.parse(view.body) };
}

describe("apiSupportClient.memberRule's calls", () => {
  test("coop.settings carries membership.classes with the sub rule the client reads: a $3+ sub qualifies", async () => {
    const { settings } = await memberRuleCalls(viewer);
    const row = settings.find((s) => s.key === "membership.classes");
    expect(row).toBeDefined();
    const rule = ClientSubRule.parse(row?.value);
    // The governance default (packages/db seed): an active subscription of 300 cents or more.
    expect(rule.viewer).toEqual({ activeSubscriptionQualifies: true, minSubscriptionCents: 300 });

    // The API returns the stored setting, not a literal of its own.
    const [stored] = await db()
      .select({ value: schema.governanceSettings.value })
      .from(schema.governanceSettings)
      .where(eq(schema.governanceSettings.key, "membership.classes"));
    expect(ClientSubRule.parse(stored?.value).viewer).toEqual(rule.viewer);
  });

  test("coop.settings is public: the same rule signed out", async () => {
    const r = await client(api).call<unknown>("GET", "/api/coop/settings");
    expect(r.status).toBe(200);
    const row = z
      .array(ClientSetting)
      .parse(r.body)
      .find((s) => s.key === "membership.classes");
    expect(ClientSubRule.parse(row?.value).viewer.minSubscriptionCents).toBe(300);
  });

  test("coop.membership: no memberships for a new account, so the client keeps the line", async () => {
    const { view } = await memberRuleCalls(viewer);
    expect(view.memberships.filter((m) => m.class === "viewer")).toEqual([]);
  });

  test("coop.membership lists an active viewer membership with the fields the client narrows on", async () => {
    await db().insert(schema.memberships).values({ userId: viewer.userId, class: "viewer", basis: "subscription" });
    const { view } = await memberRuleCalls(viewer);
    const viewerRows = view.memberships.filter((m) => m.class === "viewer");
    expect(viewerRows).toHaveLength(1);
    expect(viewerRows[0]).toMatchObject({ class: "viewer", status: "active" });
    expect(Number.isNaN(Date.parse(viewerRows[0]?.joinedAt ?? ""))).toBe(false);
  });

  test("an exited viewer membership reads as exited (the client then leaves the line out)", async () => {
    await db()
      .update(schema.memberships)
      .set({ status: "exited", exitedAt: new Date() })
      .where(eq(schema.memberships.userId, viewer.userId));
    const { view } = await memberRuleCalls(viewer);
    expect(view.memberships.filter((m) => m.class === "viewer").map((m) => m.status)).toEqual(["exited"]);
  });

  test("coop.membership needs a session (the dialog is signed in only)", async () => {
    expect((await client(api).call("GET", "/api/coop/membership")).status).toBe(401);
  });
});
