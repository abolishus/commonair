// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Milestone E2 end to end (docs/testing/e2-selectors.md): a streamer goes live over RTMP; a fan
 * discovers the stream in the directory, follows it and sees it in their `following` section; an
 * unmodified tmi.js bot owned by the streamer answers `!ping` through the IRC gateway; the
 * streamer times a troll out from the chat menu and everyone (web and IRC) sees it; the timeout
 * is lifted, the fan unfollows and the stream stops.
 *
 * `--set via=api` drives the three people through the API and chat socket instead of the web app
 * (same steps, same assertions), to tell backend failures from web ones.
 */
import { join } from "node:path";
import { twitchTagProblems } from "../src/bots/tmi-bot.ts";
import { playerBundles } from "../src/player-server.ts";
import { DEFAULT_REPORT_DIR } from "../src/report.ts";
import { defineScenario, type ScenarioContext } from "../src/scenario.ts";
import {
  ApiActor,
  type SocialActor,
  TIMEOUT_SECONDS,
  type WaitBudget,
  WebActor,
  isActiveTimeout,
  timeoutDurationOk,
} from "../src/social.ts";
import type { SignedInUser } from "../src/users.ts";
import { waitFor } from "../src/wait.ts";
import { signInViaUi } from "../src/web/flows.ts";
import { ROUTES, TEST_IDS as T, tid } from "../src/web/selectors.ts";
import { WebSession, byTestId } from "../src/web/session.ts";

/** Bounds from the brief: the directory refreshes on an interval, chat is near real time. */
export const DIRECTORY_TIMEOUT_MS = 60_000;
export const CHAT_TIMEOUT_MS = 10_000;
const UI_TIMEOUT_MS = 20_000;
const LIVE_TIMEOUT_MS = 30_000;
const OFFLINE_TIMEOUT_MS = 60_000;

/** Never let a failure screenshot show a secret. */
const REDACT = [tid(T.streamKey)];

export const VIA = ["web", "api"] as const;
export type Via = (typeof VIA)[number];

export function parseVia(value: string): Via {
  if ((VIA as readonly string[]).includes(value)) return value as Via;
  throw new Error(`--set via=${value}: expected one of ${VIA.join(", ")}`);
}

export default defineScenario({
  name: "e2e-social",
  description:
    "RTMP live → directory discovery → follow (+ following section) → tmi.js bot !ping via IRC → chat timeout from the menu seen on web and IRC → unban, unfollow, offline",
  needs: ["api", "web", "chat", "irc", "media", "origin", "ffmpeg", "browser"],
  timeoutMs: 6 * 60_000,
  async run(ctx) {
    const sessions: WebSession[] = [];
    const state = { finished: false, softFailed: false };
    // Registered first so it runs last: screenshots while the pages still show the failure.
    ctx.defer(async () => {
      if (!state.finished || state.softFailed) await screenshotSessions(ctx, sessions);
      await Promise.allSettled(sessions.map((s) => s.close()));
    });
    const check: ScenarioContext["check"] = (name, condition, details) => {
      if (!condition) state.softFailed = true;
      return ctx.check(name, condition, details);
    };
    await e2eSocial(ctx, sessions, check);
    state.finished = true;
  },
});

async function screenshotSessions(ctx: ScenarioContext, sessions: readonly WebSession[]): Promise<void> {
  const dir = join(ctx.env.HARNESS_REPORT_DIR ?? DEFAULT_REPORT_DIR, `${ctx.runId}-${ctx.name}`);
  const files = (await Promise.all(sessions.map((s) => s.screenshotAll(dir, REDACT)))).flat();
  if (files.length > 0) {
    ctx.data("screenshots", files);
    ctx.log.info("failure screenshots written", { dir, count: files.length });
  }
}

