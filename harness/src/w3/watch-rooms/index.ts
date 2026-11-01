// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `watch-room` steps 1–8 (docs/testing/b7-selectors.md, "Scenarios"; feature-wins §4.13; ADR 0017)
 * and their run state.
 *
 * - Steps 1 and 2 share the sync channel: four Chromium members (step 1), then a WebKit one
 *   (step 2). Sync is measured from the `room.sync` frames each page sends (`./sync.ts`).
 * - Steps 3, 5, 6, 7 and 8 share a plain live channel; step 4 has its own mature one.
 * - Every step signs up its own actors (no named thing is shared between steps), and every
 *   refusal sets up its own room.
 * - `via=web` drives the drawer (create, invite, join, the refusal message, the report action);
 *   `via=api` makes the same calls through the API, and the sync steps still play in browsers.
 * - Database reads and the direct insert use `DATABASE_URL`; retention runs through the b7 test
 *   hooks (`OPS_TEST_HOOKS`). No token, nonce or email is logged.
 */
import { B7JobResult, INTERNAL_ROUTES, INTERNAL_SECRET_HEADER, WATCH_ROOM_JOBS } from "@commonair/contracts/internal";
import type { Page, WebSocket } from "playwright";
import type { BrowserEngine } from "../../browser-viewer.ts";
import type { Via } from "../../money.ts";
import { playerBundles } from "../../player-server.ts";
import { internalSecret } from "../../safety-io.ts";
import type { ScenarioContext } from "../../scenario.ts";
import type { Streamer } from "../../streamer.ts";
import type { SignedInUser } from "../../users.ts";
import { sleep, waitFor } from "../../wait.ts";
import { signInViaUi } from "../../web/flows.ts";
import { ROUTES } from "../../web/selectors.ts";
import { WebSession } from "../../web/session.ts";
import { type WatchRoomStep, watchRoomTitle } from "../steps.ts";
import { directMemberInsert, reportRow, roomCounts } from "./db.ts";
import { refusalCode, summarizeDelta, syncFrameOf, type PlayheadSample } from "./sync.ts";

/** Watch-room test ids (docs/testing/b7-selectors.md "Watch rooms"). */
export const WR = {
  open: "watch-room-open",
  drawer: "watch-room-drawer",
  create: "watch-room-create",
  bandNotice: "watch-room-band-notice",
  matureNotice: "watch-room-mature-notice",
  inviteLink: "watch-room-invite-link",
  join: "watch-room-join",
  joinRefused: "watch-room-join-refused",
  member: "watch-room-member",
  chat: "watch-room-chat",
  input: "watch-room-input",
  send: "watch-room-send",
  message: "watch-room-message",
  report: "watch-room-report",
} as const;

/** Decision (r) targets; the step reads the p90 spread over the last 8 s of reports. */
export const CHROMIUM_DELTA_MS = 500;
export const WEBKIT_DELTA_MS = 1_000;
/** How long the members play together before the sync is measured. */
export const SYNC_SETTLE_MS = 30_000;
/** A minor on the scenario's day (13+, under 18). */
export const MINOR_BIRTH_DATE = `${new Date().getUTCFullYear() - 15}-01-15`;

const LIVE_TIMEOUT_MS = 60_000;
const UI_TIMEOUT_MS = 30_000;
const PLAYING_TIMEOUT_MS = 90_000;
const HOOK_TIMEOUT_MS = 75_000;

export interface LiveChannel {
  owner: SignedInUser;
  channel: string;
  encoder: Streamer;
}

interface Member {
  label: string;
  user: SignedInUser;
  session: WebSession;
  page: Page;
}

export interface WatchRoomRun {
  ctx: ScenarioContext;
  via: Via;
  /** The sync channel (steps 1 and 2) and the plain one (steps 3, 5–8). */
  syncChannel(): Promise<LiveChannel>;
  plainChannel(): Promise<LiveChannel>;
  newChannel(prefix: string, opts?: { mature?: boolean }): Promise<LiveChannel>;
  /** Step 1's room, members and playhead samples (step 2 joins them). */
  sync: { roomId: string; members: Member[]; samples: Record<string, PlayheadSample[]> } | null;
}

