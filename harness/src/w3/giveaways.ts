// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `interact` W3 extension `giveaway` (docs/testing/b7-selectors.md, "Scenarios"; ADR 0039), with
 * `GIVEAWAYS_ENABLED=true` (harness/compose.w3.yaml):
 *
 * 1. Its own streamer goes live and opens a keyword giveaway that needs verified watching.
 * 2. Two verified viewers (HTTP viewers the integrity scorer verifies) become eligible: the open
 *    giveaway's verified-watch criterion alone makes the worker write `KEYS.verifiedWatch` for the
 *    channel (ADR 0039 §2; the chat gate and surge guard stay off here). One enters
 *    by typing the keyword in chat, the other with `chat-giveaway-enter` in the web chat panel
 *    (`--set via=api`: through the API).
 * 3. A viewbot (heartbeats only, never verified) is refused with `verified_watch`.
 * 4. Close and draw; `channel.giveaway.begin` and `.end` are in the outbox.
 * 5. The harness re-runs the draw from `verify` with `packages/draw` and matches the winners; on
 *    the web the verify page says `giveaway-verify-result` `data-match="true"`.
 *
 * The flag-off refusal of `open` is an API integration test (the `w3` stack turns the flag on for
 * every replica). Every named actor is this step's own.
 */
import type { Page } from "playwright";
// The harness does not depend on packages/draw; it reads it by path, as the n2 steps read i18n.
import { commit, draw, isSortedUnique } from "../../../packages/draw/src/index.ts";
import type { ChatClient } from "../chat-client.ts";
import { codeOf, refusal } from "../e8/raids.ts";
import { outboxRows } from "../e8/polls.ts";
import { type E8Streamer, newE8Streamer, waitLive } from "../e8/kit.ts";
import { HttpViewer } from "../http-viewer.ts";
import { HeartbeatOnlyViewer, STEADY_TIMING } from "../integrity-viewers.ts";
import { playerBundles } from "../player-server.ts";
import type { SignedInUser } from "../users.ts";
import { waitFor } from "../wait.ts";
import { signInViaUi } from "../web/flows.ts";
import { ROUTES } from "../web/selectors.ts";
import { WebSession } from "../web/session.ts";
import type { InteractW3Extension } from "./kit.ts";
import { w3ExtensionTitle } from "./steps.ts";

// ------------------------------------------------------------------ pure helpers (unit-tested)

/** Seconds of verified watching the giveaway asks for: past the gate's jitter, short for CI. */
export const GIVEAWAY_WATCH_SECONDS = 20;
export const GIVEAWAY_KEYWORD = "!w3give";
/** Verification (ADR 0015: up to 30 s jitter, 15 s scoring passes) plus slack for a loaded runner. */
export const ELIGIBLE_TIMEOUT_MS = 240_000;
const ENTRY_TIMEOUT_MS = 30_000;
const UI_TIMEOUT_MS = 20_000;

/** What `interact.giveaways.verify` returns (the fields the re-run reads). */
export interface Verification {
  status: string;
  seedCommitment: string;
  seed: string | null;
  entries: string[];
  winnerCount: number;
  winners: { rank: number; index: number; pseudonym: string }[];
}

/**
 * Re-run the draw as a viewer would: the seed hashes to the commitment, the entries are in draw
 * order, and the winners by rank are the draw's permutation in order with only passed-over entries
 * between them (at most `winnerCount`). Returns the problems found (empty: it matches).
 */
export async function rerunDraw(v: Verification): Promise<string[]> {
  const problems: string[] = [];
  if (v.seed === null) return ["the seed is not revealed"];
  if ((await commit(v.seed)) !== v.seedCommitment) problems.push("the seed does not hash to the commitment");
  if (!isSortedUnique(v.entries)) {
    problems.push("the entries are not sorted and unique");
    return problems;
  }
  const order = await draw(v.seed, v.entries, v.entries.length);
  const byRank = [...v.winners].sort((a, b) => a.rank - b.rank);
  if (byRank.length > v.winnerCount) problems.push(`${byRank.length} winners for ${v.winnerCount} places`);
  let pos = 0;
  for (const [i, w] of byRank.entries()) {
    if (w.rank !== i + 1) problems.push(`rank ${w.rank} out of sequence`);
    if (v.entries[w.index] !== w.pseudonym) problems.push(`winner ${w.rank}: index ${w.index} is another pseudonym`);
    while (pos < order.length && order[pos] !== w.index) pos++;
    if (pos >= order.length) problems.push(`winner ${w.rank}: index ${w.index} is not next in the draw`);
    pos++;
  }
  return problems;
}

