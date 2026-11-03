// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * B8-web's extensions (docs/testing/b8-selectors.md, "Scenarios"):
 *
 * - `interact` `grace-bet-web`: a viewer whose player sits 9 s behind live (the `timeline-sync`
 *   far latency) has typed an amount when the streamer locks; the card offers `prediction-grace`,
 *   the viewer bets from it, and the server accepts the bet (stored before `lock_media_ts`, within
 *   30 s of the lock). The grace is the server's rule (ADR 0039 §3): the web only offers it.
 * - `interact` `giveaway-verify-mine`: with `GIVEAWAYS_ENABLED` (harness/compose.w3.yaml), an
 *   entrant of an older, drawn giveaway (a newer one is the channel's current) sees their own
 *   pseudonym marked on its verify page, from `verify.me`; a non-entrant sees no mark; `verify`
 *   carries no salt and no user id.
 * - `twitch-import` `channel-panels-banner` (adds steps 3 and 7): the step 3 channel gets the
 *   step 7 panels (through the API, as step 7's `via=api`), one panel with markup, and a banner
 *   upload; the channel page shows `channel-banner` (not before 18+ while the imported mature label
 *   is on) and `channel-panels`, the markup as text, `nofollow ugc` links, and no horizontal scroll
 *   at 320 px.
 *
 * Every actor is the step's own, apart from the twitch-import streamer step 3 leaves.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "playwright";
import { playerBundles } from "../player-server.ts";
import type { ScenarioContext } from "../scenario.ts";
import { apiIdentityClient } from "../seed/social/identity.ts";
import { artPng, artRng, artScene } from "../seed/art.ts";
import { createRng } from "../seed/prng.ts";
import type { SignedInUser } from "../users.ts";
import { FORCED_LATENCIES } from "../w1/timeline-web.ts";
import { W1_ROUTES, W1_TEST_IDS, byW1Id } from "../w1/selectors.ts";
import { testIdSelector as tid } from "../w2/rehearsal/checks.ts";
import { toDate } from "../w2/sql-time.ts";
import { type E8Streamer, newE8Streamer, waitLive } from "../e8/kit.ts";
import { PANEL_EXPECTED } from "../n3/index.ts";
import { blockingViolations } from "../n4/web.ts";
import { signInViaUi } from "../web/flows.ts";
import { ROUTES } from "../web/selectors.ts";
import { WebSession } from "../web/session.ts";
import type { InteractB8Extension, TwitchImportB8Extension } from "./kit.ts";

// ------------------------------------------------------------------ pure helpers (unit-tested)

/** docs/testing/b8-selectors.md, B8-web's ids. */
export const B8_WEB_IDS = {
  banner: "channel-banner",
  panels: "channel-panels",
  panel: "channel-panel",
  grace: "prediction-grace",
  verifyMine: "giveaway-verify-mine",
} as const;

/** ADR 0039 §3: a bet after the lock is taken for 30 s of wall clock. */
export const GRACE_MS = 30_000;
export const GRACE_GRANT = 1_000;
export const GRACE_BET = 120;
const UI_TIMEOUT_MS = 30_000;
const PLAYING_TIMEOUT_MS = 60_000;
/** The card shows the grace within this long of the lock (the lock reaches chat in well under it). */
const GRACE_SHOWN_MS = 6_000;

/** The `rel` every panel link must carry (apps/web `PANEL_LINK_REL`). */
export const PANEL_LINK_REL = ["noopener", "noreferrer", "nofollow", "ugc"] as const;

/** What is wrong with a panel link's `target` and `rel`. Empty when all is well. Pure. */
export function panelLinkProblems(target: string | null, rel: string | null): string[] {
  const problems: string[] = [];
  if (target !== "_blank") problems.push(`target ${String(target)}, want _blank`);
  const have = new Set((rel ?? "").split(/\s+/).filter(Boolean));
  for (const r of PANEL_LINK_REL) if (!have.has(r)) problems.push(`rel lacks ${r}`);
  return problems;
}

/** What is wrong with a grace bet as stored, against the lock it followed. Empty when all is well. Pure. */
export function graceBetProblems(
  bet: { mediaTs: Date | null; placedAt: Date | null } | null,
  lock: { lockMediaTs: string; lockedAt: string },
): string[] {
  if (!bet) return ["no bet stored"];
  const problems: string[] = [];
  const lockMedia = Date.parse(lock.lockMediaTs);
  const lockedAt = Date.parse(lock.lockedAt);
  if (bet.mediaTs === null) problems.push("the bet has no media_ts");
  else if (!(bet.mediaTs.getTime() < lockMedia)) problems.push("media_ts is not before lock_media_ts");
  if (bet.placedAt === null) problems.push("the bet has no placed_at");
  else {
    const after = bet.placedAt.getTime() - lockedAt;
    if (after < 0) problems.push("the bet was placed before the lock: not a grace bet");
    if (after >= GRACE_MS) problems.push(`the bet was placed ${after} ms after the lock, past the grace`);
  }
  return problems;
}

/** The verify answer's shape this step reads. */
export interface VerifyAnswer {
  entries: string[];
  me: { pseudonym: string } | null;
}

/** What is wrong with `verify.me` for a caller whose own pseudonym is `own` (null: not an entrant). Pure. */
export function verifyMeProblems(v: VerifyAnswer & Record<string, unknown>, own: string | null): string[] {
  const problems: string[] = [];
  if ("salt" in v) problems.push("verify publishes the salt");
  if (own === null) {
    if (v.me !== null) problems.push("a non-entrant got a pseudonym");
    return problems;
  }
  if (v.me?.pseudonym !== own) problems.push(`me is ${JSON.stringify(v.me)}, want ${own}`);
  if (!v.entries.includes(own)) problems.push("the caller's pseudonym is not in the entries");
  return problems;
}

/** One panel with markup in title and body: the page must show it as text. */
export const MARKUP_PANEL = {
  title: "Rules <i>here</i>",
  body: 'Be kind.\n<b onclick="steal()">No</b> spoilers.',
  imageKey: null,
  linkUrl: "https://rules.example.org/",
};

// ------------------------------------------------------------------ shared

async function goLive(ctx: ScenarioContext, s: E8Streamer): Promise<void> {
  const streamer = await ctx.platform.streamerFor(s.user, {
    protocol: "rtmp",
    width: 640,
    height: 360,
    bitrateKbps: 800,
  });
  ctx.defer(() => streamer.stop());
  await streamer.start();
  await waitLive(ctx, s.channel);
}

async function signedInSession(ctx: ScenarioContext, user: SignedInUser | null, label: string): Promise<Page> {
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
  if (user) await signInViaUi(page, user, UI_TIMEOUT_MS, ctx.signal);
  return page;
}

const within = (scope: Page | Locator, id: string, data: Record<string, string> = {}) => scope.locator(tid(id, data));

/** The brief's axe check: no serious or critical violation inside `testId` (all are recorded). */
async function checkAxe(ctx: ScenarioContext, page: Page, testId: string): Promise<void> {
  const result = await new AxeBuilder({ page }).include(tid(testId)).analyze();
  ctx.data(
    `b8.web.axe.${testId}`,
    result.violations.map((v) => ({ id: v.id, impact: v.impact ?? null, nodes: v.nodes.length })),
  );
  const blocking = blockingViolations(result.violations);
  ctx.assert(`b8 web: ${testId} has no serious axe violations`, blocking.length === 0, blocking);
}

// ------------------------------------------------------------------ interact: grace-bet-web

export async function stepGraceBetWeb(run: InteractB8Extension): Promise<void> {
  const { ctx } = run;
  const p = ctx.platform;
  const title = (what: string) => `grace-bet-web: ${what}`;

  const s = await ctx.step(title("sign up the streamer"), () => newE8Streamer(ctx, "b8gs"));
  const viewer = await ctx.step(title("sign up a viewer"), () => p.signUp({ prefix: "b8gv" }));
  const owner = s.user.api.client;
  await ctx.step(title("the viewer gets points"), () =>
    owner.bot.points.adjust({ channel: s.channel, username: viewer.username, delta: GRACE_GRANT, reason: "reward" }),
  );
  await ctx.step(title("the streamer goes live"), () => goLive(ctx, s));

  const page = await ctx.step(
    title(`the viewer watches the channel page ${FORCED_LATENCIES.far} s behind live`),
    async () => {
      const pg = await signedInSession(ctx, viewer, "b8-grace-bet");
      await pg.goto(
        new URL(
          W1_ROUTES.channel(s.channel, { targetLatency: FORCED_LATENCIES.far }),
          ctx.env.HARNESS_WEB_URL,
        ).toString(),
        {
          waitUntil: "domcontentloaded",
        },
      );
      await byW1Id(pg, W1_TEST_IDS.player, { state: "playing", "playback-mode": "live" }).waitFor({
        timeout: PLAYING_TIMEOUT_MS,
      });
      return pg;
    },
  );

  const created = await ctx.step(title("the streamer starts a prediction; the viewer types an amount"), async () => {
    const c = await owner.interact.predictions.create({
      channel: s.channel,
      title: `Grace ${ctx.runId}`.slice(0, 45),
      outcomes: ["Alpha", "Beta"],
      windowSeconds: 120,
    });
    ctx.defer(async () => {
      await owner.interact.predictions.cancel({ id: c.id }).catch(() => undefined);
    });
    await within(page, "chat-prediction", { "prediction-id": c.id, status: "active" }).waitFor({
      timeout: UI_TIMEOUT_MS,
    });
    await within(page, "chat-prediction-amount").fill(String(GRACE_BET), { timeout: UI_TIMEOUT_MS });
    return c;
  });
  const A = created.outcomes[0]?.id ?? "";

  const lock = await ctx.step(title("the streamer locks it"), async () => {
    const locked = await owner.interact.predictions.lock({ id: created.id });
    ctx.assert(
      title("locked with a media-time lock"),
      locked.status === "locked" && !!locked.lockMediaTs && !!locked.lockedAt,
      locked,
    );
    return { lockMediaTs: locked.lockMediaTs ?? "", lockedAt: locked.lockedAt ?? "" };
  });

  await ctx.step(title("the card offers prediction-grace; the viewer bets from it"), async () => {
    const grace = within(page, B8_WEB_IDS.grace, { "prediction-id": created.id });
    await grace.waitFor({ timeout: GRACE_SHOWN_MS });
    const endsAt = await grace.getAttribute("data-grace-ends-at");
    ctx.assert(
      title("the grace ends 30 s after lockedAt"),
      endsAt !== null && Date.parse(endsAt) === Date.parse(lock.lockedAt) + GRACE_MS,
      { endsAt, lockedAt: lock.lockedAt },
    );
    await checkAxe(ctx, page, B8_WEB_IDS.grace);
    await within(grace, "chat-prediction-amount").fill(String(GRACE_BET), { timeout: UI_TIMEOUT_MS });
    await within(grace, `chat-prediction-bet-${A}`).click({ timeout: UI_TIMEOUT_MS });
    await within(page, "chat-prediction-my-bet", { "outcome-id": A, points: String(GRACE_BET) }).waitFor({
      timeout: UI_TIMEOUT_MS,
    });
    ctx.assert(title("no refusal shown"), (await within(page, "chat-prediction-refused").count()) === 0);
    ctx.assert(title("the grace form closed after the bet"), (await within(page, B8_WEB_IDS.grace).count()) === 0);
  });

  await ctx.step(title("the server accepted it: before lock_media_ts, within 30 s of the lock"), async () => {
    const row = await run.db.query.predictionBets.findFirst({
      columns: { mediaTs: true, placedAt: true, points: true },
      where: (b, { and, eq }) => and(eq(b.predictionId, created.id), eq(b.userId, viewer.id)),
    });
    const stored = row ? { mediaTs: toDate(row.mediaTs), placedAt: toDate(row.placedAt) } : null;
    const problems = graceBetProblems(stored, lock);
    ctx.assert(title("a grace bet as ADR 0039 §3 allows"), problems.length === 0, { problems, row, lock });
    ctx.assert(title("the amount the viewer typed"), row?.points === GRACE_BET, row);
  });
}

// ------------------------------------------------------------------ interact: giveaway-verify-mine

export async function stepGiveawayVerifyMine(run: InteractB8Extension): Promise<void> {
  const { ctx } = run;
  const p = ctx.platform;
  const title = (what: string) => `giveaway-verify-mine: ${what}`;

  const info = await p.api().client.instance.info();
  ctx.assert(
    title("giveaways are on (GIVEAWAYS_ENABLED: start the stack with harness/compose.w3.yaml, `stack --harness --w3`)"),
    info.features.giveaways === true,
    info.features,
  );

  const s = await ctx.step(title("sign up the streamer"), () => newE8Streamer(ctx, "b8gm"));
  const [entrant, other] = await ctx.step(title("sign up an entrant and a non-entrant"), () =>
    Promise.all([p.signUp({ prefix: "b8ge" }), p.signUp({ prefix: "b8gn" })]),
  );
  const owner = s.user.api.client;
  const open = (name: string) =>
    owner.interact.giveaways.open({
      channel: s.channel,
      title: name,
      prize: "A harness sticker",
      winnerCount: 1,
      keyword: null,
      durationMinutes: null,
      eligibility: { minAccountAgeDays: 0, minFollowDays: null, minVerifiedWatchSeconds: 0 },
    });

  const old = await ctx.step(title("an older giveaway: the entrant enters, then it is closed and drawn"), async () => {
    const g = await open("Last week's giveaway");
    const entered = await entrant.api.client.interact.giveaways.enter({ id: g.id });
    ctx.assert(title("entered"), entered.me?.entered === true, entered.me);
    await owner.interact.giveaways.close({ channel: s.channel, id: g.id });
    const d = await owner.interact.giveaways.draw({ channel: s.channel, id: g.id });
    ctx.assert(title("drawn"), d.status === "drawn", d.status);
    return g;
  });
  await ctx.step(title("a newer giveaway is the channel's current one"), async () => {
    const g = await open("This week's giveaway");
    ctx.defer(async () => {
      await owner.interact.giveaways.cancel({ channel: s.channel, id: g.id }).catch(() => undefined);
    });
    const current = await entrant.api.client.interact.giveaways.current({ channel: s.channel });
    ctx.assert(title("current is the newer one"), current?.id === g.id, current?.id);
  });

  const own = await ctx.step(
    title("verify.me: the entrant's pseudonym; null for the non-entrant and anonymous"),
    async () => {
      const row = await run.db.query.giveawayEntries.findFirst({
        columns: { pseudonym: true },
        where: (e, { and, eq }) => and(eq(e.giveawayId, old.id), eq(e.userId, entrant.id)),
      });
      const mine = row?.pseudonym ?? null;
      ctx.assert(title("the entry row exists"), mine !== null);
      const answers: [string, SignedInUser | null, string | null][] = [
        ["entrant", entrant, mine],
        ["non-entrant", other, null],
        ["anonymous", null, null],
      ];
      for (const [who, user, want] of answers) {
        const client = user ? user.api.client : p.api().client;
        const v = await client.interact.giveaways.verify({ channel: s.channel, id: old.id });
        const problems = verifyMeProblems(v as VerifyAnswer & Record<string, unknown>, want);
        ctx.assert(title(`verify.me for the ${who}`), problems.length === 0, { problems, me: v.me });
        ctx.assert(title(`no user id in verify for the ${who}`), !JSON.stringify(v).includes(entrant.id));
      }
      return mine as string;
    },
  );

  await ctx.step(title("the entrant's verify page marks giveaway-verify-mine"), async () => {
    const page = await signedInSession(ctx, entrant, "b8-verify-mine");
    await page.goto(
      new URL(`/${encodeURIComponent(s.channel)}/giveaways/${old.id}`, ctx.env.HARNESS_WEB_URL).toString(),
      {
        waitUntil: "domcontentloaded",
      },
    );
    await within(page, B8_WEB_IDS.verifyMine, { pseudonym: own }).waitFor({ timeout: UI_TIMEOUT_MS });
    ctx.assert(title("exactly one mark"), (await within(page, B8_WEB_IDS.verifyMine).count()) === 1);
    await checkAxe(ctx, page, "giveaway-verify-page");
    ctx.assert(
      title("no username on the page (decision (n))"),
      // The page content, not the site header, which shows the signed-in entrant's own account.
      !(await page.locator("#main-content").innerText()).includes(entrant.username),
    );
  });

  await ctx.step(title("the non-entrant's verify page marks nothing"), async () => {
    const page = await signedInSession(ctx, other, "b8-verify-other");
    await page.goto(
      new URL(`/${encodeURIComponent(s.channel)}/giveaways/${old.id}`, ctx.env.HARNESS_WEB_URL).toString(),
      {
        waitUntil: "domcontentloaded",
      },
    );
    await within(page, "giveaway-verify-result").waitFor({ timeout: UI_TIMEOUT_MS });
    ctx.assert(title("no mark"), (await within(page, B8_WEB_IDS.verifyMine).count()) === 0);
  });
}

// ------------------------------------------------------------------ twitch-import: channel-panels-banner

export async function stepChannelPanelsBanner(run: TwitchImportB8Extension): Promise<void> {
  const { ctx } = run;
  const title = (what: string) => `channel-panels-banner: ${what}`;
  ctx.assert(title("step 3 imported the channel"), run.streamer !== null && run.done !== null);
  const streamer = run.streamer as SignedInUser;
  const channel = streamer.me.channelSlug ?? streamer.username;
  const c = streamer.api.client.channels;

  await ctx.step(title("the step 7 panels and a panel with markup, through the API"), async () => {
    const saved = await c.setPanels({ channel, panels: [...PANEL_EXPECTED, MARKUP_PANEL] });
    ctx.assert(title("three panels saved"), saved.length === 3, saved);
  });
  const bannerUrl = await ctx.step(title("upload a banner"), async () => {
    const png = artPng(artScene(artRng(createRng(0xb8), `${ctx.runId}:banner`), "banner"));
    const identity = apiIdentityClient(streamer.api, ctx.signal);
    const key = await identity.upload(channel, "banner", png);
    await identity.setTheme(channel, { ...(await identity.theme(channel)), bannerKey: key });
    const got = await c.get({ channel });
    ctx.assert(title("channels.get has the banner"), got.bannerUrl !== null, got.bannerUrl);
    return got.bannerUrl as string;
  });

  const page = await ctx.step(title("an anonymous visitor opens the channel page"), async () => {
    const pg = await signedInSession(ctx, null, "b8-channel-panels");
    await pg.goto(new URL(`/${channel}`, ctx.env.HARNESS_WEB_URL).toString(), { waitUntil: "domcontentloaded" });
    await within(pg, B8_WEB_IDS.panels).waitFor({ timeout: UI_TIMEOUT_MS });
    return pg;
  });

  await ctx.step(title("the imported mature label hides the banner before 18+"), async () => {
    const got = await c.get({ channel });
    if (!got.mature) return;
    // After hydration: SSR never renders the banner, so an early count would prove nothing.
    await page.waitForLoadState("networkidle", { timeout: UI_TIMEOUT_MS }).catch(() => undefined);
    ctx.assert(title("no banner for an anonymous visitor"), (await within(page, B8_WEB_IDS.banner).count()) === 0);
    await c.update({ channel, mature: false });
    // Step 4 (and any rerun) expects the imported label back.
    ctx.defer(async () => {
      await c.update({ channel, mature: true });
    });
  });

  await ctx.step(title("channel-panels: in order, markup as text, nofollow ugc links"), async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    const panels = within(page, B8_WEB_IDS.panel);
    await within(page, B8_WEB_IDS.panel, { "panel-index": "2" }).waitFor({ timeout: UI_TIMEOUT_MS });
    ctx.assert(title("three panels"), (await panels.count()) === 3);
    const texts = await panels.allInnerTexts();
    ctx.assert(
      title("titles in order"),
      PANEL_EXPECTED.every((x, i) => texts[i]?.includes(x.title)),
      texts,
    );
    const markup = within(page, B8_WEB_IDS.panel, { "panel-index": "2" });
    const body = await within(markup, "channel-panel-body").innerText();
    ctx.assert(title("the markup is shown as text"), body.includes('<b onclick="steal()">No</b>'), body);
    ctx.assert(title("no element came from panel text"), (await markup.locator("b, i, script").count()) === 0);
    for (const link of await within(page, "channel-panel-link").all()) {
      const problems = panelLinkProblems(await link.getAttribute("target"), await link.getAttribute("rel"));
      ctx.assert(title("the link is nofollow ugc in a new tab"), problems.length === 0, problems);
    }
    await checkAxe(ctx, page, B8_WEB_IDS.panels);
  });

  await ctx.step(title("channel-banner: our own media URL, decorative, in its frame"), async () => {
    const banner = within(page, B8_WEB_IDS.banner);
    await banner.waitFor({ timeout: UI_TIMEOUT_MS });
    const img = banner.locator("img");
    ctx.assert(title("the API's banner URL, unchanged"), (await img.getAttribute("src")) === bannerUrl, {
      src: await img.getAttribute("src"),
      bannerUrl,
    });
    ctx.assert(title("alt is empty"), (await img.getAttribute("alt")) === "");
    ctx.assert(title("lazy"), (await img.getAttribute("loading")) === "lazy");
    await checkAxe(ctx, page, B8_WEB_IDS.banner);
  });

  await ctx.step(title("320 px: no horizontal scroll"), async () => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await within(page, B8_WEB_IDS.panels).waitFor({ timeout: UI_TIMEOUT_MS });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ctx.assert(title("the page fits 320 px"), overflow <= 0, { overflow });
  });
}