/** Set up what the selected steps share (channels start on first use, so any step runs alone). */
export async function newWatchRoomRun(ctx: ScenarioContext, opts: { via: Via }): Promise<WatchRoomRun> {
  let syncCh: Promise<LiveChannel> | null = null;
  let plainCh: Promise<LiveChannel> | null = null;
  const run: WatchRoomRun = {
    ctx,
    via: opts.via,
    syncChannel: () => (syncCh ??= liveChannel(ctx, "wrsync")),
    plainChannel: () => (plainCh ??= liveChannel(ctx, "wrplain")),
    newChannel: (prefix, o) => liveChannel(ctx, prefix, o),
    sync: null,
  };
  return run;
}

async function liveChannel(
  ctx: ScenarioContext,
  prefix: string,
  opts: { mature?: boolean } = {},
): Promise<LiveChannel> {
  const p = ctx.platform;
  const owner = await p.signUp({ prefix });
  const channel = owner.me.channelSlug ?? owner.username;
  if (opts.mature) await owner.api.client.channels.update({ channel, mature: true });
  const encoder = await p.streamerFor(owner, { protocol: "rtmp", width: 640, height: 360, bitrateKbps: 800 });
  ctx.defer(() => encoder.stop());
  await encoder.start();
  await p.waitForLive(channel, true, LIVE_TIMEOUT_MS);
  return { owner, channel, encoder };
}

const sel = (id: string, data: Record<string, string> = {}) =>
  `[data-testid="${id}"]` +
  Object.entries(data)
    .map(([k, v]) => `[data-${k}="${v}"]`)
    .join("");

/** Open a signed-in browser session for `user`, recording its room sync frames into `samples`. */
async function openMember(
  run: WatchRoomRun,
  label: string,
  user: SignedInUser,
  engine: BrowserEngine,
  record?: { roomId: () => string | null; samples: Record<string, PlayheadSample[]> },
): Promise<Member> {
  const { ctx } = run;
  const session = await WebSession.open({
    fleet: ctx.platform.fleet,
    engine,
    webUrl: ctx.env.HARNESS_WEB_URL,
    probeScript: (await playerBundles()).probe,
    label: `watch-room-${label}`,
    log: ctx.log,
  });
  ctx.defer(() => session.close());
  const page = await session.goto(ROUTES.signin);
  await signInViaUi(page, user, UI_TIMEOUT_MS, ctx.signal);
  if (record) {
    const list: PlayheadSample[] = [];
    record.samples[label] = list;
    page.on("websocket", (ws: WebSocket) => {
      ws.on("framesent", ({ payload }) => {
        const roomId = record.roomId();
        if (!roomId) return;
        const f = syncFrameOf(payload, roomId);
        if (f) list.push({ sentAt: Date.now(), ...f });
      });
    });
  }
  return { label, user, session, page };
}

async function openDrawer(page: Page): Promise<void> {
  const drawer = page.locator(sel(WR.drawer));
  if (await drawer.isVisible().catch(() => false)) return;
  await page.locator(sel(WR.open)).click({ timeout: UI_TIMEOUT_MS });
  await drawer.waitFor({ timeout: UI_TIMEOUT_MS });
}

/** The host opens a room on `channel`; returns its id and the invite path (`/<slug>?room=&invite=`). */
async function createRoom(run: WatchRoomRun, host: Member | SignedInUser, channel: string) {
  const user = "user" in host ? host.user : host;
  if (run.via === "web" && "page" in host) {
    await host.session.goto(`/${channel}`);
    await openDrawer(host.page);
    await host.page.locator(sel(WR.create)).click({ timeout: UI_TIMEOUT_MS });
    const link = host.page.locator(sel(WR.inviteLink));
    await link.waitFor({ timeout: UI_TIMEOUT_MS });
    const url = new URL(await link.inputValue());
    const roomId = url.searchParams.get("room");
    if (!roomId) throw new Error("the invite link carries no room");
    return { roomId, invitePath: url.pathname + url.search, nonce: url.searchParams.get("invite") ?? "" };
  }
  const room = await user.api.client.watchRooms.create({ channel });
  const url = new URL(room.invite.url);
  return { roomId: room.id, invitePath: url.pathname + url.search, nonce: room.invite.nonce };
}

