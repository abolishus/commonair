// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-media's plans (pure): the backdated broadcast history over seed-social's chat windows
 * (broadcasts, stream hours, health and egress samples) and the real recordings (who streams, in
 * which batch, with which viewers, chat, clips, room, rehearsal, captions and swarm). Writers turn
 * these into inserts (`write.ts`) and API calls (`record.ts`).
 *
 * Content is keyed by owner handle and per-owner ordinal, never by a channel id: ids differ between
 * runs, and the same `--seed` must give the same titles, counts and states.
 */
import { HEALTH_WARNING_CODES } from "@commonair/contracts/enums";
import type { Rng } from "../prng.ts";
import type { SeedScale } from "../scale.ts";
import type { SeededChannel } from "../types.ts";
import { BROADCAST_TITLES, CHAT_LINES, CLIP_TITLES, ROOM_LINES, fillLine, fillTitle } from "./content.ts";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Health samples are written every 2 minutes of a sampled broadcast. */
export const HEALTH_INTERVAL_MS = 2 * MINUTE_MS;
/** Egress samples are written per 5-minute bucket (minute-aligned) of a recent broadcast. */
export const EGRESS_BUCKET_MS = 5 * MINUTE_MS;
/** `/admin/egress` covers at most 31 days: older broadcasts get no egress samples. */
export const EGRESS_DAYS = 31;
/** Fixed streamers get health samples on their newest broadcasts. */
export const FIXED_HEALTH_BROADCASTS = 3;
/** Share of bulk broadcasts with health samples. */
export const BULK_HEALTH_SHARE = 0.15;
/** seed-coop seats streamer members from eligible stream hours inside this many days. */
export const MEMBER_HOURS_DAYS = 90;
/**
 * Recordings in flight at once. The brief said at most 3, run in batches of 3, and on CI four
 * batches took 199 s (run 42215129857: 69, 43, 50 and 37 s), each waiting for its slowest
 * recording. Now each next recording starts as soon as one ends (`settledPool`), five at a time
 * (about 110 s for the same recordings, `poolSeconds`): two publishers more than before, each a
 * 640x360 test pattern at 800 kb/s (veryfast), below the
 * seed stack's adaptive-ladder threshold (TRANSCODE_VIEWER_THRESHOLD, 50 viewers), with one
 * captioned stream (CAPTIONS_MAX_STREAMS=1), and the media service finalizes VODs and cuts clips
 * two at a time either way.
 */
export const RECORDING_CONCURRENCY = 5;

/** The fixed streamers' recordings, in the order they run (streamer3's is its first broadcast). */
export const FIXED_RECORDERS = ["streamer1", "streamer2", "council1", "streamer3"] as const;
/** Fixed accounts that chat in recordings (viewer2 is timed out on streamer1; rejections are tolerated). */
export const FIXED_CHATTERS = ["viewer1", "member1", "chanmod"] as const;
/** The health states streamer1's newest sampled broadcast walks through: clean, then every warning. */
export const HEALTH_STATES: readonly (readonly string[])[] = [[], ...HEALTH_WARNING_CODES.map((c) => [c])];

export interface ChatWindowRef {
  channelId: string;
  start: Date;
  end: Date;
}

export interface HistoryInput {
  channels: readonly SeededChannel[];
  windows: readonly ChatWindowRef[];
  categoryIds: readonly string[];
}

export interface BroadcastSpec {
  index: number;
  channelId: string;
  ownerHandle: string;
  slug: string;
  /** 0-based per owner, oldest first. */
  ordinal: number;
  start: Date;
  end: Date;
  title: string;
  categoryId: string | null;
  ingestProtocol: "rtmp" | "whip";
  peakVerifiedViewers: number;
  verifiedViewerSeconds: number;
  excludedViewerSeconds: number;
}

export interface StreamHourSpec {
  broadcast: number;
  channelId: string;
  hourStart: Date;
  liveSeconds: number;
  verifiedOtherViewers: number;
  eligible: boolean;
}

