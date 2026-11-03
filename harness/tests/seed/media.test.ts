// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { HEALTH_WARNING_CODES } from "@commonair/contracts/enums";
import { describe, expect, test } from "vite-plus/test";
import { bulkStreamerHandle, bulkViewerHandle } from "../../src/seed/accounts.ts";
import { unit } from "../../src/seed/media.ts";
import { buildMediaExtra, type RecordedOutcome } from "../../src/seed/media/extra.ts";
import { loadHarnessEnv } from "../../src/env.ts";
import { relayArgv } from "../../src/relay.ts";
import { SINK_STREAM_KEY, seedRelayHost, sinkArgs } from "../../src/seed/media/peers.ts";
import {
  DAY_MS,
  EGRESS_DAYS,
  FIXED_RECORDERS,
  HEALTH_STATES,
  HOUR_MS,
  type HistoryInput,
  MEMBER_HOURS_DAYS,
  RECENT_VOD_CHANNELS,
  RECORDING_CONCURRENCY,
  SWARM_SESSIONS,
  bulkRecordings,
  historyCounts,
  maxConcurrency,
  planHistory,
  planRecordings,
  recentVodChannels,
} from "../../src/seed/media/plan.ts";
import { DEFAULT_LIVE_CHANNELS, LIVE_FIXED_ORDER } from "../../src/seed/live.ts";
import { createRng } from "../../src/seed/prng.ts";
import { SEED_SCALES, type SeedScale } from "../../src/seed/scale.ts";
import type { SeededChannel } from "../../src/seed/types.ts";

const NOW = new Date("2026-11-01T12:00:00.000Z");
const small = SEED_SCALES.small;
const FIXED_STREAMERS = ["streamer1", "streamer2", "streamer3", "council1", "council2"];

/** Channels with stable ids per handle, and social-shaped windows: one per day offset, never overlapping. */
function fixture(scale: SeedScale, seed = 3): HistoryInput {
  const handles = [...FIXED_STREAMERS, ...Array.from({ length: scale.streamers }, (_, i) => bulkStreamerHandle(i + 1))];
  const channels: SeededChannel[] = handles.map((h, i) => ({
    id: `00000000-0000-7000-8000-${String(i).padStart(12, "0")}`,
    ownerId: `10000000-0000-7000-8000-${String(i).padStart(12, "0")}`,
    ownerHandle: h,
    slug: `demo_${h}`,
  }));
  const r = createRng(seed);
  const windows = channels.flatMap((c) => {
    // streamer3's first broadcast is the real recording: no history windows.
    if (c.ownerHandle === "streamer3") return [];
    const fixed = FIXED_STREAMERS.includes(c.ownerHandle);
    const days = r.sample(
      Array.from({ length: scale.historyDays - 2 }, (_, i) => i + 1),
      fixed ? Math.round(scale.historyDays / 3) : Math.max(1, Math.round(scale.historyDays / 12)),
    );
    return days.map((d) => {
      const end = NOW.getTime() - d * DAY_MS - r.int(0, 360) * 60_000;
      return { channelId: c.id, start: new Date(end - r.int(60, 240) * 60_000), end: new Date(end) };
    });
  });
  return { channels, windows, categoryIds: ["c1", "c2", "c3"] };
}

const INPUT = fixture(small);
const H = planHistory(createRng(7).fork("history"), INPUT, NOW);
const bulk = (scale: SeedScale) => ({
  bulkStreamers: Array.from({ length: scale.streamers }, (_, i) => bulkStreamerHandle(i + 1)),
  bulkViewers: Array.from({ length: Math.min(scale.viewers, 500) }, (_, i) => bulkViewerHandle(i + 1)),
});
const R = planRecordings(createRng(7).fork("recordings"), small, bulk(small));

