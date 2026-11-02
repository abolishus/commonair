// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-media's real recordings, through the product only: each planned streamer publishes a short
 * test pattern (streamer1 the speaking publisher, for captions), HTTP viewers watch it (playback
 * sessions), harness chat clients say the planned lines (chat replay), the VOD is recorded, the
 * rollup runs through the `OPS_TEST_HOOKS` analytics tick, and clips are cut through the API.
 * streamer1's recording also carries the viewbot swarm, the watch room, the simulcast push to a
 * local sink and the share link; streamer2 rehearses first. Every protected row (vods, clips,
 * rooms, rehearsal invitees, rollups, caption edits) is written by the services.
 */
import { INTERNAL_ROUTES, INTERNAL_SECRET_HEADER } from "@commonair/contracts/internal";
import type { DbHandle } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import { ChatClient } from "../../chat-client.ts";
import type { HarnessEnv } from "../../env.ts";
import type { Platform } from "../../platform.ts";
import { type MediaBucketConfig, internalSecret, listMediaKeys } from "../../safety-io.ts";
import { Streamer, rtmpPublishUrl } from "../../streamer.ts";
import type { SignedInUser } from "../../users.ts";
import { ViewbotSwarm } from "../../viewbot.ts";
import type { Viewer } from "../../viewer.ts";
import { sleep, waitFor } from "../../wait.ts";
import { startSpeechStream } from "../../w2/captions/publisher.ts";
import type { SeedStore } from "../types.ts";
import { CAPTION_CORRECTION } from "./content.ts";
import type { PlannedLine, RecordingPlan, RecordingSpec, RoomPlan } from "./plan.ts";

const LIVE_TIMEOUT_MS = 60_000;
const OFFLINE_TIMEOUT_MS = 60_000;
const VOD_READY_TIMEOUT_MS = 5 * 60_000;
const CLIP_READY_TIMEOUT_MS = 3 * 60_000;
const CAPTIONS_TIMEOUT_MS = 4 * 60_000;
const REHEARSAL_TIMEOUT_MS = 60_000;
const HOOK_TIMEOUT_MS = 90_000;

/** Signs each seeded account in once (through the forwarding proxy, one address each) and keeps it. */
export class MediaSessions {
  private readonly cache = new Map<string, Promise<SignedInUser>>();

  constructor(
    private readonly platform: Pick<Platform, "users">,
    private readonly store: SeedStore,
    private readonly password: string,
  ) {}

  as(handle: string): Promise<SignedInUser> {
    let p = this.cache.get(handle);
    if (!p) {
      const u = this.store.users.find((x) => x.handle === handle);
      if (!u) throw new Error(`seed-media: no seeded user "${handle}"`);
      p = this.platform.users
        .signIn({
          username: u.username,
          displayName: u.username,
          email: u.email,
          password: this.password,
          birthDate: "",
        })
        .catch((err: unknown) => {
          throw new Error(`seed-media: sign-in as ${handle} failed: ${String(err)}`);
        });
      this.cache.set(handle, p);
    }
    return p;
  }

  get signedIn(): number {
    return this.cache.size;
  }
}

export interface RecordDeps {
  platform: Platform;
  sessions: MediaSessions;
  store: SeedStore;
  env: HarnessEnv;
  db: DbHandle;
  log: Logger;
  signal: AbortSignal;
  /** The speech fixture (streamer1's captions recording). */
  audioPath: string;
  /** The local RTMP sink streamer1's simulcast target points at (null: no simulcast). */
  sink: { rtmpUrl: string; streamKey: string } | null;
  bucket: MediaBucketConfig | null;
  notes: string[];
}

export interface RecordingResult {
  handle: string;
  channelId: string;
  broadcastId: string;
  start: Date;
  end: Date;
  vodId: string;
  /** Clips that remain (the removed one is not listed). */
  clipIds: string[];
  removedClipId: string | null;
  private: boolean;
  chatSent: number;
  roomMessages: number;
}