/** A member joins through the invite; resolves with null, or the refusal code. */
async function joinRoom(
  run: WatchRoomRun,
  member: Member | SignedInUser,
  room: { roomId: string; invitePath: string; nonce: string },
): Promise<string | null> {
  if (run.via === "web" && "page" in member) {
    await member.session.goto(room.invitePath);
    await member.page.locator(sel(WR.join)).click({ timeout: UI_TIMEOUT_MS });
    const joined = member.page.locator(sel(WR.drawer, { "room-id": room.roomId }));
    const refused = member.page.locator(sel(WR.joinRefused));
    await Promise.race([joined.waitFor({ timeout: UI_TIMEOUT_MS }), refused.waitFor({ timeout: UI_TIMEOUT_MS })]);
    if (await refused.isVisible().catch(() => false)) return (await refused.getAttribute("data-code")) ?? "unknown";
    return null;
  }
  const user = "user" in member ? member.user : member;
  try {
    await user.api.client.watchRooms.join({ id: room.roomId, nonce: room.nonce });
    return null;
  } catch (err) {
    const code = refusalCode(err);
    if (code) return code;
    throw err;
  }
}

/** A browser member watching the room: the channel page, playing live, the drawer on the room. */
async function watchInRoom(member: Member, channel: string, roomId: string): Promise<void> {
  if (!member.page.url().includes(`/${channel}`)) await member.session.goto(`/${channel}`);
  await member.page.locator(`[data-testid="player"][data-state="playing"]`).waitFor({ timeout: PLAYING_TIMEOUT_MS });
  await openDrawer(member.page);
  await member.page.locator(sel(WR.drawer, { "room-id": roomId })).waitFor({ timeout: UI_TIMEOUT_MS });
}

/** The b7 test hooks (`OPS_TEST_HOOKS`). */
async function hook(ctx: ScenarioContext, path: string, body: unknown): Promise<Response> {
  const secret = internalSecret(ctx.env);
  if (!secret) throw new Error("INTERNAL_API_SECRET is not set: the watch-room test hooks need it");
  const res = await fetch(new URL(path, ctx.env.HARNESS_API_URL), {
    method: "POST",
    headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: secret },
    body: JSON.stringify(body),
    signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(HOOK_TIMEOUT_MS)]),
  });
  if (res.status === 404) throw new Error(`${path} answered 404: the b7 test hooks are off (OPS_TEST_HOOKS=true)`);
  if (!res.ok) throw new Error(`${path} answered HTTP ${res.status}`);
  return res;
}

function needDatabase(ctx: ScenarioContext): string {
  const url = ctx.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set: the watch-room steps read and insert rows directly");
  return url;
}

// ------------------------------------------------------------------ steps