/**
 * With every entrant eligible at the draw, the winners are exactly the first `winnerCount` drawn
 * indices, in rank order: `rerunDraw` alone would also accept a winner wrongly passed over.
 */
export async function winnersAreFirstDrawn(v: Verification): Promise<boolean> {
  if (v.seed === null) return false;
  const first = await draw(v.seed, v.entries, v.winnerCount);
  const byRank = [...v.winners].sort((a, b) => a.rank - b.rank);
  return byRank.length === first.length && byRank.every((w, i) => w.index === first[i]);
}

/** `data.reason` of an oRPC error, or null. */
export function reasonOf(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const data = (err as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const r = (data as { reason?: unknown }).reason;
  return typeof r === "string" ? r : null;
}

// ------------------------------------------------------------------ the step

const title = (what: string) => w3ExtensionTitle("giveaway", what);
const byId = (page: Page, id: string, data: Record<string, string> = {}) =>
  page.locator(
    `[data-testid="${id}"]${Object.entries(data)
      .map(([k, v]) => `[data-${k}="${v}"]`)
      .join("")}`,
  );

async function goLive(run: InteractW3Extension, s: E8Streamer): Promise<void> {
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

export async function stepGiveaway(run: InteractW3Extension): Promise<void> {
  const { ctx } = run;
  const p = ctx.platform;
  const signal = ctx.signal;

  const s = await ctx.step(title("sign up the streamer, two viewers and a viewbot"), async () => {
    const streamer = await newE8Streamer(ctx, "w3gs");
    const [keyword, button, bot] = await Promise.all([
      p.signUp({ prefix: "w3gk" }),
      p.signUp({ prefix: "w3gb" }),
      p.signUp({ prefix: "w3gx" }),
    ]);
    return { streamer, keyword, button, bot };
  });
  const channel = s.streamer.channel;
  const owner = s.streamer.user.api.client;

  await ctx.step(title("the streamer goes live"), () => goLive(run, s.streamer));

  const g = await ctx.step(
    title(`open a keyword giveaway (${GIVEAWAY_KEYWORD}, verified watching required)`),
    async () => {
      const opened = await owner.interact.giveaways.open({
        channel,
        title: "Harness giveaway",
        prize: "A harness sticker",
        winnerCount: 1,
        keyword: GIVEAWAY_KEYWORD,
        durationMinutes: null,
        eligibility: { minAccountAgeDays: 0, minFollowDays: null, minVerifiedWatchSeconds: GIVEAWAY_WATCH_SECONDS },
      });
      ctx.assert(title("open with a published commitment"), /^[0-9a-f]{64}$/.test(opened.seedCommitment), opened);
      return opened;
    },
  );

  await ctx.step(title("two viewers watch until verified; the viewbot only heartbeats"), async () => {
    for (const u of [s.keyword, s.button]) {
      const v = new HttpViewer({
        id: `w3-giveaway-${u.username}`,
        target: { channel },
        api: p.api({ jar: u.api.jar }).client,
        timing: STEADY_TIMING,
        log: p.log,
      });
      ctx.defer(() => v.stop());
      await v.start();
    }
    const bot = new HeartbeatOnlyViewer({
      id: `w3-giveaway-bot-${s.bot.username}`,
      api: p.api({ jar: s.bot.api.jar }).client,
      channel,
      log: p.log,
    });
    ctx.defer(() => bot.stop());
    await bot.start();
    const eligible = async (u: SignedInUser) =>
      (await u.api.client.interact.giveaways.current({ channel }))?.me?.eligible === true;
    await waitFor(
      `${channel}: both viewers eligible for the giveaway`,
      async () => (await eligible(s.keyword)) && (await eligible(s.button)),
      { timeoutMs: ELIGIBLE_TIMEOUT_MS, intervalMs: 2_000, signal },
    );
  });

  await ctx.step(title("a verified viewer enters by typing the keyword in chat"), async () => {
    const chat: ChatClient = await p.chat(s.keyword);
    ctx.defer(() => chat.close());
    await chat.join(channel);
    const ack = await chat.send(channel, GIVEAWAY_KEYWORD.toUpperCase());
    ctx.assert(title("the keyword message is accepted"), ack.id !== null, ack);
    await waitFor(
      `${s.keyword.username} entered by keyword`,
      async () => (await s.keyword.api.client.interact.giveaways.current({ channel }))?.me?.entered === true,
      { timeoutMs: ENTRY_TIMEOUT_MS, intervalMs: 500, signal },
    );
  });

  if (run.via === "api") {
    await ctx.step(title("a verified viewer enters with the button (API)"), async () => {
      const after = await s.button.api.client.interact.giveaways.enter({ id: g.id });
      ctx.assert(title("entered"), after.me?.entered === true, after.me);
    });
  } else {
    await ctx.step(title("a verified viewer enters with chat-giveaway-enter in the chat panel"), async () => {
      const session = await WebSession.open({
        fleet: p.fleet,
        engine: "chromium",
        webUrl: ctx.env.HARNESS_WEB_URL,
        probeScript: (await playerBundles()).probe,
        label: "w3-giveaway-button",
        log: ctx.log,
      });
      ctx.defer(() => session.close());
      const page = await session.goto(ROUTES.signin);
      await signInViaUi(page, s.button, UI_TIMEOUT_MS, signal);
      await session.goto(ROUTES.channel(channel));
      const ui = { timeout: UI_TIMEOUT_MS };
      await byId(page, "chat-giveaway", { "giveaway-id": g.id, status: "open" }).waitFor(ui);
      await byId(page, "chat-giveaway-no-purchase").waitFor(ui);
      await byId(page, "chat-giveaway-enter").click(ui);
      await byId(page, "chat-giveaway-entered").waitFor(ui);
    });
  }

  await ctx.step(title("the viewbot is refused (verified_watch)"), async () => {
    const err = await refusal("viewbot enter", () => s.bot.api.client.interact.giveaways.enter({ id: g.id }));
    ctx.assert(
      title("viewbot refused with FORBIDDEN verified_watch"),
      codeOf(err) === "FORBIDDEN" && reasonOf(err) === "verified_watch",
      { code: codeOf(err), reason: reasonOf(err) },
    );
  });

  const drawn = await ctx.step(title("close entries and draw"), async () => {
    const closed = await owner.interact.giveaways.close({ channel, id: g.id });
    ctx.assert(title("closed with two entries"), closed.status === "closed" && closed.entries === 2, closed);
    const d = await owner.interact.giveaways.draw({ channel, id: g.id });
    ctx.assert(title("drawn: one winner"), d.status === "drawn" && d.winners.length === 1, d);
    const rows = await outboxRows(run.db, s.streamer.channelId, ["channel.giveaway.begin", "channel.giveaway.end"]);
    const mine = rows.filter((r) => r.payload.id === g.id);
    ctx.assert(
      title("outbox: begin and end"),
      mine.some((r) => r.type === "channel.giveaway.begin") && mine.some((r) => r.type === "channel.giveaway.end"),
      mine.map((r) => r.type),
    );
    return d;
  });

  await ctx.step(title("re-run the draw from verify and match the winners"), async () => {
    const v = await p.api().client.interact.giveaways.verify({ channel, id: g.id });
    ctx.assert(title("verify publishes no salt"), !("salt" in v), Object.keys(v));
    const problems = await rerunDraw(v);
    ctx.assert(title("the re-run matches"), problems.length === 0, { problems, v });
    // Both entrants are eligible here, so nobody may have been passed over.
    ctx.assert(title("no eligible winner passed over"), await winnersAreFirstDrawn(v), v);
    ctx.assert(
      title("verify's winners are the draw's"),
      v.winners.map((w) => w.pseudonym).join() === drawn.winners.map((w) => w.pseudonym).join(),
      { verify: v.winners, drawn: drawn.winners },
    );
  });

  if (run.via !== "api") {
    await ctx.step(title("the public verify page re-runs the draw: giveaway-verify-result matches"), async () => {
      const session = await WebSession.open({
        fleet: p.fleet,
        engine: "chromium",
        webUrl: ctx.env.HARNESS_WEB_URL,
        probeScript: (await playerBundles()).probe,
        label: "w3-giveaway-verify",
        log: ctx.log,
      });
      ctx.defer(() => session.close());
      const page = await session.goto(`/${encodeURIComponent(channel)}/giveaways/${g.id}`);
      await byId(page, "giveaway-verify-result", { match: "true" }).waitFor({ timeout: UI_TIMEOUT_MS });
      ctx.assert(title("verify page lists both entries"), (await byId(page, "giveaway-verify-entry").count()) === 2);
    });
  }
}
