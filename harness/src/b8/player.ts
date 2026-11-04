// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * B8-player's extensions (docs/testing/b8-selectors.md, "Scenarios"):
 *
 * - `watch-room` `edge-sync`: two Chromium members on different sources sync within today's
 *   target (under 500 ms), then a WebKit member joins them (under 1 s). The watch-room stack runs
 *   no relay, so the two sources are the latency gap a relay against the origin gives: one member
 *   holds back 3 s (`?targetLatency=`), the other 9 s, which is past chat's 5 s cap. Every member's
 *   `room.sync` frames carry `edgeWallclock` (batch 8), and the far member is pulled up to the cap
 *   measured from `max(edgeWallclock)`, not from the most advanced playhead.
 * - `relay-dvr` `relay-dvr-switch`: a Chromium player on the relay rewinds a minute, the relay
 *   stops (SIGTERM: it drains and leaves the active set), and the player keeps playing DVR, now
 *   from the origin (`dvrSwitchTo`), with no 403 and no jump to live. The relay is started again
 *   afterwards, so the scenario's later steps find it serving. `relay-dvr` is B8-harness's wave 2
 *   scenario; the orchestrator wires `stepRelayDvrSwitch` into it at that merge.
 *
 * No token is logged: DVR URLs are reduced to their origin and path.
 */
import type { Page, Response } from "playwright";
import { ROOM_LIMITS } from "@commonair/contracts/enums";
import { playerBundles } from "../player-server.ts";
import { sleep, waitFor } from "../wait.ts";
import { FORCED_LATENCIES } from "../w1/timeline-web.ts";
import { W1_ROUTES } from "../w1/selectors.ts";
import { liveChannel, waitDvrWindow } from "../w3/dvr-relay/index.ts";
import {
  CHROMIUM_DELTA_MS,
  createRoom,
  joinRoom,
  openMember,
  SYNC_SETTLE_MS,
  watchInRoom,
  WEBKIT_DELTA_MS,
} from "../w3/watch-rooms/index.ts";
import {
  behindRoomEdgeAt,
  edgeSummary,
  summarizeDelta,
  targetLeadSummary,
  type PlayheadSample,
  type TargetSample,
} from "../w3/watch-rooms/sync.ts";
import { WebSession } from "../web/session.ts";
import type { RelayDvrB8Extension, WatchRoomB8Extension } from "./kit.ts";
import { b8ExtensionTitle } from "./steps.ts";

/** How far past chat's cap a member may sit behind the room's edge (one report and a step's settle). */
export const EDGE_CAP_SLACK_MS = 1_500;

/** Batch 8 checks on one member's frames: it reports an edge on (nearly) every live frame, never behind its playhead, never in DVR. */
export function edgeReportsOk(s: ReturnType<typeof edgeSummary>): boolean {
  return s.live > 0 && s.withEdge >= Math.ceil(s.live * 0.8) && s.behindPlayhead === 0 && s.dvrWithEdge === 0;
}

/**
 * Whether chat's target sits the cap behind `max(edgeWallclock)` (within the slack), the batch 8
 * path: the far member is past the cap, so the target is the edge minus the cap. The batch 7
 * estimate, measured from the most advanced playhead, would put the target nearer the playheads
 * and the lead elsewhere. Needs a handful of frames, so one late frame does not decide it.
 */
export function targetLeadOk(s: ReturnType<typeof targetLeadSummary>): boolean {
  if (s.measured < 3 || s.medianMs === null) return false;
  return Math.abs(s.medianMs - ROOM_LIMITS.edgeCapSeconds * 1000) <= EDGE_CAP_SLACK_MS;
}

/** Whether every member sits no further behind the room's edge than the cap (plus slack). */
export function withinEdgeCap(behind: Readonly<Record<string, number>> | null, members: readonly string[]): boolean {
  if (!behind) return false;
  return members.every((m) => {
    const b = behind[m];
    return b !== undefined && b <= ROOM_LIMITS.edgeCapSeconds * 1000 + EDGE_CAP_SLACK_MS;
  });
}