async function stepChromiumSync(run: WatchRoomRun): Promise<void> {
  const { ctx } = run;
  const t = (what: string) => watchRoomTitle(1, what);
  const ch = await ctx.step(t("the sync channel is live"), () => run.syncChannel());
  const users = await ctx.step(t("sign up four members"), () =>
    Promise.all([0, 1, 2, 3].map((i) => ctx.platform.signUp({ prefix: `wrm${i}` }))),
  );
  let roomId: string | null = null;
  const samples: Record<string, PlayheadSample[]> = {};
  const members = await ctx.step(t("four Chromium members sign in"), () =>
    Promise.all(users.map((u, i) => openMember(run, `chromium${i}`, u, "chromium", { roomId: () => roomId, samples }))),
  );
  const [host, ...guests] = members;
  if (!host) throw new Error("no host");
  const room = await ctx.step(t("the host opens a room (watch-room-create)"), () => createRoom(run, host, ch.channel));
  roomId = room.roomId;
  for (const g of guests) {
    const refused = await ctx.step(t(`${g.label} joins through the invite (watch-room-join)`), () =>
      joinRoom(run, g, room),
    );
    ctx.assert(t(`${g.label} is admitted`), refused === null, { refused });
  }
  await ctx.step(t("every member plays live with the room drawer open"), () =>
    Promise.all(members.map((m) => watchInRoom(m, ch.channel, room.roomId))),
  );
  // A drawer re-reads the members on each `room.state`, which chat sends when a member's room socket
  // joins; the last joiner's socket can connect after its page reports the drawer, so wait for it.
  const want = members.map((m) => m.user.id).sort();
  let listed: Record<string, string[]> = {};
  const settled = await waitFor(
    "every drawer lists the four members",
    async () => {
      listed = {};
      for (const m of members) {
        const ids = await m.page
          .locator(sel(WR.member))
          .evaluateAll((els) => els.map((el) => el.getAttribute("data-user-id") ?? ""));
        listed[m.label] = ids.sort();
      }
      return Object.values(listed).every((ids) => ids.join() === want.join()) || null;
    },
    { timeoutMs: UI_TIMEOUT_MS, intervalMs: 250, signal: ctx.signal },
  ).catch(() => false);
  ctx.check(t("the drawer lists four members"), settled === true, {
    count: listed[host.label]?.length ?? 0,
    counts: Object.fromEntries(Object.entries(listed).map(([k, v]) => [k, v.length])),
  });
  await ctx.step(t(`play together for ${SYNC_SETTLE_MS / 1000} s`), () => sleep(SYNC_SETTLE_MS, ctx.signal));
  const summary = summarizeDelta(
    samples,
    members.map((m) => m.label),
    Date.now(),
  );
  ctx.data("watchRoomChromiumDelta", summary);
  ctx.metric("watch_room_chromium_delta_ms", summary.p90Ms, "ms");
  ctx.assert(
    t(`the members' playheads are within ${CHROMIUM_DELTA_MS} ms (p90 over the last 8 s)`),
    summary.p90Ms !== null && summary.p90Ms < CHROMIUM_DELTA_MS,
    summary,
  );
  run.sync = { roomId: room.roomId, members, samples };
}

async function stepWebkitSync(run: WatchRoomRun): Promise<void> {
  const { ctx } = run;
  const t = (what: string) => watchRoomTitle(2, what);
  const sync = run.sync;
  if (!sync) throw new Error("step 2 needs step 1's room");
  const ch = await run.syncChannel();
  const user = await ctx.step(t("sign up the WebKit member"), () => ctx.platform.signUp({ prefix: "wrwk" }));
  const member = await ctx.step(t("the WebKit member signs in"), () =>
    openMember(run, "webkit", user, "webkit", { roomId: () => sync.roomId, samples: sync.samples }),
  );
  const host = sync.members[0]!;
  const invite = await ctx.step(t("the host makes a new invite"), async () => {
    const inv = await host.user.api.client.watchRooms.invite({ id: sync.roomId });
    const url = new URL(inv.url);
    return { roomId: sync.roomId, invitePath: url.pathname + url.search, nonce: inv.nonce };
  });
  const refused = await ctx.step(t("the WebKit member joins"), () => joinRoom(run, member, invite));
  ctx.assert(t("the WebKit member is admitted"), refused === null, { refused });
  await ctx.step(t("the WebKit member plays live in the room"), () => watchInRoom(member, ch.channel, sync.roomId));
  await ctx.step(t(`play together for ${SYNC_SETTLE_MS / 1000} s`), () => sleep(SYNC_SETTLE_MS, ctx.signal));
  // WebKit against the room: the spread between it and the Chromium members.
  const worst = sync.members.map((m) => summarizeDelta(sync.samples, [m.label, "webkit"], Date.now()));
  const p90s = worst.map((s) => s.p90Ms);
  ctx.data("watchRoomWebkitDelta", worst);
  const max = p90s.every((m) => m !== null) ? Math.max(...(p90s as number[])) : null;
  ctx.metric("watch_room_webkit_delta_ms", max, "ms");
  ctx.assert(
    t(`WebKit is within ${WEBKIT_DELTA_MS} ms of every member (p90 over the last 8 s)`),
    max !== null && max < WEBKIT_DELTA_MS,
    { p90s },
  );
}

/** A host with a room on the plain channel, made through the API (the refusal steps' setup). */
async function apiRoom(run: WatchRoomRun, prefix: string, channel: LiveChannel, birthDate?: string) {
  const host = await run.ctx.platform.signUp({ prefix, ...(birthDate ? { birthDate } : {}) });
  const room = await host.api.client.watchRooms.create({ channel: channel.channel });
  const url = new URL(room.invite.url);
  return { host, room: { roomId: room.id, invitePath: url.pathname + url.search, nonce: room.invite.nonce } };
}

