// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `interact` step 5 and `channel-bot` step 6 (the studio pages) (docs/testing/e8-selectors.md,
 * "Scenarios"), driven in a real browser through `data-testid`s only:
 *
 * - `stepInteractStudio`: step 1 (a 20 s poll, three viewers vote 2/1/0, it completes, the outbox
 *   agrees) and step 3 on a fresh source/target pair (both live, a gate-eligible viewer, the countdown, `raids-execute`, the
 *   completed raid with its verified viewers and cooldown; the target's policy `off` from its own
 *   page refuses with `raid_refused`, the cooldown with `raid_cooldown`) from `/interact`, plus a
 *   followers goal started and ended from `goal-form`.
 * - `stepBotStudio`: step 1 (enable the bot, `!hello` with a 30 s cooldown and a moderator-level
 *   command; one reply from the bot account, none inside the cooldown or below the level) and
 *   step 3 (a timer every minute after 3 lines: silent in an empty room, posts once after three)
 *   set up on `/bot`.
 *
 * The outcomes are checked the same way as the API steps: through the API and the database. These
 * steps are the web path by definition; `--set via=api` does not change them (the API steps 1 and
 * 3 already cover that path). Owned by E8-studio.
 */
import { join } from "node:path";
import type { ServerFrame } from "@commonair/contracts";
import type { Locator, Page } from "playwright";
import type { ChatClient } from "../chat-client.ts";
import { STEADY_TIMING } from "../integrity-viewers.ts";
import { playerBundles } from "../player-server.ts";
import { DEFAULT_REPORT_DIR } from "../report.ts";
import { FixturePublisher } from "../safety-io.ts";
import { benignPatternSource, runSeed } from "../safety.ts";
import { rtmpPublishUrl } from "../streamer.ts";
import type { SignedInUser } from "../users.ts";
import { sleep, waitFor } from "../wait.ts";
import { signInViaUi } from "../web/flows.ts";
import { ROUTES, TEST_IDS } from "../web/selectors.ts";
import { WebSession, byTestId } from "../web/session.ts";
import { REPLY_TIMEOUT_MS, SILENCE_MS, TIMER_TICK_MS, isBotMessage } from "./bot.ts";
import { API_SETTLE_MS, type E8Run, type E8Streamer, newE8Streamer, waitLive } from "./kit.ts";
import { POLL_SECONDS, POLL_VOTES, expectedVotes, outboxRows, pollOutboxProblems } from "./polls.ts";
import { RAID_HEARTBEAT_WINDOW_MS, gateEligibleViewers, viewersBracketed } from "./raids.ts";
import { E8_ROUTES, E8_TEST_IDS as T, byE8Id, e8Option } from "./selectors.ts";
import { botTitle, interactTitle } from "./steps.ts";

type MessageFrame = Extract<ServerFrame, { op: "message" }>;

/** UI waits: a page action plus one API round trip. */
export const UI_TIMEOUT_MS = 20_000;
/** The poll card re-reads counts every 2 s; allow a few refreshes. */
const LIVE_REFRESH_MS = 15_000;
const VERIFIED_TIMEOUT_MS = 180_000;
/** Ends a command or timer message so this step's posts are told apart from step 1 and 3's. */
export const STUDIO_TIMER_MARK = "(studio timer)";

// ---------------------------------------------------------------- pure helpers

/** A poll title for this run, inside the 60-character bound. */
export function studioPollTitle(runId: string): string {
  return `Studio poll ${runId}`.slice(0, 60);
}

/** A timer name for this run, inside the 50-character bound. */
export function studioTimerName(runId: string): string {
  return `studio-${runId}`.slice(0, 50);
}

/** Whether a switch with this `aria-checked` must be clicked to reach `want`. */
export function needsToggle(ariaChecked: string | null, want: boolean): boolean {
  return (ariaChecked === "true") !== want;
}

/** The `data-votes` of the `poll-live-choice` rows, in order, as numbers (NaN for a missing value). */
export function votesOf(attrs: readonly (string | null)[]): number[] {
  return attrs.map((v) => (v === null || v === "" ? Number.NaN : Number(v)));
}