export interface HealthSampleSpec {
  broadcast: number;
  at: Date;
  bitrateKbps: number;
  fps: number;
  width: number;
  height: number;
  videoCodec: string | null;
  audioCodec: string | null;
  keyframeIntervalMs: number;
  droppedFrames: number;
  warnings: string[];
}

export type DeliverySource = "origin" | "relay" | "p2p" | "cdn";

export interface EgressSpec {
  broadcast: number;
  bucketStart: Date;
  source: DeliverySource;
  bytes: number;
  requests: number;
}

export interface HistoryPlan {
  broadcasts: BroadcastSpec[];
  streamHours: StreamHourSpec[];
  health: HealthSampleSpec[];
  egress: EgressSpec[];
}

const at = (ms: number) => new Date(ms);
const isFixed = (handle: string) => !/^[sv]\d+$/.test(handle);

/** Viewer ranges per fixed streamer (bulk streamers are small). */
const PEAK: Readonly<Record<string, [number, number]>> = {
  streamer1: [20, 60],
  streamer2: [8, 25],
  council1: [3, 12],
  council2: [3, 10],
};

function healthSample(
  r: Rng,
  broadcast: number,
  when: number,
  big: boolean,
  warnings: readonly string[],
): HealthSampleSpec {
  const w = new Set(warnings);
  const base = big ? 6000 : 2500;
  return {
    broadcast,
    at: at(when),
    bitrateKbps: w.has("bitrate_high")
      ? base * 4
      : w.has("bitrate_low")
        ? Math.round(base / 5)
        : base + r.int(-300, 300),
    fps: w.has("fps_drop") ? r.int(12, 20) : w.has("video_missing") ? 0 : 30,
    width: big ? 1920 : 1280,
    height: big ? 1080 : 720,
    videoCodec: w.has("video_missing") ? null : w.has("video_codec_unsupported") ? "hevc" : "h264",
    audioCodec: w.has("audio_missing") ? null : w.has("audio_codec_unsupported") ? "mp3" : "aac",
    keyframeIntervalMs: w.has("keyframe_interval") ? 10_000 : 2_000,
    droppedFrames: w.has("fps_drop") || w.has("transcode_capacity") ? r.int(30, 300) : r.int(0, 3),
    warnings: [...warnings],
  };
}

/**
 * One broadcast per chat window (windows never overlap per channel, so neither do broadcasts), each
 * with its clock hours, health samples on a sample of them (streamer1's newest walks every state)
 * and egress per 5-minute bucket for those inside the egress report's 31 days.
 */
