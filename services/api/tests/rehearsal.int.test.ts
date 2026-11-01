// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `stream.rehearsal.*` against Postgres and Valkey (W2-rehearsal; batch 6 decisions (f), (g)):
 * arm, disarm and invite with their audit rows and events in the same transaction, a rehearsal
 * started through the media gate leaving nothing that counts, the invitee-gated watch token and
 * the report.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { REHEARSAL_RULES } from "@commonair/contracts/enums";
import { INTERNAL_ROUTES, INTERNAL_SECRET_HEADER, KEYS, mediaPath } from "@commonair/contracts/internal";
import type { RehearsalReport, RehearsalStatus, RehearsalWatch } from "@commonair/contracts/dto";
import { schema, uuidv7 } from "@commonair/db";
import { verifyPlaybackToken } from "@commonair/tokens";
import { client, signUpAndSignIn, startApi, type Client, type TestApi } from "./harness.ts";

let api: TestApi;
beforeAll(async () => {
  api = await startApi();
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const db = () => api.db.db;
const base = (slug: string) => `/api/channels/${slug}/rehearsal`;

const mediaAuth = (body: Record<string, unknown>) =>
  fetch(`${api.url}${INTERNAL_ROUTES.mediaAuth}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ip: "10.0.0.5", protocol: "rtmp", ...body }),
  });
const hook = (route: string, slug: string, sourceId: string) =>
  fetch(`${api.url}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: api.internalSecret },
    body: JSON.stringify({ path: mediaPath(slug), sourceType: "rtmpConn", sourceId }),
  });

interface Streamer {
  client: Client;
  username: string;
  userId: string;
  channelId: string;
  secret: string;
}

async function streamer(): Promise<Streamer> {
  const s = await signUpAndSignIn(api);
  const r = await s.client.call<{ key: string }>("POST", `/api/channels/${s.username}/stream-keys`);
  expect(r.status).toBe(200);
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, s.username));
  return {
    client: s.client,
    username: s.username,
    userId: s.userId,
    channelId: c!.id,
    secret: r.body.key.split("?key=")[1] ?? "",
  };
}

async function follower(st: Streamer, opts: { excluded?: boolean } = {}) {
  const u = await signUpAndSignIn(api);
  await db()
    .insert(schema.follows)
    .values({ followerId: u.userId, channelId: st.channelId, excludedAt: opts.excluded ? new Date() : null });
  return u;
}

async function publish(st: Streamer, sourceId = crypto.randomUUID()) {
  expect((await mediaAuth({ action: "publish", path: mediaPath(st.username), query: `key=${st.secret}` })).status).toBe(
    200,
  );
  expect((await hook(INTERNAL_ROUTES.mediaReady, st.username, sourceId)).status).toBe(204);
  return sourceId;
}

const arm = (st: Streamer) =>
  st.client.call<RehearsalStatus & { data?: { requirement?: string } }>("POST", base(st.username));
const status = (st: Streamer) => st.client.call<RehearsalStatus>("GET", base(st.username));
const disarm = (st: Streamer) => st.client.call<RehearsalStatus>("DELETE", base(st.username));
const invite = (st: Streamer, username: string, remove = false) =>
  st.client.call<RehearsalStatus & { data?: { requirement?: string } }>("POST", `${base(st.username)}/invitees`, {
    username,
    remove,
  });
const requirement = (r: { body: unknown }) => (r.body as { data?: { requirement?: string } }).data?.requirement;

const auditRows = (channelId: string, actions: string[]) =>
  db()
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.channelId, channelId), inArray(schema.auditLog.action, actions)));
const eventRows = (channelId: string, types: string[]) =>
  db()
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.channelId, channelId), inArray(schema.events.type, types)));

