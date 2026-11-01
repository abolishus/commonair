// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `timeline-sync` W2 extension `replay-panel` (W2-vod-watch; docs/testing/w2-selectors.md,
 * "Scenarios"): the VOD and clip watch pages' chat replay panel, driven in Chromium.
 *
 * The step brings its own actors (it ends its broadcast and blocks a chatter): a streamer with VODs
 * on records a short broadcast and clips it live; once the VOD and the clip are ready, marker lines
 * are written into the broadcast at known instants (a catching-up line among them, one by a
 * chatter the viewer blocked, one inside the clip window). Then a signed-in viewer opens
 * `/$channel/vods/$vodId`, plays from the start, seeks back and to the end and presses a line's
 * time; the panel is read through the DOM only (`video.currentTime`, the player's `data-playhead`,
 * the rows' `data-at`): rows are in `data-at` order and appear only once the playhead passes them,
 * the catching-up line is labelled, the blocked author's line never shows. The clip page shows the
 * clip window's chat; an aged-out VOD (backdated rows and the `chat-retention` ops tick) shows the
 * not-retained notice; a stranger gets not-found once the VOD is `subscribers`-only.
 *
 * Writes go through the Drizzle query builder (Dates bind there); raw reads take no Date
 * parameters and read timestamps through `sql-time.ts` `toDate` (`createDb`'s raw client neither
 * takes nor returns Dates).
 */
import { chatEnv, loadEnv } from "@commonair/config";
import { createDb, schema, uuidv7, type Database, type DbHandle } from "@commonair/db";
import type { Page } from "playwright";
import { playerBundles } from "../player-server.ts";
import { apiError, isNotFound } from "../safety.ts";
import type { SignedInUser } from "../users.ts";
import { sleep, waitFor } from "../wait.ts";
import { signInViaUi } from "../web/flows.ts";
import { ROUTES, TEST_IDS as T } from "../web/selectors.ts";
import { WebSession, byTestId } from "../web/session.ts";
import { atKey } from "../w1/timeline.ts";
import type { W1Run } from "./kit.ts";
import { toDate } from "./sql-time.ts";
import { w2ExtensionTitle } from "./steps.ts";

// ------------------------------------------------------------------ selectors (w2-selectors.md)

export const REPLAY_IDS = {
  vodPage: "vod-watch-page",
  clipPage: "clip-watch-page",
  notFound: "watch-not-found",
  player: "vod-player",
  panel: "replay-panel",
  row: "replay-row",
  rowTime: "replay-row-time",
  catchingUp: "replay-catching-up",
  notRetained: "replay-not-retained",
} as const;

/** `[data-testid="…"]` with optional `data-*` attributes. */
export function replaySel(id: string, data: Record<string, string> = {}): string {
  const attrs = Object.entries(data)
    .map(([k, v]) => `[data-${k}="${v.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"]`)
    .join("");
  return `[data-testid="${id}"]${attrs}`;
}

export const vodPath = (channel: string, vodId: string) =>
  `/${encodeURIComponent(channel)}/vods/${encodeURIComponent(vodId)}`;
export const clipPath = (channel: string, clipId: string) =>
  `/${encodeURIComponent(channel)}/clips/${encodeURIComponent(clipId)}`;

// ------------------------------------------------------------------ pure expectations

/** How far a shown row may lead the playhead it was read with (one render behind). */
export const LEAD_TOLERANCE_MS = 1_000;
/** How long after the playhead passed a row it may still be missing (render and a loaded runner). */
export const LAG_TOLERANCE_MS = 2_500;
/** How close a press on a row's time must land the playhead to that row. */
export const SEEK_TOLERANCE_MS = 2_000;

/** One reading of the page: the player's `data-playhead`, `video.currentTime` and the shown rows. */
export interface PanelSample {
  /** ISO 8601, or "" before the first frame. */
  playhead: string;
  currentTime: number;
  rows: { id: string; at: string; catchingUpLabel: boolean }[];
}

/** `at` in epoch microseconds (replay's text keeps microseconds). */
export function atMicros(iso: string): number {
  const [ms, sub] = atKey(iso);
  return ms * 1000 + sub;
}

/** Rows out of `(data-at, id)` order in one sample. */
export function orderProblems(rows: readonly { id: string; at: string }[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1];
    const b = rows[i];
    if (!a || !b) continue;
    const d = atMicros(a.at) - atMicros(b.at);
    if (d > 0 || (d === 0 && a.id > b.id)) out.push(`${a.id} (${a.at}) before ${b.id} (${b.at})`);
  }
  return out;
}