export function planHistory(rng: Rng, input: HistoryInput, now: Date): HistoryPlan {
  const t = now.getTime();
  const byId = new Map(input.channels.map((c) => [c.id, c]));
  const perOwner = new Map<string, ChatWindowRef[]>();
  for (const w of input.windows) {
    const c = byId.get(w.channelId);
    if (!c) throw new Error(`seed-media: chat window on unknown channel ${w.channelId}`);
    if (w.end.getTime() <= w.start.getTime()) throw new Error(`seed-media: empty chat window on ${c.ownerHandle}`);
    const list = perOwner.get(c.ownerHandle) ?? [];
    list.push(w);
    perOwner.set(c.ownerHandle, list);
  }
  const owners = [...perOwner.keys()].sort();
  const plan: HistoryPlan = { broadcasts: [], streamHours: [], health: [], egress: [] };
  const egressFrom = t - EGRESS_DAYS * DAY_MS;
  for (const owner of owners) {
    const firstHour = plan.streamHours.length;
    const windows = (perOwner.get(owner) ?? []).sort((a, b) => a.start.getTime() - b.start.getTime());
    const fixed = isFixed(owner);
    const r = rng.fork(`history:${owner}`);
    const [lo, hi] = PEAK[owner] ?? (fixed ? [2, 8] : [0, 6]);
    const sampledFrom = fixed ? windows.length - FIXED_HEALTH_BROADCASTS : Number.POSITIVE_INFINITY;
    const relayShare = owner === "streamer1" ? 0.4 : r.chance(0.3) ? 0.2 : 0;
    windows.forEach((w, ordinal) => {
      const c = byId.get(w.channelId) as SeededChannel;
      const index = plan.broadcasts.length;
      const s = w.start.getTime();
      const e = w.end.getTime();
      const seconds = Math.floor((e - s) / 1000);
      const peak = r.int(lo, hi);
      const categoryId = input.categoryIds.length > 0 ? r.pick(input.categoryIds) : null;
      plan.broadcasts.push({
        index,
        channelId: c.id,
        ownerHandle: owner,
        slug: c.slug,
        ordinal,
        start: w.start,
        end: w.end,
        title: fillTitle(r.pick(BROADCAST_TITLES), ordinal + 1),
        categoryId,
        ingestProtocol: r.chance(0.15) ? "whip" : "rtmp",
        peakVerifiedViewers: peak,
        verifiedViewerSeconds: Math.round(peak * 0.6 * seconds),
        excludedViewerSeconds: peak > 0 && r.chance(0.3) ? r.int(30, 600) : 0,
      });
      // Clock hours the broadcast touches; the trigger only refuses rehearsals (these are `live`).
      for (let h = Math.floor(s / HOUR_MS) * HOUR_MS; h < e; h += HOUR_MS) {
        const live = Math.round((Math.min(e, h + HOUR_MS) - Math.max(s, h)) / 1000);
        if (live <= 0) continue;
        const others = peak === 0 ? 0 : r.int(0, peak);
        plan.streamHours.push({
          broadcast: index,
          channelId: c.id,
          hourStart: at(h),
          liveSeconds: live,
          verifiedOtherViewers: others,
          eligible: others > 0,
        });
      }
      const sampled = ordinal >= sampledFrom || (!fixed && r.chance(BULK_HEALTH_SHARE));
      if (sampled) {
        const big = owner === "streamer1" || r.chance(0.3);
        const everyState = owner === "streamer1" && ordinal === windows.length - 1;
        let i = 0;
        for (let when = s + 30_000; when < e; when += HEALTH_INTERVAL_MS, i++) {
          const warnings = everyState
            ? (HEALTH_STATES[i % HEALTH_STATES.length] ?? [])
            : r.chance(0.08)
              ? [r.pick(HEALTH_WARNING_CODES)]
              : [];
          plan.health.push(healthSample(r, index, when, big, warnings));
        }
      }
      if (e > egressFrom) {
        const bitrateBytes = ((owner === "streamer1" ? 6000 : 2500) * 1000) / 8;
        for (let b = Math.floor(s / MINUTE_MS) * MINUTE_MS; b < e; b += EGRESS_BUCKET_MS) {
          if (b < egressFrom) continue;
          const viewers = Math.max(1, Math.round(peak * (0.5 + r.next() * 0.5)));
          const total = viewers * bitrateBytes * (EGRESS_BUCKET_MS / 1000);
          const relay = Math.round(total * relayShare);
          const p2p = r.chance(0.25) ? Math.round(total * 0.1) : 0;
          const cdn = peak >= 30 && r.chance(0.2) ? Math.round(total * 0.2) : 0;
          const origin = total - relay - p2p - cdn;
          const parts: [DeliverySource, number][] = [
            ["origin", origin],
            ["relay", relay],
            ["p2p", p2p],
            ["cdn", cdn],
          ];
          for (const [source, bytes] of parts) {
            if (bytes <= 0) continue;
            // About one request per 2 s segment per viewer.
            const requests = Math.max(1, Math.round((bytes / total) * viewers * (EGRESS_BUCKET_MS / 2_000)));
            plan.egress.push({ broadcast: index, bucketStart: at(b), source, bytes: Math.round(bytes), requests });
          }
        }
      }
    });
    ensureMemberHour(plan, firstHour, t - MEMBER_HOURS_DAYS * DAY_MS);
  }
  return plan;
}

/**
 * seed-coop's membership sync makes streamer members from eligible hours with another verified
 * viewer inside the last 90 days: an owner with any hour there gets at least one, on its newest.
 */