describe("seed-media unit", () => {
  test("claims its stub's tables, runs after social and leaves nothing pending", () => {
    expect(unit.name).toBe("media");
    expect(unit.after).toEqual(["social"]);
    expect(unit.pending).toEqual([]);
    expect(unit.tables).toContain("watch_room_messages");
    expect(unit.tables).toHaveLength(23);
  });
});

describe("planHistory", () => {
  test("deterministic per seed; a different seed changes content, not counts", () => {
    const again = planHistory(createRng(7).fork("history"), INPUT, NOW);
    expect(again).toEqual(H);
    const other = planHistory(createRng(8).fork("history"), INPUT, NOW);
    expect(other.broadcasts.length).toBe(H.broadcasts.length);
    expect(other.streamHours.length).toBe(H.streamHours.length);
    expect(other.broadcasts.map((b) => b.title)).not.toEqual(H.broadcasts.map((b) => b.title));
  });

  test("one broadcast per chat window: every window is covered exactly, none overlap per channel", () => {
    expect(H.broadcasts).toHaveLength(INPUT.windows.length);
    for (const w of INPUT.windows) {
      const covering = H.broadcasts.filter((b) => b.channelId === w.channelId && b.start <= w.start && b.end >= w.end);
      expect(covering).toHaveLength(1);
    }
    const byChannel = new Map<string, { start: number; end: number }[]>();
    for (const b of H.broadcasts)
      byChannel.set(b.channelId, [...(byChannel.get(b.channelId) ?? []), { start: +b.start, end: +b.end }]);
    for (const list of byChannel.values()) {
      list.sort((a, b) => a.start - b.start);
      for (let i = 1; i < list.length; i++) expect(list[i]?.start).toBeGreaterThan(list[i - 1]?.end ?? 0);
    }
  });

  test("no broadcast predates its window (so never its channel), and none is in the future", () => {
    const earliest = Math.min(...INPUT.windows.map((w) => +w.start));
    for (const b of H.broadcasts) {
      expect(+b.start).toBeGreaterThanOrEqual(earliest);
      expect(+b.end).toBeLessThan(+NOW);
    }
  });

  test("stream hours: one row per clock hour, summing to the broadcast's length; eligible iff another viewer", () => {
    for (const b of H.broadcasts) {
      const hours = H.streamHours.filter((s) => s.broadcast === b.index);
      const seconds = hours.reduce((n, s) => n + s.liveSeconds, 0);
      expect(Math.abs(seconds - (+b.end - +b.start) / 1000)).toBeLessThanOrEqual(hours.length);
      expect(new Set(hours.map((s) => +s.hourStart)).size).toBe(hours.length);
      for (const s of hours) {
        expect(+s.hourStart % HOUR_MS).toBe(0);
        expect(s.liveSeconds).toBeGreaterThan(0);
        expect(s.liveSeconds).toBeLessThanOrEqual(3600);
        expect(s.eligible).toBe(s.verifiedOtherViewers > 0);
      }
    }
  });

  test("every owner with an hour in the last 90 days has an eligible one with another viewer (seed-coop's members)", () => {
    const since = +NOW - MEMBER_HOURS_DAYS * DAY_MS;
    for (let seed = 1; seed <= 40; seed++) {
      const h = planHistory(createRng(seed).fork("history"), fixture(small, seed), NOW);
      const owners = new Set(h.broadcasts.map((b) => b.ownerHandle));
      for (const owner of owners) {
        const recent = h.streamHours.filter(
          (s) => h.broadcasts[s.broadcast]?.ownerHandle === owner && +s.hourStart >= since,
        );
        if (recent.length === 0) continue;
        expect(
          recent.some((s) => s.eligible && s.verifiedOtherViewers >= 1),
          `${owner} (seed ${seed})`,
        ).toBe(true);
      }
      for (const s of h.streamHours) {
        expect(s.eligible).toBe(s.verifiedOtherViewers > 0);
        expect(!s.eligible || (h.broadcasts[s.broadcast]?.peakVerifiedViewers ?? 0) >= 1).toBe(true);
      }
    }
  });

  test("a bulk streamer with one quiet window still gets a member hour", () => {
    // One short window each: without the guarantee, a broadcast with no other viewer has no eligible hour.
    const channels: SeededChannel[] = Array.from({ length: 30 }, (_, i) => ({
      id: `20000000-0000-7000-8000-${String(i).padStart(12, "0")}`,
      ownerId: `30000000-0000-7000-8000-${String(i).padStart(12, "0")}`,
      ownerHandle: bulkStreamerHandle(i + 1),
      slug: `demo_${bulkStreamerHandle(i + 1)}`,
    }));
    const windows = channels.map((c) => ({
      channelId: c.id,
      start: new Date(+NOW - 2 * DAY_MS - 30 * 60_000),
      end: new Date(+NOW - 2 * DAY_MS),
    }));
    const h = planHistory(createRng(11).fork("history"), { channels, windows, categoryIds: [] }, NOW);
    for (const c of channels) {
      const hours = h.streamHours.filter((s) => s.channelId === c.id);
      expect(
        hours.some((s) => s.eligible && s.verifiedOtherViewers >= 1),
        c.ownerHandle,
      ).toBe(true);
    }
    expect(h.broadcasts.every((b) => b.peakVerifiedViewers >= 1)).toBe(true);
  });

  test("health samples cover every state, all of them on streamer1's newest broadcast", () => {
    const seen = new Set(H.health.flatMap((s) => (s.warnings.length === 0 ? ["clean"] : s.warnings)));
    for (const c of HEALTH_WARNING_CODES) expect(seen).toContain(c);
    expect(seen).toContain("clean");
    const s1 = H.broadcasts.filter((b) => b.ownerHandle === "streamer1").at(-1);
    const states = new Set(
      H.health.filter((s) => s.broadcast === s1?.index).map((s) => (s.warnings.length ? s.warnings.join() : "")),
    );
    expect(states.size).toBe(HEALTH_STATES.length);
    // Each sample lies inside its broadcast; primary keys are unique.
    const keys = new Set(H.health.map((s) => `${s.broadcast}:${+s.at}`));
    expect(keys.size).toBe(H.health.length);
    for (const s of H.health) {
      const b = H.broadcasts[s.broadcast];
      expect(+s.at).toBeGreaterThanOrEqual(+(b?.start ?? 0));
      expect(+s.at).toBeLessThan(+(b?.end ?? 0));
    }
  });

  test("egress only inside the egress report's 31 days, every source present, unique keys", () => {
    expect(H.egress.length).toBeGreaterThan(0);
    const from = +NOW - EGRESS_DAYS * DAY_MS;
    for (const e of H.egress) {
      expect(+e.bucketStart).toBeGreaterThanOrEqual(from);
      expect(e.bytes).toBeGreaterThan(0);
      expect(Number.isSafeInteger(e.bytes)).toBe(true);
    }
    expect(new Set(H.egress.map((e) => e.source))).toEqual(new Set(["origin", "relay", "p2p", "cdn"]));
    expect(new Set(H.egress.map((e) => `${e.broadcast}:${+e.bucketStart}:${e.source}`)).size).toBe(H.egress.length);
  });

  test("streamer1 has a long history with health samples; streamer3 has none", () => {
    const s1 = H.broadcasts.filter((b) => b.ownerHandle === "streamer1");
    expect(s1.length).toBeGreaterThanOrEqual(20);
    expect(H.broadcasts.some((b) => b.ownerHandle === "streamer3")).toBe(false);
    for (const h of ["streamer1", "streamer2", "council1"]) {
      const ids = new Set(H.broadcasts.filter((b) => b.ownerHandle === h).map((b) => b.index));
      expect(
        H.health.some((s) => ids.has(s.broadcast)),
        h,
      ).toBe(true);
    }
  });

  test("zero bulk accounts and empty windows plan nothing extra", () => {
    const none = planHistory(createRng(1), { channels: INPUT.channels, windows: [], categoryIds: [] }, NOW);
    expect(historyCounts(none)).toEqual({
      broadcasts: 0,
      stream_hours: 0,
      broadcast_health_samples: 0,
      egress_samples: 0,
    });
    const fixedOnly = fixture({ ...small, streamers: 0 });
    const p = planHistory(createRng(1), fixedOnly, NOW);
    expect(p.broadcasts.every((b) => FIXED_STREAMERS.includes(b.ownerHandle))).toBe(true);
    expect(p.broadcasts[0]?.categoryId).not.toBeUndefined();
  });

  test("a window on an unknown channel fails loudly", () => {
    expect(() =>
      planHistory(
        createRng(1),
        { ...INPUT, windows: [{ channelId: "nope", start: NOW, end: new Date(+NOW + 1) }] },
        NOW,
      ),
    ).toThrow(/unknown channel/);
  });

  test("counts grow with the scale's windows (medium writes more than small)", () => {
    const medium = planHistory(createRng(7), fixture({ ...SEED_SCALES.medium, streamers: 30 }), NOW);
    expect(medium.broadcasts.length).toBeGreaterThan(H.broadcasts.length);
    expect(medium.streamHours.length).toBeGreaterThan(H.streamHours.length);
  });
});