describe("arm and disarm", () => {
  test("arm writes the key, the event and the audit row together; a second arm is refused", async () => {
    const st = await streamer();
    expect((await status(st)).body).toMatchObject({ state: "idle", armId: null, invitees: [] });
    const r = await arm(st);
    expect(r.status).toBe(200);
    expect(r.body.state).toBe("armed");
    const armId = r.body.armId!;
    const left = Date.parse(r.body.armExpiresAt!) - Date.now();
    expect(left).toBeGreaterThan((REHEARSAL_RULES.armTtlSeconds - 30) * 1000);
    expect(left).toBeLessThanOrEqual(REHEARSAL_RULES.armTtlSeconds * 1000 + 1000);
    expect(await api.deps.valkey.ttl(KEYS.rehearsalArmed(st.channelId))).toBeGreaterThan(590);

    const [ev] = await eventRows(st.channelId, ["rehearsal.armed"]);
    expect(ev?.payload).toMatchObject({ channel_id: st.channelId, arm_id: armId });
    const [row] = await auditRows(st.channelId, ["rehearsal.arm"]);
    expect(row).toMatchObject({
      actorType: "user",
      actorId: st.userId,
      subjectType: "channel",
      subjectId: st.channelId,
    });
    expect(row?.details).toEqual({ armId });

    const again = await arm(st);
    expect(again.status).toBe(412);
    expect(requirement(again)).toBe("armed");
    expect(await eventRows(st.channelId, ["rehearsal.armed"])).toHaveLength(1);
  });

  test("concurrent arms: exactly one wins, with one event and one audit row", async () => {
    const st = await streamer();
    const rs = await Promise.all([arm(st), arm(st), arm(st)]);
    expect(rs.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 412, 412]);
    expect(await eventRows(st.channelId, ["rehearsal.armed"])).toHaveLength(1);
    expect(await auditRows(st.channelId, ["rehearsal.arm"])).toHaveLength(1);
  });

  test("a lapsed arm reads idle and may be re-armed", async () => {
    const st = await streamer();
    const first = (await arm(st)).body.armId;
    await api.deps.valkey.del(KEYS.rehearsalArmed(st.channelId)); // the TTL ran out
    expect((await status(st)).body.state).toBe("idle");
    const second = await arm(st);
    expect(second.status).toBe(200);
    expect(second.body.armId).not.toBe(first);
  });

  test("arm is refused while live and while suspended; status is owner-only", async () => {
    const st = await streamer();
    const sourceId = await publish(st); // not armed: a real go-live
    const live = await arm(st);
    expect(live.status).toBe(412);
    expect(requirement(live)).toBe("live");
    await hook(INTERNAL_ROUTES.mediaNotReady, st.username, sourceId);

    const other = await signUpAndSignIn(api);
    expect((await other.client.call("GET", base(st.username))).status).toBe(403);
    expect((await client(api).call("POST", base(st.username))).status).toBe(401);

    await db().update(schema.channels).set({ suspendedAt: new Date() }).where(eq(schema.channels.id, st.channelId));
    const suspended = await arm(st);
    expect(suspended.status).toBe(412);
    expect(requirement(suspended)).toBe("suspended");
  });

  test("disarm is idempotent when idle, and clears an arm with the event and audit row", async () => {
    const st = await streamer();
    expect((await disarm(st)).body.state).toBe("idle");
    expect(await auditRows(st.channelId, ["rehearsal.disarm"])).toEqual([]);
    const armId = (await arm(st)).body.armId;
    const d = await disarm(st);
    expect(d.status).toBe(200);
    expect(d.body.state).toBe("idle");
    expect(await api.deps.valkey.exists(KEYS.rehearsalArmed(st.channelId))).toBe(0);
    const [ev] = await eventRows(st.channelId, ["rehearsal.ended"]);
    expect(ev?.payload).toEqual({ channel_id: st.channelId, arm_id: armId, broadcast_id: null, reason: "disarmed" });
    expect(await auditRows(st.channelId, ["rehearsal.disarm"])).toHaveLength(1);
    expect((await disarm(st)).status).toBe(200);
    expect(await auditRows(st.channelId, ["rehearsal.disarm"])).toHaveLength(1);
  });

  test("a running rehearsal: status shows the cap; disarm ends it quietly, clears the session and refuses the reconnect", async () => {
    const st = await streamer();
    const armId = (await arm(st)).body.armId!;
    await publish(st);
    const s = (await status(st)).body;
    expect(s).toMatchObject({ state: "rehearsing", armId });
    const [b] = await db().select().from(schema.broadcasts).where(eq(schema.broadcasts.channelId, st.channelId));
    expect(s.broadcastId).toBe(b!.id);
    expect(Date.parse(s.endsAt!) - b!.startedAt.getTime()).toBe(REHEARSAL_RULES.maxDurationSeconds * 1000);
    expect((await arm(st)).status).toBe(412);

    const d = await disarm(st);
    expect(d.body.state).toBe("idle");
    const [ended] = await db().select().from(schema.broadcasts).where(eq(schema.broadcasts.id, b!.id));
    expect(ended?.endedAt).not.toBeNull();
    expect(await api.deps.valkey.exists(KEYS.rehearsalSession(st.channelId))).toBe(0);
    expect(await api.deps.valkey.exists(KEYS.rehearsalKicked(st.channelId))).toBe(1);
    expect(
      (await mediaAuth({ action: "publish", path: mediaPath(st.username), query: `key=${st.secret}` })).status,
    ).toBe(401);
    const [ev] = await eventRows(st.channelId, ["rehearsal.ended"]);
    expect(ev?.payload).toMatchObject({ arm_id: armId, broadcast_id: b!.id, reason: "disarmed" });
    expect(await eventRows(st.channelId, ["stream.online", "stream.offline"])).toEqual([]);
  });
});