const step = async <T>(who: string, what: string, f: () => Promise<T>, signal: AbortSignal): Promise<T> => {
  signal.throwIfAborted();
  try {
    return await f();
  } catch (err) {
    if (signal.aborted) throw err;
    throw new Error(`seed-media: ${what} as ${who} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};

/** POST/PUT an `OPS_TEST_HOOKS` route. */
export async function opsHook(
  env: HarnessEnv,
  path: string,
  method: "POST" | "PUT",
  body: unknown,
  signal: AbortSignal,
): Promise<Response> {
  const secret = internalSecret(env);
  if (!secret) throw new Error("seed-media: INTERNAL_API_SECRET is not set (the analytics test hooks need it)");
  const res = await fetch(new URL(path, env.HARNESS_API_URL), {
    method,
    headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: secret },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(HOOK_TIMEOUT_MS)]),
  });
  if (res.status === 404) throw new Error(`seed-media: ${path} answered 404: set OPS_TEST_HOOKS=true on the api`);
  if (!res.ok) throw new Error(`seed-media: ${path} answered HTTP ${res.status}`);
  return res;
}

function channelOf(store: SeedStore, handle: string): { id: string; slug: string } {
  const c = store.channels.find((x) => x.ownerHandle === handle);
  if (!c) throw new Error(`seed-media: ${handle} has no seeded channel`);
  return { id: c.id, slug: c.slug };
}

async function liveBroadcastId(db: DbHandle, channelId: string): Promise<string> {
  const rows = await db.sql<{ id: string }[]>`
    select id from broadcasts
     where channel_id = ${channelId} and kind = 'live' and ended_at is null
     order by started_at desc limit 1`;
  const id = rows[0]?.id;
  if (!id) throw new Error("no open live broadcast");
  return id;
}

/** Connect one chat client per author (signed in), join the channel, say the lines on time. */
async function sayLines(
  d: RecordDeps,
  channel: string,
  lines: readonly PlannedLine[],
  liveAt: number,
): Promise<number> {
  const authors = [...new Set(lines.map((l) => l.author))];
  const clients = new Map<string, ChatClient>();
  try {
    for (const a of authors) {
      const u = await d.sessions.as(a);
      const c = await ChatClient.connectWithApi(u.api.client, d.log);
      clients.set(a, c);
      await c.join(channel);
    }
    let sent = 0;
    for (const l of lines) {
      const wait = liveAt + l.atMs - Date.now();
      if (wait > 0) await sleep(wait, d.signal);
      const c = clients.get(l.author);
      if (!c?.isOpen) continue;
      // A line the channel refuses (a timeout, followers-only) is skipped: the rest still land.
      const ack = await c.send(channel, l.body).catch(() => null);
      if (ack?.id) sent++;
    }
    return sent;
  } finally {
    for (const c of clients.values()) c.close();
  }
}

/** viewer1 opens a room on the live broadcast, two guests join, they talk, the host closes it. */
async function watchRoom(d: RecordDeps, channel: string, room: RoomPlan): Promise<number> {
  const host = await d.sessions.as(room.host);
  const created = await step(
    room.host,
    "open a watch room",
    () => host.api.client.watchRooms.create({ channel }),
    d.signal,
  );
  const nonce = created.invite.nonce;
  const members: { user: SignedInUser; token: string }[] = [];
  const hostJoin = await step(
    room.host,
    "join the room it hosts",
    () => host.api.client.watchRooms.join({ id: created.id, nonce }),
    d.signal,
  );
  members.push({ user: host, token: hostJoin.chatToken });
  for (const c of room.candidates) {
    if (members.length > room.guests) break;
    const u = await d.sessions.as(c);
    try {
      const j = await u.api.client.watchRooms.join({ id: created.id, nonce });
      members.push({ user: u, token: j.chatToken });
    } catch (err) {
      d.notes.push(
        `seed-media: ${c} was refused from viewer1's watch room (${err instanceof Error ? err.message : String(err)}); the next candidate joined instead`,
      );
    }
  }
  if (members.length <= room.guests)
    throw new Error(`seed-media: only ${members.length - 1} of ${room.guests} watch-room guests could join`);
  const clients: ChatClient[] = [];
  let said = 0;
  try {
    for (const m of members) {
      const c = await ChatClient.connectWithApi(m.user.api.client, d.log);
      clients.push(c);
      const state = c.next("room.state", (f) => f.roomId === created.id, 15_000);
      c.raw({ op: "room.join", roomId: created.id, token: m.token, nonce: `j${clients.length}` });
      await state;
    }
    for (const [i, l] of room.lines.entries()) {
      const c = clients[l.slot % clients.length];
      if (!c?.isOpen) continue;
      const echo = c.next("room.message", (f) => f.roomId === created.id && f.message.body === l.body, 10_000);
      c.raw({ op: "room.send", roomId: created.id, body: l.body, nonce: `r${i}` });
      if (await echo.then(() => true).catch(() => false)) said++;
      await sleep(1_500, d.signal);
    }
  } finally {
    for (const c of clients) c.close();
  }
  await step(room.host, "close the watch room", () => host.api.client.watchRooms.close({ id: created.id }), d.signal);
  return said;
}

