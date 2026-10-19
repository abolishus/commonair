// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Review-round regressions: mature categories, media references, admin audit, tokens, 2FA. */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { BUS } from "@commonair/contracts/events";
import { INTERNAL_ROUTES, INTERNAL_SECRET_HEADER, mediaPath } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { hmacHex, sha256Hex } from "@commonair/tokens";
import { instanceMediaBase } from "../src/lib/media-ref.ts";
import { client, mailTo, signUpAndSignIn, startApi, subscriber, waitFor, type TestApi } from "./harness.ts";

let api: TestApi;
let alice: Awaited<ReturnType<typeof signUpAndSignIn>>;
let bob: Awaited<ReturnType<typeof signUpAndSignIn>>;

beforeAll(async () => {
  api = await startApi();
  alice = await signUpAndSignIn(api);
  bob = await signUpAndSignIn(api);
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const db = () => api.db.db;
const channelOf = async (slug: string) => {
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, slug));
  if (!c) throw new Error(`no channel ${slug}`);
  return c;
};
const hook = (route: string, body: Record<string, unknown>) =>
  fetch(`${api.url}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: api.internalSecret },
    body: JSON.stringify(body),
  });

describe("playback mature gate", () => {
  test("a mature category gates playback even when the channel and broadcast are unlabelled", async () => {
    const [cat] = await db()
      .insert(schema.categories)
      .values({ slug: `cat-${uuidv7()}`, name: "Late-flagged", mature: false })
      .returning();
    if (!cat) throw new Error("no category");
    const c = await channelOf(alice.username);
    await db().update(schema.channels).set({ categoryId: cat.id, mature: false }).where(eq(schema.channels.id, c.id));
    const ready = await hook(INTERNAL_ROUTES.mediaReady, {
      path: mediaPath(alice.username),
      sourceType: "rtmpConn",
      sourceId: crypto.randomUUID(),
    });
    expect(ready.status).toBe(204);
    // Staff flag the category after the stream started: rows written earlier still say "not mature".
    await db().update(schema.categories).set({ mature: true }).where(eq(schema.categories.id, cat.id));
    const live = await channelOf(alice.username);
    const [b] = await db()
      .select()
      .from(schema.broadcasts)
      .where(eq(schema.broadcasts.id, live.liveBroadcastId ?? ""));
    expect(b?.mature).toBe(false);
    expect(live.mature).toBe(false);

    const start = (c2 = client(api)) =>
      c2.call<{ requirement?: string; data?: { requirement: string } }>(
        "POST",
        `/api/channels/${alice.username}/playback`,
        { deviceId: "device-0123456789abcdef" },
      );
    const anon = await start();
    expect(anon.status).toBe(412);
    expect(anon.body.data?.requirement).toBe("mature_confirmation");
    expect((await start(bob.client)).status).toBe(412);
    expect((await bob.client.call("POST", "/api/me/mature-confirmation")).status).toBe(200);
    expect((await start(bob.client)).status).toBe(200);

    await db().update(schema.categories).set({ mature: false }).where(eq(schema.categories.id, cat.id));
    expect((await start()).status).toBe(200);
  });
});

describe("media references stay on this instance", () => {
  test("channel theme avatar/banner must be own uploads or instance URLs", async () => {
    const c = await channelOf(alice.username);
    const patch = (theme: Record<string, string>) =>
      alice.client.call("PATCH", `/api/channels/${alice.username}`, { theme });
    expect((await patch({ avatarKey: "https://tracker.invalid/pixel.gif" })).status).toBe(400);
    expect((await patch({ bannerKey: "https://tracker.invalid/banner.png" })).status).toBe(400);
    const bobs = await channelOf(bob.username);
    expect((await patch({ avatarKey: `channels/${bobs.id}/avatar/x.png` })).status).toBe(400);
    expect((await patch({ avatarKey: `channels/${c.id}/banner/x.png` })).status).toBe(400);
    expect((await patch({ avatarKey: `channels/${c.id}/avatar/../../${bobs.id}/avatar/x.png` })).status).toBe(400);
    const ok = await patch({
      avatarKey: `channels/${c.id}/avatar/01.png`,
      bannerKey: `channels/${c.id}/banner/01.webp`,
      accent: "teal",
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const bucket = instanceMediaBase(api.deps.env);
    expect((await patch({ avatarKey: `${bucket}channels/${c.id}/avatar/02.png` })).status).toBe(200);
    expect((await patch({ avatarKey: `${bucket}channels/${bobs.id}/avatar/02.png` })).status).toBe(400);
    expect((await patch({ avatarKey: `${api.url}/static/default.png` })).status).toBe(400);
  });

  test("profile image through update-user must be an own avatar upload", async () => {
    const c = await channelOf(bob.username);
    const set = (image: string | null) => bob.client.call("POST", "/api/auth/update-user", { image });
    expect((await set("https://tracker.invalid/me.png")).status).toBe(400);
    const alices = await channelOf(alice.username);
    expect((await set(`channels/${alices.id}/avatar/a.png`)).status).toBe(400);
    expect((await set(`channels/${c.id}/avatar/a.png`)).status).toBe(200);
    expect((await set(`${instanceMediaBase(api.deps.env)}channels/${c.id}/avatar/b.png`)).status).toBe(200);
    expect((await set(`${instanceMediaBase(api.deps.env)}channels/${alices.id}/avatar/b.png`)).status).toBe(400);
    expect((await set(`${api.url}/static/default.png`)).status).toBe(400);
    expect((await set(null)).status).toBe(200);
    const [u] = await db().select().from(schema.users).where(eq(schema.users.id, bob.userId));
    expect(u?.image).toBeNull();
  });
});

describe("better-auth admin plugin endpoints", () => {
  test("are closed even to admins; the audited admin procedure is the only path", async () => {
    await db().update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, alice.userId));
    const calls: [string, Record<string, unknown>][] = [
      ["/api/auth/admin/set-role", { userId: bob.userId, role: "admin" }],
      ["/api/auth/admin/ban-user", { userId: bob.userId, banReason: "x" }],
      ["/api/auth/admin/impersonate-user", { userId: bob.userId }],
      ["/api/auth/admin/remove-user", { userId: bob.userId }],
      ["/api/auth/admin/set-user-password", { userId: bob.userId, newPassword: "x".repeat(20) }],
      ["/api/auth/admin/revoke-user-sessions", { userId: bob.userId }],
      ["/api/auth/admin/create-user", { email: "x@test.invalid", password: "x".repeat(20), name: "x" }],
    ];
    for (const [path, body] of calls) {
      const res = await alice.client.call("POST", path, body);
      expect(res.status, path).toBe(404);
    }
    expect((await alice.client.call("GET", "/api/auth/admin/list-users")).status).toBe(404);
    const [b] = await db().select().from(schema.users).where(eq(schema.users.id, bob.userId));
    expect(b).toMatchObject({ role: "user", banned: false });
    // Bob's session still works (no impersonation, no session revocation).
    expect((await bob.client.call("GET", "/api/me")).status).toBe(200);

    const set = await alice.client.call("PUT", `/api/admin/users/${bob.username}/role`, { role: "moderator" });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const logs = await db().select().from(schema.auditLog).where(eq(schema.auditLog.subjectId, bob.userId));
    expect(logs.map((l) => l.action)).toContain("user.set_role");
    await db().update(schema.users).set({ role: "user" }).where(eq(schema.users.id, bob.userId));
  });
});

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s), enough to drive better-auth's two-factor flow. */
async function totp(uri: string, at = Date.now()): Promise<string> {
  const secret = new URL(uri).searchParams.get("secret") ?? "";
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const key = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < key.length; i++) key[i] = Number.parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  const counter = new DataView(new ArrayBuffer(8));
  counter.setBigUint64(0, BigInt(Math.floor(at / 1000 / 30)));
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, counter.buffer));
  const offset = (mac[mac.length - 1] ?? 0) & 0xf;
  const view = new DataView(mac.buffer, offset, 4);
  return String((view.getUint32(0) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

describe("two-factor authentication (TOTP)", () => {
  test("enable → verify → sign-in needs a code; wrong codes and backup codes behave", async () => {
    const s = await signUpAndSignIn(api);
    const enable = await s.client.call<{ totpURI: string; backupCodes: string[] }>(
      "POST",
      "/api/auth/two-factor/enable",
      {
        password: s.password,
      },
    );
    expect(enable.status, JSON.stringify(enable.body)).toBe(200);
    expect(enable.body.backupCodes).toHaveLength(10);
    expect(enable.body.totpURI).toMatch(/^otpauth:\/\/totp\//);
    // Not enabled until a code proves the authenticator works.
    const [before] = await db().select().from(schema.users).where(eq(schema.users.id, s.userId));
    expect(before?.twoFactorEnabled).toBe(false);
    expect((await s.client.call("POST", "/api/auth/two-factor/verify-totp", { code: "000000" })).status).toBe(401);
    const verify = await s.client.call("POST", "/api/auth/two-factor/verify-totp", {
      code: await totp(enable.body.totpURI),
    });
    expect(verify.status, JSON.stringify(verify.body)).toBe(200);
    const [after] = await db().select().from(schema.users).where(eq(schema.users.id, s.userId));
    expect(after?.twoFactorEnabled).toBe(true);
    const notice = await waitFor(async () => {
      const m = await mailTo(s.email);
      return m && /two-factor|2fa|authenticat/i.test(m.subject) ? m : null;
    });
    expect(notice.subject).toBeTruthy();

    // A password alone no longer signs in.
    const fresh = client(api);
    const signIn = await fresh.call<{ twoFactorRedirect?: boolean }>("POST", "/api/auth/sign-in/email", {
      email: s.email,
      password: s.password,
    });
    expect(signIn.status).toBe(200);
    expect(signIn.body.twoFactorRedirect).toBe(true);
    expect((await fresh.call("GET", "/api/me")).status).toBe(401);
    expect((await fresh.call("POST", "/api/auth/two-factor/verify-totp", { code: "123456" })).status).toBe(401);
    const ok = await fresh.call("POST", "/api/auth/two-factor/verify-totp", { code: await totp(enable.body.totpURI) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await fresh.call("GET", "/api/me")).status).toBe(200);

    // A backup code works once.
    const code = enable.body.backupCodes[0] ?? "";
    const viaBackup = async () => {
      const c = client(api);
      await c.call("POST", "/api/auth/sign-in/email", { email: s.email, password: s.password });
      return c.call("POST", "/api/auth/two-factor/verify-backup-code", { code });
    };
    expect((await viaBackup()).status).toBe(200);
    expect((await viaBackup()).status).toBe(401);
  });
});

describe("developer tokens", () => {
  test("list shows own and owned-bot tokens; revoke kills the token and disconnects its sockets", async () => {
    const owner = await signUpAndSignIn(api);
    const bot = await owner.client.call<{ id: string }>("POST", "/api/me/bots", {
      username: `${owner.username.slice(0, 18)}_bot`,
      displayName: "Bot",
    });
    expect(bot.status).toBe(200);
    const minted = await owner.client.call<{ token: { id: string }; accessToken: string }>(
      "POST",
      `/api/me/bots/${bot.body.id}/tokens`,
      { scopes: ["chat:read"] },
    );
    expect(minted.status).toBe(200);
    const list = await owner.client.call<{ id: string; scopes: string[]; appName: string | null }[]>(
      "GET",
      "/api/developer/tokens",
    );
    expect(list.status).toBe(200);
    expect(list.body).toEqual([
      expect.objectContaining({ id: minted.body.token.id, scopes: ["chat:read"], appName: null }),
    ]);
    // Nobody else sees or revokes it.
    expect((await bob.client.call<unknown[]>("GET", "/api/developer/tokens")).body).toEqual([]);
    expect((await bob.client.call("DELETE", `/api/developer/tokens/${minted.body.token.id}`)).status).toBe(404);

    const sub = subscriber();
    const got: Record<string, unknown>[] = [];
    await sub.subscribe(BUS.userControl);
    sub.on("message", (_ch, msg) => got.push(JSON.parse(msg) as Record<string, unknown>));
    try {
      const asBot = client(api, { bearer: minted.body.accessToken });
      expect((await asBot.call("GET", "/api/oauth2/validate")).status).toBe(200);
      expect((await owner.client.call("DELETE", `/api/developer/tokens/${minted.body.token.id}`)).status).toBe(200);
      expect((await asBot.call("GET", "/api/oauth2/validate")).status).toBe(401);
      expect((await owner.client.call("DELETE", `/api/developer/tokens/${minted.body.token.id}`)).status).toBe(404);
      expect((await owner.client.call<unknown[]>("GET", "/api/developer/tokens")).body).toEqual([]);
      const msg = await waitFor(async () => got.find((m) => m.userId === bot.body.id) ?? null);
      expect(msg).toEqual({
        op: "disconnect",
        userId: bot.body.id,
        tokenHash: await sha256Hex(minted.body.accessToken),
        reason: "token_revoked",
      });
    } finally {
      sub.disconnect();
    }
  });
});

describe("user control fan-out", () => {
  test("role and profile changes invalidate chat caches", async () => {
    const sub = subscriber();
    const got: Record<string, unknown>[] = [];
    await sub.subscribe(BUS.userControl);
    sub.on("message", (_ch, msg) => got.push(JSON.parse(msg) as Record<string, unknown>));
    try {
      await db().update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, alice.userId));
      expect(
        (await alice.client.call("PUT", `/api/admin/users/${bob.username}/role`, { role: "moderator" })).status,
      ).toBe(200);
      expect((await bob.client.call("POST", "/api/auth/update-user", { name: "Bob Renamed" })).status).toBe(200);
      await waitFor(async () => (got.filter((m) => m.userId === bob.userId).length >= 2 ? true : null));
      expect(got.filter((m) => m.userId === bob.userId)).toEqual([
        { op: "invalidate", userId: bob.userId, reason: "role_changed" },
        { op: "invalidate", userId: bob.userId, reason: "profile_changed" },
      ]);
    } finally {
      sub.disconnect();
      await db().update(schema.users).set({ role: "user" }).where(eq(schema.users.id, bob.userId));
    }
  });
});

describe("playback heartbeats", () => {
  let clock = Date.now();
  let realNow: () => Date;
  let streamer: Awaited<ReturnType<typeof signUpAndSignIn>>;

  beforeAll(async () => {
    streamer = await signUpAndSignIn(api);
    const ready = await hook(INTERNAL_ROUTES.mediaReady, {
      path: mediaPath(streamer.username),
      sourceType: "rtmpConn",
      sourceId: crypto.randomUUID(),
    });
    if (ready.status !== 204) throw new Error(`mediaReady failed: ${ready.status}`);
    realNow = api.deps.now;
    api.deps.now = () => new Date(clock);
  });
  afterAll(() => {
    api.deps.now = realNow;
  });

  async function session() {
    const viewer = client(api);
    const start = await viewer.call<{ sessionId: string; token: string }>(
      "POST",
      `/api/channels/${streamer.username}/playback`,
      { deviceId: "device-0123456789abcdef" },
    );
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    const beat = (playedSeconds: number) =>
      viewer.call("POST", "/api/playback/heartbeat", {
        sessionId: start.body.sessionId,
        token: start.body.token,
        playedSeconds,
        bufferSeconds: 3,
        stalls: 0,
        bytesHttp: 100,
        bytesP2p: 0,
        rendition: "source",
        latencySeconds: 2,
        ttffMs: 800,
        visible: true,
        muted: false,
      });
    const row = async () => {
      const [r] = await db()
        .select()
        .from(schema.playbackSessions)
        .where(eq(schema.playbackSessions.id, start.body.sessionId));
      if (!r) throw new Error("no session");
      return r;
    };
    return { id: start.body.sessionId, beat, row };
  }

  test("a beat sooner than 5 s credits no watch time and leaves the clock alone", async () => {
    const s = await session();
    clock += 1000;
    expect((await s.beat(1)).status).toBe(200);
    let r = await s.row();
    expect(r).toMatchObject({ heartbeats: 0, watchSeconds: 0, lastHeartbeatAt: null });
    clock += 1000;
    expect((await s.beat(1)).status).toBe(200);
    r = await s.row();
    expect(r).toMatchObject({ heartbeats: 0, watchSeconds: 0, lastHeartbeatAt: null });
    clock += 8000; // 10 s since start
    expect((await s.beat(10)).status).toBe(200);
    r = await s.row();
    expect(r.heartbeats).toBe(1);
    expect(r.watchSeconds).toBe(10);
    expect(r.lastHeartbeatAt?.getTime()).toBe(clock);
  });

  test("concurrent beats: only one is credited (compare-and-set on the clock)", async () => {
    const s = await session();
    clock += 10_000;
    const results = await Promise.all([s.beat(10), s.beat(10), s.beat(10)]);
    expect(results.every((x) => x.status === 200)).toBe(true);
    const r = await s.row();
    expect(r.watchSeconds).toBe(10);
    expect(r.heartbeats).toBe(1);
  });

  const threeGoodBeats = async (s: Awaited<ReturnType<typeof session>>) => {
    for (let i = 0; i < 4; i++) {
      clock += 10_000;
      expect((await s.beat(10)).status).toBe(200);
    }
  };

  test("an unscored session is promoted by the interim check", async () => {
    const s = await session();
    await threeGoodBeats(s);
    expect((await s.row()).verdict).toBe("verified");
  });

  test("a media_unconfirmed hold from the scorer is never lifted by heartbeats", async () => {
    const s = await session();
    await db()
      .update(schema.playbackSessions)
      .set({ verdictReasons: ["media_unconfirmed"] })
      .where(eq(schema.playbackSessions.id, s.id));
    await threeGoodBeats(s);
    expect((await s.row()).verdict).toBe("pending");
  });

  test("once scored, the scorer's verdict stands: no promotion, no demotion", async () => {
    const pending = await session();
    await db()
      .update(schema.playbackSessions)
      .set({ scoredAt: new Date(clock), verdict: "pending" })
      .where(eq(schema.playbackSessions.id, pending.id));
    await threeGoodBeats(pending);
    expect((await pending.row()).verdict).toBe("pending");

    const excluded = await session();
    await db()
      .update(schema.playbackSessions)
      .set({ scoredAt: new Date(clock), verdict: "excluded", verdictReasons: ["headless"] })
      .where(eq(schema.playbackSessions.id, excluded.id));
    await threeGoodBeats(excluded);
    expect((await excluded.row()).verdict).toBe("excluded");

    const verified = await session();
    await db()
      .update(schema.playbackSessions)
      .set({ scoredAt: new Date(clock), verdict: "verified" })
      .where(eq(schema.playbackSessions.id, verified.id));
    clock += 10_000;
    await verified.beat(60); // inconsistent beat
    expect((await verified.row()).verdict).toBe("verified");
  });
});

describe("ingest auth records the publisher's address hash", () => {
  test("a successful publish sets stream_keys.last_used_ip_hash with the playback ip_hash scheme", async () => {
    const s = await signUpAndSignIn(api);
    const r = await s.client.call<{ key: string }>("POST", `/api/channels/${s.username}/stream-keys`);
    expect(r.status).toBe(200);
    const secret = r.body.key.split("?key=")[1] ?? "";
    const auth = (ip: string, key: string) =>
      fetch(`${api.url}${INTERNAL_ROUTES.mediaAuth}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ip,
          protocol: "rtmp",
          action: "publish",
          path: mediaPath(s.username),
          query: `key=${key}`,
        }),
      });
    const keyRow = async () => {
      const c = await channelOf(s.username);
      const [k] = await db().select().from(schema.streamKeys).where(eq(schema.streamKeys.channelId, c.id));
      return k;
    };
    expect((await auth("198.51.100.20", "wrong")).status).toBe(401);
    expect((await keyRow())?.lastUsedIpHash).toBeNull();
    expect((await auth("198.51.100.20", secret)).status).toBe(200);
    const hash = (await keyRow())?.lastUsedIpHash;
    expect(hash).toBe(await hmacHex(api.deps.env.AUTH_SECRET, "ip:198.51.100.20"));
    expect(hash).not.toContain("198.51.100.20");
    expect((await auth("203.0.113.9", secret)).status).toBe(200);
    expect((await keyRow())?.lastUsedIpHash).toBe(await hmacHex(api.deps.env.AUTH_SECRET, "ip:203.0.113.9"));
  });
});