describe("invitees", () => {
  test("followers only, never the owner, five at most, idempotent, each change audited", async () => {
    const st = await streamer();
    const stranger = await signUpAndSignIn(api);
    const notArmed = await invite(st, stranger.username);
    expect(notArmed.status).toBe(412);
    expect(requirement(notArmed)).toBe("not_armed");
    await arm(st);

    expect(requirement(await invite(st, stranger.username))).toBe("not_follower");
    expect(requirement(await invite(st, st.username))).toBe("not_follower");
    expect(requirement(await invite(st, "nosuchuser_xyz"))).toBe("not_follower");
    const excluded = await follower(st, { excluded: true });
    expect(requirement(await invite(st, excluded.username))).toBe("not_follower");
    const gone = await follower(st);
    await db().update(schema.users).set({ deletedAt: new Date() }).where(eq(schema.users.id, gone.userId));
    expect(requirement(await invite(st, gone.username))).toBe("not_follower");
    const banned = await follower(st);
    await db().update(schema.users).set({ banned: true }).where(eq(schema.users.id, banned.userId));
    expect(requirement(await invite(st, banned.username))).toBe("not_follower");

    const five = await Promise.all([1, 2, 3, 4, 5].map(() => follower(st)));
    for (const f of five) expect((await invite(st, f.username)).status).toBe(200);
    // A re-add is a no-op, not a sixth.
    const again = await invite(st, five[0]!.username);
    expect(again.status).toBe(200);
    expect(again.body.invitees.map((i) => i.username).sort()).toEqual(five.map((f) => f.username).sort());
    const sixth = await follower(st);
    const refused = await invite(st, sixth.username);
    expect(refused.status).toBe(412);
    expect(requirement(refused)).toBe("invitee_limit");
    expect(await auditRows(st.channelId, ["rehearsal.invitee.add"])).toHaveLength(5);

    const removed = await invite(st, five[0]!.username, true);
    expect(removed.body.invitees).toHaveLength(4);
    const [rm] = await auditRows(st.channelId, ["rehearsal.invitee.remove"]);
    expect(rm).toMatchObject({ subjectType: "user", subjectId: five[0]!.userId });
    // Ids only in the append-only row.
    expect(JSON.stringify(rm?.details)).not.toContain(five[0]!.username);
    // Removing someone not on the list writes nothing.
    await invite(st, five[0]!.username, true);
    expect(await auditRows(st.channelId, ["rehearsal.invitee.remove"])).toHaveLength(1);
    expect((await invite(st, sixth.username)).status).toBe(200);
  });
});

describe("a rehearsal started through the gate", () => {
  test("leaves no stream_hours, ledger or attestation row; direct inserts are refused", async () => {
    const st = await streamer();
    await arm(st);
    const sourceId = await publish(st);
    const [b] = await db().select().from(schema.broadcasts).where(eq(schema.broadcasts.channelId, st.channelId));
    expect(b?.kind).toBe("rehearsal");
    await hook(INTERNAL_ROUTES.mediaNotReady, st.username, sourceId);

    const n = async (table: string) =>
      Number(
        (
          await db().execute<{ n: string }>(
            sql.raw(`select count(*)::text as n from ${table} where broadcast_id = '${b!.id}'`),
          )
        )[0]?.n,
      );
    expect(await n("stream_hours")).toBe(0);
    expect(await n("integrity_attestations")).toBe(0);
    const [ledger] = await db().execute<{ n: string }>(
      sql`select count(*)::text as n from ledger_transactions where ref_type = 'broadcast' and ref_id = ${b!.id}`,
    );
    expect(ledger?.n).toBe("0");

    await expect(
      db().execute(
        sql`insert into ledger_transactions (id, kind, description, occurred_at, ref_type, ref_id, idempotency_key)
            values (${uuidv7()}, 'tip', 'x', now(), 'broadcast', ${b!.id}, ${crypto.randomUUID()})`,
      ),
    ).rejects.toMatchObject({ cause: { message: "a rehearsal broadcast is never posted to the ledger" } });
    await expect(
      db().execute(
        sql`insert into integrity_attestations (channel_id, broadcast_id) values (${st.channelId}, ${b!.id})`,
      ),
    ).rejects.toMatchObject({ cause: { message: "a rehearsal broadcast is never attested" } });
    await expect(
      db()
        .insert(schema.streamHours)
        .values({ broadcastId: b!.id, channelId: st.channelId, hourStart: new Date(), liveSeconds: 60 }),
    ).rejects.toMatchObject({ cause: { message: "a rehearsal broadcast never reaches stream_hours" } });
    await expect(
      db().update(schema.channels).set({ liveBroadcastId: b!.id }).where(eq(schema.channels.id, st.channelId)),
    ).rejects.toMatchObject({ cause: { message: "a rehearsal is never a channel's live broadcast" } });
  });
});

