// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * d2-metrics against Postgres and Valkey: `POST /metrics/ui` counts a cookieless keepalive POST
 * from the web origin (and from elsewhere), ignores a session, answers Ok when rate limited or
 * capped, and keeps no address in Valkey; `admin.growth` is admins only and floors every cell;
 * `transparency.numbers` is public, covers the last 12 UTC months and floors too.
 */
import { GROWTH_METRICS, type GrowthMetric } from "@commonair/contracts/enums";
import type { GrowthNumbers, GrowthReport } from "@commonair/contracts/dto";
import { schema, uuidv7 } from "@commonair/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { recordUiMetric, utcDay } from "../src/growth/ingest.ts";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

let api: TestApi;
let admin: Awaited<ReturnType<typeof signUpAndSignIn>>;
let plain: Awaited<ReturnType<typeof signUpAndSignIn>>;
const db = () => api.db.db;
const WEB = "http://localhost:3000";

async function counter(surface: string, action: string, step = "none", day = utcDay(new Date())) {
  const [row] = await db()
    .select({ count: schema.uiCounters.count })
    .from(schema.uiCounters)
    .where(
      and(
        eq(schema.uiCounters.day, day),
        eq(schema.uiCounters.surface, surface as never),
        eq(schema.uiCounters.action, action as never),
        eq(schema.uiCounters.step, step as never),
      ),
    );
  return row ? Number(row.count) : 0;
}

