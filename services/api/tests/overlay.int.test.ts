// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Overlay tokens, alerts and the alert stream (docs/testing/e6-selectors.md "Overlays and alerts",
 * ADR 0021) against real Postgres and Valkey. The stream's re-check interval is shortened so
 * revocation and expiry are observed within seconds.
 */
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { BUS, OVERLAY_EVENTS_PATH } from "@commonair/contracts/events";
import { schema, uuidv7 } from "@commonair/db";
import { sha256Hex } from "@commonair/tokens";
import { configureOverlayHub, overlayHub } from "../src/overlay/stream.ts";
import { t } from "../src/overlay/messages.ts";
import { client, signUpAndSignIn, startApi, waitFor, type TestApi } from "./harness.ts";

let api: TestApi;
type User = Awaited<ReturnType<typeof signUpAndSignIn>>;
let s: User;
let other: User;

beforeAll(async () => {
  api = await startApi();
  await configureOverlayHub(api.deps, { pingMs: 1000, recheckMs: 1000 });
  [s, other] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api)]);
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const db = () => api.db.db;
type TokenOut = { token: string; alertsUrl: string; goalsUrl: string; chatUrl: string; expiresAt: string | null };

async function channelId(slug: string) {
  const [c] = await db().select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.slug, slug));
  if (!c) throw new Error("no channel");
  return c.id;
}

async function createToken(u: User, expiresAt?: string | null) {
  const r = await u.client.call<TokenOut>(
    "POST",
    `/api/channels/${u.username}/overlay-token`,
    expiresAt === undefined ? {} : { expiresAt },
  );
  return r;
}

const state = (token: string, how: "query" | "bearer" = "query") =>
  how === "query"
    ? client(api).call<{ channelSlug: string; eventsUrl: string; alerts: unknown[]; goals: unknown[] }>(
        "GET",
        `/api/overlay/state?token=${encodeURIComponent(token)}`,
      )
    : client(api, { bearer: token }).call<{
        channelSlug: string;
        eventsUrl: string;
        alerts: unknown[];
        goals: unknown[];
      }>("GET", "/api/overlay/state");

interface Frame {
  event: string;
  data: string;
}

async function openStream(token: string) {
  const ctrl = new AbortController();
  const res = await fetch(`${api.url}${OVERLAY_EVENTS_PATH}?token=${encodeURIComponent(token)}`, {
    signal: ctrl.signal,
  });
  const frames: Frame[] = [];
  let closed = false;
  if (res.status === 200 && res.body) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i = buf.indexOf("\n\n");
          while (i >= 0) {
            const raw = buf.slice(0, i);
            buf = buf.slice(i + 2);
            let event = "message";
            const data: string[] = [];
            for (const line of raw.split("\n")) {
              if (line.startsWith("event: ")) event = line.slice(7);
              else if (line.startsWith("data: ")) data.push(line.slice(6));
            }
            if (data.length) frames.push({ event, data: data.join("\n") });
            i = buf.indexOf("\n\n");
          }
        }
      } catch {
        // aborted
      }
      closed = true;
    })();
  } else {
    closed = true;
  }
  return {
    res,
    frames,
    closed: () => closed,
    alerts: () => frames.filter((f) => f.event === "alert").map((f) => JSON.parse(f.data) as Record<string, unknown>),
    close: () => ctrl.abort(),
  };
}

async function publishEvent(channel: string, type: string, payload: Record<string, unknown>) {
  const id = uuidv7();
  await api.deps.valkey.publish(
    BUS.events,
    JSON.stringify({ id, type, version: "1", channelId: channel, payload, occurredAt: new Date().toISOString() }),
  );
  return id;
}

const tipPayload = (u: User, value: number, anonymous = false) => ({
  broadcaster_user_id: u.userId,
  broadcaster_user_login: u.username,
  broadcaster_user_name: u.username,
  user_id: anonymous ? null : other.userId,
  user_login: anonymous ? null : other.username,
  user_name: anonymous ? null : "Vee Viewer",
  is_anonymous: anonymous,
  amount: { value, decimal_places: 2, currency: "usd" },
  message: "nice",
});