/** streamer2 arms a rehearsal, invites chanmod, publishes briefly and ends it; `/rehearse` is idle after. */
export async function rehearse(d: RecordDeps, owner: string, invitee: string, seconds: number): Promise<void> {
  const u = await d.sessions.as(owner);
  const guest = await d.sessions.as(invitee);
  const { slug: channel } = channelOf(d.store, owner);
  const r = u.api.client.stream.rehearsal;
  await step(owner, "arm a rehearsal", () => r.arm({ channel }), d.signal);
  try {
    await r.invite({ channel, username: guest.username });
  } catch {
    // Invitees must follow the channel: chanmod follows streamer2 first (an API follow), then is invited.
    await step(
      invitee,
      `follow ${owner} to be invited`,
      () => guest.api.client.channels.follow({ channel, notify: false }),
      d.signal,
    );
    await step(owner, `invite ${invitee}`, () => r.invite({ channel, username: guest.username }), d.signal);
    d.notes.push(`seed-media: ${invitee} followed ${owner} through the API so it could be a rehearsal invitee`);
  }
  const { key } = await step(
    owner,
    "rotate the stream key",
    () => u.api.client.stream.rotateKey({ channel }),
    d.signal,
  );
  const encoder = new Streamer({
    protocol: "rtmp",
    url: rtmpPublishUrl(d.env.HARNESS_RTMP_URL, key),
    name: `seed-rehearsal-${owner}`,
    width: 640,
    height: 360,
    bitrateKbps: 800,
    log: d.log,
  });
  try {
    await step(owner, "publish the rehearsal", () => encoder.start(), d.signal);
    await step(
      owner,
      "see the rehearsal start",
      () =>
        waitFor("rehearsing", async () => ((await r.status({ channel })).state === "rehearsing" ? true : null), {
          timeoutMs: REHEARSAL_TIMEOUT_MS,
          intervalMs: 1_000,
          signal: d.signal,
        }),
      d.signal,
    );
    await sleep(seconds * 1000, d.signal);
    await step(owner, "end the rehearsal", () => r.disarm({ channel }), d.signal);
  } finally {
    await encoder.stop();
  }
  await step(
    owner,
    "see the rehearsal idle",
    () =>
      waitFor("rehearsal idle", async () => ((await r.status({ channel })).state === "idle" ? true : null), {
        timeoutMs: REHEARSAL_TIMEOUT_MS,
        intervalMs: 1_000,
        signal: d.signal,
      }),
    d.signal,
  );
}