describe("watch", () => {
  test("invitees and the owner get an origin-only rehearsal token; everyone else is refused", async () => {
    const st = await streamer();
    await arm(st);
    const inv = await follower(st);
    const fan = await follower(st);
    await invite(st, inv.username);
    const watch = (c: Client) =>
      c.call<RehearsalWatch>("POST", `${base(st.username)}/watch`, { deviceId: "device-0123456789abcdef" });

    // Nothing open yet: the same answer as for a stranger.
    expect((await watch(inv.client)).status).toBe(404);
    await publish(st);
    const [b] = await db().select().from(schema.broadcasts).where(eq(schema.broadcasts.channelId, st.channelId));

    const ok = await watch(inv.client);
    expect(ok.status).toBe(200);
    const nowS = Math.floor(Date.now() / 1000);
    const v = await verifyPlaybackToken(api.deps.signingKey.publicKey, ok.body.token, nowS);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value).toMatchObject({ src: "origin", rb: b!.id, path: mediaPath(st.username), sid: ok.body.sessionId });
    expect(v.value.rid).toBeUndefined();
    expect(v.value.exp).toBeLessThanOrEqual(
      Math.floor(b!.startedAt.getTime() / 1000) + REHEARSAL_RULES.maxDurationSeconds,
    );
    expect(ok.body.playlistUrl).toContain(`/hls/${mediaPath(st.username)}/index.m3u8?t=`);
    const [ps] = await db()
      .select()
      .from(schema.playbackSessions)
      .where(eq(schema.playbackSessions.id, ok.body.sessionId));
    expect(ps).toMatchObject({ broadcastId: b!.id, userId: inv.userId, assignedSource: "origin" });
    // The heartbeat accepts the rehearsal session.
    const hb = await inv.client.call<{ ok: boolean }>("POST", "/api/playback/heartbeat", {
      sessionId: ok.body.sessionId,
      token: ok.body.token,
      rendition: "source",
      playedSeconds: 0,
      bufferSeconds: 1,
      visible: true,
      muted: false,
      stalls: 0,
      bytesHttp: 0,
      bytesP2p: 0,
      latencySeconds: null,
      ttffMs: null,
    });
    expect(hb.status).toBe(200);
    expect(hb.body.ok).toBe(true);

    expect((await watch(st.client)).status).toBe(200);
    expect((await watch(fan.client)).status).toBe(404);
    expect((await watch(client(api))).status).toBe(401);
    // The channel's normal playback (and so the embed) sees it as offline.
    const start = await client(api).call("POST", `/api/channels/${st.username}/playback`, {
      deviceId: "device-0123456789abcdef",
    });
    expect(start.status).toBe(412);
    const embedStart = await inv.client.call("POST", `/api/channels/${st.username}/playback`, {
      deviceId: "device-0123456789abcdef",
      embed: true,
    });
    expect(embedStart.status).toBe(412);
  });
});

const heartbeat = (c: Client, w: RehearsalWatch) =>
  c.call<{ ok: boolean; token?: string }>("POST", "/api/playback/heartbeat", {
    sessionId: w.sessionId,
    token: w.token,
    rendition: "source",
    playedSeconds: 0,
    bufferSeconds: 1,
    visible: true,
    muted: false,
    stalls: 0,
    bytesHttp: 0,
    bytesP2p: 0,
    latencySeconds: null,
    ttffMs: null,
  });