/** A joiner for a refusal: a browser session under `via=web`, the API otherwise. */
async function joiner(run: WatchRoomRun, label: string, user: SignedInUser): Promise<Member | SignedInUser> {
  return run.via === "web" ? openMember(run, label, user, "chromium") : user;
}

async function stepMixedAge(run: WatchRoomRun): Promise<void> {
  const { ctx } = run;
  const t = (what: string) => watchRoomTitle(3, what);
  const ch = await ctx.step(t("the plain channel is live"), () => run.plainChannel());
  const { room } = await ctx.step(t("an adult opens a room"), () => apiRoom(run, "wrah", ch));
  const minor = await ctx.step(t("sign up a minor"), () =>
    ctx.platform.signUp({ prefix: "wrmn", birthDate: MINOR_BIRTH_DATE }),
  );
  const who = await joiner(run, "minor", minor);
  const code = await ctx.step(t("the minor's join is refused (watch-room-join-refused)"), () =>
    joinRoom(run, who, room),
  );
  ctx.assert(t("refused with room_age_band"), code === "room_age_band", { code });
  const insert = await ctx.step(t("a direct insert of the minor is refused by the trigger"), () =>
    directMemberInsert(needDatabase(ctx), room.roomId, minor.id),
  );
  ctx.assert(
    t("the trigger refuses the mixed-age member"),
    insert.refused && /room_age_band/.test(insert.message ?? ""),
    {
      sqlState: insert.sqlState,
      message: insert.message,
    },
  );
  // And the other way: an adult cannot enter a minor room.
  const minorRoom = await ctx.step(t("a minor opens a room"), () => apiRoom(run, "wrmh", ch, MINOR_BIRTH_DATE));
  const adult = await ctx.step(t("sign up an adult"), () => ctx.platform.signUp({ prefix: "wrad" }));
  const adultCode = await ctx.step(t("the adult's join of the minor room is refused"), () =>
    joinRoom(run, adult, minorRoom.room),
  );
  ctx.assert(t("refused with room_age_band (adult into a minor room)"), adultCode === "room_age_band", { adultCode });
  const adultInsert = await directMemberInsert(needDatabase(ctx), minorRoom.room.roomId, adult.id);
  ctx.assert(t("the trigger refuses the adult in the minor room"), adultInsert.refused, {
    sqlState: adultInsert.sqlState,
  });
}

async function stepMatureMinor(run: WatchRoomRun): Promise<void> {
  const { ctx } = run;
  const t = (what: string) => watchRoomTitle(4, what);
  const ch = await ctx.step(t("a mature channel is live"), () => run.newChannel("wrmat", { mature: true }));
  const host = await ctx.step(t("an adult confirms mature viewing"), async () => {
    const u = await ctx.platform.signUp({ prefix: "wrmah" });
    await u.api.client.me.confirmMature();
    return u;
  });
  const created = await ctx.step(t("the adult opens a room on the mature channel"), () =>
    host.api.client.watchRooms.create({ channel: ch.channel }),
  );
  ctx.assert(t("the room is adult and mature"), created.ageBand === "adult" && created.mature, {
    ageBand: created.ageBand,
    mature: created.mature,
  });
  const url = new URL(created.invite.url);
  const room = { roomId: created.id, invitePath: url.pathname + url.search, nonce: created.invite.nonce };
  const minor = await ctx.step(t("sign up a minor"), () =>
    ctx.platform.signUp({ prefix: "wrmm", birthDate: MINOR_BIRTH_DATE }),
  );
  const code = await ctx.step(t("the minor's join is refused"), async () =>
    joinRoom(run, await joiner(run, "mature-minor", minor), room),
  );
  ctx.assert(t("refused with room_mature_minor"), code === "room_mature_minor", { code });
  const minorHost = await ctx.step(t("a minor cannot open a room on it either"), async () => {
    try {
      await minor.api.client.watchRooms.create({ channel: ch.channel });
      return null;
    } catch (err) {
      return refusalCode(err);
    }
  });
  ctx.assert(t("create refused with room_mature_minor"), minorHost === "room_mature_minor", { minorHost });
}