/** Exactly what `trackUi` sends: keepalive, no credentials, JSON. */
function beacon(body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${api.url}/api/metrics/ui`, {
    method: "POST",
    keepalive: true,
    credentials: "omit",
    headers: { origin: WEB, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function atTime<T>(at: Date, fn: () => Promise<T>): Promise<T> {
  const real = api.deps.now;
  api.deps.now = () => at;
  try {
    return await fn();
  } finally {
    api.deps.now = real;
  }
}

beforeAll(async () => {
  api = await startApi();
  [admin, plain] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api)]);
  await db().update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, admin.userId));
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

describe("metrics.ui", () => {
  test("a cookieless keepalive POST from the web origin is counted, and repeats add up", async () => {
    const res = await beacon({ surface: "home.hero", action: "view" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("access-control-allow-origin")).toBe(WEB);
    expect(await counter("home.hero", "view")).toBe(1);
    await beacon({ surface: "home.hero", action: "view", step: "none" });
    expect(await counter("home.hero", "view")).toBe(2);
  });

  test("another origin is counted too (no cookie is needed), and a session changes nothing", async () => {
    expect(
      (await beacon({ surface: "signup", action: "submit", step: "stream" }, { origin: "https://elsewhere.test" }))
        .status,
    ).toBe(200);
    const signedIn = await client(api, { jar: plain.client.jar }).call("POST", "/api/metrics/ui", {
      surface: "signup",
      action: "submit",
      step: "stream",
    });
    expect(signedIn.status).toBe(200);
    expect(await counter("signup", "submit", "stream")).toBe(2);
    // The table has no column that could hold who sent it.
    const [row] = await db().select().from(schema.uiCounters).where(eq(schema.uiCounters.surface, "signup"));
    expect(Object.keys(row ?? {}).sort()).toEqual(["action", "count", "day", "step", "surface", "updatedAt"]);
  });

  test("names off the closed lists are refused before anything is written", async () => {
    expect((await beacon({ surface: "home.nope", action: "view" })).status).toBe(400);
    expect((await beacon({ surface: "home.hero", action: "hover" })).status).toBe(400);
    expect((await beacon({ surface: "home.hero", action: "view", step: "user-42" })).status).toBe(400);
    expect((await beacon({ surface: "home.hero", action: "view", userId: "x" })).status).toBe(200);
    expect(await counter("home.hero", "view")).toBe(3);
  });

  test("an empty bucket and a full surface both answer Ok without counting", async () => {
    const day = new Date("2031-01-02T10:00:00Z");
    const limits = { burst: 2, refillPerSecond: 0.001, surfaceDayCap: 1_000 };
    const deps = { ...api.deps, now: () => day };
    const ev = { surface: "creators.calc", action: "used", step: "none" } as const;
    expect(await recordUiMetric(deps, "198.51.100.9", ev, limits)).toBe("counted");
    expect(await recordUiMetric(deps, "198.51.100.9", ev, limits)).toBe("counted");
    expect(await recordUiMetric(deps, "198.51.100.9", ev, limits)).toBe("rate_limited");
    // Another address has its own bucket; the surface cap is shared.
    const capped = { burst: 5, refillPerSecond: 1, surfaceDayCap: 3 };
    expect(await recordUiMetric(deps, "198.51.100.10", ev, capped)).toBe("counted");
    expect(await recordUiMetric(deps, "198.51.100.10", ev, capped)).toBe("capped");
    expect(await counter("creators.calc", "used", "none", "2031-01-02")).toBe(3);
    // The next UTC day starts a new cap and new buckets.
    const next = { ...deps, now: () => new Date("2031-01-03T00:00:01Z") };
    expect(await recordUiMetric(next, "198.51.100.9", ev, capped)).toBe("counted");

    // Over HTTP the answer is the same either way.
    await atTime(day, async () => {
      for (let i = 0; i < 3; i++) expect((await beacon(ev)).status).toBe(200);
    });
  });

  test("beacons have their own high bucket: 40 from one address all answer Ok, keyed by address", async () => {
    const ev = { surface: "home.hero", action: "click", step: "none" } as const;
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) statuses.push((await beacon(ev)).status);
    expect(statuses.filter((s) => s !== 200)).toEqual([]);
    // Signed in, the limiter still keys by address: no user id reaches the metrics bucket.
    const signedIn = await client(api, { jar: plain.client.jar }).call("POST", "/api/metrics/ui", ev);
    expect(signedIn.status).toBe(200);
    const keys = await api.deps.valkey.keys(`${api.keyPrefix}rl:metrics:*`);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(k).toContain("rl:metrics:ip:");
      expect(k).not.toContain(plain.userId);
    }
  });

  test("Valkey holds hashed, short-lived bucket keys and never the address", async () => {
    await recordUiMetric(api.deps, "203.0.113.77", { surface: "coop.band", action: "click", step: "none" });
    const keys = await api.deps.valkey.keys(`${api.keyPrefix}ui-metrics:*`);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(k).not.toContain("203.0.113.77");
      expect(k).not.toContain("127.0.0.1");
    }
    const bucket = keys.find((k) => k.includes("ui-metrics:tb:"));
    expect(bucket).toBeDefined();
    const ttl = await api.deps.valkey.pttl(bucket!.slice(api.keyPrefix.length));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(5 * 60_000);
  });
});

// Reports read at 2026-06-20 (UTC): the 30-day window is 2026-05-21 to 2026-06-19.
const NOW = new Date("2026-06-20T08:00:00Z");

async function daily(day: string, values: Partial<Record<GrowthMetric, number>>) {
  const rows = Object.entries(values).map(([metric, value]) => ({ day, metric: metric as GrowthMetric, value }));
  await db()
    .insert(schema.growthDaily)
    .values(rows)
    .onConflictDoUpdate({
      target: [schema.growthDaily.day, schema.growthDaily.metric],
      set: { value: schema.growthDaily.value },
    });
}

describe("admin.growth", () => {
  beforeAll(async () => {
    await daily("2026-06-18", { accounts_created: 4, accounts_verified: 3, members_total: 40, active_streamers: 9 });
    await daily("2026-06-19", { accounts_created: 3, accounts_verified: 1, members_total: 42, active_streamers: 4 });
    await daily("2026-05-20", { accounts_created: 100 }); // the day before the window
    await daily("2026-06-20", { accounts_created: 100 }); // today: not in the window
    const ui = [
      { day: "2026-06-01", surface: "home.hero", action: "view", step: "none", count: 30 },
      { day: "2026-06-02", surface: "home.hero", action: "view", step: "none", count: 12 },
      { day: "2026-06-02", surface: "authGate", action: "view", step: "follow", count: 4 },
    ] as const;
    await db()
      .insert(schema.uiCounters)
      .values([...ui]);
    // Accounts by intent: six "follow" and two "stream" in the window, one "follow" before it.
    const user = (i: number, intent: "follow" | "stream" | null, createdAt: Date) => ({
      id: uuidv7(),
      name: `intent${i}`,
      email: `intent${i}@test.invalid`,
      username: `intent${i}`,
      signupIntent: intent,
      createdAt,
    });
    await db()
      .insert(schema.users)
      .values([
        ...Array.from({ length: 6 }, (_, i) => user(i, "follow", new Date("2026-06-10T12:00:00Z"))),
        user(6, "stream", new Date("2026-06-10T12:00:00Z")),
        user(7, "stream", new Date("2026-06-11T12:00:00Z")),
        user(8, "follow", new Date("2026-05-01T12:00:00Z")),
      ]);
  });

  const report = () => atTime(NOW, () => admin.client.call<GrowthReport>("GET", "/api/admin/growth?days=30"));

  test("admins only", async () => {
    expect((await plain.client.call("GET", "/api/admin/growth")).status).toBe(403);
    expect((await client(api).call("GET", "/api/admin/growth")).status).toBe(401);
    expect((await admin.client.call("GET", "/api/admin/growth?days=3")).status).toBe(400);
  });

  test("the window ends yesterday and every metric has a point per day", async () => {
    const { status, body } = await report();
    expect(status).toBe(200);
    expect(body.from).toBe("2026-05-21");
    expect(body.to).toBe("2026-06-19");
    expect(body.series.map((s) => s.metric)).toEqual([...GROWTH_METRICS]);
    for (const s of body.series) expect(s.points).toHaveLength(30);
    expect(body.totals.map((x) => x.metric)).toEqual([...GROWTH_METRICS]);
  });

  test("flows are summed, stocks take the last day, and anything under 5 is null", async () => {
    const { body } = await report();
    const total = Object.fromEntries(body.totals.map((x) => [x.metric, x.value]));
    expect(total.accounts_created).toBe(7);
    expect(total.accounts_verified).toBeNull(); // 4
    expect(total.members_total).toBe(42);
    expect(total.active_streamers).toBeNull(); // 4 on the last day
    expect(total.first_live).toBeNull(); // no rows
    const created = body.series.find((s) => s.metric === "accounts_created")!.points;
    // Each daily point is floored on its own: 4 and 3 are both hidden.
    expect(created.filter((p) => p.value !== null)).toEqual([]);
    const members = body.series.find((s) => s.metric === "members_total")!.points;
    expect(members.slice(-2)).toEqual([
      { day: "2026-06-18", value: 40 },
      { day: "2026-06-19", value: 42 },
    ]);
  });

  test("sign-ups by intent and UI counters are floored aggregates", async () => {
    const { body } = await report();
    const intents = Object.fromEntries(body.signupsByIntent.map((x) => [x.intent, x.value]));
    expect(intents.follow).toBe(6);
    expect(intents.stream).toBeNull();
    expect(body.signupsByIntent).toHaveLength(10);
    const hero = body.ui.find((r) => r.surface === "home.hero" && r.action === "view");
    expect(hero?.value).toBe(42);
    expect(body.ui[0]).toEqual(hero);
    expect(body.ui.find((r) => r.surface === "authGate")?.value).toBeNull();
    for (const row of body.ui) expect(Object.keys(row).sort()).toEqual(["action", "step", "surface", "value"]);
  });
});

describe("transparency.numbers", () => {
  beforeAll(async () => {
    // 2026-05: 3 + 4 accounts, plus the admin fixture's 100 on the 20th; members 12 then 15 (the
    // last day wins); 3 active streamers (hidden).
    await daily("2026-05-03", { accounts_created: 3, members_total: 12, active_streamers: 2 });
    await daily("2026-05-30", { accounts_created: 4, members_total: 15, active_streamers: 3 });
    // 2025-06 is 13 months back: outside the 12.
    await daily("2025-06-30", { accounts_created: 50, members_total: 50, active_streamers: 50 });
    await daily("2025-07-01", { accounts_created: 6 });
  });

  test("public, the last 12 UTC months ending with this one, floored", async () => {
    const res = await atTime(NOW, () => client(api).call<GrowthNumbers>("GET", "/api/transparency/numbers"));
    expect(res.status).toBe(200);
    const months = res.body.months;
    expect(months).toHaveLength(12);
    expect(months[0]?.month).toBe("2025-07");
    expect(months.at(-1)?.month).toBe("2026-06");
    const may = months.find((m) => m.month === "2026-05");
    expect(may).toEqual({ month: "2026-05", accountsCreated: 107, membersTotal: 15, activeStreamers: null });
    expect(months[0]).toEqual({ month: "2025-07", accountsCreated: 6, membersTotal: null, activeStreamers: null });
    // June so far (the admin fixtures): 4 + 3 + today's 100 accounts, 42 members on the last day, 4 streamers.
    const june = months.at(-1);
    expect(june).toEqual({ month: "2026-06", accountsCreated: 107, membersTotal: 42, activeStreamers: null });
    const shown = months
      .flatMap((m) => [m.accountsCreated, m.membersTotal, m.activeStreamers])
      .filter((v) => v !== null);
    expect(shown.every((v) => v >= 5)).toBe(true);
  });
});
