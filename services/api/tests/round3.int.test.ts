// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** API round 3: heartbeat floor, P2P source, canonical IP hashes, appeals, stream-key use. */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { INTERNAL_ROUTES, INTERNAL_SECRET_HEADER, KEYS, mediaPath } from "@commonair/contracts/internal";
import { schema } from "@commonair/db";
import { INTEGRITY_KEYS, loadAllowances } from "@commonair/integrity";
import { hmacHex } from "@commonair/tokens";
import { client, signUpAndSignIn, startApi, type Client, type TestApi } from "./harness.ts";

let api: TestApi;
let streamer: Awaited<ReturnType<typeof signUpAndSignIn>>;

const db = () => api.db.db;
const hook = (route: string, body: Record<string, unknown>) =>
  fetch(`${api.url}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: api.internalSecret },
    body: JSON.stringify(body),
  });
const goLive = async (slug: string) => {
  const res = await hook(INTERNAL_ROUTES.mediaReady, {
    path: mediaPath(slug),
    sourceType: "rtmpConn",
    sourceId: crypto.randomUUID(),
  });
  if (res.status !== 204) throw new Error(`mediaReady failed: ${res.status}`);
};
const sessionRow = async (id: string) => {
  const [r] = await db().select().from(schema.playbackSessions).where(eq(schema.playbackSessions.id, id));
  if (!r) throw new Error("no session");
  return r;
};
async function startPlayback(viewer: Client, body: Record<string, unknown> = {}) {
  const res = await viewer.call<{
    sessionId: string;
    token: string;
    source: string;
    p2p: { enabled: boolean; trackerUrls: string[] };
  }>("POST", `/api/channels/${streamer.username}/playback`, { deviceId: "device-0123456789abcdef", ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

beforeAll(async () => {
  api = await startApi();
  streamer = await signUpAndSignIn(api);
  await goLive(streamer.username);
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

describe("heartbeat floor", () => {
  let clock = Date.now();
  let realNow: () => Date;
  beforeAll(() => {
    realNow = api.deps.now;
    api.deps.now = () => new Date(clock);
  });
  afterAll(() => {
    api.deps.now = realNow;
  });

  test("a burst of sub-floor beats changes nothing in Postgres or Valkey", async () => {
    const viewer = client(api);
    const s = await startPlayback(viewer);
    const beat = (playedSeconds: number) =>
      viewer.call("POST", "/api/playback/heartbeat", {
        sessionId: s.sessionId,
        token: s.token,
        playedSeconds,
        bufferSeconds: 3,
        stalls: 2,
        bytesHttp: 5000,
        bytesP2p: 700,
        rendition: "source",
        latencySeconds: 2,
        ttffMs: 800,
        visible: true,
        muted: false,
        fingerprint: { webdriver: false, cores: 8 },
      });
    const before = await sessionRow(s.sessionId);
    const channelId = before.channelId;
    const valkeyState = async () => ({
      verify: await api.deps.valkey.hgetall(`playback-verify:${s.sessionId}`),
      evidence: await api.deps.valkey.llen(INTEGRITY_KEYS.heartbeats(s.sessionId)),
      viewer: await api.deps.valkey.zscore(KEYS.viewers(channelId), s.sessionId),
    });

    for (let i = 0; i < 20; i++) {
      clock += 200; // 4 s in total: still under the 5 s floor
      const r = await beat(1);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, throttled: true });
    }
    const after = await sessionRow(s.sessionId);
    expect(after).toEqual(before);
    expect(await valkeyState()).toEqual({ verify: {}, evidence: 0, viewer: null });

    // The first beat past the floor is credited normally.
    clock += 6000;
    const counted = await beat(10);
    expect(counted.status).toBe(200);
    expect(counted.body).not.toHaveProperty("throttled");
    const credited = await sessionRow(s.sessionId);
    expect(credited).toMatchObject({ heartbeats: 1, bytesHttp: 5000, bytesP2p: 700, stalls: 2, latencyMs: 2000 });
    expect(credited.lastHeartbeatAt?.getTime()).toBe(clock);
    expect((await valkeyState()).evidence).toBe(1);

    // And sub-floor beats after it are ignored again.
    clock += 1000;
    expect((await beat(1)).status).toBe(200);
    expect(await sessionRow(s.sessionId)).toEqual(credited);
    expect((await valkeyState()).evidence).toBe(1);
  });
});

describe("word filters", () => {
  test("a stored regex the validator now refuses is listed as invalid with the reason", async () => {
    const [ch] = await db().select().from(schema.channels).where(eq(schema.channels.slug, streamer.username));
    if (!ch) throw new Error("no channel");
    // Inserted directly: the API refuses this pattern on create, but older rows may hold it.
    await db()
      .insert(schema.wordFilters)
      .values([
        { channelId: ch.id, pattern: "(?:a(?:bc|bd))+", isRegex: true, action: "block", replacement: null },
        { channelId: ch.id, pattern: "spam", isRegex: false, action: "hold", replacement: null },
      ]);
    const res = await streamer.client.call<{ pattern: string; invalid: boolean; invalidReason: string | null }[]>(
      "GET",
      `/api/channels/${streamer.username}/word-filters`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const byPattern = new Map(res.body.map((f) => [f.pattern, f]));
    expect(byPattern.get("(?:a(?:bc|bd))+")).toMatchObject({ invalid: true, invalidReason: expect.any(String) });
    expect(byPattern.get("spam")).toMatchObject({ invalid: false, invalidReason: null });
  });
});

describe("P2P sessions", () => {
  test("a client claiming p2pCapable on an origin assignment is still recorded as origin", async () => {
    // Regression: `p2p` lowers integrity's expected origin share, and P2P is client input.
    const s = await startPlayback(client(api), { p2pCapable: true });
    expect(s.p2p.enabled).toBe(true);
    // The tracker URL carries the playback token so announces count as server-side evidence.
    expect(s.p2p.trackerUrls).toHaveLength(1);
    expect(new URL(s.p2p.trackerUrls[0] ?? "").searchParams.get("t")).toBe(s.token);
    expect(s.source).toBe("origin");
    expect((await sessionRow(s.sessionId)).assignedSource).toBe("origin");
  });

  test("no P2P (client opts out or native HLS) stays origin", async () => {
    const optOut = await startPlayback(client(api), { p2pCapable: false });
    expect(optOut.p2p.enabled).toBe(false);
    expect((await sessionRow(optOut.sessionId)).assignedSource).toBe("origin");
    const native = await startPlayback(client(api), { nativeHls: true });
    expect(native.p2p.enabled).toBe(false);
    expect((await sessionRow(native.sessionId)).assignedSource).toBe("origin");
  });

  test("P2P_ENABLED=false on the instance stays origin", async () => {
    const env = api.deps.env as { P2P_ENABLED: boolean };
    env.P2P_ENABLED = false;
    try {
      const s = await startPlayback(client(api));
      expect(s.p2p.enabled).toBe(false);
      expect((await sessionRow(s.sessionId)).assignedSource).toBe("origin");
    } finally {
      env.P2P_ENABLED = true;
    }
  });
});

describe("canonical IP hashes", () => {
  test("a playback session and an ingest auth from one client hash the same", async () => {
    const env = api.deps.env as { TRUSTED_PROXY_CIDRS: string[] };
    const saved = env.TRUSTED_PROXY_CIDRS;
    env.TRUSTED_PROXY_CIDRS = ["127.0.0.0/8"];
    try {
      // The request comes from 127.0.0.1 (trusted), so X-Forwarded-For names the client.
      const res = await fetch(`${api.url}/api/channels/${streamer.username}/playback`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "::FFFF:198.51.100.77" },
        body: JSON.stringify({ deviceId: "device-0123456789abcdef" }),
      });
      expect(res.status).toBe(200);
      const { sessionId } = (await res.json()) as { sessionId: string };
      const expected = await hmacHex(api.deps.env.AUTH_SECRET, "ip:198.51.100.77");
      expect((await sessionRow(sessionId)).ipHash).toBe(expected);

      const owner = await signUpAndSignIn(api);
      const key = await owner.client.call<{ key: string }>("POST", `/api/channels/${owner.username}/stream-keys`);
      const secret = key.body.key.split("?key=")[1] ?? "";
      const auth = await fetch(`${api.url}${INTERNAL_ROUTES.mediaAuth}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ip: "::ffff:198.51.100.77",
          protocol: "rtmp",
          action: "publish",
          path: mediaPath(owner.username),
          query: `key=${secret}`,
        }),
      });
      expect(auth.status).toBe(200);
      const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, owner.username));
      const [k] = await db()
        .select()
        .from(schema.streamKeys)
        .where(eq(schema.streamKeys.channelId, c?.id ?? ""));
      expect(k?.lastUsedIpHash).toBe(expected);
    } finally {
      env.TRUSTED_PROXY_CIDRS = saved;
    }
  });
});