describe("watch: removal and reconnects", () => {
  test("removing an invitee ends their watch: no more heartbeats, no new token", async () => {
    const st = await streamer();
    await arm(st);
    const inv = await follower(st);
    await invite(st, inv.username);
    await publish(st);
    const watch = (c: Client) =>
      c.call<RehearsalWatch>("POST", `${base(st.username)}/watch`, { deviceId: "device-0123456789abcdef" });
    const ok = await watch(inv.client);
    expect(ok.status).toBe(200);

    expect((await invite(st, inv.username, true)).status).toBe(200);
    const [ps] = await db()
      .select()
      .from(schema.playbackSessions)
      .where(eq(schema.playbackSessions.id, ok.body.sessionId));
    expect(ps?.endedAt).not.toBeNull();
    const hb = await heartbeat(inv.client, ok.body);
    expect(hb.status).toBe(409);
    expect(hb.body.token).toBeUndefined();
    expect((await watch(inv.client)).status).toBe(404);
    // The owner's own watch is untouched by an invitee's removal.
    expect((await watch(st.client)).status).toBe(200);
    await disarm(st);
  });

  test("a reconnect under the same arm keeps the first start's cap (status and watch token)", async () => {
    const st = await streamer();
    await arm(st);
    const inv = await follower(st);
    await invite(st, inv.username);
    const firstSource = await publish(st);
    expect((await hook(INTERNAL_ROUTES.mediaNotReady, st.username, firstSource)).status).toBe(204);
    await publish(st); // inside the session grace: a second rehearsal under the same arm
    const rows = await db()
      .select()
      .from(schema.broadcasts)
      .where(eq(schema.broadcasts.channelId, st.channelId))
      .orderBy(schema.broadcasts.startedAt);
    expect(rows).toHaveLength(2);
    const [first, second] = rows;
    // Make the reconnect visibly later than the first start.
    const later = new Date(first!.startedAt.getTime() + 600_000);
    await db().update(schema.broadcasts).set({ startedAt: later }).where(eq(schema.broadcasts.id, second!.id));

    const s = (await status(st)).body;
    expect(s).toMatchObject({ state: "rehearsing", broadcastId: second!.id });
    expect(Date.parse(s.endsAt!)).toBe(first!.startedAt.getTime() + REHEARSAL_RULES.maxDurationSeconds * 1000);
    const w = await inv.client.call<RehearsalWatch>("POST", `${base(st.username)}/watch`, {
      deviceId: "device-0123456789abcdef",
    });
    expect(w.status).toBe(200);
    const v = await verifyPlaybackToken(api.deps.signingKey.publicKey, w.body.token, Math.floor(Date.now() / 1000));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.exp).toBeLessThanOrEqual(
      Math.floor(first!.startedAt.getTime() / 1000) + REHEARSAL_RULES.maxDurationSeconds,
    );
    await disarm(st);
  });
});

describe("report", () => {
  test("blank until the driver writes, then the stored report; safety ends say nothing more", async () => {
    const st = await streamer();
    expect((await st.client.call("GET", `${base(st.username)}/report`)).status).toBe(404);
    await arm(st);
    await publish(st);
    const [b] = await db().select().from(schema.broadcasts).where(eq(schema.broadcasts.channelId, st.channelId));
    const blank = await st.client.call<RehearsalReport>("GET", `${base(st.username)}/report`);
    expect(blank.status).toBe(200);
    expect(blank.body).toMatchObject({ broadcastId: b!.id, endReason: null, ingest: [], chat: { accepted: 0 } });

    const stored: RehearsalReport = {
      ...blank.body,
      chat: {
        accepted: 120,
        held: { wordFilter: 4, link: 0, duplicate: 0, rateLimit: 0, other: 0 },
        rejected: { wordFilter: 10, link: 15, duplicate: 9, rateLimit: 8, other: 0 },
      },
      ingest: [{ check: "bitrate", ok: false, dips: [{ at: new Date().toISOString(), seconds: 10 }] }],
      moderation: { samples: 12, flagged: false },
      inviteesWatched: [],
      updatedAt: new Date().toISOString(),
    };
    await api.deps.valkey.set(
      KEYS.rehearsalReport(b!.id),
      JSON.stringify({ ...stored, driver: { nextSeq: 10 } }),
      "EX",
      60,
    );
    const got = await st.client.call<RehearsalReport>("GET", `${base(st.username)}/report?broadcastId=${b!.id}`);
    expect(got.body).toEqual(stored);

    await api.deps.valkey.set(
      KEYS.rehearsalReport(b!.id),
      JSON.stringify({ ...stored, endReason: "safety", endedAt: new Date().toISOString() }),
      "EX",
      60,
    );
    const safety = await st.client.call<RehearsalReport>("GET", `${base(st.username)}/report`);
    expect(safety.body).toMatchObject({ endReason: "safety", ingest: [], inviteesWatched: [], chat: { accepted: 0 } });

    // Another channel's broadcast id is not this channel's report.
    const other = await streamer();
    expect((await other.client.call("GET", `${base(other.username)}/report?broadcastId=${b!.id}`)).status).toBe(404);
  });
});
