// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Email unsubscribe (ADR 0028 decision 4, RFC 8058; N1-email): the one-click raw route
 * `/api/email/unsubscribe` and `notifications.unsubscribe`, against real Postgres and Valkey.
 */
import { EMAIL_UNSUBSCRIBE_PATH, UNSUBSCRIBE_PAGE_PATH } from "@commonair/contracts/notify";
import { schema } from "@commonair/db";
import { signUnsubscribeToken } from "@commonair/tokens";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { client, startApi, uniqueName, type TestApi } from "./harness.ts";

let api: TestApi;
beforeAll(async () => {
  api = await startApi();
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const db = () => api.db.db;
const np = schema.notificationPreferences;

async function newMember(): Promise<{ id: string; channelId: string }> {
  const username = uniqueName("un");
  const [u] = await db()
    .insert(schema.users)
    .values({ name: username, email: `${username}@example.test`, username, emailVerified: true })
    .returning({ id: schema.users.id });
  const [c] = await db()
    .insert(schema.channels)
    .values({ ownerId: u!.id, slug: username, displayName: username })
    .returning({ id: schema.channels.id });
  return { id: u!.id, channelId: c!.id };
}

const token = (userId: string, list: "go_live" | "governance") =>
  signUnsubscribeToken(api.deps.env.AUTH_SECRET, userId, list);

const oneClickUrl = (query: Record<string, string>) =>
  `${api.url}${EMAIL_UNSUBSCRIBE_PATH}?${new URLSearchParams(query).toString()}`;

function oneClick(query: Record<string, string>, init: RequestInit = {}): Promise<Response> {
  return fetch(oneClickUrl(query), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
    redirect: "manual",
    ...init,
  });
}

async function prefs(userId: string) {
  const rows = await db()
    .select({ type: np.type, medium: np.medium, channelId: np.channelId, enabled: np.enabled })
    .from(np)
    .where(eq(np.userId, userId));
  return rows.toSorted((a, b) =>
    `${a.type}${a.medium}${a.channelId ?? ""}`.localeCompare(`${b.type}${b.medium}${b.channelId ?? ""}`),
  );
}

describe("GET (mail scanners prefetch it)", () => {
  test("answers 303 to the web confirm page with the same list and token, and applies nothing", async () => {
    const m = await newMember();
    const t = await token(m.id, "go_live");
    const res = await fetch(oneClickUrl({ list: "go_live", token: t, extra: "dropped" }), { redirect: "manual" });
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin).toBe(new URL(api.deps.site.publicUrl).origin);
    expect(location.pathname).toBe(UNSUBSCRIBE_PAGE_PATH);
    expect(Object.fromEntries(location.searchParams)).toEqual({ list: "go_live", token: t });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await prefs(m.id)).toEqual([]);
  });

  test("a GET without a query still lands on the confirm page (which shows the invalid state)", async () => {
    const res = await fetch(`${api.url}${EMAIL_UNSUBSCRIBE_PATH}`, { redirect: "manual" });
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location") ?? "").search).toBe("");
  });
});