/** One planned recording, start to clips. */
export async function record(d: RecordDeps, plan: RecordingPlan, spec: RecordingSpec): Promise<RecordingResult> {
  const who = spec.handle;
  const owner = await d.sessions.as(who);
  const { id: channelId, slug: channel } = channelOf(d.store, who);
  const api = owner.api.client;
  await step(who, "turn VODs on", () => api.channels.update({ channel, vodEnabled: true }), d.signal);
  if (spec.speech)
    await step(
      who,
      "turn captions on",
      () => api.channels.updateMediaSettings({ channel, captions: { enabled: true, maskWords: [] } }),
      d.signal,
    );
  let targetId: string | null = null;
  if (spec.simulcast && d.sink) {
    const sink = d.sink;
    const t = await step(
      who,
      "add the local simulcast sink",
      () =>
        api.stream.simulcast.create({
          channel,
          platform: "custom",
          name: "Local test sink",
          rtmpUrl: sink.rtmpUrl,
          streamKey: sink.streamKey,
          enabled: true,
        }),
      d.signal,
    );
    targetId = t.id;
  }
  if (spec.rehearsal) await rehearse(d, plan.rehearsal.owner, plan.rehearsal.invitee, plan.rehearsal.seconds);

  // Sign the chatters in before going live, so the lines land on time.
  for (const a of new Set(spec.chat.map((l) => l.author))) await d.sessions.as(a);
  const start = new Date();
  const { key } = await step(who, "rotate the stream key", () => api.stream.rotateKey({ channel }), d.signal);
  const url = rtmpPublishUrl(d.env.HARNESS_RTMP_URL, key);
  const speech = spec.speech ? startSpeechStream({ url, audioPath: d.audioPath }, `seed-speech-${who}`) : null;
  const encoder = spec.speech
    ? null
    : new Streamer({
        protocol: "rtmp",
        url,
        name: `seed-${who}`,
        width: 640,
        height: 360,
        bitrateKbps: 800,
        log: d.log,
      });
  const viewers: Viewer[] = [];
  let swarm: ViewbotSwarm | null = null;
  let chatSent = 0;
  let roomMessages = 0;
  let broadcastId: string;
  try {
    if (encoder) await step(who, "publish", () => encoder.start(), d.signal);
    await step(who, "go live", () => d.platform.waitForLive(channel, true, LIVE_TIMEOUT_MS), d.signal);
    const liveAt = Date.now();
    broadcastId = await step(who, "find the live broadcast", () => liveBroadcastId(d.db, channelId), d.signal);
    viewers.push(
      ...(await step(
        who,
        "open the HTTP viewers",
        () => d.platform.openViewers(channel, { http: spec.httpViewers }),
        d.signal,
      )),
    );
    if (spec.swarm > 0) {
      const s = new ViewbotSwarm(
        { channel, sessions: spec.swarm },
        d.platform.datacenter,
        (o) => d.platform.api(o),
        d.log,
      );
      swarm = s;
      await step(who, "start the viewbot swarm", () => s.start(), d.signal);
    }
    const talk = sayLines(d, channel, spec.chat, liveAt);
    const room = spec.watchRoom ? watchRoom(d, channel, plan.room) : Promise.resolve(0);
    const done = speech ? speech.exited.then(() => undefined) : sleep(spec.seconds * 1000, d.signal);
    [chatSent, roomMessages] = await Promise.all([
      step(who, "chat during the recording", () => talk, d.signal),
      step(who, "watch-room session", () => room, d.signal),
      done,
    ]);
  } finally {
    await Promise.all([...viewers.map((v) => v.stop().catch(() => undefined)), swarm?.stop().catch(() => undefined)]);
    await speech?.stop();
    await encoder?.stop();
  }
  await step(who, "go offline", () => d.platform.waitForLive(channel, false, OFFLINE_TIMEOUT_MS), d.signal);
  const end = new Date();
  if (targetId)
    await step(
      who,
      "disable the simulcast target",
      () => api.stream.simulcast.update({ channel, id: targetId as string, enabled: false }),
      d.signal,
    );

  const vod = await step(
    who,
    "wait for the VOD",
    () =>
      waitFor(
        `${who}'s VOD ready`,
        async () => {
          const page = await api.vods.list({ channel, limit: 10 });
          const v = page.items.find((x) => Date.parse(x.createdAt) >= start.getTime() - 5_000);
          if (v?.status === "failed") throw new Error(`VOD failed (${v.failedReason ?? "no reason"})`);
          return v?.status === "ready" ? v : null;
        },
        { timeoutMs: VOD_READY_TIMEOUT_MS, intervalMs: 3_000, signal: d.signal },
      ),
    d.signal,
  );
  if (d.bucket) {
    const bucket = d.bucket;
    const rows = await d.db.sql<{ prefix: string }[]>`select storage_prefix as prefix from vods where id = ${vod.id}`;
    const prefix = rows[0]?.prefix;
    const keys = prefix ? await listMediaKeys(bucket, prefix, 5) : [];
    if (keys.length === 0)
      throw new Error(`seed-media: ${who}'s VOD ${vod.id} is ready but has no objects in the media bucket`);
  }
  await step(
    who,
    "run the broadcast rollup",
    () =>
      opsHook(
        d.env,
        INTERNAL_ROUTES.analyticsTick,
        "POST",
        { job: "broadcast-rollup", broadcastId, settleSeconds: 0 },
        d.signal,
      ),
    d.signal,
  );

  const clipIds: string[] = [];
  let removedClipId: string | null = null;
  for (const c of spec.clips) {
    const by = await d.sessions.as(c.by);
    const clip = await step(
      c.by,
      `clip ${who}'s VOD`,
      () =>
        by.api.client.clips.create({
          channel,
          title: c.title,
          vodId: vod.id,
          startOffset: c.startOffset,
          durationSeconds: c.durationSeconds,
        }),
      d.signal,
    );
    await step(
      c.by,
      "wait for the clip",
      () =>
        waitFor(
          `clip ${clip.id} ready`,
          async () => {
            const got = await api.clips.get({ id: clip.id });
            if (got.status === "failed") throw new Error(`clip ${clip.id} failed`);
            return got.status === "ready" ? got : null;
          },
          { timeoutMs: CLIP_READY_TIMEOUT_MS, intervalMs: 2_000, signal: d.signal },
        ),
      d.signal,
    );
    if (c.remove) {
      await step(who, "delete a clip", () => api.clips.remove({ id: clip.id }), d.signal);
      removedClipId = clip.id;
    } else clipIds.push(clip.id);
  }
  if (spec.makePrivate)
    await step(who, "make the VOD private", () => api.vods.update({ id: vod.id, visibility: "private" }), d.signal);
  if (spec.speech) await correctCaption(d, who, vod.id);
  if (spec.shareLink)
    await step(
      who,
      "share the broadcast's analytics",
      () => api.analytics.shareLink.create({ channel, broadcastId, expiresInDays: 30 }),
      d.signal,
    );

  return {
    handle: who,
    channelId,
    broadcastId,
    start,
    end,
    vodId: vod.id,
    clipIds,
    removedClipId,
    private: spec.makePrivate,
    chatSent,
    roomMessages,
  };
}