describe("planRecordings", () => {
  test("deterministic per seed; a different seed changes content, not counts", () => {
    expect(planRecordings(createRng(7).fork("recordings"), small, bulk(small))).toEqual(R);
    const other = planRecordings(createRng(9).fork("recordings"), small, bulk(small));
    expect(other.recordings.length).toBe(R.recordings.length);
    expect(other.recordings.map((r) => r.chat.map((l) => l.body))).not.toEqual(
      R.recordings.map((r) => r.chat.map((l) => l.body)),
    );
  });

  test("at most 3 recordings at once", () => {
    expect(R.concurrency).toBe(RECORDING_CONCURRENCY);
    expect(maxConcurrency(R)).toBeLessThanOrEqual(3);
    const large = planRecordings(createRng(7), SEED_SCALES.large, bulk(SEED_SCALES.large));
    expect(maxConcurrency(large)).toBeLessThanOrEqual(3);
  });

  test("the fixed recorders and a few bulk streamers record; streamer3 exactly once", () => {
    const handles = R.recordings.map((r) => r.handle);
    for (const h of FIXED_RECORDERS) expect(handles.filter((x) => x === h)).toHaveLength(1);
    expect(handles.filter((h) => /^s\d+$/.test(h))).toHaveLength(bulkRecordings(small, small.streamers));
    expect(new Set(handles).size).toBe(handles.length);
  });

  test("bulk recordings: the recent-VOD channels plus the removed one at every scale; zero bulk streamers gives none", () => {
    for (const scale of [SEED_SCALES.small, SEED_SCALES.medium, SEED_SCALES.large])
      expect(bulkRecordings(scale, scale.streamers)).toBe(RECENT_VOD_CHANNELS + 1);
    expect(bulkRecordings(SEED_SCALES.large, 1)).toBe(1);
    const none = planRecordings(createRng(1), small, { bulkStreamers: [], bulkViewers: [] });
    expect(none.recordings.map((r) => r.handle)).toEqual([...FIXED_RECORDERS]);
    expect(none.recordings.every((r) => r.chat.length > 0)).toBe(true);
    expect(none.room.candidates).toEqual(["viewer2", "member1"]);
  });

  test("every recording window has planned chat inside it", () => {
    for (const r of R.recordings) {
      expect(r.chat.length, r.handle).toBeGreaterThanOrEqual(4);
      for (const l of r.chat) {
        expect(l.atMs).toBeGreaterThan(0);
        expect(l.atMs).toBeLessThan(r.seconds * 1000);
        expect(l.body.length).toBeGreaterThan(0);
      }
      expect(r.seconds).toBeGreaterThanOrEqual(20);
    }
  });

  test("captions, rehearsal, swarm and watch room fit inside the recording plan, once each", () => {
    const one = <K extends keyof (typeof R.recordings)[number]>(k: K) =>
      R.recordings.filter((r) => Boolean(r[k]) && (typeof r[k] !== "number" || (r[k] as number) > 0));
    expect(one("speech").map((r) => r.handle)).toEqual(["streamer1"]);
    expect(one("swarm").map((r) => r.handle)).toEqual(["streamer1"]);
    expect(one("watchRoom").map((r) => r.handle)).toEqual(["streamer1"]);
    expect(one("simulcast").map((r) => r.handle)).toEqual(["streamer1"]);
    expect(one("rehearsal").map((r) => r.handle)).toEqual(["streamer2"]);
    expect(one("makePrivate")).toHaveLength(1);
    expect(one("makePrivate")[0]?.handle).not.toBe("streamer1");
    expect(R.recordings.flatMap((r) => r.clips).filter((c) => c.remove)).toHaveLength(1);
    expect(R.recordings[R.room.recording]?.watchRoom).toBe(true);
    expect(R.recordings[R.rehearsal.recording]?.rehearsal).toBe(true);
    expect(R.rehearsal).toMatchObject({ owner: "streamer2", invitee: "chanmod" });
    expect(R.room.host).toBe("viewer1");
    expect(R.room.candidates[0]).toBe("viewer2");
    expect(R.room.candidates.length).toBeGreaterThan(R.room.guests);
    expect(R.recordings.find((r) => r.swarm > 0)?.swarm).toBe(SWARM_SESSIONS);
    // The watch-page VOD is streamer1's public one, with a clip that is not removed.
    const watch = R.recordings.filter((r) => r.watchPage);
    expect(watch.map((r) => r.handle)).toEqual(["streamer1"]);
    expect(watch[0]?.clips.some((c) => !c.remove)).toBe(true);
  });

  test("one bulk recording removes its VOD mid-stream; it has no clips and is none of the special VODs", () => {
    const purged = R.recordings.filter((r) => r.removeMidStream);
    expect(purged).toHaveLength(1);
    const p = purged[0];
    expect(p?.handle).toMatch(/^s\d+$/);
    expect(p?.clips).toEqual([]);
    expect(p?.watchPage || p?.makePrivate || p?.speech || p?.rehearsal).toBe(false);
    const none = planRecordings(createRng(7).fork("recordings"), small, { bulkStreamers: [], bulkViewers: [] });
    expect(none.recordings.filter((r) => r.removeMidStream)).toEqual([]);
  });

  test("at least six channels outside seed live's default set end with a public VOD, at every scale", () => {
    const live = LIVE_FIXED_ORDER.slice(0, DEFAULT_LIVE_CHANNELS);
    for (const scale of [SEED_SCALES.small, SEED_SCALES.medium, SEED_SCALES.large]) {
      const plan = planRecordings(createRng(7).fork("recordings"), scale, bulk(scale));
      const recent = recentVodChannels(plan, live);
      expect(recent.length, `${scale.streamers} streamers`).toBeGreaterThanOrEqual(RECENT_VOD_CHANNELS);
      expect(new Set(recent).size).toBe(recent.length);
      for (const h of live) expect(recent).not.toContain(h);
    }
  });

  test("clips fit inside their recording", () => {
    for (const r of R.recordings)
      for (const c of r.clips) {
        expect(c.durationSeconds).toBeGreaterThanOrEqual(5);
        expect(c.startOffset + c.durationSeconds).toBeLessThanOrEqual(r.seconds);
      }
  });
});