/** One member's frames for the report: `[t, behind, edgeLead]` (ms), `edgeLead` null without an edge, `dvr` frames flagged. */
export interface EdgeSyncTrajectory {
  /** Harness clock (epoch ms) every `t` is measured from: the first frame either way. */
  t0: number | null;
  /** Per member: `[t, now - playhead, edge - playhead | null, dvr ? 1 : 0]` for each `room.sync` sent. */
  frames: Record<string, [number, number, number | null, 0 | 1][]>;
  /** Per member: `[t, now - target]` for each server `room.sync {target}` received. */
  targets: Record<string, [number, number][]>;
}

/**
 * The members' reported playheads, edges and the targets they received, compactly, relative to the
 * first frame (diagnostics for `edge-sync`; no user data, only timings).
 */
export function edgeSyncTrajectory(
  samples: Readonly<Record<string, readonly PlayheadSample[]>>,
  targets: Readonly<Record<string, readonly TargetSample[]>>,
): EdgeSyncTrajectory {
  const times = [
    ...Object.values(samples).flatMap((l) => l.map((s) => s.sentAt)),
    ...Object.values(targets).flatMap((l) => l.map((s) => s.receivedAt)),
  ];
  const t0 = times.length === 0 ? null : Math.min(...times);
  const base = t0 ?? 0;
  const frames: EdgeSyncTrajectory["frames"] = {};
  for (const [member, list] of Object.entries(samples))
    frames[member] = list.map((s) => [
      s.sentAt - base,
      Math.round(s.sentAt - s.pdt),
      s.edge === undefined || s.edge === null ? null : Math.round(s.edge - s.pdt),
      s.mode === "dvr" ? 1 : 0,
    ]);
  const received: EdgeSyncTrajectory["targets"] = {};
  for (const [member, list] of Object.entries(targets))
    received[member] = list.map((s) => [s.receivedAt - base, Math.round(s.receivedAt - s.target)]);
  return { t0, frames, targets: received };
}