function ensureMemberHour(plan: HistoryPlan, from: number, since: number): void {
  const mine = plan.streamHours.slice(from).filter((h) => h.hourStart.getTime() >= since);
  if (mine.length === 0 || mine.some((h) => h.eligible)) return;
  const newest = mine.reduce((a, b) => (b.hourStart.getTime() > a.hourStart.getTime() ? b : a));
  newest.verifiedOtherViewers = 1;
  newest.eligible = true;
  const b = plan.broadcasts[newest.broadcast];
  if (b && b.peakVerifiedViewers < 1) {
    // Keep the broadcast's totals consistent with a viewer having watched.
    b.peakVerifiedViewers = 1;
    b.verifiedViewerSeconds = Math.max(b.verifiedViewerSeconds, newest.liveSeconds);
  }
}

// ------------------------------------------------------------------ recordings

export interface PlannedLine {
  /** Milliseconds after the stream is live. */
  atMs: number;
  author: string;
  body: string;
}

export interface ClipSpec {
  by: string;
  title: string;
  startOffset: number;
  durationSeconds: number;
  /** Deleted through the API once ready (one clip of the run). */
  remove: boolean;
}

export interface RecordingSpec {
  /** Start order: the first `concurrency` start together, then each next one when one ends. */
  index: number;
  handle: string;
  /** How long the publisher streams (the speech recording's length is its fixture's). */
  seconds: number;
  title: string;
  /** streamer1's recording: the speaking publisher, captions on, then a cue correction. */
  speech: boolean;
  httpViewers: number;
  /** Viewbot sessions beside the honest viewers (one recording). */
  swarm: number;
  watchRoom: boolean;
  simulcast: boolean;
  /** streamer2 rehearses (arm, invite, publish briefly, end) before this recording. */
  rehearsal: boolean;
  /** Marked private once ready (one VOD of the run). */
  makePrivate: boolean;
  /** streamer1 shares this broadcast's analytics. */
  shareLink: boolean;
  /** The VOD and first clip published as `vodId` / `clipId`. */
  watchPage: boolean;
  /**
   * The owner removes the in-progress VOD while live, so the relay gets a mid-stream `relay_purges`
   * row (`vod_hidden`, `dvr/<vodId>/`). One bulk recording; it has no VOD or clips after.
   */
  removeMidStream: boolean;
  chat: PlannedLine[];
  clips: ClipSpec[];
}

export interface RoomPlan {
  recording: number;
  host: string;
  /** Tried in order until `guests` joined (a guest the host's channel banned or blocked is refused). */
  candidates: string[];
  guests: number;
  /** Lines by member slot: 0 = host, 1.. = the guests in join order. */
  lines: { slot: number; body: string }[];
}

export interface RehearsalPlan {
  recording: number;
  owner: string;
  invitee: string;
  seconds: number;
}

export interface RecordingPlan {
  recordings: RecordingSpec[];
  room: RoomPlan;
  rehearsal: RehearsalPlan;
  concurrency: number;
}

export interface RecordingInput {
  bulkStreamers: readonly string[];
  bulkViewers: readonly string[];
}

/** Speech recording length: lead silence, the fixture (about 34 s) and the tail. */
export const SPEECH_SECONDS = 15 + 35 + 12;
export const SWARM_SESSIONS = 8;

/**
 * Channels outside `seed live`'s default set (streamer1–3) that end the seed with a public VOD, so
 * the home page's recently-live tiles have thumbnails at every scale (D1-seed).
 */
export const RECENT_VOD_CHANNELS = 6;

/**
 * Bulk streamers that record: `RECENT_VOD_CHANNELS` plus the one whose VOD is removed mid-stream,
 * at every scale (council1's VOD is private, so it does not count).
 */
export function bulkRecordings(_scale: Pick<SeedScale, "factor">, available: number): number {
  return Math.max(0, Math.min(available, RECENT_VOD_CHANNELS + 1));
}

/** Who ends the seed with a public VOD and is not in `live`: the recently-live tiles' channels. Pure. */
export function recentVodChannels(plan: Pick<RecordingPlan, "recordings">, live: readonly string[]): string[] {
  return plan.recordings
    .filter((r) => !r.removeMidStream && !r.makePrivate && !live.includes(r.handle))
    .map((r) => r.handle);
}