export interface ExpectedLine {
  id: string;
  at: string;
  catchingUp: boolean;
}

/**
 * Everything wrong with a series of samples: rows out of order, rows shown before the playhead
 * reached them, expected rows still missing well after it passed them, a row that should never
 * show (blocked), unknown rows, and a catching-up line without its label (or a label on another).
 */
export function revealProblems(
  samples: readonly PanelSample[],
  expected: readonly ExpectedLine[],
  never: readonly string[],
  tol = { leadMs: LEAD_TOLERANCE_MS, lagMs: LAG_TOLERANCE_MS },
): string[] {
  const out: string[] = [];
  const known = new Map(expected.map((e) => [e.id, e]));
  samples.forEach((s, i) => {
    const tag = `sample ${i} (playhead ${s.playhead || "none"})`;
    for (const p of orderProblems(s.rows)) out.push(`${tag}: ${p}`);
    const head = s.playhead ? Date.parse(s.playhead) : Number.NaN;
    for (const r of s.rows) {
      if (never.includes(r.id)) out.push(`${tag}: ${r.id} must never show`);
      const e = known.get(r.id);
      if (!e) {
        out.push(`${tag}: unexpected row ${r.id}`);
        continue;
      }
      if (r.catchingUpLabel !== e.catchingUp) out.push(`${tag}: ${r.id} catching-up label ${r.catchingUpLabel}`);
      if (!Number.isFinite(head)) out.push(`${tag}: ${r.id} shown before the first frame`);
      else if (atMicros(r.at) / 1000 > head + tol.leadMs) out.push(`${tag}: ${r.id} at ${r.at} shown early`);
    }
    if (!Number.isFinite(head)) return;
    const shown = new Set(s.rows.map((r) => r.id));
    for (const e of expected)
      if (atMicros(e.at) / 1000 < head - tol.lagMs && !shown.has(e.id)) out.push(`${tag}: ${e.id} at ${e.at} missing`);
  });
  return out;
}

/** `n` instants (seconds from the broadcast start) spread over a recording of `duration` seconds, clear of both ends. */
export function lineOffsets(durationSeconds: number, n: number): number[] {
  const first = 3;
  const last = Math.max(first + 1, durationSeconds - 8);
  if (n <= 1) return [first];
  return Array.from({ length: n }, (_, i) => first + ((last - first) * i) / (n - 1));
}

// ------------------------------------------------------------------ database seeds (tested on a real database)

export interface SeedLine {
  channelId: string;
  broadcastId: string;
  userId: string;
  body: string;
  /** Where replay places it: its media time, or (catching up) its receive time. */
  at: Date;
  catchingUp: boolean;
}

/** Write chat lines into a broadcast; returns their ids in input order. */
export async function seedLines(db: Database, lines: readonly SeedLine[]): Promise<string[]> {
  const ids = lines.map(() => uuidv7());
  if (lines.length === 0) return ids;
  await db.insert(schema.chatMessages).values(
    lines.map((l, i) => ({
      id: ids[i] as string,
      channelId: l.channelId,
      broadcastId: l.broadcastId,
      userId: l.userId,
      body: l.body,
      createdAt: l.at,
      mediaTs: l.catchingUp ? null : l.at,
    })),
  );
  return ids;
}