async function stepChannelBan(run: WatchRoomRun): Promise<void> {
  const { ctx } = run;
  const t = (what: string) => watchRoomTitle(5, what);
  const ch = await ctx.step(t("the plain channel is live"), () => run.plainChannel());
  const { room } = await ctx.step(t("an adult opens a room"), () => apiRoom(run, "wrbh", ch));
  const banned = await ctx.step(t("sign up a viewer the channel bans"), async () => {
    const u = await ctx.platform.signUp({ prefix: "wrbn" });
    await ch.owner.api.client.chat.bans.ban({ channel: ch.channel, username: u.username });
    return u;
  });
  const code = await ctx.step(t("the banned viewer's join is refused"), async () =>
    joinRoom(run, await joiner(run, "banned", banned), room),
  );
  ctx.assert(t("refused with room_banned"), code === "room_banned", { code });
}

async function stepBlockedPair(run: WatchRoomRun): Promise<void> {
  const { ctx } = run;
  const t = (what: string) => watchRoomTitle(6, what);
  const ch = await ctx.step(t("the plain channel is live"), () => run.plainChannel());
  const { host, room } = await ctx.step(t("an adult opens a room"), () => apiRoom(run, "wrkh", ch));
  const [blocker, blocked] = await ctx.step(t("sign up a blocker and the person the host blocks"), () =>
    Promise.all([ctx.platform.signUp({ prefix: "wrkb" }), ctx.platform.signUp({ prefix: "wrkd" })]),
  );
  if (!blocker || !blocked) throw new Error("sign-up returned nothing");
  // Either direction: the joiner blocked the host, and the host blocked the other joiner.
  await blocker.api.client.me.blocks.add({ username: host.username });
  await host.api.client.me.blocks.add({ username: blocked.username });
  const first = await ctx.step(t("a joiner who blocked the host is refused"), async () =>
    joinRoom(run, await joiner(run, "blocker", blocker), room),
  );
  ctx.assert(t("refused with room_blocked (joiner blocked a member)"), first === "room_blocked", { first });
  const second = await ctx.step(t("a joiner the host blocked is refused"), () => joinRoom(run, blocked, room));
  ctx.assert(t("refused with room_blocked (a member blocked the joiner)"), second === "room_blocked", { second });
}

async function stepReport(run: WatchRoomRun): Promise<{ roomId: string }> {
  const { ctx } = run;
  const t = (what: string) => watchRoomTitle(7, what);
  const ch = await ctx.step(t("the plain channel is live"), () => run.plainChannel());
  const marker = `watch-room ${ctx.runId.slice(-8)} ${Date.now().toString(36)}`;
  const reporter = await ctx.step(t("sign up the reporting member"), () => ctx.platform.signUp({ prefix: "wrrp" }));
  const { host, room } = await ctx.step(t("an adult opens a room"), () => apiRoom(run, "wrrh", ch));
  const member = await ctx.step(t("the member signs in and joins"), async () => {
    const m = await openMember(run, "reporter", reporter, "chromium");
    const code = await joinRoom({ ...run, via: "web" }, m, room);
    if (code) throw new Error(`the reporting member was refused: ${code}`);
    await watchInRoom(m, ch.channel, room.roomId);
    return m;
  });
  await ctx.step(t("the member sends a room message (watch-room-send)"), async () => {
    await member.page.locator(sel(WR.input)).fill(marker, { timeout: UI_TIMEOUT_MS });
    await member.page.locator(sel(WR.send)).click({ timeout: UI_TIMEOUT_MS });
    await member.page
      .locator(sel(WR.message, { "user-id": reporter.id }))
      .first()
      .waitFor({ timeout: UI_TIMEOUT_MS });
  });
  const reportId = await ctx.step(t("the member reports the room"), async () => {
    if (run.via === "web") {
      await member.page.locator(sel(WR.report)).first().click({ timeout: UI_TIMEOUT_MS });
      await member.page.locator(sel("report-reason")).click({ timeout: UI_TIMEOUT_MS });
      await member.page.locator(sel("report-reason-harassment")).click({ timeout: UI_TIMEOUT_MS });
      const created = member.page.waitForResponse(
        (r) => /\/(safety\/report|reports)\b/.test(new URL(r.url()).pathname) && r.request().method() === "POST",
        {
          timeout: UI_TIMEOUT_MS,
        },
      );
      await member.page.locator(sel("report-submit")).click({ timeout: UI_TIMEOUT_MS });
      const body = (await (await created).json()) as { id?: string; json?: { id?: string } };
      const id = body.id ?? body.json?.id;
      if (!id) throw new Error("the report answer carried no id");
      return id;
    }
    const r = await reporter.api.client.safety.report({
      subjectType: "watch_room",
      subjectId: room.roomId,
      reason: "harassment",
      details: "",
    });
    return r.id;
  });
  const row = await ctx.step(t("the report row carries the transcript"), () => reportRow(needDatabase(ctx), reportId));
  ctx.assert(t("the report exists"), row !== null);
  ctx.assert(t("the report has no channel (platform queue only)"), row?.channelId === null, {
    channelId: row?.channelId,
  });
  const evidence = (row?.evidence ?? {}) as {
    messages?: { userId?: string; body?: string }[];
    members?: { userId?: string }[];
  };
  const copied = evidence.messages?.find((m) => m.body === marker);
  ctx.assert(t("the evidence has the message, by author id"), copied?.userId === reporter.id, {
    messages: evidence.messages?.length ?? 0,
  });
  const memberIds = new Set((evidence.members ?? []).map((m) => m.userId));
  ctx.assert(t("the evidence lists the host and the member"), memberIds.has(host.id) && memberIds.has(reporter.id), {
    members: memberIds.size,
  });
  // Ids only: no username or email in the copy.
  const text = JSON.stringify(row?.evidence ?? {});
  ctx.assert(
    t("the evidence carries no username or email"),
    !text.includes(reporter.email) && !text.includes(host.email),
  );
  return { roomId: room.roomId };
}

