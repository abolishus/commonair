// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The rehearsal driver against Postgres and Valkey with an injected clock (W2-rehearsal): the
 * simulated chat and its burst tallied by rule, ingest dips, the end reasons (publisher, cap,
 * safety, expired, disarmed), the cap's kick and audit row, and a restarted job resuming the same
 * report without re-sending the burst.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { REHEARSAL_RULES } from "@commonair/contracts/enums";
import { KEYS, type ChatDryRunResult, type RehearsalArm } from "@commonair/contracts/internal";
import type { RehearsalReport } from "@commonair/contracts/dto";
import { schema, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { createValkey, type ValkeyClient } from "@commonair/service";
import { BURST_BODY } from "@commonair/sim";
import { driveRehearsal, type ChatProbe, type DriverDeps } from "../src/jobs/rehearsal-driver.ts";
import { emit } from "../src/moderation/records.ts";
import { makeUser, quietLogger, VALKEY_URL } from "./fixtures.ts";

let t: TestDatabase;
let valkey: ValkeyClient;
beforeAll(async () => {
  t = await createTestDatabase();
  valkey = createValkey(VALKEY_URL, { keyPrefix: `test:${crypto.randomUUID()}:`, name: "worker-test-rehearsal" });
});
afterAll(async () => {
  await valkey?.quit();
  await t?.drop();
});
const db = () => t.db;
const S = 1000;

/** A pipeline stand-in: links rejected, the filter word held, a sender's repeat a duplicate. */
function fakeChat(): ChatProbe & { calls: { sender: string; body: string }[] } {
  const seen = new Set<string>();
  const calls: { sender: string; body: string }[] = [];
  return {
    calls,
    async send(_channelId, sender, body): Promise<ChatDryRunResult> {
      calls.push({ sender, body });
      if (/https?:\/\//.test(body)) return { outcome: "rejected", code: "msg_links_blocked" };
      if (body.includes("badword")) return { outcome: "held", code: null };
      const k = `${sender}\n${body}`;
      if (seen.has(k)) return { outcome: "rejected", code: "msg_duplicate" };
      seen.add(k);
      return { outcome: "accepted", code: null };
    },
  };
}

interface Rig {
  deps: DriverDeps;
  clock: { ms: number };
  chat: ReturnType<typeof fakeChat>;
  kicks: string[];
  ended: string[];
}

/** `onTick(elapsedMs)` runs at every sleep, after the clock moved. */
function rig(startMs: number, onTick: (ms: number) => Promise<void> = async () => {}): Rig {
  const clock = { ms: startMs };
  const chat = fakeChat();
  const kicks: string[] = [];
  const ended: string[] = [];
  return {
    clock,
    chat,
    kicks,
    ended,
    deps: {
      db: db(),
      valkey,
      logger: quietLogger,
      now: () => new Date(clock.ms),
      sleep: async (ms) => {
        clock.ms += ms;
        await onTick(clock.ms);
      },
      chat,
      kick: async (path) => {
        kicks.push(path);
        return true;
      },
      publishEnded: async (e) => {
        ended.push(e.broadcastId);
      },
    },
  };
}

async function armed(startMs: number) {
  const { user, channel } = await makeUser(db());
  const arm: RehearsalArm = { armId: uuidv7(startMs), ownerId: user.id, armedAt: new Date(startMs).toISOString() };
  await db().transaction((tx) =>
    emit(
      tx,
      "rehearsal.armed",
      channel.id,
      { channel_id: channel.id, arm_id: arm.armId, expires_at: new Date(startMs + 600 * S).toISOString() },
      new Date(startMs),
    ),
  );
  await valkey.set(KEYS.rehearsalArmed(channel.id), JSON.stringify(arm), "EX", 600);
  await db().insert(schema.wordFilters).values({ channelId: channel.id, pattern: "badword", action: "hold" });
  return { user, channel, arm };
}

async function rehearsal(channelId: string, startedAt: Date) {
  const [b] = await db()
    .insert(schema.broadcasts)
    .values({ channelId, kind: "rehearsal", ingestProtocol: "rtmp", path: `live/${channelId}`, startedAt })
    .returning();
  return b!;
}

const report = async (broadcastId: string) =>
  JSON.parse((await valkey.get(KEYS.rehearsalReport(broadcastId))) ?? "null") as
    | (RehearsalReport & { driver: { nextSeq: number; burstStarted: boolean; burstDone: boolean; done: boolean } })
    | null;
const endedEvents = (channelId: string) =>
  db()
    .select({ payload: schema.events.payload })
    .from(schema.events)
    .where(and(eq(schema.events.channelId, channelId), eq(schema.events.type, "rehearsal.ended")));
const endBroadcast = (id: string, at: number) =>
  db()
    .update(schema.broadcasts)
    .set({ endedAt: new Date(at) })
    .where(eq(schema.broadcasts.id, id));

describe("rehearsal driver", () => {
  test("simulated chat and the burst are tallied by rule; dips timed; invitees who watched; publisher end", async () => {
    const start = Date.parse("2026-11-01T12:00:00Z");
    const { user, channel, arm } = await armed(start);
    const b = await rehearsal(channel.id, new Date(start));
    // Ingest: 4000 kbps every 5 s with a dip at 12:00:20 and 12:00:25.
    await db()
      .insert(schema.broadcastHealthSamples)
      .values(
        Array.from({ length: 14 }, (_, i) => ({
          broadcastId: b.id,
          at: new Date(start + i * 5 * S),
          bitrateKbps: i === 4 || i === 5 ? 900 : 4000,
          fps: 30,
          keyframeIntervalMs: 2000,
          droppedFrames: 0,
        })),
      );
    const invitee = await makeUser(db());
    await db().insert(schema.follows).values({ followerId: invitee.user.id, channelId: channel.id });
    await db()
      .insert(schema.rehearsalInvitees)
      .values({ armId: arm.armId, channelId: channel.id, userId: invitee.user.id, broadcastId: b.id });
    await db().insert(schema.playbackSessions).values({
      channelId: channel.id,
      broadcastId: b.id,
      userId: invitee.user.id,
      deviceHash: "d",
      ipHash: "i",
    });
    const r = rig(start, async (ms) => {
      if (ms - start === 70 * S) {
        await endBroadcast(b.id, ms); // the encoder stopped
        await valkey.del(KEYS.rehearsalArmed(channel.id), KEYS.rehearsalSession(channel.id));
      }
    });
    const result = await driveRehearsal(r.deps, { armId: arm.armId, channelId: channel.id });
    expect(result).toMatchObject({ broadcasts: 1, ended: 1, expired: 0 });

    const rep = (await report(b.id))!;
    expect(rep.endReason).toBe("publisher_ended");
    expect(rep.endedAt).toBe(new Date(start + 70 * S).toISOString());
    // ~3 msg/s for 70 s plus the 50-message burst.
    const burst = r.chat.calls.filter((c) => c.body.startsWith(BURST_BODY) || c.sender.startsWith("spam"));
    expect(burst).toHaveLength(50);
    expect(r.chat.calls.length).toBeGreaterThan(50 + 70 * 3 * 0.8);
    expect(rep.chat.accepted).toBeGreaterThan(100);
    expect(rep.chat.held.wordFilter).toBeGreaterThan(10);
    expect(rep.chat.rejected.link).toBeGreaterThan(10);
    expect(rep.chat.rejected.duplicate).toBeGreaterThan(10);
    expect(rep.chat.accepted + sum(rep.chat.held) + sum(rep.chat.rejected)).toBe(r.chat.calls.length);

    const bitrate = rep.ingest.find((c) => c.check === "bitrate")!;
    expect(bitrate.ok).toBe(false);
    expect(bitrate.dips).toEqual([{ at: "2026-11-01T12:00:20.000Z", seconds: 10 }]);
    expect(rep.ingest.find((c) => c.check === "fps")?.ok).toBe(true);
    expect(rep.moderation.flagged).toBe(false);
    expect(rep.inviteesWatched).toEqual([{ id: invitee.user.id, username: invitee.user.username }]);
    expect(rep.inviteesWatched.some((i) => i.id === user.id)).toBe(false);

    // Synthetic viewers are never sessions: only the invitee's row exists.
    const [ps] = await db().execute<{ n: string }>(
      sql`select count(*)::text as n from playback_sessions where broadcast_id = ${b.id}`,
    );
    expect(ps?.n).toBe("1");
    expect((await endedEvents(channel.id)).map((e) => e.payload)).toEqual([
      { channel_id: channel.id, arm_id: arm.armId, broadcast_id: b.id, reason: "publisher_ended" },
    ]);
    // Never a live announcement.
    const [online] = await db().execute<{ n: string }>(
      sql`select count(*)::text as n from events where channel_id = ${channel.id} and type in ('stream.online', 'stream.offline')`,
    );
    expect(online?.n).toBe("0");
  });

  test("the cap refuses the reconnect, clears the arm, ends, audits and kicks", async () => {
    const now = Date.parse("2026-11-01T13:00:00Z");
    const startedAt = now - (REHEARSAL_RULES.maxDurationSeconds - 3) * S;
    const { channel, arm } = await armed(startedAt - 60 * S);
    await valkey.set(KEYS.rehearsalSession(channel.id), JSON.stringify(arm), "EX", 600);
    const b = await rehearsal(channel.id, new Date(startedAt));
    const r = rig(now);
    const result = await driveRehearsal(r.deps, { armId: arm.armId, channelId: channel.id });
    expect(result.broadcasts).toBe(1);

    const [row] = await db().select().from(schema.broadcasts).where(eq(schema.broadcasts.id, b.id));
    expect(row?.endedAt?.getTime()).toBeGreaterThanOrEqual(startedAt + REHEARSAL_RULES.maxDurationSeconds * S);
    expect(await valkey.exists(KEYS.rehearsalKicked(channel.id))).toBe(1);
    expect(await valkey.ttl(KEYS.rehearsalKicked(channel.id))).toBeLessThanOrEqual(REHEARSAL_RULES.kickCooldownSeconds);
    expect(await valkey.exists(KEYS.rehearsalArmed(channel.id), KEYS.rehearsalSession(channel.id))).toBe(0);
    expect(r.kicks).toEqual([b.path]);
    expect(r.ended).toEqual([b.id]);
    expect((await endedEvents(channel.id)).map((e) => (e.payload as { reason: string }).reason)).toEqual(["cap"]);
    const audits = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.channelId, channel.id), eq(schema.auditLog.action, "rehearsal.cap")));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: "system", subjectType: "broadcast", subjectId: b.id });
    expect((await report(b.id))?.endReason).toBe("cap");
  });

  test("a restarted job resumes the same report and never re-sends the burst", async () => {
    const start = Date.parse("2026-11-01T14:00:00Z");
    const { channel, arm } = await armed(start);
    const b = await rehearsal(channel.id, new Date(start));
    // The first run dies in the middle of the burst (it starts at 45 s).
    const crash = rig(start, async (ms) => {
      if (ms - start >= 46 * S && (await report(b.id))?.driver.burstStarted) throw new Error("worker stopped");
    });
    await expect(driveRehearsal(crash.deps, { armId: arm.armId, channelId: channel.id })).rejects.toThrow(
      "worker stopped",
    );
    const mid = (await report(b.id))!;
    expect(mid.driver.burstStarted).toBe(true);
    expect(mid.driver.done).toBe(false);
    const firstBurst = crash.chat.calls.filter((c) => c.sender.startsWith("spam")).length;
    expect(firstBurst).toBeGreaterThan(0);
    expect(firstBurst).toBeLessThan(50);

    const resumed = rig(crash.deps.now().getTime(), async (ms) => {
      if (ms - start >= 80 * S) {
        await endBroadcast(b.id, ms);
        await valkey.del(KEYS.rehearsalArmed(channel.id));
      }
    });
    await driveRehearsal(resumed.deps, { armId: arm.armId, channelId: channel.id });
    expect(resumed.chat.calls.filter((c) => c.sender.startsWith("spam"))).toEqual([]);
    expect(resumed.chat.calls.length).toBeGreaterThan(0);
    const final = (await report(b.id))!;
    const total = final.chat.accepted + sum(final.chat.held) + sum(final.chat.rejected);
    expect(total).toBe(crash.chat.calls.length + resumed.chat.calls.length);
    expect(final.driver.done).toBe(true);
    // A third run finds the rehearsal done and the arm gone: nothing more.
    const again = rig(resumed.deps.now().getTime() + 700 * S);
    expect(await driveRehearsal(again.deps, { armId: arm.armId, channelId: channel.id })).toMatchObject({
      broadcasts: 0,
      expired: 0,
    });
    expect(again.chat.calls).toEqual([]);
    expect(await endedEvents(channel.id)).toHaveLength(1);
  });

  test("a T0 suspension ends it as 'safety' and the report says nothing more", async () => {
    const start = Date.parse("2026-11-01T15:00:00Z");
    const { channel, arm } = await armed(start);
    const b = await rehearsal(channel.id, new Date(start));
    const r = rig(start, async (ms) => {
      if (ms - start === 20 * S) {
        await db()
          .update(schema.channels)
          .set({ suspendedAt: new Date(ms) })
          .where(eq(schema.channels.id, channel.id));
        await endBroadcast(b.id, ms);
        await valkey.del(KEYS.rehearsalArmed(channel.id));
      }
    });
    await driveRehearsal(r.deps, { armId: arm.armId, channelId: channel.id });
    const rep = (await report(b.id))!;
    expect(rep.endReason).toBe("safety");
    expect(rep.chat.accepted).toBe(0);
    expect(rep.ingest).toEqual([]);
    expect(rep.inviteesWatched).toEqual([]);
    expect((await endedEvents(channel.id)).map((e) => (e.payload as { reason: string }).reason)).toEqual(["safety"]);
  });

  test("an arm that lapses unused is 'expired', once; a disarm before any publish is left alone", async () => {
    const now = Date.parse("2026-11-01T16:00:00Z");
    const lapsed = await armed(now - 700 * S);
    await valkey.del(KEYS.rehearsalArmed(lapsed.channel.id));
    const r = rig(now);
    expect(await driveRehearsal(r.deps, { armId: lapsed.arm.armId, channelId: lapsed.channel.id })).toMatchObject({
      broadcasts: 0,
      expired: 1,
    });
    expect(
      await driveRehearsal(rig(now).deps, { armId: lapsed.arm.armId, channelId: lapsed.channel.id }),
    ).toMatchObject({
      expired: 0,
    });
    expect((await endedEvents(lapsed.channel.id)).map((e) => e.payload)).toEqual([
      { channel_id: lapsed.channel.id, arm_id: lapsed.arm.armId, broadcast_id: null, reason: "expired" },
    ]);

    const disarmed = await armed(now - 10 * S);
    await valkey.del(KEYS.rehearsalArmed(disarmed.channel.id));
    await db().transaction((tx) =>
      emit(
        tx,
        "rehearsal.ended",
        disarmed.channel.id,
        { channel_id: disarmed.channel.id, arm_id: disarmed.arm.armId, broadcast_id: null, reason: "disarmed" },
        new Date(now),
      ),
    );
    expect(
      await driveRehearsal(rig(now).deps, { armId: disarmed.arm.armId, channelId: disarmed.channel.id }),
    ).toMatchObject({
      broadcasts: 0,
      expired: 0,
    });
    expect(await endedEvents(disarmed.channel.id)).toHaveLength(1);
  });

  test("an unknown arm does nothing", async () => {
    const { channel } = await makeUser(db());
    expect(await driveRehearsal(rig(Date.now()).deps, { armId: uuidv7(), channelId: channel.id })).toEqual({
      broadcasts: 0,
      sent: 0,
      ended: 0,
      expired: 0,
    });
  });
});

const sum = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);