async function e2eSocial(ctx: ScenarioContext, sessions: WebSession[], check: ScenarioContext["check"]): Promise<void> {
  const p = ctx.platform;
  const signal = ctx.signal;
  const via = parseVia(ctx.param("via", "web"));
  ctx.data("via", via);
  const chat: WaitBudget = { timeoutMs: CHAT_TIMEOUT_MS, signal };
  const ui: WaitBudget = { timeoutMs: UI_TIMEOUT_MS, signal };
  const directory: WaitBudget = { timeoutMs: DIRECTORY_TIMEOUT_MS, signal };

  // 1. Streamer live over RTMP; fan, troll and the streamer's bot connect.
  const streamer = await ctx.step("sign up the streamer (API)", () => p.signUp({ prefix: "e2s_st" }));
  const channel = streamer.me.channelSlug ?? streamer.username;
  const encoder = await ctx.step("rotate the stream key", () => p.streamerFor(streamer, { protocol: "rtmp" }));
  ctx.defer(() => encoder.stop());
  await ctx.step("publish the RTMP test pattern", () => encoder.start());
  ctx.metric(
    "time_to_live",
    await ctx.step("channel goes live (API)", () => p.waitForLive(channel, true, LIVE_TIMEOUT_MS)),
    "ms",
  );

  const [fan, troll] = await ctx.step("sign up the fan and the troll (API)", () =>
    Promise.all([p.signUp({ prefix: "e2s_fan" }), p.signUp({ prefix: "e2s_troll" })]),
  );

  const botAccount = await ctx.step("create the streamer's bot account", () => p.createBot(streamer, "e2s_bot"));
  const bot = p.tmiBot(botAccount, [channel]);
  ctx.defer(() => bot.disconnect());
  await ctx.step("tmi.js bot connects to the IRC gateway and joins", async () => {
    await bot.connect();
    await bot.events.waitForJoin(channel, chat);
  });

  const { probe } = via === "web" ? await playerBundles() : { probe: "" };
  const actor = async (who: string, user: SignedInUser): Promise<SocialActor> => {
    if (via === "api") return new ApiActor(who, user.username, user.api.client, () => p.chat(user));
    const session = await WebSession.open({
      fleet: p.fleet,
      engine: "chromium",
      webUrl: ctx.env.HARNESS_WEB_URL,
      probeScript: probe,
      label: who,
      log: ctx.log,
    });
    sessions.push(session);
    await ctx.step(`${who}: sign in through the web UI`, async () => {
      const page = await session.goto(ROUTES.signin);
      await signInViaUi(page, user, UI_TIMEOUT_MS, signal);
      await byTestId(page, T.navUser, { username: user.username }).waitFor({ timeout: UI_TIMEOUT_MS });
    });
    return new WebActor(who, user.username, (path) => session.goto(path));
  };
  const F = await actor("fan", fan);
  const Tr = await actor("troll", troll);
  const S = await actor("streamer", streamer);

  // 2. Discovery and follow.
  const section = await ctx.step("fan: find the stream in the directory and open it", () =>
    F.discover(channel, directory),
  );
  ctx.data("discoveredIn", section);
  const before = await ctx.step("fan: read follow state", () => F.followState(ui));
  ctx.assert("fan does not follow yet", !before.following, before);
  const followStarted = performance.now();
  const followed = await ctx.step("fan: follow", () => F.toggleFollow(ui));
  ctx.metric("follow_round_trip", performance.now() - followStarted, "ms");
  ctx.assert("follow-button data-following=true", followed.following, followed);
  ctx.assert("follower-count increased by one", followed.count === before.count + 1, { before, followed });
  const followers = await ctx.step("streamer: channels.followers lists the fan", () =>
    streamer.api.client.channels.followers({ channel }),
  );
  ctx.assert(
    "channels.followers includes the fan",
    followers.items.some((f) => f.user.id === fan.id),
    { count: followers.items.length },
  );
  await ctx.step("fan: / shows the channel under following", () => F.waitFollowingSection(channel, directory));

  // The streamer's own channel page and the troll's, with chat open.
  await ctx.step("streamer: open the own channel page", () => S.openChannel(channel, ui));
  check("no follow-button on your own channel", !(await S.hasFollowControl()));
  await ctx.step("troll: open the channel page", () => Tr.openChannel(channel, ui));

  // 3. The tmi.js bot answers !ping in web chat and sees the fan's tags.
  const ping = `!ping ${ctx.runId}`;
  const pingSent = performance.now();
  await ctx.step("fan: send !ping", () => F.send(ping, chat));
  const seen = await ctx.step("bot: sees the fan's !ping with Twitch tags", () =>
    bot.events.waitForMessage((m) => m.username === fan.username && m.text === ping, `${fan.username}'s !ping`, chat),
  );
  const tagProblems = twitchTagProblems(seen, fan.username);
  check("the bot sees Twitch-compatible tags", tagProblems.length === 0, { tagProblems });
  check("the bot sees the fan's user id", String(seen.tags["user-id"]) === fan.id, { userId: seen.tags["user-id"] });
  await ctx.step("fan: sees the bot's reply", () => F.waitMessage(bot.username, "pong", chat));
  ctx.metric("bot_reply_round_trip", performance.now() - pingSent, "ms");
  const reply = bot.replies.find((r) => r.command === "!ping");
  if (reply?.receivedAt !== undefined) ctx.metric("bot_reply_latency", reply.at - reply.receivedAt, "ms");

  check("no moderation controls for the fan", (await F.moderationControls()) === 0);

  // 4. The troll writes; the streamer times them out from the chat menu.
  const trollText = `troll says hi ${ctx.runId}`;
  await ctx.step("troll: send a message", () => Tr.send(trollText, chat));
  const trollMsgId = await ctx.step("fan: sees the troll's message", () =>
    F.waitMessage(troll.username, trollText, chat),
  );
  await ctx.step("streamer: sees the troll's message", () => S.waitMessage(troll.username, trollText, chat));
  check("the troll's message carries data-id", trollMsgId.length > 0);
  const modStarted = Date.now();
  const modStartedPerf = performance.now();
  await ctx.step("streamer: chat-mod-timeout on the troll's message", () =>
    S.timeoutAuthor(troll.username, trollText, ui),
  );
  await ctx.step("fan: the troll's message turns deleted", () =>
    F.waitDeleted(trollMsgId, troll.username, trollText, chat),
  );
  ctx.metric("moderation_to_web", performance.now() - modStartedPerf, "ms");
  const clear = await ctx.step("bot: CLEARCHAT for the troll", () =>
    bot.events.waitForModeration(
      (e) => (e.kind === "timeout" || e.kind === "ban") && e.username === troll.username,
      `CLEARCHAT for ${troll.username}`,
      chat,
    ),
  );
  ctx.metric("moderation_to_irc", clear.at - modStarted, "ms");
  ctx.assert("CLEARCHAT is a timeout, not a ban", clear.kind === "timeout", { kind: clear.kind });
  check(`CLEARCHAT ban-duration ≈ ${TIMEOUT_SECONDS}`, timeoutDurationOk(clear.durationSeconds), {
    durationSeconds: clear.durationSeconds,
  });
  check("CLEARCHAT target-user-id is the troll", String(clear.tags["target-user-id"]) === troll.id, {
    targetUserId: clear.tags["target-user-id"],
  });

  await ctx.step("troll: next send shows msg_timedout", async () => {
    await Tr.send(`still here ${ctx.runId}`, chat);
    await Tr.waitNotice("msg_timedout", chat);
  });
  const bans = await ctx.step("chat.bans.list shows the troll with an expiry", () =>
    streamer.api.client.chat.bans.list({ channel }),
  );
  const trollBan = bans.items.find((b) => b.user.id === troll.id);
  ctx.assert("the troll is listed", trollBan !== undefined, { listed: bans.items.length });
  if (trollBan) {
    ctx.assert("the ban is a timeout still in force", isActiveTimeout(trollBan), { expiresAt: trollBan.expiresAt });
    const lengthS = (Date.parse(trollBan.expiresAt ?? "") - Date.parse(trollBan.createdAt)) / 1000;
    check(`timeout lasts ${TIMEOUT_SECONDS} s`, Math.abs(lengthS - TIMEOUT_SECONDS) <= 2, { lengthS });
  }

  // 5. Lift it, the troll chats again; the fan unfollows; the stream stops.
  await ctx.step("streamer: chat.bans.unban", () =>
    streamer.api.client.chat.bans.unban({ channel, username: troll.username }),
  );
  const unbanned = performance.now();
  await ctx.step("troll: can chat again (fan sees it)", () =>
    // The unban reaches chat asynchronously: resend (distinct text) until it lands.
    waitFor(
      "the troll's message after the unban",
      async () => {
        const text = `back again ${ctx.runId} ${Math.round(performance.now() - unbanned)}`;
        await Tr.send(text, chat);
        return F.waitMessage(troll.username, text, { timeoutMs: 2_500, signal }).catch(() => null);
      },
      { timeoutMs: CHAT_TIMEOUT_MS, intervalMs: 0, signal },
    ),
  );
  ctx.metric("unban_to_chat", performance.now() - unbanned, "ms");

  const unfollowed = await ctx.step("fan: unfollow", () => F.toggleFollow(ui));
  ctx.assert("follow-button data-following=false", !unfollowed.following, unfollowed);
  check("follower-count back to where it started", unfollowed.count === before.count, { before, unfollowed });

  await ctx.step("stop publishing", () => encoder.stop());
  ctx.metric(
    "time_to_offline",
    await ctx.step("channel goes offline (API)", () => p.waitForLive(channel, false, OFFLINE_TIMEOUT_MS)),
    "ms",
  );
}