export async function stepEdgeSync(run: WatchRoomB8Extension): Promise<void> {
  const { ctx } = run;
  const t = (what: string) => b8ExtensionTitle("edge-sync", what);
  const ch = await ctx.step(t("a live channel"), () => run.newChannel("wredge"));
  const [hostUser, guestUser, webkitUser] = await ctx.step(t("sign up two Chromium members and a WebKit one"), () =>
    Promise.all(["wreh", "wreg", "wrew"].map((prefix) => ctx.platform.signUp({ prefix }))),
  );
  if (!hostUser || !guestUser || !webkitUser) throw new Error("sign-up returned too few users");
  let roomId: string | null = null;
  const samples: Record<string, PlayheadSample[]> = {};
  const targets: Record<string, TargetSample[]> = {};
  const record = { roomId: () => roomId, samples, targets };
  const [near, far] = await ctx.step(t("the Chromium members sign in"), () =>
    Promise.all([
      openMember(run, "near", hostUser, "chromium", record),
      openMember(run, "far", guestUser, "chromium", record),
    ]),
  );
  if (!near || !far) throw new Error("no members");
  // Through the API, so each member then loads the channel with its own forced latency.
  const room = await ctx.step(t("the host opens a room"), () => createRoom(run, near.user, ch.channel));
  roomId = room.roomId;
  const refused = await ctx.step(t("the guest joins"), () => joinRoom(run, far.user, room));
  ctx.assert(t("the guest is admitted"), refused === null, { refused });
  await ctx.step(
    t(`the members play ${FORCED_LATENCIES.near} s and ${FORCED_LATENCIES.far} s behind live (two sources)`),
    async () => {
      await near.session.goto(W1_ROUTES.channel(ch.channel, { targetLatency: FORCED_LATENCIES.near }));
      await far.session.goto(W1_ROUTES.channel(ch.channel, { targetLatency: FORCED_LATENCIES.far }));
      await Promise.all([near, far].map((m) => watchInRoom(m, ch.channel, room.roomId)));
    },
  );
  await ctx.step(t(`play together for ${SYNC_SETTLE_MS / 1000} s`), () => sleep(SYNC_SETTLE_MS, ctx.signal));
  const settledAt = Date.now();

  // Diagnostics: every frame, so a failing run shows how the members moved, not only where they ended.
  ctx.data("edgeSyncTrajectory", edgeSyncTrajectory(samples, targets));
  const chromiumEdges = { near: edgeSummary(samples.near ?? []), far: edgeSummary(samples.far ?? []) };
  ctx.data("edgeSyncChromiumEdges", chromiumEdges);
  for (const [label, s] of Object.entries(chromiumEdges))
    ctx.assert(t(`${label}'s room.sync frames carry edgeWallclock`), edgeReportsOk(s), s);
  const behind = behindRoomEdgeAt(samples, Date.now());
  ctx.data("edgeSyncBehindEdge", behind);
  ctx.assert(
    t(`both members sit within ${ROOM_LIMITS.edgeCapSeconds} s of max(edgeWallclock) (the far one was pulled up)`),
    withinEdgeCap(behind, ["near", "far"]),
    { behind },
  );
  // The target chat sends, against the edges the members report: the cap from max(edgeWallclock).
  const lead = targetLeadSummary(samples, targets.near ?? [], settledAt - 10_000, settledAt);
  ctx.data("edgeSyncTargetLead", lead);
  ctx.metric("edge_sync_target_lead_ms", lead.medianMs, "ms");
  ctx.assert(
    t(`chat's target sits ${ROOM_LIMITS.edgeCapSeconds} s behind max(edgeWallclock) (the batch 8 cap)`),
    targetLeadOk(lead),
    lead,
  );
  const chromium = summarizeDelta(samples, ["near", "far"], Date.now());
  ctx.data("edgeSyncChromiumDelta", chromium);
  ctx.metric("edge_sync_chromium_delta_ms", chromium.p90Ms, "ms");
  ctx.assert(
    t(`the Chromium members are within ${CHROMIUM_DELTA_MS} ms (p90 over the last 8 s)`),
    chromium.p90Ms !== null && chromium.p90Ms < CHROMIUM_DELTA_MS,
    chromium,
  );

  const webkit = await ctx.step(t("the WebKit member signs in and joins"), async () => {
    const m = await openMember(run, "webkit", webkitUser, "webkit", record);
    const code = await joinRoom(run, m.user, room);
    if (code !== null) throw new Error(`the WebKit member was refused: ${code}`);
    return m;
  });
  await ctx.step(t("the WebKit member plays live in the room"), () => watchInRoom(webkit, ch.channel, room.roomId));
  await ctx.step(t(`play together for ${SYNC_SETTLE_MS / 1000} s`), () => sleep(SYNC_SETTLE_MS, ctx.signal));
  const webkitEdges = edgeSummary(samples.webkit ?? []);
  ctx.data("edgeSyncWebkitEdges", webkitEdges);
  // Native HLS reports its edge from `seekable`; a WebKit build without it still syncs on the others' edges.
  ctx.check(t("WebKit's room.sync frames carry edgeWallclock"), edgeReportsOk(webkitEdges), webkitEdges);
  const pairs = ["near", "far"].map((m) => summarizeDelta(samples, [m, "webkit"], Date.now()));
  const p90s = pairs.map((p) => p.p90Ms);
  ctx.data("edgeSyncWebkitDelta", pairs);
  const max = p90s.every((p) => p !== null) ? Math.max(...(p90s as number[])) : null;
  ctx.metric("edge_sync_webkit_delta_ms", max, "ms");
  ctx.assert(
    t(`WebKit is within ${WEBKIT_DELTA_MS} ms of both members (p90 over the last 8 s)`),
    max !== null && max < WEBKIT_DELTA_MS,
    { p90s },
  );
}