/** Wait for the VOD's caption track, then streamer1 corrects the first cue (`caption_edits`). */
async function correctCaption(d: RecordDeps, who: string, vodId: string): Promise<void> {
  const u = await d.sessions.as(who);
  const vod = await waitFor(
    "the VOD's caption track",
    async () => {
      const v = await u.api.client.vods.get({ id: vodId });
      return v.captions.length > 0 ? v : null;
    },
    { timeoutMs: CAPTIONS_TIMEOUT_MS, intervalMs: 3_000, signal: d.signal },
  ).catch((err: unknown) => {
    if (d.signal.aborted) throw err;
    throw new Error(
      "seed-media: streamer1's VOD has no caption track: run the whisper sidecar (compose profile `captions`) with WHISPER_URL and CAPTIONS_MAX_STREAMS >= 1",
    );
  });
  const language = vod.captions[0]?.language ?? "en";
  const cues = await step(
    who,
    "read the captions",
    () => u.api.client.vods.captions.get({ id: vodId, language }),
    d.signal,
  );
  const first = cues.cues[0];
  if (!first) throw new Error("seed-media: streamer1's caption track has no cues to correct");
  await step(
    who,
    "correct a caption cue",
    () =>
      u.api.client.vods.captions.update({
        id: vodId,
        language,
        cues: [{ index: first.index, text: CAPTION_CORRECTION }],
      }),
    d.signal,
  );
}

/** Run the plan batch by batch (at most `plan.concurrency` at once). */
export async function recordAll(
  d: RecordDeps,
  plan: RecordingPlan,
  progress: (line: string) => void,
): Promise<RecordingResult[]> {
  const batches = new Map<number, RecordingSpec[]>();
  for (const r of plan.recordings) batches.set(r.batch, [...(batches.get(r.batch) ?? []), r]);
  const out: RecordingResult[] = [];
  for (const [batch, specs] of [...batches.entries()].sort((a, b) => a[0] - b[0])) {
    if (specs.length > plan.concurrency) throw new Error(`seed-media: batch ${batch} runs ${specs.length} recordings`);
    const started = Date.now();
    // Settle the whole batch first, so a failure never leaves the others' publishers running.
    const settled = await Promise.allSettled(specs.map((s) => record(d, plan, s)));
    for (const s of settled) if (s.status === "rejected") throw s.reason;
    const results = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
    out.push(...results);
    progress(
      `recording batch ${batch + 1}: ${specs.map((s) => s.handle).join(", ")} in ${((Date.now() - started) / 1000).toFixed(0)} s`,
    );
  }
  return out;
}
