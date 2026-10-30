// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `timeline-sync` step 2 (docs/testing/w1-selectors.md, "Scenarios"; ADR 0012 amendment 1
 * decision 1): two Chromium viewers on `/$channel` of a live channel whose ladder runs, pinned to
 * different rungs and different latencies through the player's diagnostic query parameters
 * (`?rendition=`, `?targetLatency=` 3 and 12), each send a marker through the chat input. The step
 * records the `mediaTs` each page put in its outgoing `send` frame (Playwright `framesent`): that
 * is the PDT under the sender's playhead at send time. The echoed row's `data-media-ts` is the
 * server's clamped value, so comparing against it would be circular. After the broadcast ends and
 * the VOD is ready, `vods.chat` returns both markers in media-time order, each within 1 s of what
 * the page reported.
 *
 * The far viewer sends after the near one, so a correct replay puts the later-sent marker first.
 * The step brings its own streamer (it ends the broadcast) and its own viewers. Owned by W1-player.
 */
import { RENDITIONS } from "@commonair/contracts/enums";
import type { Page, WebSocket } from "playwright";
import { RenditionSampler } from "../clock-skew-io.ts";
import { playerBundles } from "../player-server.ts";
import type { ScenarioContext } from "../scenario.ts";
import type { SignedInUser } from "../users.ts";
import { sleep, waitFor } from "../wait.ts";
import { signInViaUi } from "../web/flows.ts";
import { ROUTES, TEST_IDS as T } from "../web/selectors.ts";
import { WebSession, byTestId } from "../web/session.ts";
import { DEFAULT_LADDER_VIEWERS, type W1Run } from "./kit.ts";
import { W1_ROUTES, W1_TEST_IDS as W, byW1Id } from "./selectors.ts";
import { timelineTitle } from "./steps.ts";

/**
 * The two forced latencies (seconds) through `?targetLatency=`. The brief names 3 and 12, but the
 * harness MediaMTX keeps 7 segments (~14 s on the 2 s GOP) and hls.js adds up to one target
 * duration after a stall, so 12 s sits on the oldest fragment and rebuffers; 9 s keeps a margin.
 */
export const FORCED_LATENCIES = { near: 3, far: 9 } as const;
/** How far the recorded playhead and the replayed `mediaTs` may differ (Chromium; WebKit too). */
export const MEDIA_TS_TOLERANCE_MS = 1_000;
/**
 * The far viewer's playhead must trail the near one's by at least this much at send time, or the
 * forced latencies did not take and the ordering check proves nothing (6 s apart by design).
 */
export const MIN_LATENCY_GAP_MS = 4_000;

const UI_TIMEOUT_MS = 30_000;
const LIVE_TIMEOUT_MS = 30_000;
const PLAYING_TIMEOUT_MS = 60_000;
const LADDER_TIMEOUT_MS = 5 * 60_000;
/** hls.js settles on its target after the first segments; give it a few more. */
const SETTLE_MS = 8_000;
const FRAME_TIMEOUT_MS = 10_000;
const VOD_TIMEOUT_MS = 4 * 60_000;

const step = (what: string) => timelineTitle(2, what);

/** What a page sent for one marker: the frame's `mediaTs` and `playbackMode` (null when absent). */
export interface SentFrame {
  mediaTs: string | null;
  playbackMode: string | null;
}

/** The `send` frame for `marker` in a WebSocket payload, or null when this frame is not it. */
export function sentFrameOf(payload: string | Buffer, marker: string): SentFrame | null {
  const text = typeof payload === "string" ? payload : payload.toString("utf8");
  let frame: unknown;
  try {
    frame = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof frame !== "object" || frame === null) return null;
  const f = frame as Record<string, unknown>;
  if (f.op !== "send" || typeof f.body !== "string" || f.body.trim() !== marker) return null;
  return {
    mediaTs: typeof f.mediaTs === "string" ? f.mediaTs : null,
    playbackMode: typeof f.playbackMode === "string" ? f.playbackMode : null,
  };
}