// ------------------------------------------------------------ relay-dvr-switch

/** One `/dvr/` response the page saw: where it came from (origin only, never the token), status, when. */
export interface DvrFetch {
  origin: string;
  status: number;
  at: number;
}

/** What a page's DVR fetches say since `since`: by source, 403s, and the last one from each source. */
export function dvrFetchSummary(
  fetches: readonly DvrFetch[],
  hosts: { relay: string; origin: string },
  since: number,
): {
  relay: number;
  origin: number;
  other: number;
  forbidden: number;
  lastRelayAt: number | null;
  firstOriginOkAt: number | null;
} {
  const relay = new URL(hosts.relay).origin;
  const origin = new URL(hosts.origin).origin;
  const out = {
    relay: 0,
    origin: 0,
    other: 0,
    forbidden: 0,
    lastRelayAt: null as number | null,
    firstOriginOkAt: null as number | null,
  };
  for (const f of fetches) {
    if (f.at < since) continue;
    if (f.status === 403) out.forbidden++;
    if (f.origin === relay) {
      out.relay++;
      out.lastRelayAt = Math.max(out.lastRelayAt ?? f.at, f.at);
    } else if (f.origin === origin) {
      out.origin++;
      if (f.status >= 200 && f.status < 300) out.firstOriginOkAt = Math.min(out.firstOriginOkAt ?? f.at, f.at);
    } else out.other++;
  }
  return out;
}

const RELAY_DVR_BEHIND_SECONDS = 60;
/** A relay-assigned page within this many loads (one relay: about half of them). */
const MAX_LOADS = 20;
const PLAYING_TIMEOUT_MS = 90_000;
const UI_TIMEOUT_MS = 30_000;
/** The relay drains (it leaves the active set at once), then the next beat (~10 s) moves the session. */
const SWITCH_TIMEOUT_MS = 45_000;
/** How long DVR must keep playing from the origin after the switch. */
const AFTER_SWITCH_MS = 20_000;
/** The readout may move a little (a segment boundary, the load time); a jump to live would be > 40 s. */
const POSITION_TOLERANCE_SECONDS = 20;

const player = (page: Page) => page.locator('[data-testid="player"]');

async function behindReadout(page: Page): Promise<number | null> {
  const v = await page
    .locator('[data-testid="player-dvr-behind"]')
    .getAttribute("data-seconds", { timeout: 2_000 })
    .catch(() => null);
  const n = Number(v);
  return v === null || !Number.isFinite(n) ? null : n;
}