async function stepRetention(run: WatchRoomRun): Promise<void> {
  const { ctx } = run;
  const t = (what: string) => watchRoomTitle(8, what);
  const ch = await ctx.step(t("the plain channel is live"), () => run.plainChannel());
  const { host, room } = await ctx.step(t("an adult opens a room"), () => apiRoom(run, "wrth", ch));
  const reporter = await ctx.step(t("a member joins and reports it"), async () => {
    const m = await ctx.platform.signUp({ prefix: "wrtm" });
    await m.api.client.watchRooms.join({ id: room.roomId, nonce: room.nonce });
    return m;
  });
  const report = await reporter.api.client.safety.report({
    subjectType: "watch_room",
    subjectId: room.roomId,
    reason: "spam",
    details: "",
  });
  const db = needDatabase(ctx);
  ctx.assert(t("the room has rows before retention"), (await roomCounts(db, room.roomId)).rooms === 1);
  await ctx.step(t("age the room 31 days (watchRoomAge hook)"), () =>
    hook(ctx, INTERNAL_ROUTES.watchRoomAge, { roomId: room.roomId, days: 31 }),
  );
  const result = await ctx.step(t("run retention now (b7Tick watch-room-retention)"), async () =>
    B7JobResult.parse(await (await hook(ctx, INTERNAL_ROUTES.b7Tick, { job: WATCH_ROOM_JOBS.retention })).json()),
  );
  ctx.data("watchRoomRetention", result);
  const counts = await waitFor(
    "the aged room is gone",
    async () => {
      const c = await roomCounts(db, room.roomId);
      return c.rooms === 0 ? c : null;
    },
    { timeoutMs: 15_000, intervalMs: 1_000, signal: ctx.signal },
  ).catch(() => null);
  ctx.assert(
    t("the room, its members and messages are gone"),
    counts !== null && counts.members === 0 && counts.messages === 0,
    {
      counts,
      result,
    },
  );
  const kept = await reportRow(db, report.id);
  ctx.assert(t("the report keeps its evidence"), kept !== null && JSON.stringify(kept.evidence).includes(host.id));
}

export const WATCH_ROOM_STEP_RUNNERS: Readonly<Record<WatchRoomStep, (run: WatchRoomRun) => Promise<void>>> = {
  1: stepChromiumSync,
  2: stepWebkitSync,
  3: stepMixedAge,
  4: stepMatureMinor,
  5: stepChannelBan,
  6: stepBlockedPair,
  7: async (run) => {
    await stepReport(run);
  },
  8: stepRetention,
};