describe("alerts", () => {
  test("list returns one default per type; set upserts with an audit row; media keys are refused", async () => {
    const list = await s.client.call<{ type: string; enabled: boolean }[]>("GET", `/api/channels/${s.username}/alerts`);
    expect(list.status).toBe(200);
    expect(list.body.map((a) => a.type)).toEqual(["follow", "subscription", "tip", "raid"]);
    expect(list.body.every((a) => !a.enabled)).toBe(true);

    const body = {
      enabled: true,
      template: { message: "${user} tipped ${amount}", animation: "fade", showMessage: true },
      minAmountCents: 100,
      durationMs: 5000,
    };
    expect((await s.client.call("PUT", `/api/channels/${s.username}/alerts/tip`, body)).status).toBe(200);
    // Upsert: a second write updates the same row.
    expect((await s.client.call("PUT", `/api/channels/${s.username}/alerts/tip`, body)).status).toBe(200);
    const rows = await db()
      .select()
      .from(schema.alertConfigs)
      .where(eq(schema.alertConfigs.channelId, await channelId(s.username)));
    expect(rows).toHaveLength(1);
    const after = await s.client.call<{ type: string; enabled: boolean; minAmountCents: number }[]>(
      "GET",
      `/api/channels/${s.username}/alerts`,
    );
    expect(after.body.find((a) => a.type === "tip")).toMatchObject({ enabled: true, minAmountCents: 100 });
    const audits = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "alert.update"), eq(schema.auditLog.actorId, s.userId)));
    expect(audits.length).toBe(2);

    for (const extra of [{ imageKey: "uploads/x.png" }, { soundKey: "uploads/x.mp3" }]) {
      const r = await s.client.call("PUT", `/api/channels/${s.username}/alerts/follow`, {
        ...body,
        template: { ...body.template, ...extra },
      });
      expect(r.status).toBe(400);
    }
    // Not the owner.
    expect((await other.client.call("PUT", `/api/channels/${s.username}/alerts/tip`, body)).status).toBe(403);
    expect((await other.client.call("GET", `/api/channels/${s.username}/alerts`)).status).toBe(403);
  });
});