export async function stepRelayDvrSwitch(ext: RelayDvrB8Extension): Promise<void> {
  const { ctx, check } = ext;
  const t = (what: string) => b8ExtensionTitle("relay-dvr-switch", what);
  ctx.assert(t("the relay is running"), ext.relay.running);
  const ch = await ctx.step(t("a streamer goes live with VODs on (recording)"), () =>
    liveChannel(ext, "b8rdvr", { vods: true }),
  );
  await ctx.step(t(`the DVR window reaches ${RELAY_DVR_BEHIND_SECONDS + 30} s`), () =>
    waitDvrWindow(ctx, ch.channel, RELAY_DVR_BEHIND_SECONDS + 30),
  );

  const session = await WebSession.open({
    fleet: ctx.platform.fleet,
    engine: "chromium",
    webUrl: ctx.env.HARNESS_WEB_URL,
    probeScript: (await playerBundles()).probe,
    label: "b8-relay-dvr",
    log: ctx.log,
  });
  ctx.defer(() => session.close());
  const fetches: DvrFetch[] = [];
  const failed: { origin: string; at: number }[] = [];
  const page = await ctx.step(t("a Chromium player lands on the relay"), async () => {
    for (let i = 0; i < MAX_LOADS; i++) {
      const p = await session.goto(`/${ch.channel}`);
      await p.locator('[data-testid="player"][data-state="playing"]').waitFor({ timeout: PLAYING_TIMEOUT_MS });
      if ((await player(p).getAttribute("data-source")) === "relay") return p;
    }
    throw new Error(`no relay-assigned player in ${MAX_LOADS} loads`);
  });
  page.on("response", (r: Response) => {
    const u = new URL(r.url());
    if (u.pathname.includes("/dvr/")) fetches.push({ origin: u.origin, status: r.status(), at: Date.now() });
  });
  page.on("requestfailed", (r) => {
    const u = new URL(r.url());
    if (u.pathname.includes("/dvr/")) failed.push({ origin: u.origin, at: Date.now() });
  });

  await ctx.step(t("the player rewinds a minute on the relay (Page Down)"), async () => {
    await player(page).hover();
    await page.locator('[data-testid="player-dvr-scrubber"] input[type="range"]').focus({ timeout: UI_TIMEOUT_MS });
    await page.keyboard.press("PageDown");
    await page.locator('[data-testid="player"][data-playback-mode="dvr"]').waitFor({ timeout: UI_TIMEOUT_MS });
    await waitFor(
      "a DVR fetch from the relay",
      async () => fetches.some((f) => f.origin === new URL(ext.relay.url).origin && f.status === 200) || null,
      { timeoutMs: UI_TIMEOUT_MS, intervalMs: 250, signal: ctx.signal },
    );
  });
  const before = await behindReadout(page);
  ctx.data("relayDvrSwitchBehindBefore", before);

  const t0 = Date.now();
  const exited = ext.relay.terminate();
  await ctx.step(t("SIGTERM: the relay drains; the player moves live and DVR to the origin"), async () => {
    await page.locator('[data-testid="player"][data-source="origin"]').waitFor({ timeout: SWITCH_TIMEOUT_MS });
    await waitFor(
      "a DVR fetch from the origin",
      async () =>
        dvrFetchSummary(fetches, { relay: ext.relay.url, origin: ctx.env.HARNESS_ORIGIN_URL }, t0).firstOriginOkAt,
      { timeoutMs: SWITCH_TIMEOUT_MS, intervalMs: 250, signal: ctx.signal },
    );
  });
  ctx.metric("relay_dvr_switch_ms", Date.now() - t0, "ms");
  await ctx.step(t(`DVR keeps playing for ${AFTER_SWITCH_MS / 1000} s`), () => sleep(AFTER_SWITCH_MS, ctx.signal));

  const summary = dvrFetchSummary(fetches, { relay: ext.relay.url, origin: ctx.env.HARNESS_ORIGIN_URL }, t0);
  const after = await behindReadout(page);
  const mode = await player(page).getAttribute("data-playback-mode");
  const state = await player(page).getAttribute("data-state");
  ctx.data("relayDvrSwitch", { summary, before, after, mode, state, failedRequests: failed.length });
  ctx.assert(t("no DVR fetch answered 403"), summary.forbidden === 0, summary);
  ctx.assert(t("the player is still playing DVR (no jump to live)"), mode === "dvr" && state === "playing", {
    mode,
    state,
  });
  ctx.assert(t("DVR now comes from the origin"), summary.firstOriginOkAt !== null && summary.other === 0, summary);
  const switchedAt = summary.firstOriginOkAt ?? Date.now();
  const relayAfter = fetches.filter((f) => f.at > switchedAt && f.origin === new URL(ext.relay.url).origin).length;
  check(t("no DVR fetch goes to the relay after the switch"), relayAfter === 0, { relayAfter });
  check(
    t(`the position is kept (within ${POSITION_TOLERANCE_SECONDS} s of the readout before)`),
    before !== null && after !== null && Math.abs(after - before) <= POSITION_TOLERANCE_SECONDS,
    { before, after },
  );

  // Leave the relay serving for whatever the scenario runs next.
  await ctx.step(t("the relay exits, then starts again"), async () => {
    await exited;
    ext.relay.start();
    await ext.relay.waitHealthy(30_000, ctx.signal);
  });
  await session.close();
}