/** The broadcast span of a VOD (raw read: timestamps come back as text on `createDb`'s client). */
export async function broadcastSpan(
  sql: DbHandle["sql"],
  vodId: string,
): Promise<{ broadcastId: string; startedAt: Date; endedAt: Date | null } | null> {
  const rows = await sql<{ id: string; started_at: string | Date; ended_at: string | Date | null }[]>`
    select b.id, b.started_at, b.ended_at from vods v join broadcasts b on b.id = v.broadcast_id
     where v.id = ${vodId}`;
  const r = rows[0];
  return r ? { broadcastId: r.id, startedAt: toDate(r.started_at), endedAt: toDate(r.ended_at) } : null;
}

/**
 * A finished broadcast `daysAgo` days back with a ready, public VOD (no media objects: its page
 * shows the not-retained notice, not playback) and `lines` chat rows from then.
 */
export async function seedAgedOutVod(
  db: Database,
  opts: { channelId: string; channel: string; userId: string; daysAgo: number; lines: number; now?: Date },
): Promise<{ vodId: string; broadcastId: string; lineIds: string[] }> {
  const now = opts.now ?? new Date();
  const startedAt = new Date(now.getTime() - opts.daysAgo * 86_400_000);
  const endedAt = new Date(startedAt.getTime() + 30 * 60_000);
  const broadcastId = uuidv7();
  const vodId = uuidv7();
  await db.insert(schema.broadcasts).values({
    id: broadcastId,
    channelId: opts.channelId,
    ingestProtocol: "rtmp",
    path: `live/${opts.channel}`,
    startedAt,
    endedAt,
  });
  await db.insert(schema.vods).values({
    id: vodId,
    channelId: opts.channelId,
    broadcastId,
    title: "replay-panel aged out",
    status: "ready",
    visibility: "public",
    storagePrefix: `vods/${vodId}/`,
    durationSeconds: 1800,
    // Kept (a VOD that still exists keeps its chat for CHAT_REPLAY_MAX_DAYS, then it goes too).
    expiresAt: new Date(now.getTime() + 86_400_000),
  });
  const lineIds = await seedLines(
    db,
    Array.from({ length: opts.lines }, (_, i) => ({
      channelId: opts.channelId,
      broadcastId,
      userId: opts.userId,
      body: `w2 replay aged ${i} ${vodId.slice(-6)}`,
      at: new Date(startedAt.getTime() + (i + 1) * 60_000),
      catchingUp: false,
    })),
  );
  return { vodId, broadcastId, lineIds };
}

/** Which of `ids` still exist. */
export async function existingLines(sql: DbHandle["sql"], ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await sql<{ id: string }[]>`select id from chat_messages where id = any(${[...ids]}::uuid[])`;
  return rows.map((r) => r.id);
}

// ------------------------------------------------------------------ the browser side

/** Read the player and the panel once (DOM only, no test globals). */
async function sample(page: Page): Promise<PanelSample> {
  return page.evaluate(
    ({ player, row, catchingUp }) => {
      const p = document.querySelector(`[data-testid="${player}"]`);
      const video = p?.querySelector("video");
      return {
        playhead: p?.getAttribute("data-playhead") ?? "",
        currentTime: video?.currentTime ?? Number.NaN,
        rows: [...document.querySelectorAll(`[data-testid="${row}"]`)].map((r) => ({
          id: r.getAttribute("data-message-id") ?? "",
          at: r.getAttribute("data-at") ?? "",
          catchingUpLabel: r.querySelector(`[data-testid="${catchingUp}"]`) !== null,
        })),
      };
    },
    { player: REPLAY_IDS.player, row: REPLAY_IDS.row, catchingUp: REPLAY_IDS.catchingUp },
  );
}

async function samples(page: Page, ms: number, everyMs: number, signal: AbortSignal): Promise<PanelSample[]> {
  const out: PanelSample[] = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    out.push(await sample(page));
    await sleep(everyMs, signal);
  }
  return out;
}

async function setTime(page: Page, seconds: number | "end"): Promise<void> {
  await page.evaluate(
    ({ player, seconds: s }) => {
      const video = document.querySelector(`[data-testid="${player}"] video`);
      if (!(video instanceof HTMLVideoElement)) throw new Error("no video");
      video.muted = true;
      video.currentTime = s === "end" ? Math.max(0, video.duration - 0.25) : s;
      void video.play().catch(() => undefined);
    },
    { player: REPLAY_IDS.player, seconds },
  );
}