describe("overlay tokens", () => {
  test("create returns the token once with URLs; only the hash is stored; status reflects it", async () => {
    const r = await createToken(s);
    expect(r.status).toBe(200);
    expect(r.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.body.alertsUrl).toBe(`${api.url}/overlay/alerts?token=${r.body.token}`);
    expect(r.body.goalsUrl).toBe(`${api.url}/overlay/goals?token=${r.body.token}`);
    expect(r.body.chatUrl).toBe(`${api.url}/overlay/chat?token=${r.body.token}`);
    expect(r.body.expiresAt).toBeNull();
    const rows = await db()
      .select()
      .from(schema.overlayTokens)
      .where(eq(schema.overlayTokens.channelId, await channelId(s.username)));
    expect(rows.some((row) => row.tokenHash === r.body.token)).toBe(false);
    const st = await s.client.call<{ active: boolean; expiresAt: string | null }>(
      "GET",
      `/api/channels/${s.username}/overlay-token`,
    );
    expect(st.body).toMatchObject({ active: true, expiresAt: null });

    const ok = await state(r.body.token);
    expect(ok.status).toBe(200);
    expect(ok.body.channelSlug).toBe(s.username);
    expect(ok.body.goals).toEqual([]);
    expect(ok.body.alerts).toHaveLength(4);
    expect(ok.body.eventsUrl).toBe(`${api.url}${OVERLAY_EVENTS_PATH}?token=${r.body.token}`);
    expect((await state(r.body.token, "bearer")).status).toBe(200);
  });

  test("the stored value is the SHA-256 of the token", async () => {
    const r = await createToken(other);
    const [row] = await db()
      .select()
      .from(schema.overlayTokens)
      .where(
        and(
          eq(schema.overlayTokens.channelId, await channelId(other.username)),
          isNull(schema.overlayTokens.revokedAt),
        ),
      );
    expect(row?.tokenHash).toBe(await sha256Hex(r.body.token));
  });

  test("rotate revokes the old token; revoke without replacement; audit rows", async () => {
    const a = await createToken(s);
    const b = await createToken(s);
    expect((await state(a.body.token)).status).toBe(401);
    expect((await state(b.body.token)).status).toBe(200);
    const active = await db()
      .select()
      .from(schema.overlayTokens)
      .where(
        and(eq(schema.overlayTokens.channelId, await channelId(s.username)), isNull(schema.overlayTokens.revokedAt)),
      );
    expect(active).toHaveLength(1);

    expect((await s.client.call("DELETE", `/api/channels/${s.username}/overlay-token`)).status).toBe(200);
    expect((await state(b.body.token)).status).toBe(401);
    const st = await s.client.call<{ active: boolean }>("GET", `/api/channels/${s.username}/overlay-token`);
    expect(st.body.active).toBe(false);
    // Revoking again is a harmless no-op.
    expect((await s.client.call("DELETE", `/api/channels/${s.username}/overlay-token`)).status).toBe(200);

    const actions = (
      await db()
        .select({ action: schema.auditLog.action, details: schema.auditLog.details })
        .from(schema.auditLog)
        .where(eq(schema.auditLog.channelId, await channelId(s.username)))
    ).map((x) => x.action);
    expect(actions.filter((x) => x === "overlay.token.create").length).toBeGreaterThanOrEqual(2);
    expect(actions.filter((x) => x === "overlay.token.revoke")).toHaveLength(1);
    // Only the owner manages the token.
    expect((await createToken({ ...s, client: other.client })).status).toBe(403);
  });

  test("expiry: past is BAD_REQUEST; a token stops resolving once expired", async () => {
    expect((await createToken(s, new Date(Date.now() - 1000).toISOString())).status).toBe(400);
    const soon = new Date(Date.now() + 1500).toISOString();
    const r = await createToken(s, soon);
    expect(r.status).toBe(200);
    expect(r.body.expiresAt).toBe(soon);
    const st = await s.client.call<{ active: boolean; expiresAt: string }>(
      "GET",
      `/api/channels/${s.username}/overlay-token`,
    );
    expect(st.body).toMatchObject({ active: true, expiresAt: soon });
    expect((await state(r.body.token)).status).toBe(200);
    await Bun.sleep(1700);
    expect((await state(r.body.token)).status).toBe(401);
    const st2 = await s.client.call<{ active: boolean }>("GET", `/api/channels/${s.username}/overlay-token`);
    expect(st2.body.active).toBe(false);
  });

  test("two concurrent creates leave exactly one active token", async () => {
    const results = await Promise.all([createToken(other), createToken(other), createToken(other)]);
    for (const r of results) expect([200, 409]).toContain(r.status);
    const active = await db()
      .select()
      .from(schema.overlayTokens)
      .where(
        and(
          eq(schema.overlayTokens.channelId, await channelId(other.username)),
          isNull(schema.overlayTokens.revokedAt),
        ),
      );
    expect(active).toHaveLength(1);
    const live = (await Promise.all(results.filter((r) => r.status === 200).map((r) => state(r.body.token)))).filter(
      (x) => x.status === 200,
    );
    expect(live).toHaveLength(1);
  });

  test("the token is anonymous everywhere except the overlay", async () => {
    const r = await createToken(s);
    const token = r.body.token;
    const paths = ["/api/me", `/api/channels/${s.username}/alerts`, `/api/channels/${s.username}/simulcast`];
    for (const p of paths) {
      expect((await client(api, { bearer: token }).call("GET", p)).status).toBe(401);
      expect((await client(api).call("GET", `${p}?token=${encodeURIComponent(token)}`)).status).toBe(401);
    }
    // A write with the token is refused too.
    expect(
      (await client(api, { bearer: token }).call("DELETE", `/api/channels/${s.username}/overlay-token`)).status,
    ).toBe(401);
    // Unknown and garbage tokens.
    expect((await state("x".repeat(43))).status).toBe(401);
    expect((await client(api).call("GET", "/api/overlay/state")).status).toBe(401);
    // A signed-in session is not an overlay credential.
    expect((await s.client.call("GET", "/api/overlay/state")).status).toBe(401);
  });
});