describe("stream key last_used_at", () => {
  test("set once per broadcast start; duplicate ready hooks do not move it", async () => {
    let clock = Date.now();
    const realNow = api.deps.now;
    api.deps.now = () => new Date(clock);
    try {
      const owner = await signUpAndSignIn(api);
      const key = await owner.client.call<{ key: string }>("POST", `/api/channels/${owner.username}/stream-keys`);
      const secret = key.body.key.split("?key=")[1] ?? "";
      const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, owner.username));
      const keyRow = async () =>
        (
          await db()
            .select()
            .from(schema.streamKeys)
            .where(eq(schema.streamKeys.channelId, c?.id ?? ""))
        )[0];
      const publish = () =>
        fetch(`${api.url}${INTERNAL_ROUTES.mediaAuth}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ip: "203.0.113.5",
            protocol: "rtmp",
            action: "publish",
            path: mediaPath(owner.username),
            query: `key=${secret}`,
          }),
        });
      const path = mediaPath(owner.username);
      expect((await publish()).status).toBe(200);
      expect((await keyRow())?.lastUsedAt).toBeNull(); // auth alone is not a broadcast
      const first = crypto.randomUUID();
      expect((await hook(INTERNAL_ROUTES.mediaReady, { path, sourceType: "rtmpConn", sourceId: first })).status).toBe(
        204,
      );
      const t1 = clock;
      expect((await keyRow())?.lastUsedAt?.getTime()).toBe(t1);
      clock += 60_000;
      await hook(INTERNAL_ROUTES.mediaReady, { path, sourceType: "rtmpConn", sourceId: first });
      expect((await keyRow())?.lastUsedAt?.getTime()).toBe(t1);
      await hook(INTERNAL_ROUTES.mediaNotReady, { path, sourceType: "rtmpConn", sourceId: first });
      clock += 60_000;
      expect((await publish()).status).toBe(200);
      await hook(INTERNAL_ROUTES.mediaReady, { path, sourceType: "rtmpConn", sourceId: crypto.randomUUID() });
      expect((await keyRow())?.lastUsedAt?.getTime()).toBe(clock);
    } finally {
      api.deps.now = realNow;
    }
  });
});

describe("appeals", () => {
  type AppealDto = { id: string; status: string; resolution: string | null; resolvedAt: string | null; body: string };
  let alice: Awaited<ReturnType<typeof signUpAndSignIn>>;
  let bob: Awaited<ReturnType<typeof signUpAndSignIn>>;
  let mod: Awaited<ReturnType<typeof signUpAndSignIn>>;
  let aliceSession: string;
  let bobSession: string;
  let flagOnAlice: string;
  const BODY = "I was watching normally, this flag is wrong. Contact me at alice@example.test";

  const flag = async (subjectType: "session" | "user" | "channel", subjectId: string) => {
    const [f] = await db()
      .insert(schema.integrityFlags)
      .values({ subjectType, subjectId, signal: "headless", score: 0.9, createdAt: new Date(Date.now() - 60_000) })
      .returning();
    if (!f) throw new Error("no flag");
    return f.id;
  };

  beforeAll(async () => {
    alice = await signUpAndSignIn(api);
    bob = await signUpAndSignIn(api);
    mod = await signUpAndSignIn(api);
    await db().update(schema.users).set({ role: "moderator" }).where(eq(schema.users.id, mod.userId));
    aliceSession = (await startPlayback(alice.client)).sessionId;
    bobSession = (await startPlayback(bob.client)).sessionId;
    flagOnAlice = await flag("session", aliceSession);
  }, 120_000);

  const create = (who: Client, body: Record<string, unknown>) =>
    who.call<AppealDto>("POST", "/api/appeals", { kind: "integrity", body: BODY, ...body });

  test("subjects must exist, concern the appellant and fit the kind", async () => {
    // Someone else's session, someone else's account, someone else's flag: indistinguishable from missing.
    expect((await create(alice.client, { subjectType: "session", subjectId: bobSession })).status).toBe(404);
    expect((await create(alice.client, { subjectType: "user", subjectId: bob.userId })).status).toBe(404);
    expect((await create(bob.client, { subjectType: "integrity_flag", subjectId: flagOnAlice })).status).toBe(404);
    expect(
      (await create(alice.client, { subjectType: "session", subjectId: "01900000-0000-7000-8000-000000000000" }))
        .status,
    ).toBe(404);
    // Kind and subject type must match.
    expect(
      (await create(alice.client, { kind: "moderation", subjectType: "session", subjectId: aliceSession })).status,
    ).toBe(400);
    expect(
      (await create(alice.client, { kind: "integrity", subjectType: "moderation_action", subjectId: aliceSession }))
        .status,
    ).toBe(400);
    // Not wired yet.
    expect(
      (await create(alice.client, { kind: "dmca", subjectType: "dmca_notice", subjectId: aliceSession })).status,
    ).toBe(501);
    expect(
      (await create(alice.client, { kind: "account", subjectType: "account_action", subjectId: alice.userId })).status,
    ).toBe(501);
    // Signed out.
    expect((await create(client(api), { subjectType: "user", subjectId: alice.userId })).status).toBe(401);
  });

  test("a flag on the appellant's channel can be appealed", async () => {
    const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, streamer.username));
    const channelFlag = await flag("channel", c?.id ?? "");
    expect((await create(alice.client, { subjectType: "integrity_flag", subjectId: channelFlag })).status).toBe(404);
    const r = await create(streamer.client, { subjectType: "integrity_flag", subjectId: channelFlag });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  test("moderation appeals: only for a mod action that targeted the appellant", async () => {
    const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, streamer.username));
    const [m] = await db()
      .insert(schema.modActions)
      .values({ scope: "channel", channelId: c?.id ?? null, targetUserId: bob.userId, action: "ban" })
      .returning();
    const body = { kind: "moderation", subjectType: "moderation_action", subjectId: m?.id ?? "" };
    expect((await create(alice.client, body)).status).toBe(404);
    expect((await create(bob.client, body)).status).toBe(200);
  });

  test("the moderator who took the action cannot resolve its appeal", async () => {
    const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, streamer.username));
    const [m] = await db()
      .insert(schema.modActions)
      .values({
        scope: "platform",
        channelId: c?.id ?? null,
        moderatorId: mod.userId,
        targetUserId: alice.userId,
        action: "timeout",
      })
      .returning();
    const created = await create(alice.client, {
      kind: "moderation",
      subjectType: "moderation_action",
      subjectId: m?.id ?? "",
    });
    expect(created.status).toBe(200);
    const byActor = await mod.client.call("POST", `/api/admin/appeals/${created.body.id}`, {
      status: "overturned",
      resolution: "My own call.",
    });
    expect(byActor.status).toBe(403);
    const [row] = await db().select().from(schema.appeals).where(eq(schema.appeals.id, created.body.id));
    expect(row?.status).toBe("open");
  });

  test("two concurrent resolves: one wins, the other is a CONFLICT", async () => {
    const other = await signUpAndSignIn(api);
    await db().update(schema.users).set({ role: "moderator" }).where(eq(schema.users.id, other.userId));
    const created = await create(alice.client, { subjectType: "user", subjectId: alice.userId });
    expect(created.status).toBe(200);
    const results = await Promise.all(
      [mod, other].map((m, i) =>
        m.client.call("POST", `/api/admin/appeals/${created.body.id}`, {
          status: i === 0 ? "upheld" : "overturned",
          resolution: "Reviewed.",
        }),
      ),
    );
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 409]);
    const audits = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectType, "appeal"), eq(schema.auditLog.subjectId, created.body.id)));
    expect(audits).toHaveLength(1);
  });

  test("create → queue → resolve overturned → the integrity allowance sees it", async () => {
    const sessionFacts = async () => {
      const r = await sessionRow(aliceSession);
      return [{ id: r.id, userId: r.userId, startedAt: r.startedAt }];
    };
    expect((await loadAllowances(db(), await sessionFacts())).get(aliceSession)).toBeUndefined();

    const created = await create(alice.client, { subjectType: "integrity_flag", subjectId: flagOnAlice });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body).toMatchObject({ status: "open", resolution: null, resolvedAt: null, body: BODY });
    // One open appeal per subject.
    expect((await create(alice.client, { subjectType: "integrity_flag", subjectId: flagOnAlice })).status).toBe(409);

    const mine = await alice.client.call<AppealDto[]>("GET", "/api/appeals");
    expect(mine.body.map((a) => a.id)).toContain(created.body.id);
    expect((await bob.client.call<AppealDto[]>("GET", "/api/appeals")).body.map((a) => a.id)).not.toContain(
      created.body.id,
    );

    // The queue is for platform moderators only.
    expect((await alice.client.call("GET", "/api/admin/appeals")).status).toBe(403);
    const queue = await mod.client.call<{ items: AppealDto[] }>("GET", "/api/admin/appeals?status=open&limit=100");
    expect(queue.status).toBe(200);
    expect(queue.body.items.map((a) => a.id)).toContain(created.body.id);

    // Appellants cannot resolve; nor can a moderator resolve their own appeal.
    expect(
      (
        await alice.client.call("POST", `/api/admin/appeals/${created.body.id}`, {
          status: "overturned",
          resolution: "self-service",
        })
      ).status,
    ).toBe(403);
    const modOwn = await create(mod.client, { subjectType: "user", subjectId: mod.userId });
    expect(
      (
        await mod.client.call("POST", `/api/admin/appeals/${modOwn.body.id}`, {
          status: "overturned",
          resolution: "mine",
        })
      ).status,
    ).toBe(403);

    const resolved = await mod.client.call<AppealDto>("POST", `/api/admin/appeals/${created.body.id}`, {
      status: "overturned",
      resolution: "Reviewed the session: playback was genuine.",
    });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(resolved.body.status).toBe("overturned");
    expect(resolved.body.resolvedAt).not.toBeNull();

    const [row] = await db().select().from(schema.appeals).where(eq(schema.appeals.id, created.body.id));
    expect(row).toMatchObject({ status: "overturned", resolverId: mod.userId });
    expect(row?.resolvedAt).toBeInstanceOf(Date);

    // Re-resolving a closed appeal is a conflict.
    expect(
      (
        await mod.client.call("POST", `/api/admin/appeals/${created.body.id}`, {
          status: "upheld",
          resolution: "changed my mind",
        })
      ).status,
    ).toBe(409);

    // Audit row: ids and enums only, never the appeal body or resolution text.
    const audits = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectType, "appeal"), eq(schema.auditLog.subjectId, created.body.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: "moderator", actorId: mod.userId, action: "appeal.resolve" });
    const auditText = JSON.stringify(audits[0]);
    expect(auditText).not.toContain("alice@example.test");
    expect(auditText).not.toContain("genuine");
    expect(audits[0]?.details).toMatchObject({
      kind: "integrity",
      appealSubjectType: "integrity_flag",
      appealSubjectId: flagOnAlice,
      appellantId: alice.userId,
      status: "overturned",
    });

    // No outbox row until `appeal.resolved` is in the event catalog (an unknown type would be lost).
    expect(await db().select().from(schema.events).where(eq(schema.events.type, "appeal.resolved"))).toHaveLength(0);

    // The resolved appeal leaves the open queue and shows in the overturned one.
    const open = await mod.client.call<{ items: AppealDto[] }>("GET", "/api/admin/appeals?status=open&limit=100");
    expect(open.body.items.map((a) => a.id)).not.toContain(created.body.id);
    const over = await mod.client.call<{ items: AppealDto[] }>("GET", "/api/admin/appeals?status=overturned");
    expect(over.body.items.map((a) => a.id)).toContain(created.body.id);

    const allowance = (await loadAllowances(db(), await sessionFacts())).get(aliceSession);
    expect(allowance?.codes).toEqual(["headless"]);
  });

  test("an upheld appeal is no allowance; the queue paginates", async () => {
    const created = await create(bob.client, { subjectType: "session", subjectId: bobSession });
    expect(created.status).toBe(200);
    const upheld = await mod.client.call<AppealDto>("POST", `/api/admin/appeals/${created.body.id}`, {
      status: "upheld",
      resolution: "The signal stands.",
    });
    expect(upheld.body.status).toBe("upheld");
    const r = await sessionRow(bobSession);
    expect(
      (await loadAllowances(db(), [{ id: r.id, userId: r.userId, startedAt: r.startedAt }])).get(bobSession),
    ).toBeUndefined();

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const qs: string = `status=open&limit=1${cursor ? `&cursor=${cursor}` : ""}`;
      const pg = await mod.client.call<{ items: AppealDto[]; nextCursor: string | null }>(
        "GET",
        `/api/admin/appeals?${qs}`,
      );
      expect(pg.status).toBe(200);
      seen.push(...pg.body.items.map((a) => a.id));
      cursor = pg.body.nextCursor;
    } while (cursor);
    const openIds = (await db().select().from(schema.appeals).where(eq(schema.appeals.status, "open"))).map(
      (a) => a.id,
    );
    expect(new Set(seen)).toEqual(new Set(openIds));
    expect(seen).toHaveLength(openIds.length);
  });
});