describe("store.extra.media", () => {
  const outcome = (handle: string, i: number, extra: Partial<RecordedOutcome> = {}): RecordedOutcome => ({
    handle,
    channelId: `ch-${handle}`,
    broadcastId: `b-${i}`,
    start: new Date(+NOW + i),
    end: new Date(+NOW + i + 30_000),
    vodId: `v-${i}`,
    clipIds: [`c-${i}`],
    private: false,
    ...extra,
  });

  test("recordedBroadcasts and recordedWindow cover every recording; vodId/clipId are streamer1's", () => {
    const results = R.recordings.map((r, i) =>
      outcome(
        r.handle,
        i,
        r.removeMidStream ? { vodId: null, clipIds: [], private: false } : { private: r.makePrivate },
      ),
    );
    const extra = buildMediaExtra(results);
    expect(extra.recordedBroadcasts).toHaveLength(R.recordings.length);
    expect(extra.recordedWindow).toHaveLength(R.recordings.length);
    expect(new Set(extra.recordedBroadcasts.map((b) => b.broadcastId)).size).toBe(R.recordings.length);
    const s1 = results.find((r) => r.handle === "streamer1");
    expect(extra.vodId).toBe(s1?.vodId);
    expect(extra.clipId).toBe(s1?.clipIds[0]);
    // The VOD removed mid-stream is not listed (seed-safety files DMCA against listed VODs).
    const removed = R.recordings.filter((r) => r.removeMidStream).length;
    expect(removed).toBe(1);
    expect(Object.values(extra.vodsByChannel).flat()).toHaveLength(R.recordings.length - removed);
    expect(Object.values(extra.vodsByChannel).flat()).not.toContain(null);
    expect(Object.values(extra.vodsByChannel).every((v) => v.length > 0)).toBe(true);
  });

  test("refuses without streamer1's public VOD and clip", () => {
    expect(() => buildMediaExtra([outcome("streamer2", 1)])).toThrow(/streamer1/);
    expect(() => buildMediaExtra([outcome("streamer1", 1, { clipIds: [] })])).toThrow(/streamer1/);
  });
});