/**
 * The two rungs to pin: `source` and the lowest advertised rung, so the viewers decode different
 * renditions (ADR 0012 part 1: the PDT is the same on each). Null while only `source` is advertised.
 */
export function pickRenditions(advertised: readonly string[]): { near: string; far: string } | null {
  const rungs = RENDITIONS.filter((r) => r !== "source" && r !== "audio" && advertised.includes(r));
  const lowest = rungs.at(-1);
  return lowest === undefined ? null : { near: "source", far: lowest };
}

/** One marker as its page sent it. */
export interface SentMarker {
  label: string;
  marker: string;
  /** The PDT the page reported (the frame's `mediaTs`), ISO 8601. */
  mediaTs: string;
}

/** One `vods.chat` item, as far as the check needs it. */
export interface ReplayItem {
  body: string;
  mediaTs?: string | null | undefined;
  at: string;
}

export interface ReplayCheck {
  ok: boolean;
  problems: string[];
  /** Marker labels in replay order. */
  order: string[];
  /** Per label: replayed `mediaTs` minus the recorded playhead, ms (null when missing). */
  deltaMs: Record<string, number | null>;
}

/**
 * Whether replay has every marker exactly once, in the order of the recorded playheads (which is
 * media-time order), each with a `mediaTs` within `toleranceMs` of what its page reported.
 */
export function checkReplay(
  sent: readonly SentMarker[],
  items: readonly ReplayItem[],
  toleranceMs = MEDIA_TS_TOLERANCE_MS,
): ReplayCheck {
  const problems: string[] = [];
  const deltaMs: Record<string, number | null> = {};
  const order: string[] = [];
  const positions = new Map<string, number>();
  items.forEach((item, i) => {
    const m = sent.find((s) => s.marker === item.body.trim());
    if (!m) return;
    if (positions.has(m.label)) problems.push(`${m.label} replayed twice`);
    else {
      positions.set(m.label, i);
      order.push(m.label);
    }
  });
  for (const m of sent) {
    const i = positions.get(m.label);
    const item = i === undefined ? undefined : items[i];
    if (!item) {
      problems.push(`${m.label} missing from replay`);
      deltaMs[m.label] = null;
      continue;
    }
    const replayed = item.mediaTs ? Date.parse(item.mediaTs) : Number.NaN;
    if (!Number.isFinite(replayed)) {
      problems.push(`${m.label} replayed without mediaTs`);
      deltaMs[m.label] = null;
      continue;
    }
    const delta = replayed - Date.parse(m.mediaTs);
    deltaMs[m.label] = delta;
    if (Math.abs(delta) > toleranceMs)
      problems.push(`${m.label} mediaTs ${item.mediaTs} is ${delta} ms from the page's ${m.mediaTs}`);
  }
  const expected = [...sent].sort((a, b) => Date.parse(a.mediaTs) - Date.parse(b.mediaTs)).map((m) => m.label);
  if (problems.length === 0 && order.join(",") !== expected.join(","))
    problems.push(`replay order ${order.join(",")} is not media-time order ${expected.join(",")}`);
  return { ok: problems.length === 0, problems, order, deltaMs };
}

/** Records the `send` frames a page's chat socket sends, from before the page opens. */
class FrameRecorder {
  readonly frames: string[] = [];
  constructor(page: Page) {
    page.on("websocket", (ws: WebSocket) => {
      ws.on("framesent", ({ payload }) => {
        this.frames.push(typeof payload === "string" ? payload : payload.toString("utf8"));
      });
    });
  }

  find(marker: string): SentFrame | null {
    for (const f of this.frames) {
      const sent = sentFrameOf(f, marker);
      if (sent) return sent;
    }
    return null;
  }
}

interface Watcher {
  label: string;
  user: SignedInUser;
  page: Page;
  frames: FrameRecorder;
  rendition: string;
  targetLatency: number;
}