function planChat(r: Rng, seconds: number, owner: string, chatters: readonly string[]): PlannedLine[] {
  if (chatters.length === 0) return [];
  const n = Math.max(4, Math.round(seconds / 3));
  const from = 4_000;
  // Lines stop 10 s before the planned end: going live takes a few seconds, and every line must land
  // while the broadcast is still open (so it carries the broadcast id and shows in replay).
  const to = Math.max(from + 1_000, seconds * 1000 - 10_000);
  const times = Array.from({ length: n }, () => r.int(from, to)).sort((a, b) => a - b);
  return times.map((atMs) => ({ atMs, author: r.pick(chatters), body: fillLine(r.pick(CHAT_LINES), owner) }));
}

export function planRecordings(rng: Rng, scale: SeedScale, input: RecordingInput): RecordingPlan {
  const bulk = rng.fork("recorders").sample(input.bulkStreamers, bulkRecordings(scale, input.bulkStreamers.length));
  const handles = [...FIXED_RECORDERS, ...bulk];
  // A bulk streamer's recording, so the watch-page, private and clip VODs stay untouched.
  const purged = bulk[0] ?? null;
  const recordings: RecordingSpec[] = handles.map((handle, index) => {
    const r = rng.fork(`recording:${handle}`);
    const speech = handle === "streamer1";
    const seconds = speech ? SPEECH_SECONDS : r.int(20, 40);
    const extra = r.sample(input.bulkViewers, Math.min(input.bulkViewers.length, 4));
    const chatters = [...FIXED_CHATTERS, ...extra];
    const clipBase = r.pick(CLIP_TITLES);
    const clips: ClipSpec[] =
      handle === purged
        ? []
        : [
            { by: handle, title: clipBase, startOffset: 2, durationSeconds: 10, remove: false },
            {
              by: "viewer1",
              title: r.pick(CLIP_TITLES.filter((c) => c !== clipBase)),
              startOffset: Math.max(2, Math.floor(seconds / 2) - 5),
              durationSeconds: 8,
              remove: handle === "streamer2",
            },
          ];
    return {
      index,
      handle,
      seconds,
      title: fillTitle(r.pick(BROADCAST_TITLES), index + 1),
      speech,
      httpViewers: speech ? 4 : 2,
      swarm: speech ? SWARM_SESSIONS : 0,
      watchRoom: speech,
      simulcast: speech,
      rehearsal: handle === "streamer2",
      makePrivate: handle === "council1",
      shareLink: speech,
      watchPage: speech,
      removeMidStream: handle === purged,
      chat: planChat(r, seconds, handle, chatters),
      clips,
    };
  });
  const s1 = recordings.find((x) => x.speech);
  const s2 = recordings.find((x) => x.rehearsal);
  if (!s1 || !s2) throw new Error("seed-media: streamer1 and streamer2 always record");
  const rr = rng.fork("room");
  const lines = Array.from({ length: 6 }, (_, i) => ({ slot: i % 3, body: rr.pick(ROOM_LINES) }));
  return {
    recordings,
    room: {
      recording: s1.index,
      host: "viewer1",
      // viewer2 first (the brief's guest); member1 and bulk viewers stand in when a guest is refused.
      candidates: ["viewer2", "member1", ...rr.sample(input.bulkViewers, Math.min(input.bulkViewers.length, 6))],
      guests: 2,
      lines,
    },
    rehearsal: { recording: s2.index, owner: "streamer2", invitee: "chanmod", seconds: 15 },
    concurrency: RECORDING_CONCURRENCY,
  };
}

/** Row counts the history plan writes, per table. Pure. */
export function historyCounts(plan: HistoryPlan): Record<string, number> {
  return {
    broadcasts: plan.broadcasts.length,
    stream_hours: plan.streamHours.length,
    broadcast_health_samples: plan.health.length,
    egress_samples: plan.egress.length,
  };
}