describe("alert stream", () => {
  test("401 without a valid token", async () => {
    expect((await fetch(`${api.url}${OVERLAY_EVENTS_PATH}`)).status).toBe(401);
    expect((await fetch(`${api.url}${OVERLAY_EVENTS_PATH}?token=nope-nope-nope-nope`)).status).toBe(401);
  });

  test("tip → alert frame; other channel and below-minimum → nothing; anonymous hides the name; test alert", async () => {
    const sid = await channelId(s.username);
    const oid = await channelId(other.username);
    await s.client.call("PUT", `/api/channels/${s.username}/alerts/tip`, {
      enabled: true,
      template: { message: "${user} tipped ${amount}", animation: "fade", showMessage: true },
      minAmountCents: 100,
      durationMs: 5000,
    });
    const { token } = (await createToken(s)).body;
    const stream = await openStream(token);
    expect(stream.res.status).toBe(200);
    expect(stream.res.headers.get("content-type")).toContain("text/event-stream");
    await waitFor(async () => overlayHub(api.deps).count(sid) === 1);

    await publishEvent(oid, "channel.tip", tipPayload(other, 500));
    await publishEvent(sid, "channel.tip", tipPayload(s, 50));
    const tipId = await publishEvent(sid, "channel.tip", tipPayload(s, 250));
    const first = await waitFor(async () => stream.alerts()[0]);
    expect(first).toMatchObject({
      id: tipId,
      type: "tip",
      amountCents: 250,
      test: false,
      text: "Vee Viewer tipped $2.50",
    });
    expect(stream.alerts()).toHaveLength(1);

    const anonId = await publishEvent(sid, "channel.tip", tipPayload(s, 300, true));
    const anon = await waitFor(async () => stream.alerts().find((a) => a.id === anonId));
    expect(anon.text).toBe(`${t("alert.anonymous")} tipped $3.00`);
    const anonFrame = stream.frames.find((f) => f.data.includes(anonId));
    expect(anonFrame?.data).not.toContain(other.userId);
    expect(anonFrame?.data).not.toContain(other.username);

    expect((await s.client.call("POST", `/api/channels/${s.username}/alerts/follow/test`)).status).toBe(200);
    const testAlert = await waitFor(async () => stream.alerts().find((a) => a.test === true));
    expect(testAlert.type).toBe("follow");

    // Pings keep the stream alive.
    await waitFor(async () => stream.frames.some((f) => f.event === "ping"), 3000);
    // Only alerts for this channel ever arrived.
    expect(stream.alerts().every((a) => a.id !== undefined)).toBe(true);
    expect(stream.alerts().some((a) => a.amountCents === 500 || a.amountCents === 50)).toBe(false);

    stream.close();
    await waitFor(async () => overlayHub(api.deps).count(sid) === 0);
  });

  test("goals (E8): state lists the open goal; `goal` frames reach only the goal's channel; raid alert", async () => {
    const sid = await channelId(s.username);
    const oid = await channelId(other.username);
    const g = await s.client.call<{ id: string; startedAt: string }>("POST", `/api/channels/${s.username}/goals`, {
      type: "followers",
      title: "Two follows",
      target: 2,
    });
    expect(g.status).toBe(200);
    const { token } = (await createToken(s)).body;
    expect((await state(token)).body.goals).toEqual([
      {
        id: g.body.id,
        type: "followers",
        title: "Two follows",
        target: 2,
        current: 0,
        startedAt: g.body.startedAt,
        endedAt: null,
      },
    ]);
    await s.client.call("PUT", `/api/channels/${s.username}/alerts/raid`, {
      enabled: true,
      template: { message: "${user} raids with ${viewers}", animation: "fade", showMessage: true },
      minAmountCents: 0,
      durationMs: 5000,
    });
    const stream = await openStream(token);
    await waitFor(async () => overlayHub(api.deps).count(sid) === 1);
    const goals = () =>
      stream.frames.filter((f) => f.event === "goal").map((f) => JSON.parse(f.data) as Record<string, unknown>);

    const goalPayload = (u: User, id: string, current: number) => ({
      broadcaster_user_id: u.userId,
      broadcaster_user_login: u.username,
      broadcaster_user_name: u.username,
      id,
      type: "followers",
      description: "Two follows",
      current_amount: current,
      target_amount: 2,
      started_at: g.body.startedAt,
    });
    await publishEvent(oid, "channel.goal.progress", goalPayload(other, uuidv7(), 1));
    await publishEvent(sid, "channel.goal.progress", goalPayload(s, g.body.id, 1));
    await publishEvent(sid, "channel.goal.end", {
      ...goalPayload(s, g.body.id, 2),
      is_achieved: true,
      ended_at: new Date().toISOString(),
    });
    await waitFor(async () => goals().length >= 2);
    expect(goals().map((x) => [x.id, x.current, x.endedAt === null])).toEqual([
      [g.body.id, 1, true],
      [g.body.id, 2, false],
    ]);
    // A goal event is never an alert.
    expect(stream.alerts()).toHaveLength(0);

    const raidId = await publishEvent(sid, "channel.raid", {
      from_broadcaster_user_id: other.userId,
      from_broadcaster_user_login: other.username,
      from_broadcaster_user_name: "Raider Rae",
      to_broadcaster_user_id: s.userId,
      to_broadcaster_user_login: s.username,
      to_broadcaster_user_name: s.username,
      viewers: 3,
    });
    const raid = await waitFor(async () => stream.alerts().find((a) => a.id === raidId));
    expect(raid).toMatchObject({ type: "raid", text: "Raider Rae raids with 3" });
    stream.close();
    await waitFor(async () => overlayHub(api.deps).count(sid) === 0);
    await s.client.call("POST", `/api/channels/${s.username}/goals/${g.body.id}/end`, {});
  });

  test("revoke → `revoked` and close at once; rotation closes the old stream", async () => {
    const sid = await channelId(s.username);
    const old = (await createToken(s)).body.token;
    const a = await openStream(old);
    expect(a.res.status).toBe(200);
    await waitFor(async () => overlayHub(api.deps).count(sid) === 1);
    const fresh = (await createToken(s)).body.token;
    await waitFor(async () => a.closed(), 3000);
    expect(a.frames.some((f) => f.event === "revoked")).toBe(true);

    const b = await openStream(fresh);
    expect(b.res.status).toBe(200);
    await waitFor(async () => overlayHub(api.deps).count(sid) === 1);
    await s.client.call("DELETE", `/api/channels/${s.username}/overlay-token`);
    await waitFor(async () => b.closed(), 3000);
    expect(b.frames.some((f) => f.event === "revoked")).toBe(true);
    await waitFor(async () => overlayHub(api.deps).count(sid) === 0);
    // And it cannot reconnect.
    expect((await openStream(fresh)).res.status).toBe(401);
  });

  test("a revocation the stream never heard of is caught by the re-check", async () => {
    const sid = await channelId(s.username);
    const token = (await createToken(s)).body.token;
    const st = await openStream(token);
    await waitFor(async () => overlayHub(api.deps).count(sid) === 1);
    // Straight in the database: no bus message.
    await db()
      .update(schema.overlayTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.overlayTokens.channelId, sid), isNull(schema.overlayTokens.revokedAt)));
    await waitFor(async () => st.closed(), 4000);
    expect(st.frames.some((f) => f.event === "revoked")).toBe(true);
  });

  test("an expiring token's open stream closes after expiry", async () => {
    const sid = await channelId(s.username);
    // Opened well inside its window (no race with a loaded gate), then aged past expiry in the
    // database: the re-check must refuse the expired token.
    const token = (await createToken(s, new Date(Date.now() + 3_600_000).toISOString())).body.token;
    const st = await openStream(token);
    expect(st.res.status).toBe(200);
    await waitFor(async () => overlayHub(api.deps).count(sid) === 1);
    await db()
      .update(schema.overlayTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(and(eq(schema.overlayTokens.channelId, sid), isNull(schema.overlayTokens.revokedAt)));
    await waitFor(async () => st.closed(), 5000);
    expect(st.frames.some((f) => f.event === "revoked")).toBe(true);
  });

  test("per-channel cap", async () => {
    const hub = await configureOverlayHub(api.deps, { pingMs: 1000, recheckMs: 1000, maxPerChannel: 2 });
    const sid = await channelId(s.username);
    const token = (await createToken(s)).body.token;
    const x = await openStream(token);
    const y = await openStream(token);
    await waitFor(async () => hub.count(sid) === 2);
    expect((await openStream(token)).res.status).toBe(429);
    x.close();
    y.close();
    await waitFor(async () => hub.count(sid) === 0);
    await configureOverlayHub(api.deps, { pingMs: 1000, recheckMs: 1000 });
  });
});
