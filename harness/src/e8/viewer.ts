// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `interact` step 6 (viewer) (docs/testing/e8-selectors.md, "Scenarios"): a viewer on `/$channel`
 * votes on `chat-poll`, bets on `chat-prediction`, sees `chat-points` drop by the bet, sees
 * `raid-banner` and lands on the target channel page; `/overlay/goals?token=` shows the goal bar
 * advancing. Two browser contexts: the signed-in viewer on the source channel and the overlay
 * page (no session). The step signs up its own source and target streamers and its own viewer,
 * so it runs after steps 1 to 5 without meeting their polls, predictions or raid cooldown.
 * Owned by E8-viewer.
 */
import { RAID_RULES } from "@commonair/contracts/enums";
import type { Page } from "playwright";
import { playerBundles } from "../player-server.ts";
import { sleep, waitFor } from "../wait.ts";
import { signInViaUi } from "../web/flows.ts";
import { ROUTES, TEST_IDS as T } from "../web/selectors.ts";
import { WebSession, byTestId } from "../web/session.ts";
import { type E8Run, type E8Streamer, newE8Streamer, waitLive } from "./kit.ts";
import { E8_ID_PATTERNS, E8_ROUTES, E8_TEST_IDS as E, byE8Id } from "./selectors.ts";

const UI_TIMEOUT_MS = 20_000;
/** Goal progress is relayed in the outbox relay's next batch. */
const GOAL_TIMEOUT_MS = 20_000;
/** The chip refreshes after the viewer's own bet (and every 60 s regardless). */
const POINTS_TIMEOUT_MS = 70_000;
const NAVIGATE_TIMEOUT_MS = 20_000;

export const VIEWER_GRANT = 1000;
export const VIEWER_BET = 100;

/** The path and query of an absolute URL the API returned (the overlay URL), for `WebSession.goto`. */
export function pathAndQuery(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}

/** Whether a page URL is the channel page of `channel` (`/<channel>`, any query). */
export function onChannelPage(url: string, channel: string): boolean {
  const path = new URL(url).pathname.replace(/\/+$/, "");
  return path.toLowerCase() === E8_ROUTES.channel(channel).toLowerCase();
}

/** An attribute of the first match, or null while it is absent. */
async function attr(page: Page, id: string, name: string, data?: Record<string, string>): Promise<string | null> {
  const el = byE8Id(page, id, data).first();
  if ((await el.count()) === 0) return null;
  return el.getAttribute(name);
}