/** Hold the step's channel above the transcode threshold until a rung other than `source` is advertised. */
async function forceLadder(ctx: ScenarioContext, channel: string): Promise<{ near: string; far: string }> {
  const p = ctx.platform;
  const sampler = new RenditionSampler({ api: p.api().client, channel, log: p.log });
  ctx.defer(() => sampler.stop());
  await sampler.start();
  const viewers = await ctx.step(step(`${DEFAULT_LADDER_VIEWERS} HTTP viewers cross the transcode threshold`), () =>
    p.openViewers(channel, { http: DEFAULT_LADDER_VIEWERS }),
  );
  for (const v of viewers) ctx.defer(() => v.stop());
  return ctx.step(step("the ladder advertises a rung"), () =>
    waitFor(`${channel} advertises a rung`, () => pickRenditions(sampler.current), {
      timeoutMs: LADDER_TIMEOUT_MS,
      intervalMs: 2_000,
      signal: ctx.signal,
    }).catch((err: unknown) => {
      throw new Error(`${(err as Error).message}; sampler ${JSON.stringify(sampler.status())}`);
    }),
  );
}

export async function stepForcedLatencies(run: W1Run): Promise<void> {
  const { ctx } = run;
  const p = ctx.platform;
  const signal = ctx.signal;

  // Own streamer: this step ends its broadcast to get the VOD.
  const streamer = await ctx.step(step("sign up the step's streamer"), () => p.signUp({ prefix: "w1tws" }));
  const channel = streamer.me.channelSlug ?? streamer.username;
  await streamer.api.client.channels.update({ channel, vodEnabled: true });
  const encoder = await p.streamerFor(streamer, { protocol: "rtmp", width: 1280, height: 720, bitrateKbps: 2500 });
  ctx.defer(() => encoder.stop());
  await ctx.step(step("streamer: publish the RTMP test pattern"), () => encoder.start());
  await ctx.step(step("streamer: channel goes live"), () => p.waitForLive(channel, true, LIVE_TIMEOUT_MS));
  const vodId = await ctx.step(step("the broadcast's VOD is recording"), () =>
    waitFor(
      "a recording VOD",
      async () => {
        const page = await streamer.api.client.vods.list({ channel, limit: 5 });
        return page.items.find((v) => v.status === "recording")?.id ?? null;
      },
      { timeoutMs: LIVE_TIMEOUT_MS, intervalMs: 1_000, signal },
    ),
  );
  const rungs = await forceLadder(ctx, channel);
  ctx.data("timelineWebRenditions", rungs);

  const [nearUser, farUser] = await ctx.step(step("sign up two viewers"), () =>
    Promise.all([p.signUp({ prefix: "w1twn" }), p.signUp({ prefix: "w1twf" })]),
  );
  if (!nearUser || !farUser) throw new Error("viewer sign-up returned nothing");

  const sessions: WebSession[] = [];
  ctx.defer(async () => {
    await Promise.allSettled(sessions.map((s) => s.close()));
  });
  const probe = (await playerBundles()).probe;
  const open = async (
    label: string,
    user: SignedInUser,
    rendition: string,
    targetLatency: number,
  ): Promise<Watcher> => {
    const s = await WebSession.open({
      fleet: p.fleet,
      engine: "chromium",
      webUrl: ctx.env.HARNESS_WEB_URL,
      probeScript: probe,
      label: `w1-timeline-${label}`,
      log: ctx.log,
    });
    sessions.push(s);
    const page = await s.goto(ROUTES.signin);
    await signInViaUi(page, user, UI_TIMEOUT_MS, signal);
    await byTestId(page, T.navUser, { username: user.username }).waitFor({ timeout: UI_TIMEOUT_MS });
    // Listen before the channel page opens its chat socket.
    const frames = new FrameRecorder(page);
    await s.goto(W1_ROUTES.channel(channel, { targetLatency, rendition }));
    await byW1Id(page, W.player, { state: "playing", "playback-mode": "live" }).waitFor({
      timeout: PLAYING_TIMEOUT_MS,
    });
    await byTestId(page, T.chatInput).waitFor({ timeout: UI_TIMEOUT_MS });
    return { label, user, page, frames, rendition, targetLatency };
  };

  const watchers = await ctx.step(
    step(`viewers play ${rungs.near} at ${FORCED_LATENCIES.near} s and ${rungs.far} at ${FORCED_LATENCIES.far} s`),
    () =>
      Promise.all([
        open("near", nearUser, rungs.near, FORCED_LATENCIES.near),
        open("far", farUser, rungs.far, FORCED_LATENCIES.far),
      ]),
  );
  await sleep(SETTLE_MS, signal);

  const sent: SentMarker[] = [];
  const latencyMs: Record<string, number> = {};
  // Near first: the far viewer's later marker belongs to an earlier moment.
  for (const w of watchers) {
    const marker = `w1-timeline ${w.label} ${ctx.runId.slice(-8)} ${Date.now().toString(36)}`;
    const frame = await ctx.step(step(`${w.label} viewer sends a marker through the chat input`), async () => {
      await byTestId(w.page, T.chatInput).fill(marker, { timeout: UI_TIMEOUT_MS });
      await byTestId(w.page, T.chatSend).click({ timeout: UI_TIMEOUT_MS });
      const sentAt = Date.now();
      const f = await waitFor(`${w.label}'s send frame`, () => w.frames.find(marker), {
        timeoutMs: FRAME_TIMEOUT_MS,
        intervalMs: 100,
        signal,
      });
      return { ...f, sentAt };
    });
    ctx.assert(step(`${w.label}'s send frame carries mediaTs`), frame.mediaTs !== null, frame);
    ctx.assert(step(`${w.label}'s send frame says live (no playbackMode)`), frame.playbackMode === null, frame);
    if (frame.mediaTs === null) return;
    sent.push({ label: w.label, marker, mediaTs: frame.mediaTs });
    latencyMs[w.label] = frame.sentAt - Date.parse(frame.mediaTs);
    await sleep(1_000, signal);
  }
  ctx.data("timelineWebSent", sent);
  ctx.data("timelineWebLatencyMs", latencyMs);
  const gap = (latencyMs.far ?? 0) - (latencyMs.near ?? 0);
  ctx.assert(
    step(`the far viewer's playhead trails the near one's by at least ${MIN_LATENCY_GAP_MS / 1000} s`),
    gap >= MIN_LATENCY_GAP_MS,
    { latencyMs, gap },
  );

  await ctx.step(step("close the viewers, end the broadcast"), async () => {
    await Promise.allSettled(sessions.map((s) => s.close()));
    await encoder.stop();
    await p.waitForLive(channel, false, LIVE_TIMEOUT_MS);
  });
  await ctx.step(step("the VOD is ready"), () =>
    waitFor(
      "the VOD ready",
      async () => {
        const v = await streamer.api.client.vods.get({ id: vodId }).catch(() => null);
        return v?.status === "ready" ? v : null;
      },
      { timeoutMs: VOD_TIMEOUT_MS, intervalMs: 3_000, signal },
    ),
  );
  const replay = await ctx.step(step("vods.chat returns both markers"), () =>
    waitFor(
      "both markers in vods.chat",
      async () => {
        const res = await streamer.api.client.vods.chat({ id: vodId, limit: 500 });
        return sent.every((m) => res.items.some((i) => i.body.trim() === m.marker)) ? res.items : null;
      },
      { timeoutMs: UI_TIMEOUT_MS, intervalMs: 1_000, signal },
    ),
  );
  const check = checkReplay(sent, replay);
  ctx.data("timelineWebReplay", check);
  ctx.assert(
    step(`replay is in media-time order, each within ${MEDIA_TS_TOLERANCE_MS} ms of the page's playhead`),
    check.ok,
    check,
  );
}