// ------------------------------------------------------------------ the step

const UI_TIMEOUT_MS = 30_000;
const LIVE_TIMEOUT_MS = 30_000;
const MEDIA_READY_TIMEOUT_MS = 5 * 60_000;
/** How long the step's broadcast runs. */
const BROADCAST_MS = 40_000;
/** When the live clip is cut (it ends LIVE_CLIP_LAG_SECONDS behind live). */
const CLIP_AT_MS = 28_000;
const CLIP_SECONDS = 10;
/**
 * Days back to seed the aged-out VOD: past the stack's CHAT_REPLAY_MAX_DAYS (read from the same env
 * the stack gets, default 60), so the retention run deletes its rows even though the VOD exists.
 */
export function agedDays(source: Record<string, string | undefined>): number {
  return loadEnv(chatEnv, source).CHAT_REPLAY_MAX_DAYS + 5;
}

const title = (what: string) => w2ExtensionTitle("replay-panel", what);

export async function stepReplayPanel(run: W1Run): Promise<void> {
  const { ctx } = run;
  const p = ctx.platform;
  const signal = ctx.signal;
  const handle = createDb({ url: run.databaseUrl, max: 2, applicationName: "commonair-harness-w2-replay" });
  ctx.defer(() => handle.close());
  const { db, sql } = handle;

  const [owner, chatter, blockedChatter, viewer, stranger] = await ctx.step(title("sign up the step's actors"), () =>
    Promise.all(["w2rpo", "w2rpc", "w2rpb", "w2rpv", "w2rps"].map((prefix) => p.signUp({ prefix }))),
  );
  if (!owner || !chatter || !blockedChatter || !viewer || !stranger) throw new Error("sign-up returned nothing");
  const channel = owner.me.channelSlug ?? owner.username;
  const channelId = (await owner.api.client.channels.get({ channel })).id;
  await owner.api.client.channels.update({ channel, vodEnabled: true });
  await ctx.step(title("the viewer blocks a chatter"), () =>
    viewer.api.client.me.blocks.add({ username: blockedChatter.username }),
  );

  // ---- a short broadcast with a live clip
  const encoder = await p.streamerFor(owner, { protocol: "rtmp", width: 640, height: 360, bitrateKbps: 800 });
  ctx.defer(() => encoder.stop());
  await ctx.step(title("streamer: publish and go live"), async () => {
    await encoder.start();
    await p.waitForLive(channel, true, LIVE_TIMEOUT_MS);
  });
  const liveAt = Date.now();
  const vodId = await ctx.step(title("the broadcast's VOD is recording"), () =>
    waitFor(
      "a recording VOD",
      async () =>
        (await owner.api.client.vods.list({ channel, limit: 5 })).items.find((v) => v.status === "recording")?.id ??
        null,
      { timeoutMs: LIVE_TIMEOUT_MS, intervalMs: 1_000, signal },
    ),
  );
  await sleep(Math.max(0, liveAt + CLIP_AT_MS - Date.now()), signal);
  const clipId = await ctx.step(
    title("streamer: clip the live stream"),
    async () =>
      (await owner.api.client.clips.create({ channel, title: "replay-panel clip", durationSeconds: CLIP_SECONDS })).id,
  );
  await sleep(Math.max(0, liveAt + BROADCAST_MS - Date.now()), signal);
  await ctx.step(title("streamer: end the broadcast"), async () => {
    await encoder.stop();
    await p.waitForLive(channel, false, LIVE_TIMEOUT_MS);
  });
  const [vod, clip] = await ctx.step(title("the VOD and the clip are ready"), () =>
    Promise.all([
      waitFor(
        "the VOD ready",
        async () => {
          const v = await owner.api.client.vods.get({ id: vodId }).catch(() => null);
          return v?.status === "ready" ? v : null;
        },
        { timeoutMs: MEDIA_READY_TIMEOUT_MS, intervalMs: 3_000, signal },
      ),
      waitFor(
        "the clip ready",
        async () => {
          const c = await owner.api.client.clips.get({ id: clipId }).catch(() => null);
          return c?.status === "ready" ? c : null;
        },
        { timeoutMs: MEDIA_READY_TIMEOUT_MS, intervalMs: 3_000, signal },
      ),
    ]),
  );
  const span = await broadcastSpan(sql, vodId);
  if (!span) throw new Error(`VOD ${vodId} has no broadcast`);
  ctx.data("w2.replay.media", {
    vodId,
    clipId,
    durationSeconds: vod.durationSeconds,
    windowStartedAt: clip.windowStartedAt,
  });

  // ---- marker lines at known instants
  const offsets = lineOffsets(vod.durationSeconds, 5);
  const atOffset = (s: number) => new Date(span.startedAt.getTime() + Math.round(s * 1000));
  const marker = (what: string) => `w2 replay ${what} ${ctx.runId.slice(-6)}`;
  const clipStart = clip.windowStartedAt ? Date.parse(clip.windowStartedAt) : Number.NaN;
  const seeds: SeedLine[] = [
    ...offsets.map((s, i) => ({
      channelId,
      broadcastId: span.broadcastId,
      userId: i === 2 ? blockedChatter.id : chatter.id,
      body: marker(i === 2 ? "blocked" : i === 3 ? "catching-up" : `line-${i}`),
      at: atOffset(s),
      catchingUp: i === 3,
    })),
    ...(Number.isFinite(clipStart)
      ? [
          {
            channelId,
            broadcastId: span.broadcastId,
            userId: chatter.id,
            body: marker("in-clip"),
            at: new Date(clipStart + (CLIP_SECONDS * 1000) / 2),
            catchingUp: false,
          },
        ]
      : []),
  ];
  const seedIds = await ctx.step(title("write marker lines into the broadcast"), () => seedLines(db, seeds));
  const blockedId = seedIds[2] as string;
  const catchingUpId = seedIds[3] as string;

  const replayAs = async (who: SignedInUser, kind: "vods" | "clips", id: string) => {
    const r =
      kind === "vods"
        ? await who.api.client.vods.chat({ id, limit: 500 })
        : await who.api.client.clips.chat({ id, limit: 500 });
    return r.items.map((i) => ({ id: i.id, at: i.at, catchingUp: i.catchingUp }));
  };
  const expectedVod = await replayAs(viewer, "vods", vodId);
  ctx.assert(
    title("vods.chat (the viewer): every marker but the blocked one"),
    seedIds.every((id) => (id === blockedId) !== expectedVod.some((e) => e.id === id)),
    { seedIds, blockedId, expected: expectedVod.map((e) => e.id) },
  );
  ctx.assert(
    title("vods.chat: the catching-up marker is flagged"),
    expectedVod.find((e) => e.id === catchingUpId)?.catchingUp === true,
  );

  // ---- the viewer's browser
  const sessions: WebSession[] = [];
  ctx.defer(async () => {
    await Promise.allSettled(sessions.map((s) => s.close()));
  });
  const probe = (await playerBundles()).probe;
  const browserFor = async (label: string, user: SignedInUser): Promise<WebSession> => {
    const s = await WebSession.open({
      fleet: p.fleet,
      engine: "chromium",
      webUrl: ctx.env.HARNESS_WEB_URL,
      probeScript: probe,
      label: `w2-replay-${label}`,
      log: ctx.log,
    });
    sessions.push(s);
    const page = await s.goto(ROUTES.signin);
    await signInViaUi(page, user, UI_TIMEOUT_MS, signal);
    await byTestId(page, T.navUser, { username: user.username }).waitFor({ timeout: UI_TIMEOUT_MS });
    return s;
  };
  const watcher = await ctx.step(title("viewer: sign in (Chromium)"), () => browserFor("viewer", viewer));

  const page = await ctx.step(title("viewer: open the VOD page"), async () => {
    const pg = await watcher.goto(vodPath(channel, vodId));
    await pg
      .locator(replaySel(REPLAY_IDS.vodPage, { state: "ready", "vod-id": vodId }))
      .waitFor({ timeout: UI_TIMEOUT_MS });
    await pg.locator(replaySel(REPLAY_IDS.player, { state: "ready" })).waitFor({ timeout: UI_TIMEOUT_MS });
    const role = await pg.locator(`${replaySel(REPLAY_IDS.panel)} [role="log"]`).getAttribute("aria-live");
    ctx.assert(title("the replay log makes no live announcements"), role === "off", { ariaLive: role });
    return pg;
  });

  await ctx.step(title("play from the start: rows appear as the playhead passes them"), async () => {
    await setTime(page, 0);
    const s = await samples(page, Math.min(20_000, Math.max(8_000, (offsets[2] ?? 10) * 1000 + 3_000)), 250, signal);
    const playing = s.filter((x) => x.playhead !== "");
    const moved = (playing.at(-1)?.currentTime ?? 0) - (playing[0]?.currentTime ?? 0);
    ctx.data("w2.replay.play", { samples: s.length, moved });
    ctx.assert(title("the video plays (currentTime moves)"), moved >= 3, { moved });
    const problems = revealProblems(s, expectedVod, [blockedId]);
    ctx.assert(
      title("rows in data-at order, shown only once the playhead passes them"),
      problems.length === 0,
      problems.slice(0, 20),
    );
    ctx.assert(
      title("some rows appeared while playing"),
      s.some((x) => x.rows.length > 0),
      { last: s.at(-1) },
    );
  });

  await ctx.step(title("seek to the end: every line, the catching-up one labelled"), async () => {
    await setTime(page, "end");
    const end = await waitFor(
      "every expected row shown",
      async () => {
        const x = await sample(page);
        return expectedVod.every((e) => x.rows.some((r) => r.id === e.id)) ? x : null;
      },
      { timeoutMs: UI_TIMEOUT_MS, intervalMs: 250, signal },
    );
    const problems = revealProblems([end], expectedVod, [blockedId]);
    ctx.assert(title("at the end: all rows, in order, none early"), problems.length === 0, problems);
    ctx.assert(
      title("the catching-up line carries replay-catching-up"),
      end.rows.find((r) => r.id === catchingUpId)?.catchingUpLabel === true,
    );
    ctx.assert(title("the blocked author's line is absent"), !end.rows.some((r) => r.id === blockedId));
  });

  await ctx.step(title("seek back: later rows go"), async () => {
    await setTime(page, 0);
    await sleep(1_500, signal);
    const s = await samples(page, 2_000, 250, signal);
    const problems = revealProblems(s, expectedVod, [blockedId]);
    ctx.assert(title("after seeking back, no row past the playhead"), problems.length === 0, problems.slice(0, 20));
    const last = s.at(-1);
    ctx.assert(title("after seeking back, fewer rows than at the end"), (last?.rows.length ?? 0) < expectedVod.length, {
      shown: last?.rows.length,
    });
  });

  await ctx.step(title("a row's time seeks the player to it"), async () => {
    // From the end, press a middle line's time (well inside the media): the playhead jumps back to it.
    await setTime(page, "end");
    const target = expectedVod[Math.floor(expectedVod.length / 2)];
    if (!target) throw new Error("no expected rows");
    const time = page.locator(
      `${replaySel(REPLAY_IDS.row, { "message-id": target.id })} ${replaySel(REPLAY_IDS.rowTime)}`,
    );
    await time.waitFor({ timeout: UI_TIMEOUT_MS });
    await time.click({ timeout: UI_TIMEOUT_MS });
    const deltaMs = await waitFor(
      "the playhead at the row",
      async () => {
        const x = await sample(page);
        const d = x.playhead ? Math.abs(Date.parse(x.playhead) - atMicros(target.at) / 1000) : Number.POSITIVE_INFINITY;
        return d <= SEEK_TOLERANCE_MS ? d : null;
      },
      { timeoutMs: 10_000, intervalMs: 200, signal },
    );
    ctx.data("w2.replay.seekDeltaMs", deltaMs);
  });

  // ---- the clip page
  await ctx.step(title("the clip page shows the clip window's chat"), async () => {
    const expectedClip = await replayAs(viewer, "clips", clipId);
    ctx.assert(
      title("clips.chat has the in-clip marker"),
      Number.isFinite(clipStart) && expectedClip.some((e) => e.id === seedIds.at(-1)),
      {
        expected: expectedClip.map((e) => e.id),
      },
    );
    const pg = await watcher.goto(clipPath(channel, clipId));
    await pg.locator(replaySel(REPLAY_IDS.clipPage, { "clip-id": clipId })).waitFor({ timeout: UI_TIMEOUT_MS });
    await pg.locator(replaySel(REPLAY_IDS.player, { state: "ready" })).waitFor({ timeout: UI_TIMEOUT_MS });
    await setTime(pg, "end");
    // A line in the window's last moments may sit past where the seek lands: read the panel against
    // its own playhead once the in-clip marker shows.
    const inClip = seedIds.at(-1) ?? "";
    await waitFor(
      "the in-clip marker shown",
      async () => ((await sample(pg)).rows.some((r) => r.id === inClip) ? true : null),
      { timeoutMs: UI_TIMEOUT_MS, intervalMs: 250, signal },
    );
    const end = await samples(pg, 1_500, 250, signal);
    const problems = revealProblems(end, expectedClip, [blockedId]);
    ctx.assert(title("the clip page shows exactly the window's lines, in order"), problems.length === 0, problems);
  });

  // ---- an aged-out VOD
  await ctx.step(title("an aged-out VOD shows the not-retained notice"), async () => {
    const daysAgo = agedDays(process.env);
    const aged = await seedAgedOutVod(db, { channelId, channel, userId: chatter.id, daysAgo, lines: 3 });
    // tickRan repeats a tick the run lock skipped, so the assert below follows a run that happened.
    const result = await run.hooks.client.tickRan("chat-retention");
    ctx.data("w2.replay.retention", result);
    const left = await existingLines(sql, aged.lineIds);
    ctx.assert(title("the retention run deleted the aged rows"), left.length === 0, { left, daysAgo });
    const r = await viewer.api.client.vods.chat({ id: aged.vodId, limit: 10 });
    ctx.assert(title("vods.chat: retained false, no items"), !r.retained && r.items.length === 0, r);
    const pg = await watcher.goto(vodPath(channel, aged.vodId));
    await pg.locator(replaySel(REPLAY_IDS.notRetained)).waitFor({ timeout: UI_TIMEOUT_MS });
  });

  // ---- a stranger on a subscribers-only VOD (last: the clip follows its VOD's visibility)
  await ctx.step(title("a stranger gets not-found on a subscribers VOD"), async () => {
    await owner.api.client.vods.update({ id: vodId, visibility: "subscribers" });
    ctx.defer(() =>
      owner.api.client.vods.update({ id: vodId, visibility: "public" }).then(
        () => undefined,
        () => undefined,
      ),
    );
    const err = await stranger.api.client.vods
      .get({ id: vodId })
      .then(() => null)
      .catch((e: unknown) => e);
    ctx.assert(title("vods.get (stranger): NOT_FOUND"), err !== null && isNotFound(err), { code: apiError(err).code });
    const s = await browserFor("stranger", stranger);
    const pg = await s.goto(vodPath(channel, vodId));
    await pg.locator(replaySel(REPLAY_IDS.notFound)).waitFor({ timeout: UI_TIMEOUT_MS });
    const leaked = await pg.locator(`${replaySel(REPLAY_IDS.vodPage)}, ${replaySel(REPLAY_IDS.player)}`).count();
    ctx.assert(title("the stranger sees no page, no player"), leaked === 0, { leaked });
    // The owner still watches it.
    const own = await owner.api.client.vods.get({ id: vodId });
    ctx.assert(title("the owner still gets the VOD"), own.id === vodId);
  });
}