describe("peers", () => {
  test("the RTMP sink listens once on the given port and discards the stream", () => {
    const args = sinkArgs(19350);
    expect(args.slice(0, 1)).toEqual(["ffmpeg"]);
    expect(args).toContain("-listen");
    expect(args).toContain(`rtmp://0.0.0.0:19350/live/${SINK_STREAM_KEY}`);
    expect(args.slice(-3)).toEqual(["-f", "null", "-"]);
  });

  const lan = {
    lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    eth0: [{ address: "192.168.1.20", family: "IPv4", internal: false }],
  } as unknown as Parameters<typeof seedRelayHost>[1];

  test("the relay advertises HARNESS_RELAY_HOST when set (seed mode: the harness container on the instance's network)", () => {
    expect(seedRelayHost({ HARNESS_RELAY_HOST: "seed-harness" }, lan)).toBe("seed-harness");
    expect(
      relayArgv({
        binary: "r",
        api: "http://api:3001",
        host: seedRelayHost({ HARNESS_RELAY_HOST: "seed-harness" }, lan),
        port: 4100,
        dataDir: "/d",
      }),
    ).toContain("http://seed-harness:4100");
  });

  test("without it, the LAN address (a harness on the host of a local stack)", () => {
    expect(seedRelayHost({ HARNESS_RELAY_HOST: undefined }, lan)).toBe("192.168.1.20");
    expect(() => seedRelayHost({ HARNESS_RELAY_HOST: undefined }, { lo: lan?.lo })).toThrow(/no LAN IPv4/);
  });

  test("the harness env reads HARNESS_RELAY_HOST, empty meaning unset", () => {
    expect(loadHarnessEnv({ HARNESS_RELAY_HOST: "seed-harness" }).HARNESS_RELAY_HOST).toBe("seed-harness");
    expect(loadHarnessEnv({ HARNESS_RELAY_HOST: " " }).HARNESS_RELAY_HOST).toBeUndefined();
    expect(loadHarnessEnv({}).HARNESS_RELAY_HOST).toBeUndefined();
  });
});