async function goLive(run: E8Run, s: E8Streamer): Promise<void> {
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

export async function stepViewer(run: E8Run): Promise<void> {
  const { ctx } = run;
  const [follower] = run.viewers;
  if (!follower) throw new Error("the E8 run has no viewers");
  const signal = ctx.signal;
  const ui = { timeout: UI_TIMEOUT_MS };

  const src = await ctx.step("viewer: sign up a source streamer", () => newE8Streamer(ctx, "e8vs"));
  const dst = await ctx.step("viewer: sign up a raid target", () => newE8Streamer(ctx, "e8vt"));
  const viewer = await ctx.step("viewer: sign up the viewer", () => ctx.platform.signUp({ prefix: "e8vv" }));
  const owner = src.user.api.client;

  await ctx.step("viewer: both streamers go live", () => Promise.all([goLive(run, src), goLive(run, dst)]));
  await ctx.step(`viewer: the viewer gets ${VIEWER_GRANT} points (moderator adjust)`, async () => {
    const b = await owner.bot.points.adjust({
      channel: src.channel,
      username: viewer.username,
      delta: VIEWER_GRANT,
      reason: "reward",
    });
    ctx.assert("viewer: points granted", b.points === VIEWER_GRANT && b.enabled, b);
  });

  const sessions: WebSession[] = [];
  ctx.defer(async () => {
    await Promise.allSettled(sessions.map((s) => s.close()));
  });
  const probe = (await playerBundles()).probe;
  const open = async (label: string) => {
    const s = await WebSession.open({
      fleet: ctx.platform.fleet,
      engine: "chromium",
      webUrl: ctx.env.HARNESS_WEB_URL,
      probeScript: probe,
      label,
      log: ctx.log,
    });
    sessions.push(s);
    return s;
  };

  const page = await ctx.step("viewer: sign in through the web UI and open the source channel", async () => {
    const s = await open("e8-viewer");
    const p = await s.goto(ROUTES.signin);
    await signInViaUi(p, viewer, UI_TIMEOUT_MS, signal);
    await byTestId(p, T.navUser, { username: viewer.username }).waitFor(ui);
    await s.goto(E8_ROUTES.channel(src.channel));
    await byE8Id(p, E.chatPoints, { points: String(VIEWER_GRANT) }).waitFor(ui);
    ctx.assert(
      "viewer: chat-points names the channel's points",
      ((await attr(p, E.chatPoints, "data-name")) ?? "") !== "",
    );
    return p;
  });

  const { overlayPage, goalId } = await ctx.step("viewer: a followers goal and the goals overlay at 0", async () => {
    const { goalsUrl } = await owner.interact.overlays.token({ channel: src.channel });
    const g = await owner.interact.goals.create({
      channel: src.channel,
      type: "followers",
      title: "Two follows",
      target: 2,
    });
    const s = await open("e8-overlay");
    const p = await s.goto(pathAndQuery(goalsUrl));
    await byE8Id(p, E.overlayGoals, { state: "live" }).waitFor({ timeout: GOAL_TIMEOUT_MS });
    await byE8Id(p, E.overlayGoal, { "goal-id": g.id, current: "0", target: "2" }).waitFor({
      timeout: GOAL_TIMEOUT_MS,
    });
    return { overlayPage: p, goalId: g.id };
  });

  await ctx.step("viewer: votes on chat-poll with one click", async () => {
    const poll = await owner.interact.polls.create({
      channel: src.channel,
      title: "Harness viewer poll",
      choices: ["Left", "Right"],
      durationSeconds: 120,
      pointsPerExtraVote: 0,
    });
    const choice = poll.choices[0];
    if (!choice) throw new Error("the poll has no choices");
    await byE8Id(page, E.chatPoll, { "poll-id": poll.id, status: "active" }).waitFor(ui);
    await byE8Id(page, E.chatPollChoice, { "choice-id": choice.id }).click(ui);
    await byE8Id(page, E.chatPollVoted, { "choice-id": choice.id, votes: "1" }).waitFor(ui);
    const mine = await viewer.api.client.interact.polls.current({ channel: src.channel });
    ctx.assert("viewer: the API has the vote", mine?.myVote === choice.id && mine.myVotes === 1, mine);
  });

  await ctx.step(`viewer: bets ${VIEWER_BET} on chat-prediction; chat-points drops by the bet`, async () => {
    const p = await owner.interact.predictions.create({
      channel: src.channel,
      title: "Harness viewer prediction",
      outcomes: ["Alpha", "Beta"],
      windowSeconds: 120,
    });
    const outcome = p.outcomes[0];
    if (!outcome) throw new Error("the prediction has no outcomes");
    await byE8Id(page, E.chatPrediction, { "prediction-id": p.id, status: "active" }).waitFor(ui);
    await byE8Id(page, E.chatPredictionAmount).fill(String(VIEWER_BET), ui);
    await byE8Id(page, E8_ID_PATTERNS.chatPredictionBet.id(outcome.id)).click(ui);
    await byE8Id(page, E.chatPredictionMyBet, { "outcome-id": outcome.id, points: String(VIEWER_BET) }).waitFor(ui);
    await byE8Id(page, E.chatPoints, { points: String(VIEWER_GRANT - VIEWER_BET) }).waitFor({
      timeout: POINTS_TIMEOUT_MS,
    });
  });

  await ctx.step("viewer: the goal bar advances as viewers follow", async () => {
    await follower.api.client.channels.follow({ channel: src.channel, notify: false });
    await byE8Id(overlayPage, E.overlayGoal, { "goal-id": goalId, current: "1" }).waitFor({ timeout: GOAL_TIMEOUT_MS });
    await viewer.api.client.channels.follow({ channel: src.channel, notify: false });
    // At its target the goal ends achieved: drawn full for a moment, then gone.
    await waitFor(
      "the goal bar at 2",
      async () =>
        (await byE8Id(overlayPage, E.overlayGoal, { "goal-id": goalId, current: "2" }).count()) > 0 ||
        (await byE8Id(overlayPage, E.overlayGoal, { "goal-id": goalId }).count()) === 0,
      { timeoutMs: GOAL_TIMEOUT_MS, intervalMs: 100, signal },
    );
  });

  await ctx.step("viewer: raid-banner, then the page follows the raid to the target", async () => {
    const raid = await owner.interact.raids.start({ channel: src.channel, to: dst.channel });
    await byE8Id(page, E.raidBanner, { "raid-id": raid.id, to: dst.channel }).waitFor(ui);
    ctx.assert(
      "viewer: raid-banner counts down to executeAt",
      (await attr(page, E.raidBanner, "data-execute-at")) === raid.executeAt,
    );
    const wait = Date.parse(raid.executeAt) - Date.now();
    ctx.assert(
      "viewer: the countdown is the instance constant",
      Date.parse(raid.executeAt) - Date.parse(raid.createdAt) === RAID_RULES.countdownSeconds * 1000,
      raid,
    );
    if (wait > 0) await sleep(wait + 250, signal);
    await run.hooks.tick("raids-execute");
    await page.waitForURL((u) => onChannelPage(u.toString(), dst.channel), { timeout: NAVIGATE_TIMEOUT_MS });
    // A router navigation: the target's chat panel is up without a full reload of the app.
    await byTestId(page, T.chat).first().waitFor(ui);
    ctx.assert("viewer: landed on the target channel page", onChannelPage(page.url(), dst.channel), page.url());
  });
}