/** Two vote lists are equal (same length, same counts). */
export function sameVotes(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ---------------------------------------------------------------- browser plumbing

/** A signed-in browser session for `user`; screenshotted into the report when the step fails. */
async function studioSession(run: E8Run, label: string, user: SignedInUser): Promise<WebSession> {
  const { ctx } = run;
  const session = await WebSession.open({
    fleet: ctx.platform.fleet,
    engine: "chromium",
    webUrl: ctx.env.HARNESS_WEB_URL,
    probeScript: (await playerBundles()).probe,
    label,
    log: ctx.log,
  });
  ctx.defer(() => session.close());
  const page = await session.goto(ROUTES.signin);
  await signInViaUi(page, user, UI_TIMEOUT_MS, ctx.signal);
  await byTestId(page, TEST_IDS.navUser, { username: user.username }).waitFor({ timeout: UI_TIMEOUT_MS });
  return session;
}

/** Run `fn`; on failure write screenshots of the sessions' pages to the report, then rethrow. */
async function withScreenshots<R>(run: E8Run, sessions: readonly WebSession[], fn: () => Promise<R>): Promise<R> {
  try {
    return await fn();
  } catch (err) {
    const dir = join(run.ctx.env.HARNESS_REPORT_DIR ?? DEFAULT_REPORT_DIR, `${run.ctx.runId}-${run.ctx.name}`);
    const files = (await Promise.all(sessions.map((s) => s.screenshotAll(dir)))).flat();
    if (files.length > 0) run.ctx.data("studioScreenshots", files);
    throw err;
  }
}

const ui = { timeout: UI_TIMEOUT_MS };

async function attr(locator: Locator, name: string): Promise<string> {
  await locator.first().waitFor({ state: "attached", ...ui });
  return (await locator.first().getAttribute(name)) ?? "";
}

/** Pick an option of a `SelectField` by its item test id. */
async function choose(page: Page, field: string, value: string): Promise<void> {
  await byE8Id(page, field).click(ui);
  await byE8Id(page, e8Option(field, value)).click(ui);
}

/** Set a switch to `want` (it is clicked only when it differs). */
async function setSwitch(page: Page, id: string, want: boolean): Promise<void> {
  const el = byE8Id(page, id);
  await el.waitFor(ui);
  if (needsToggle(await el.getAttribute("aria-checked"), want)) await el.click(ui);
  await page.waitForFunction(
    ([sel, w]) => document.querySelector(sel)?.getAttribute("aria-checked") === w,
    [`[data-testid="${id}"]`, String(want)] as const,
    ui,
  );
}

/** Confirm the open `ConfirmDialog` (its stable test id, docs/testing). */
async function confirmDialog(page: Page): Promise<void> {
  await page.locator('[data-testid="confirm-dialog-confirm"]').click(ui);
}

async function waitAttached(locator: Locator, timeoutMs = UI_TIMEOUT_MS): Promise<void> {
  await locator.first().waitFor({ state: "attached", timeout: timeoutMs });
}

// ---------------------------------------------------------------- interact step 5

/** Publish to `s` unless it is already live (a second publisher would rotate the key under the first). */
async function goLive(run: E8Run, s: E8Streamer): Promise<void> {
  if ((await run.ctx.platform.api().client.channels.get({ channel: s.channel })).live !== null) return;
  const streamer = await run.ctx.platform.streamerFor(s.user, {
    protocol: "rtmp",
    width: 640,
    height: 360,
    bitrateKbps: 800,
  });
  run.ctx.defer(() => streamer.stop());
  await streamer.start();
  await waitLive(run.ctx, s.channel);
}

async function gateEligibleNow(run: E8Run, channelId: string): Promise<number> {
  const since = new Date(Date.now() - RAID_HEARTBEAT_WINDOW_MS);
  const rows = await run.db.query.playbackSessions.findMany({
    columns: { userId: true, deviceHash: true, verdict: true, verdictReasons: true, scoredAt: true },
    where: (ps, { and, eq, gt, isNull }) =>
      and(eq(ps.channelId, channelId), isNull(ps.endedAt), gt(ps.lastHeartbeatAt, since)),
  });
  return gateEligibleViewers(rows);
}

async function studioPoll(run: E8Run, page: Page): Promise<void> {
  const { ctx, streamer: s, viewers } = run;
  const t = (w: string) => interactTitle(5, `poll: ${w}`);
  const owner = s.user.api.client;

  const pollId = await ctx.step(t("start a 20 s poll with three choices on poll-form"), async () => {
    const form = byE8Id(page, T.pollForm);
    await form.waitFor(ui);
    await byE8Id(page, T.pollTitle).fill(studioPollTitle(ctx.runId), ui);
    await byE8Id(page, "poll-choice-1").fill("First", ui);
    await byE8Id(page, "poll-choice-2").fill("Second", ui);
    await byE8Id(page, T.pollAddChoice).click(ui);
    await byE8Id(page, "poll-choice-3").fill("Third", ui);
    await byE8Id(page, T.pollDuration).fill(String(POLL_SECONDS), ui);
    await byE8Id(page, T.pollExtraCost).fill("0", ui);
    await byE8Id(page, T.pollStart).click(ui);
    const live = byE8Id(page, T.pollLive, { status: "active" });
    await waitAttached(live);
    const id = await attr(live, "data-poll-id");
    const current = await owner.interact.polls.current({ channel: s.channel });
    ctx.assert(
      "the API has the page's poll, active, three choices, no bought votes",
      current?.id === id &&
        current.status === "active" &&
        current.choices.length === 3 &&
        current.pointsPerExtraVote === 0,
      current,
    );
    return id;
  });

  const poll = await owner.interact.polls.current({ channel: s.channel });
  if (!poll || poll.id !== pollId) throw new Error("the started poll vanished");
  const want = expectedVotes(POLL_VOTES, poll.choices.length);

  await ctx.step(t("three viewers vote; poll-live shows 2/1/0"), async () => {
    for (const [i, choice] of POLL_VOTES.entries()) {
      const viewer = viewers[i];
      const choiceId = poll.choices[choice]?.id;
      if (!viewer || !choiceId) throw new Error(`missing viewer ${i} or choice ${choice}`);
      await viewer.api.client.interact.polls.vote({ id: poll.id, choiceId, extraVotes: 0 });
    }
    const seen = await waitFor(
      "poll-live-choice counts 2/1/0",
      async () => {
        const rows = byE8Id(page, T.pollLiveChoice);
        const attrs = await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-votes")));
        const got = votesOf(attrs);
        return sameVotes(got, want) ? got : null;
      },
      { timeoutMs: LIVE_REFRESH_MS, intervalMs: 500, signal: ctx.signal },
    );
    ctx.assert("the live card counts the votes", sameVotes(seen, want), seen);
  });

  await ctx.step(t("a tick emits channel.poll.progress"), async () => {
    await run.hooks.tick("interact-tick");
    await waitFor(
      "channel.poll.progress in the outbox",
      async () =>
        (await outboxRows(run.db, s.channelId, ["channel.poll.progress"])).some((r) => r.payload.id === pollId),
      { timeoutMs: API_SETTLE_MS, intervalMs: 250, signal: ctx.signal },
    );
  });

  await ctx.step(t("after endsAt and one interact-tick, poll-live is completed"), async () => {
    await sleep(Math.max(0, Date.parse(poll.endsAt) - Date.now()) + 500, ctx.signal);
    await run.hooks.tick("interact-tick");
    await waitAttached(byE8Id(page, T.pollLive, { "poll-id": pollId, status: "completed" }), API_SETTLE_MS);
    const ended = await owner.interact.polls.current({ channel: s.channel });
    ctx.assert(
      "the API agrees: completed, 2/1/0",
      ended?.id === pollId &&
        ended.status === "completed" &&
        sameVotes(
          ended.choices.map((c) => c.votes),
          want,
        ),
      ended,
    );
    const problems = pollOutboxProblems(
      await outboxRows(run.db, s.channelId, ["channel.poll.begin", "channel.poll.progress", "channel.poll.end"]),
      pollId,
      { votes: want, status: "completed" },
    );
    ctx.assert("poll outbox rows", problems.length === 0, problems);
  });

  await ctx.step(t("poll-archive archives it"), async () => {
    await byE8Id(page, T.pollArchive).click(ui);
    await byE8Id(page, T.pollLive).waitFor({ state: "detached", ...ui });
    const after = await owner.interact.polls.current({ channel: s.channel });
    ctx.assert("archived polls are no longer current", after?.id !== pollId, after);
  });
}

/**
 * The raid half of step 5. `src` and `dst` are a fresh pair (not `run.streamer`/`run.target`): step 3
 * raids that pair in the same run, and its 600 s cooldown would refuse this step's first raid.
 */
async function studioRaid(run: E8Run, src: E8Streamer, dst: E8Streamer, page: Page, targetPage: Page): Promise<void> {
  const { ctx } = run;
  const t = (w: string) => interactTitle(5, `raid: ${w}`);
  const raids = src.user.api.client.interact.raids;

  await ctx.step(t("both streamers go live"), () => Promise.all([goLive(run, src), goLive(run, dst)]));
  await ctx.step(t("one HTTP viewer on the source until it is gate-eligible"), async () => {
    const viewers = await ctx.platform.openViewers(src.channel, { http: 1, httpTiming: STEADY_TIMING });
    for (const v of viewers) ctx.defer(() => v.stop());
    await waitFor(
      `${src.channel}: a gate-eligible viewer`,
      async () => (await gateEligibleNow(run, src.channelId)) >= 1,
      {
        timeoutMs: VERIFIED_TIMEOUT_MS,
        intervalMs: 1_000,
        signal: ctx.signal,
      },
    );
  });

  const pending = await ctx.step(t("raid-form → raid-pending to the target"), async () => {
    await byE8Id(page, T.raidTarget).fill(dst.channel, ui);
    await byE8Id(page, T.raidStart).click(ui);
    const el = byE8Id(page, T.raidPending, { to: dst.channel });
    await waitAttached(el);
    const raidId = await attr(el, "data-raid-id");
    const executeAt = await attr(el, "data-execute-at");
    const state = await raids.current({ channel: src.channel });
    ctx.assert(
      "the API has the page's raid, pending",
      state.raid?.id === raidId && state.raid.status === "pending" && state.raid.executeAt === executeAt,
      state,
    );
    return { raidId, executeAt };
  });

  const executed = await ctx.step(t("countdown, raids-execute → raid-last completed"), async () => {
    const wait = Date.parse(pending.executeAt) - Date.now();
    if (wait > 0) await sleep(wait + 250, ctx.signal);
    const before = await gateEligibleNow(run, src.channelId);
    await run.hooks.tick("raids-execute");
    const after = await gateEligibleNow(run, src.channelId);
    const last = byE8Id(page, T.raidLast, { "raid-id": pending.raidId, status: "completed" });
    await waitAttached(last, API_SETTLE_MS);
    const viewers = Number(await attr(last, "data-viewers"));
    const state = await raids.current({ channel: src.channel });
    ctx.assert("raid-last shows the API's viewer count", state.raid?.viewerCount === viewers, { viewers, state });
    ctx.assert("raid-last has no cancel reason", (await attr(last, "data-cancel-reason")) === "");
    const cooldown = byE8Id(page, T.raidCooldown);
    await waitAttached(cooldown);
    ctx.assert(
      "raid-cooldown shows the API's cooldown end",
      (await attr(cooldown, "data-until")) === state.cooldownEndsAt,
      { until: await attr(cooldown, "data-until"), state },
    );
    return { viewers, before, after };
  });

  await ctx.step(t("channel.raid on the target with the source's gate-eligible count"), async () => {
    const ev = await waitFor(
      "channel.raid in the target's outbox",
      async () =>
        (
          await run.db.query.events.findMany({
            where: (e, { and, eq }) => and(eq(e.type, "channel.raid"), eq(e.channelId, dst.channelId)),
          })
        ).find(
          (e) => (e.payload as { from_broadcaster_user_login?: string }).from_broadcaster_user_login === src.channel,
        ) ?? null,
      { timeoutMs: API_SETTLE_MS, intervalMs: 250, signal: ctx.signal },
    );
    const viewers = (ev.payload as { viewers?: number }).viewers ?? -1;
    ctx.data("studioRaidViewers", { viewers, page: executed.viewers, before: executed.before, after: executed.after });
    ctx.assert(
      "viewers = the page's count = the source's gate-eligible count",
      viewers >= 1 && viewers === executed.viewers && viewersBracketed(viewers, executed.before, executed.after),
      { viewers, executed },
    );
  });

  const setTargetPolicy = async (policy: "off" | "anyone") => {
    await choose(targetPage, T.raidPolicy, policy);
    await waitFor(
      `target policy ${policy}`,
      async () => (await dst.user.api.client.interact.raids.current({ channel: dst.channel })).policy === policy,
      { timeoutMs: UI_TIMEOUT_MS, intervalMs: 250, signal: ctx.signal },
    );
  };

  const startExpecting = async (code: string) => {
    await byE8Id(page, T.raidTarget).fill(dst.channel, ui);
    await byE8Id(page, T.raidStart).click(ui);
    const error = byE8Id(page, T.raidError, { code });
    await waitAttached(error);
    ctx.assert(`raid-error ${code} has a message`, ((await error.first().textContent()) ?? "").trim().length > 0);
  };

  await ctx.step(t("the target sets raid-policy off on its own page; start refuses with raid_refused"), async () => {
    await setTargetPolicy("off");
    await startExpecting("raid_refused");
  });

  await ctx.step(t("back on anyone, start inside the cooldown refuses with raid_cooldown"), async () => {
    await setTargetPolicy("anyone");
    await startExpecting("raid_cooldown");
  });
}

async function studioGoal(run: E8Run, page: Page): Promise<void> {
  const { ctx, streamer: s } = run;
  const t = (w: string) => interactTitle(5, `goal: ${w}`);
  const goals = s.user.api.client.interact.goals;
  const title = `Studio follows ${ctx.runId}`.slice(0, 60);

  const goalId = await ctx.step(t("a followers goal of 2 from goal-form"), async () => {
    await choose(page, T.goalType, "followers");
    await byE8Id(page, T.goalTitle).fill(title, ui);
    await byE8Id(page, T.goalTarget).fill("2", ui);
    await byE8Id(page, T.goalStart).click(ui);
    const row = byE8Id(page, T.goalRow, { type: "followers", ended: "false", target: "2" });
    await waitAttached(row);
    const id = await attr(row, "data-goal-id");
    const listed = (await goals.list({ channel: s.channel })).find((g) => g.id === id);
    ctx.assert(
      "the API has the goal: followers, target 2, open, counting from 0",
      listed?.type === "followers" &&
        listed.target === 2 &&
        listed.endedAt === null &&
        listed.current === 0 &&
        listed.title === title,
      listed,
    );
    return id;
  });

  await ctx.step(t("goal-end (confirmed) ends it"), async () => {
    await byE8Id(byE8Id(page, T.goalRow, { "goal-id": goalId }), T.goalEnd).click(ui);
    await confirmDialog(page);
    await waitAttached(byE8Id(page, T.goalRow, { "goal-id": goalId, ended: "true" }));
    const listed = (await goals.list({ channel: s.channel })).find((g) => g.id === goalId);
    ctx.assert("the API lists it ended", listed !== undefined && listed.endedAt !== null, listed);
    const end = await waitFor(
      "channel.goal.end for the studio goal",
      async () =>
        (await outboxRows(run.db, s.channelId, ["channel.goal.end"])).find((r) => r.payload.id === goalId) ?? null,
      { timeoutMs: API_SETTLE_MS, intervalMs: 250, signal: ctx.signal },
    );
    ctx.assert("ended before the target: not achieved", end.payload.is_achieved === false, end.payload);
  });
}

export async function stepInteractStudio(run: E8Run): Promise<void> {
  const { ctx } = run;
  const [raidSrc, raidDst] = await ctx.step(interactTitle(5, "sign up a fresh raid source and target"), () =>
    Promise.all([newE8Streamer(ctx, "e8irs"), newE8Streamer(ctx, "e8irt")]),
  );
  const streamer = await ctx.step(interactTitle(5, "streamer signs in on the web"), () =>
    studioSession(run, "studio-streamer", run.streamer.user),
  );
  const source = await ctx.step(interactTitle(5, "raid source signs in on the web"), () =>
    studioSession(run, "studio-raid-source", raidSrc.user),
  );
  const target = await ctx.step(interactTitle(5, "raid target signs in on the web"), () =>
    studioSession(run, "studio-raid-target", raidDst.user),
  );
  await withScreenshots(run, [streamer, source, target], async () => {
    const page = await streamer.goto(E8_ROUTES.interact);
    await byE8Id(page, T.interact).waitFor(ui);
    const sourcePage = await source.goto(E8_ROUTES.interact);
    await byE8Id(sourcePage, T.raidForm).waitFor(ui);
    const targetPage = await target.goto(E8_ROUTES.interact);
    await byE8Id(targetPage, T.raidPolicy).waitFor(ui);
    await studioPoll(run, page);
    await studioRaid(run, raidSrc, raidDst, sourcePage, targetPage);
    await studioGoal(run, page);
  });
}

// ---------------------------------------------------------------- channel-bot step 6

interface BotHandle {
  botUserId: string;
  botUsername: string;
}

async function chatFor(run: E8Run, user: SignedInUser): Promise<ChatClient> {
  const chat = await run.ctx.platform.chat(user);
  run.ctx.defer(() => chat.close());
  await chat.join(run.streamer.channel);
  return chat;
}

async function sendAccepted(run: E8Run, chat: ChatClient, body: string): Promise<void> {
  const ack = await chat.send(run.streamer.channel, body);
  run.ctx.assert(`chat accepted "${body}"`, ack.id !== null, ack);
}

/** Send, watch for `ms`, and return the bot's messages meanwhile. */
async function botMessagesAfter(
  run: E8Run,
  chat: ChatClient,
  bot: BotHandle,
  send: string | null,
  ms: number,
): Promise<string[]> {
  const seen: string[] = [];
  const off = chat.onFrame((f) => {
    if (isBotMessage(f, bot.botUserId)) seen.push(f.message.body);
  });
  try {
    if (send !== null) await sendAccepted(run, chat, send);
    await sleep(ms, run.ctx.signal);
  } finally {
    off();
  }
  return seen;
}

async function saveCommand(
  page: Page,
  c: { name: string; response: string; level: string; cooldown: number },
): Promise<void> {
  await byE8Id(page, T.commandNew).click(ui);
  await byE8Id(page, T.commandForm).waitFor(ui);
  await byE8Id(page, T.commandName).fill(c.name, ui);
  await byE8Id(page, T.commandAliases).fill("", ui);
  await byE8Id(page, T.commandResponse).fill(c.response, ui);
  await choose(page, T.commandLevel, c.level);
  await byE8Id(page, T.commandCooldown).fill(String(c.cooldown), ui);
  await byE8Id(page, T.commandCost).fill("0", ui);
  await setSwitch(page, T.commandEnabled, true);
  await byE8Id(page, T.commandSave).click(ui);
  await byE8Id(page, T.commandForm).waitFor({ state: "detached", ...ui });
  await waitAttached(byE8Id(page, T.commandRow, { name: c.name }));
}

async function botSettingsOnPage(run: E8Run, page: Page): Promise<BotHandle> {
  const s = run.streamer;
  await byE8Id(page, T.botSettings).waitFor(ui);
  await setSwitch(page, T.botEnabled, true);
  await byE8Id(page, T.botDisplayName).fill("HarnessBot", ui);
  // Filters off, as in the API steps: the step's own chat lines must never be dropped.
  await setSwitch(page, T.botFilterSpam, false);
  await setSwitch(page, T.botFilterLinks, false);
  await setSwitch(page, T.botFilterCaps, false);
  await byE8Id(page, T.botFilterTimeout).fill("0", ui);
  await setSwitch(page, T.botPointsEnabled, true);
  await setSwitch(page, T.botSrEnabled, true);
  await byE8Id(page, T.botSave).click(ui);
  const username = await waitFor(
    "bot-account shows the bot's username",
    async () => (await byE8Id(page, T.botAccount).getAttribute("data-username")) || null,
    { timeoutMs: UI_TIMEOUT_MS, intervalMs: 250, signal: run.ctx.signal },
  );
  const settings = await s.user.api.client.bot.settings({ channel: s.channel });
  run.ctx.assert(
    "the API has the page's settings: on, filters off, points and song requests on",
    settings.enabled &&
      settings.botUser?.username === username &&
      settings.config.displayName === "HarnessBot" &&
      !settings.config.filters.spam.enabled &&
      !settings.config.filters.links.enabled &&
      !settings.config.filters.caps.enabled &&
      settings.config.loyalty.enabled &&
      settings.config.songRequests.enabled,
    settings,
  );
  if (!settings.botUser) throw new Error("bot.settings has no bot account after enabling");
  return { botUserId: settings.botUser.id, botUsername: settings.botUser.username };
}

async function botCommands(run: E8Run, session: WebSession, page: Page, bot: BotHandle): Promise<void> {
  const { ctx, streamer: s } = run;
  const t = (w: string) => botTitle(6, `commands: ${w}`);
  const [v0, v1, v2] = run.viewers;
  if (!v0 || !v1 || !v2) throw new Error("the E8 run has three viewers (kit.ts)");

  await ctx.step(t("add !hello (cooldown 30 s) and a moderator-level !modcheck on command-form"), async () => {
    await saveCommand(page, { name: "hello", response: "Hi ${user}!", level: "everyone", cooldown: 30 });
    await saveCommand(page, { name: "modcheck", response: "moderators only", level: "moderator", cooldown: 0 });
    const listed = await s.user.api.client.bot.commands.list({ channel: s.channel });
    const hello = listed.find((c) => c.name === "hello");
    const modcheck = listed.find((c) => c.name === "modcheck");
    ctx.assert(
      "the API has both commands as entered",
      hello?.response === "Hi ${user}!" &&
        hello.cooldownSeconds === 30 &&
        hello.userLevel === "everyone" &&
        hello.enabled &&
        modcheck?.userLevel === "moderator",
      listed,
    );
  });
  const usesBefore = Number(await attr(byE8Id(page, T.commandRow, { name: "hello" }), "data-uses"));

  const [c0, c1, c2] = await ctx.step(
    t("three viewers join chat"),
    async () => [await chatFor(run, v0), await chatFor(run, v1), await chatFor(run, v2)] as const,
  );
  const reply = await ctx.step(t("a viewer's !hello gets one reply from the bot account"), async () => {
    const next = c0.next(
      "message",
      (f): f is MessageFrame => isBotMessage(f, bot.botUserId, (b) => b.startsWith("Hi ")),
      REPLY_TIMEOUT_MS,
    );
    next.catch(() => undefined);
    await sendAccepted(run, c0, "!hello");
    return next;
  });
  const shown = c0.welcome?.user?.displayName ?? v0.displayName;
  ctx.assert("reply names the caller", reply.message.body === `Hi ${shown}!`, reply.message.body);
  ctx.assert("reply is from a bot account", reply.message.user.accountType === "bot", reply.message.user);
  const extra = await botMessagesAfter(run, c0, bot, null, SILENCE_MS);
  ctx.assert("exactly one reply", !extra.some((b) => b.startsWith("Hi ")), extra);
  const cooled = await ctx.step(t("a second !hello inside the cooldown gets none"), () =>
    botMessagesAfter(run, c1, bot, "!hello", SILENCE_MS),
  );
  ctx.assert("no reply inside the cooldown", !cooled.some((b) => b.startsWith("Hi ")), cooled);
  const denied = await ctx.step(t("a viewer's moderator-level command gets none"), () =>
    botMessagesAfter(run, c2, bot, "!modcheck", SILENCE_MS),
  );
  ctx.assert("no reply below the command's level", !denied.includes("moderators only"), denied);

  await ctx.step(t("the page counts the use after a reload"), async () => {
    const reloaded = await session.goto(E8_ROUTES.bot);
    const uses = Number(await attr(byE8Id(reloaded, T.commandRow, { name: "hello" }), "data-uses"));
    ctx.assert("command-row data-uses went up by one", uses === usesBefore + 1, { usesBefore, uses });
  });
}

async function botTimer(run: E8Run, page: Page, bot: BotHandle): Promise<void> {
  const { ctx, streamer: s } = run;
  const t = (w: string) => botTitle(6, `timer: ${w}`);
  const [v0, v1] = run.viewers;
  if (!v0 || !v1) throw new Error("the E8 run has three viewers (kit.ts)");
  const name = studioTimerName(ctx.runId);

  const timerId = await ctx.step(t("add a timer every minute after 3 chat lines on timer-form"), async () => {
    await byE8Id(page, T.timerNew).click(ui);
    await byE8Id(page, T.timerForm).waitFor(ui);
    await byE8Id(page, T.timerName).fill(name, ui);
    await byE8Id(page, T.timerMessage).fill(`Follow \${channel}! ${STUDIO_TIMER_MARK}`, ui);
    await byE8Id(page, T.timerInterval).fill("1", ui);
    await byE8Id(page, T.timerMinLines).fill("3", ui);
    await setSwitch(page, T.timerEnabled, true);
    await byE8Id(page, T.timerSave).click(ui);
    await byE8Id(page, T.timerForm).waitFor({ state: "detached", ...ui });
    const timers = await s.user.api.client.bot.timers.list({ channel: s.channel });
    const timer = timers.find((x) => x.name === name);
    ctx.assert(
      "the API has the timer: 1 minute, 3 lines, on",
      timer?.intervalMinutes === 1 && timer.minChatLines === 3 && timer.enabled,
      timers,
    );
    if (!timer) throw new Error("the timer is missing");
    await waitAttached(byE8Id(page, T.timerRow, { "timer-id": timer.id, enabled: "true" }));
    return timer.id;
  });

  const { key } = await s.user.api.client.stream.rotateKey({ channel: s.channel });
  const pub = new FixturePublisher(
    `publisher-${s.channel}-studio`,
    {
      url: rtmpPublishUrl(ctx.env.HARNESS_RTMP_URL, key),
      lavfi: benignPatternSource((runSeed(ctx.runId) + 6) & 0x7fffffff),
    },
    ctx.log,
  );
  ctx.defer(() => pub.stop(1_000));
  await ctx.step(t("streamer goes live"), () => pub.start());
  await ctx.step(t("channel is live"), () => waitLive(ctx, s.channel));
  const [c0, c1] = await ctx.step(
    t("two viewers join chat"),
    async () => [await chatFor(run, v0), await chatFor(run, v1)] as const,
  );
  const isMine = (b: string) => b.endsWith(STUDIO_TIMER_MARK);

  const silent = await ctx.step(t("a minute of silence: no post"), () =>
    botMessagesAfter(run, c0, bot, null, 60_000 + TIMER_TICK_MS + 5_000),
  );
  ctx.assert("no timer post in an empty room", !silent.some(isMine), silent);

  const posted = c1.next(
    "message",
    (f): f is MessageFrame => isBotMessage(f, bot.botUserId, isMine),
    2 * TIMER_TICK_MS + 15_000,
  );
  posted.catch(() => undefined);
  await ctx.step(t("three chat lines"), async () => {
    await sendAccepted(run, c0, `studio line one ${ctx.runId}`);
    await sendAccepted(run, c1, `studio line two ${ctx.runId}`);
    await sendAccepted(run, c0, `studio line three ${ctx.runId}`);
  });
  const post = await ctx.step(t("the timer posts"), () => posted);
  ctx.assert("timer message rendered", post.message.body.startsWith("Follow "), post.message.body);
  const more = await ctx.step(t("and only once"), () => botMessagesAfter(run, c1, bot, null, TIMER_TICK_MS + 5_000));
  ctx.assert("one post", !more.some(isMine), more);

  await ctx.step(t("timer-remove (confirmed) deletes it"), async () => {
    await byE8Id(byE8Id(page, T.timerRow, { "timer-id": timerId }), T.timerRemove).click(ui);
    await confirmDialog(page);
    await byE8Id(page, T.timerRow, { "timer-id": timerId }).waitFor({ state: "detached", ...ui });
    const timers = await s.user.api.client.bot.timers.list({ channel: s.channel });
    ctx.assert("the API no longer lists it", !timers.some((x) => x.id === timerId), timers);
  });
}

export async function stepBotStudio(shared: E8Run): Promise<void> {
  const { ctx } = shared;
  // A fresh channel: steps 1-5 leave `!hello` and timers on `shared.streamer`, and the studio refuses
  // a new command whose name is taken, so in `all` this step would trip over step 1's command.
  const streamer = await ctx.step(botTitle(6, "sign up a studio streamer"), () => newE8Streamer(ctx, "e8bst"));
  const run: E8Run = { ...shared, streamer };
  const session = await ctx.step(botTitle(6, "streamer signs in on the web"), () =>
    studioSession(run, "studio-bot", run.streamer.user),
  );
  await withScreenshots(run, [session], async () => {
    const page = await session.goto(E8_ROUTES.bot);
    await byE8Id(page, T.bot).waitFor(ui);
    const bot = await ctx.step(botTitle(6, "enable the bot on bot-settings"), () => botSettingsOnPage(run, page));
    ctx.data("studioBotUser", bot);
    await botCommands(run, session, page, bot);
    const reloaded = await session.goto(E8_ROUTES.bot);
    await byE8Id(reloaded, T.timerNew).waitFor(ui);
    await botTimer(run, reloaded, bot);
  });
}