describe("POST (RFC 8058 one-click)", () => {
  test("go_live: the default email row goes off and every go-live email override with it", async () => {
    const m = await newMember();
    const a = await newMember();
    const b = await newMember();
    await db()
      .insert(np)
      .values([
        { userId: m.id, type: "go_live", channelId: null, medium: "email", enabled: true },
        { userId: m.id, type: "go_live", channelId: a.channelId, medium: "email", enabled: true },
        { userId: m.id, type: "go_live", channelId: b.channelId, medium: "email", enabled: false },
        { userId: m.id, type: "go_live", channelId: a.channelId, medium: "push", enabled: true },
        { userId: m.id, type: "go_live", channelId: null, medium: "in_app", enabled: true },
        { userId: m.id, type: "proposal", channelId: null, medium: "email", enabled: true },
      ]);
    const res = await oneClick({ list: "go_live", token: await token(m.id, "go_live") });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const rows = await prefs(m.id);
    const find = (type: string, medium: string, channelId: string | null) =>
      rows.find((r) => r.type === type && r.medium === medium && r.channelId === channelId)?.enabled;
    expect(find("go_live", "email", null)).toBe(false);
    expect(find("go_live", "email", a.channelId)).toBe(false);
    expect(find("go_live", "email", b.channelId)).toBe(false);
    // Other media and other lists are untouched.
    expect(find("go_live", "push", a.channelId)).toBe(true);
    expect(find("go_live", "in_app", null)).toBe(true);
    expect(find("proposal", "email", null)).toBe(true);
    expect(rows).toHaveLength(6);
  });

  test("go_live with no rows yet stores the default email-off row", async () => {
    const m = await newMember();
    expect((await oneClick({ list: "go_live", token: await token(m.id, "go_live") })).status).toBe(200);
    expect(await prefs(m.id)).toEqual([{ type: "go_live", medium: "email", channelId: null, enabled: false }]);
  });

  test("governance: email off for proposal and vote_open, go-live untouched", async () => {
    const m = await newMember();
    await db()
      .insert(np)
      .values([
        { userId: m.id, type: "vote_open", channelId: null, medium: "email", enabled: true },
        { userId: m.id, type: "go_live", channelId: null, medium: "email", enabled: true },
      ]);
    // A multipart body is accepted as well: the token authorizes, not the body.
    const form = new FormData();
    form.set("List-Unsubscribe", "One-Click");
    const res = await oneClick(
      { list: "governance", token: await token(m.id, "governance") },
      {
        method: "POST",
        headers: {},
        body: form,
      },
    );
    expect(res.status).toBe(200);
    expect(await prefs(m.id)).toEqual([
      { type: "go_live", medium: "email", channelId: null, enabled: true },
      { type: "proposal", medium: "email", channelId: null, enabled: false },
      { type: "vote_open", medium: "email", channelId: null, enabled: false },
    ]);
  });

  test("a repeat is idempotent: 200 again, one row per type", async () => {
    const m = await newMember();
    const t = await token(m.id, "go_live");
    expect((await oneClick({ list: "go_live", token: t })).status).toBe(200);
    expect((await oneClick({ list: "go_live", token: t })).status).toBe(200);
    expect(await prefs(m.id)).toHaveLength(1);
  });

  test("forged, foreign-list, malformed or missing tokens and unknown lists answer 400", async () => {
    const m = await newMember();
    const good = await token(m.id, "go_live");
    const flipped = `${good.slice(0, -2)}${good.endsWith("AA") ? "AB" : "AA"}`;
    const cases: Record<string, string>[] = [
      { list: "go_live", token: flipped },
      { list: "governance", token: good },
      { list: "go_live", token: "v1.x.y" },
      { list: "go_live", token: "x".repeat(300) },
      { list: "go_live" },
      { list: "everything", token: good },
      {},
    ];
    for (const query of cases) {
      const res = await oneClick(query);
      expect({ query, status: res.status }).toEqual({ query, status: 400 });
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    // Another instance's secret signs nothing here.
    const foreign = await signUnsubscribeToken("another-instance-secret-0123456789abcdef", m.id, "go_live");
    expect((await oneClick({ list: "go_live", token: foreign })).status).toBe(400);
    expect(await prefs(m.id)).toEqual([]);
  });

  test("a token for a member who no longer exists answers 400", async () => {
    const t = await signUnsubscribeToken(api.deps.env.AUTH_SECRET, "0190a000-0000-7000-8000-000000000000", "go_live");
    expect((await oneClick({ list: "go_live", token: t })).status).toBe(400);
  });

  test("other methods answer 405", async () => {
    const res = await fetch(oneClickUrl({ list: "go_live", token: "x" }), { method: "PUT" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD, POST");
  });
});

describe("notifications.unsubscribe (the confirm page)", () => {
  test("applies the list for a valid token, signed out, and answers the list", async () => {
    const m = await newMember();
    await db()
      .insert(np)
      .values({ userId: m.id, type: "go_live", channelId: m.channelId, medium: "email", enabled: true });
    const anon = client(api);
    const t = await token(m.id, "go_live");
    const res = await anon.call("POST", "/api/notifications/unsubscribe", { list: "go_live", token: t });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ list: "go_live" });
    const rows = await db()
      .select({ enabled: np.enabled })
      .from(np)
      .where(and(eq(np.userId, m.id), eq(np.medium, "email")));
    expect(rows.map((r) => r.enabled)).toEqual([false, false]);
    // Idempotent.
    expect((await anon.call("POST", "/api/notifications/unsubscribe", { list: "go_live", token: t })).status).toBe(200);
  });

  test("a forged or foreign-list token is BAD_REQUEST", async () => {
    const m = await newMember();
    const anon = client(api);
    const t = await token(m.id, "governance");
    const res = await anon.call<{ code: string }>("POST", "/api/notifications/unsubscribe", {
      list: "go_live",
      token: t,
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BAD_REQUEST");
    const bad = await anon.call("POST", "/api/notifications/unsubscribe", { list: "go_live", token: "v1.a.b" });
    expect(bad.status).toBe(400);
  });
});

describe("rate limit", () => {
  let limited: TestApi;
  beforeAll(async () => {
    limited = await startApi({ rateLimits: { write: { max: 2, windowMs: 60_000 } } });
  }, 120_000);
  afterAll(async () => {
    await limited?.stop();
  });

  test("the one-click POST is limited per address in the write bucket: 429 with retry-after", async () => {
    const url = `${limited.url}${EMAIL_UNSUBSCRIBE_PATH}?list=go_live&token=v1.x.y`;
    const post = () => fetch(url, { method: "POST", body: "List-Unsubscribe=One-Click" });
    expect((await post()).status).toBe(400);
    expect((await post()).status).toBe(400);
    const res = await post();
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    // GET only redirects and is not limited.
    expect((await fetch(url, { redirect: "manual" })).status).toBe(303);
  });
});
