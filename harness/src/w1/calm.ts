// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `e2e-social` extensions `flood` and `block` (docs/testing/w1-selectors.md, "Scenarios";
 * W1-calm-chat).
 *
 * `flood`: signed-in API chat bots send 50 messages a second for 10 seconds (a few repeated bodies,
 * varied lines and some mentions of the fan) while the fan's page has Calm Chat on. Recording
 * in the page (a MutationObserver stamping each new row and digest change), at most 3 distinct new
 * rows appear in any one-second window (mentions of the fan excepted: they are never dropped),
 * every mention of the fan appears, the digest region changes at most every 5 s, and the chat panel
 * passes the accessibility check: the in-repo one (roles, names and the live region through the DOM
 * and Playwright's `ariaSnapshot`) plus axe (`@axe-core/playwright`) on the panel.
 *
 * `block`: the fan blocks the troll from `chat-user-block`; the troll's next message is not
 * rendered for the fan but reaches the streamer; unblocking from `/settings/privacy` brings the
 * troll's next message back. With `--set via=api` the same through `me.blocks.*` (the hiding itself
 * is the web client's, so the API run checks the block list and delivery).
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "playwright";
import type { ChatClient } from "../chat-client.ts";
import { playerBundles } from "../player-server.ts";
import type { ScenarioContext } from "../scenario.ts";
import type { SignedInUser } from "../users.ts";
import { sleep, waitFor } from "../wait.ts";
import { signInViaUi } from "../web/flows.ts";
import { ROUTES, TEST_IDS as T } from "../web/selectors.ts";
import { WebSession, byTestId } from "../web/session.ts";
import type { SocialExtension } from "./kit.ts";
import { W1_ROUTES, W1_TEST_IDS as W, byW1Id, w1tid } from "./selectors.ts";

const UI_TIMEOUT_MS = 20_000;

// ------------------------------------------------------------------ flood: the plan

/** The flood's shape (the brief's numbers): 50 msg/s for 10 s, 3 rows a second. */
export const FLOOD = {
  ratePerSecond: 50,
  seconds: 10,
  /** Calm Chat's default rows per second (the fan does not change it). */
  rowsPerSecond: 3,
  /** Chat allows a member 20 messages per 30 s (`CHAT_LIMITS.user`): 30 bots send at most 17 each. */
  bots: 30,
  digestIntervalMs: 5_000,
  /** Mentions of the fan spread over the flood. */
  mentions: 6,
  /** Repeated bodies: each bot sends each once (chat refuses a member's duplicate within 30 s). */
  repeated: ["PogChamp", "LUL what a play", "KEKW"],
} as const;

export interface FloodLine {
  /** Index into the bots. */
  bot: number;
  body: string;
  /** A mention of the fan: must appear. */
  mention: boolean;
  /** Milliseconds after the flood starts. */
  at: number;
}

/**
 * The flood's lines, in send order, round-robin over the bots. A bot's turns 1, 6 and 11 send the
 * repeated bodies (each bot each body once, so three waves of about one copy per bot, a few seconds
 * apart), the mentions are spread evenly, every other line is distinct.
 */
export function floodPlan(fan: string, run: string, f: typeof FLOOD = FLOOD): FloodLine[] {
  const total = f.ratePerSecond * f.seconds;
  const step = 1000 / f.ratePerSecond;
  const mentionEvery = Math.floor(total / f.mentions);
  const lines: FloodLine[] = [];
  let mention = 0;
  for (let i = 0; i < total; i++) {
    const bot = i % f.bots;
    const turn = Math.floor(i / f.bots);
    const at = Math.round(i * step);
    const repeated = turn % 5 === 1 ? f.repeated[Math.floor(turn / 5)] : undefined;
    if (mention < f.mentions && i % mentionEvery === Math.floor(mentionEvery / 2))
      lines.push({ bot, body: `@${fan} look at this ${run}-${mention++}`, mention: true, at });
    else if (repeated !== undefined) lines.push({ bot, body: repeated, mention: false, at });
    else lines.push({ bot, body: `line ${run} ${i}`, mention: false, at });
  }
  return lines;
}

// ------------------------------------------------------------------ flood: what the page showed

/**
 * What the page recorded during the flood (`installFloodRecorder`): when each row id was first on
 * screen and when the digest's text changed, stamped in the page itself (`performance.now()` in a
 * MutationObserver), so polling latency never shifts a time. Rows on screen when the recorder was
 * installed are not recorded.
 */
export interface FloodRecord {
  rows: { id: string; t: number }[];
  digest: { text: string; t: number }[];
}

/**
 * Render latency the window allows: one batch committed late, the next on time. Rows are timed
 * when they reach the DOM, not when the governor admits them, and during the 50-messages-a-second
 * flood a commit lagged its neighbour by more than one 250 ms tick on CI (4 rows in the window,
 * three times). A governor with no window (batches one 250 ms tick apart) or one that admits
 * batches less than 600 ms apart still fails.
 */
export const RENDER_TOLERANCE_MS = 400;

/**
 * The most new rows that appeared within any one-second window (a true sliding window over the
 * recorded times, narrowed by `toleranceMs`), not counting `exempt` rows (mentions, which pass the
 * governor regardless).
 */
export function maxNewRowsPerWindow(
  rows: readonly { id: string; t: number }[],
  exempt: ReadonlySet<string>,
  windowMs = 1_000,
  toleranceMs = RENDER_TOLERANCE_MS,
): { max: number; at: number; times: number[] } {
  const times = rows
    .filter((r) => !exempt.has(r.id))
    .map((r) => r.t)
    .sort((a, b) => a - b);
  const span = windowMs - toleranceMs;
  let best = { max: 0, at: 0, times: [] as number[] };
  let j = 0;
  for (let i = 0; i < times.length; i++) {
    const from = times[i] ?? 0;
    if (j < i) j = i;
    while (j + 1 < times.length && (times[j + 1] ?? 0) - from < span) j++;
    const n = j - i + 1;
    // The window's own times go into a failure's details: they tell render lag from a governor bug.
    if (n > best.max) best = { max: n, at: from, times: times.slice(i, j + 1).map(Math.round) };
  }
  return best;
}

/** The digest's change times and the shortest gap between two of them (Infinity with fewer than two). */
export function digestUpdates(changes: readonly { text: string; t: number }[]): { times: number[]; minGapMs: number } {
  const times = changes.map((c) => c.t);
  let minGapMs = Number.POSITIVE_INFINITY;
  for (let i = 1; i < times.length; i++) minGapMs = Math.min(minGapMs, (times[i] ?? 0) - (times[i - 1] ?? 0));
  return { times, minGapMs };
}

// ------------------------------------------------------------------ accessibility (in-repo check)

/** One element of the chat panel as the check sees it. */
export interface A11yNode {
  tag: string;
  testId: string | null;
  role: string | null;
  /** The accessible name: aria-label, aria-labelledby's text, or the text content. */
  name: string;
  tabIndex: number;
  ariaLive: string | null;
  /** For inputs: has a label (aria-label, aria-labelledby or a `<label for>`). */
  labelled: boolean;
  hidden: boolean;
}

/**
 * Violations of what the chat panel must hold (a stand-in for axe on the rules that matter here):
 * every button and link has a name, every input a label, there is one named `log`, the digest is
 * a polite live region, and at most one chat row is in the tab order (roving focus).
 */
export function a11yViolations(nodes: readonly A11yNode[], opts: { calm: boolean }): string[] {
  const out: string[] = [];
  const visible = nodes.filter((n) => !n.hidden);
  for (const n of visible) {
    const interactive = n.tag === "button" || n.tag === "a" || n.role === "button" || n.role === "menuitem";
    if (interactive && n.name.trim() === "") out.push(`${n.tag}${n.testId ? `[${n.testId}]` : ""} has no name`);
    if ((n.tag === "input" || n.tag === "textarea") && !n.labelled)
      out.push(`${n.tag}${n.testId ? `[${n.testId}]` : ""} has no label`);
  }
  const logs = visible.filter((n) => n.role === "log");
  if (logs.length !== 1) out.push(`expected one log, found ${logs.length}`);
  else if (logs[0]?.name.trim() === "") out.push("the log has no name");
  if (opts.calm) {
    const digest = visible.find((n) => n.testId === W.calmDigest);
    if (!digest) out.push("calm-digest is missing");
    else if (digest.ariaLive !== "polite") out.push(`calm-digest aria-live is ${digest.ariaLive ?? "unset"}`);
  }
  const rowsInTabOrder = visible.filter(
    (n) => (n.testId === W.chatMessage || n.testId === W.chatWave) && n.tabIndex === 0,
  ).length;
  if (rowsInTabOrder > 1) out.push(`${rowsInTabOrder} chat rows are in the tab order (expected at most one)`);
  return out;
}

/** Collect the chat panel's nodes in the page. */
async function panelNodes(page: Page): Promise<A11yNode[]> {
  return page.locator(`[data-testid="${T.chat}"]`).evaluate((root) => {
    const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
    const nameOf = (el: Element) => {
      const label = el.getAttribute("aria-label");
      if (label) return label;
      const by = el.getAttribute("aria-labelledby");
      if (by)
        return by
          .split(/\s+/)
          .map((id) => text(document.getElementById(id)))
          .join(" ");
      return text(el);
    };
    const all = [root, ...root.querySelectorAll("*")];
    return all.map((el) => {
      const html = el as HTMLElement;
      const id = el.getAttribute("id");
      const labelled =
        el.hasAttribute("aria-label") ||
        el.hasAttribute("aria-labelledby") ||
        (id !== null && document.querySelector(`label[for="${CSS.escape(id)}"]`) !== null) ||
        el.closest("label") !== null;
      return {
        tag: el.tagName.toLowerCase(),
        testId: el.getAttribute("data-testid"),
        role: el.getAttribute("role"),
        name: nameOf(el),
        tabIndex: html.tabIndex,
        ariaLive: el.getAttribute("aria-live"),
        labelled,
        hidden: html.closest("[aria-hidden='true'], [hidden]") !== null,
      };
    });
  });
}

/** The in-repo accessibility check on the chat panel; returns the violations (and logs the tree). */
async function checkPanelA11y(ctx: ScenarioContext, page: Page, calm: boolean): Promise<string[]> {
  const violations = a11yViolations(await panelNodes(page), { calm });
  const tree = await page.locator(`[data-testid="${T.chat}"]`).ariaSnapshot({ timeout: UI_TIMEOUT_MS });
  ctx.data("w1.flood.ariaSnapshot", tree.slice(0, 4_000));
  if (!/\blog\b/.test(tree)) violations.push("the accessibility tree has no log");
  const axe = await new AxeBuilder({ page }).include(`[data-testid="${T.chat}"]`).analyze();
  for (const v of axe.violations) violations.push(`axe ${v.id}: ${v.help} (${v.nodes.length} nodes)`);
  return violations;
}

// ------------------------------------------------------------------ shared web helpers

async function fanPage(ext: SocialExtension, label: string): Promise<{ session: WebSession; page: Page }> {
  const { ctx } = ext;
  const { probe } = await playerBundles();
  const session = await WebSession.open({
    fleet: ctx.platform.fleet,
    engine: "chromium",
    webUrl: ctx.env.HARNESS_WEB_URL,
    probeScript: probe,
    label,
    log: ctx.log,
  });
  ctx.defer(() => session.close());
  const page = await session.goto(ROUTES.signin);
  await signInViaUi(page, ext.fan, UI_TIMEOUT_MS, ctx.signal);
  await byTestId(page, T.navUser, { username: ext.fan.username }).waitFor({ timeout: UI_TIMEOUT_MS });
  return { session, page };
}

async function openChannel(session: WebSession, channel: string): Promise<Page> {
  const page = await session.goto(ROUTES.channel(channel));
  await byTestId(page, T.chat, { state: "open" }).waitFor({ timeout: UI_TIMEOUT_MS });
  return page;
}

const RECORDER = "__w1FloodRecord";

/** Start recording row appearances and digest changes inside the page (see `FloodRecord`). */
async function installFloodRecorder(page: Page): Promise<void> {
  await page.evaluate(
    ({ chat, message, wave, digest, key }) => {
      const root = document.querySelector(`[data-testid="${chat}"]`);
      if (!root) throw new Error("no chat panel");
      const record: { rows: { id: string; t: number }[]; digest: { text: string; t: number }[] } = {
        rows: [],
        digest: [],
      };
      const rowSelector = `[data-testid="${message}"], [data-testid="${wave}"]`;
      const seen = new Set([...root.querySelectorAll<HTMLElement>(rowSelector)].map((el) => el.dataset.id ?? ""));
      const digestText = () => root.querySelector(`[data-testid="${digest}"]`)?.textContent ?? "";
      let lastDigest = digestText();
      const observer = new MutationObserver(() => {
        const t = performance.now();
        for (const el of root.querySelectorAll<HTMLElement>(rowSelector)) {
          const id = el.dataset.id ?? "";
          if (seen.has(id)) continue;
          seen.add(id);
          record.rows.push({ id, t });
        }
        const text = digestText();
        if (text !== lastDigest) {
          lastDigest = text;
          record.digest.push({ text, t });
        }
      });
      observer.observe(root, { childList: true, subtree: true, characterData: true });
      Object.assign(window, { [key]: { record, stop: () => observer.disconnect() } });
    },
    { chat: T.chat, message: W.chatMessage, wave: W.chatWave, digest: W.calmDigest, key: RECORDER },
  );
}

async function collectFloodRecord(page: Page): Promise<FloodRecord> {
  return page.evaluate((key) => {
    const rec = (window as unknown as Record<string, { record: FloodRecord; stop: () => void } | undefined>)[key];
    if (!rec) throw new Error("the flood recorder is not installed");
    rec.stop();
    return rec.record;
  }, RECORDER);
}

async function joined(ctx: ScenarioContext, chat: ChatClient, channel: string): Promise<ChatClient> {
  ctx.defer(() => chat.close());
  await chat.join(channel);
  return chat;
}

// ------------------------------------------------------------------ flood

export async function stepFlood(ext: SocialExtension): Promise<void> {
  const { ctx, channel } = ext;
  const p = ctx.platform;
  const run = ctx.runId.slice(-6);

  const bots: SignedInUser[] = [];
  await ctx.step(`sign up ${FLOOD.bots} chat bots`, async () => {
    // A few at a time: sign-up shares the auth rate limit.
    for (let i = 0; i < FLOOD.bots; i += 5)
      bots.push(
        ...(await Promise.all(Array.from({ length: Math.min(5, FLOOD.bots - i) }, () => p.signUp({ prefix: "w1fl" })))),
      );
  });
  const sockets = await ctx.step("bots join the chat", () =>
    Promise.all(bots.map(async (b) => joined(ctx, await ext.chat(b), channel))),
  );

  const { session } = await ctx.step("fan: sign in on a second page", () => fanPage(ext, "fan-calm"));
  const page = await ctx.step("fan: open the channel", () => openChannel(session, channel));
  await ctx.step("fan: turn Calm Chat on", async () => {
    const toggle = byW1Id(page, W.calmToggle);
    if ((await toggle.getAttribute("data-state", { timeout: UI_TIMEOUT_MS })) !== "on") await toggle.click();
    await page.locator(w1tid(W.calmToggle, { state: "on" })).waitFor({ timeout: UI_TIMEOUT_MS });
    await byW1Id(page, W.calmDigest).waitFor({ timeout: UI_TIMEOUT_MS });
  });

  await installFloodRecorder(page);
  const plan = floodPlan(ext.fan.username, run);
  const acks: Promise<{ line: FloodLine; id: string | null }>[] = [];
  const started = performance.now();

  await ctx.step(`bots send ${plan.length} messages in ${FLOOD.seconds} s`, async () => {
    for (const line of plan) {
      const wait = line.at - (performance.now() - started);
      if (wait > 0) await sleep(wait, ctx.signal);
      const bot = sockets[line.bot];
      if (!bot) throw new Error(`no bot ${line.bot}`);
      acks.push(bot.send(channel, line.body).then((a) => ({ line, id: a.id })));
    }
  });
  const sent = await ctx.step("every message is acknowledged", () => Promise.all(acks));
  // One more digest interval, so its last update and the last admitted rows are on screen.
  await sleep(FLOOD.digestIntervalMs + 1_000, ctx.signal);
  const record = await collectFloodRecord(page);

  const accepted = sent.filter((s) => s.id !== null);
  const mentionIds = new Set(accepted.filter((s) => s.line.mention).map((s) => s.id ?? ""));
  ctx.data("w1.flood", {
    planned: plan.length,
    accepted: accepted.length,
    refused: sent.length - accepted.length,
    rowsRecorded: record.rows.length,
    digestChanges: record.digest.length,
  });
  ctx.assert("chat accepted the mentions of the fan", mentionIds.size === FLOOD.mentions, {
    mentions: mentionIds.size,
  });

  const rate = maxNewRowsPerWindow(record.rows, mentionIds);
  ctx.metric("w1_flood_max_rows_per_second", rate.max, "rows");
  ctx.assert(
    `at most ${FLOOD.rowsPerSecond} new rows a second (mentions aside)`,
    rate.max <= FLOOD.rowsPerSecond,
    rate,
  );

  const seen = new Set(record.rows.map((r) => r.id));
  const missing = [...mentionIds].filter((id) => !seen.has(id));
  ctx.assert("every mention of the fan was rendered", missing.length === 0, { missing });

  const digest = digestUpdates(record.digest);
  ctx.data("w1.flood.digestUpdates", digest.times);
  ctx.assert("the digest updated during the flood", digest.times.length > 0, digest);
  ctx.assert(
    `the digest updates at most every ${FLOOD.digestIntervalMs / 1000} s`,
    digest.minGapMs >= FLOOD.digestIntervalMs - RENDER_TOLERANCE_MS,
    digest,
  );

  const violations = await ctx.step("chat panel accessibility check (in-repo)", () => checkPanelA11y(ctx, page, true));
  ctx.assert("the chat panel has no accessibility violations", violations.length === 0, { violations });
}

// ------------------------------------------------------------------ block

export async function stepBlock(ext: SocialExtension): Promise<void> {
  const { ctx, channel, fan, troll, streamer } = ext;
  const run = ctx.runId.slice(-6);
  const trollChat = await ctx.step("troll: chat socket", async () => joined(ctx, await ext.chat(troll), channel));
  const streamerChat = await ctx.step("streamer: chat socket", async () =>
    joined(ctx, await ext.chat(streamer), channel),
  );
  const say = async (label: string) => {
    const ack = await trollChat.send(channel, `${label} ${run}`);
    if (ack.id === null) throw new Error(`chat refused the troll's "${label}"`);
    return ack.id;
  };
  const streamerSees = (id: string) =>
    waitFor(`streamer receives ${id}`, () => streamerChat.messages(channel).some((m) => m.message.id === id), {
      timeoutMs: UI_TIMEOUT_MS,
      signal: ctx.signal,
    });

  if (ext.via === "api") {
    await ctx.step("fan: block the troll (me.blocks.add)", () =>
      fan.api.client.me.blocks.add({ username: troll.username }),
    );
    const ids = await fan.api.client.me.blocks.ids();
    ctx.assert("me.blocks.ids lists the troll", ids.userIds.includes(troll.id), ids);
    const id = await say("after block");
    await ctx.step("the streamer still receives the troll's message", () => streamerSees(id));
    await ctx.step("fan: unblock the troll (me.blocks.remove)", () =>
      fan.api.client.me.blocks.remove({ username: troll.username }),
    );
    const after = await fan.api.client.me.blocks.ids();
    ctx.assert("me.blocks.ids no longer lists the troll", !after.userIds.includes(troll.id), after);
    return;
  }

  const { session } = await ctx.step("fan: sign in on a second page", () => fanPage(ext, "fan-block"));
  let page = await ctx.step("fan: open the channel", () => openChannel(session, channel));
  const message = (id: string) => page.locator(w1tid(W.chatMessage, { id }));

  const first = await say("before block");
  await ctx.step("fan sees the troll's message", () => message(first).waitFor({ timeout: UI_TIMEOUT_MS }));
  await ctx.step("fan: block the troll from chat-user-block", async () => {
    await byW1Id(message(first), W.chatMessageActions).click({ timeout: UI_TIMEOUT_MS });
    await byW1Id(page, W.chatUserBlock).click({ timeout: UI_TIMEOUT_MS });
    await byTestId(page, T.confirmDialogConfirm).click({ timeout: UI_TIMEOUT_MS });
    await message(first).waitFor({ state: "detached", timeout: UI_TIMEOUT_MS });
  });

  const hidden = await say("after block");
  await ctx.step("the streamer receives the troll's next message", () => streamerSees(hidden));
  // The streamer's socket has it, so the fan's page has had the frame too: give it a moment.
  await sleep(2_000, ctx.signal);
  ctx.assert("the troll's next message is not rendered for the fan", (await message(hidden).count()) === 0, {
    id: hidden,
  });
  const blocked = await fan.api.client.me.blocks.ids();
  ctx.assert("me.blocks.ids lists the troll", blocked.userIds.includes(troll.id), blocked);

  await ctx.step("fan: unblock from /settings/privacy", async () => {
    page = await session.goto(W1_ROUTES.privacy);
    const entry = page.locator(w1tid(W.blockedUser, { username: troll.username }));
    await entry.waitFor({ timeout: UI_TIMEOUT_MS });
    await byW1Id(entry, W.blockedUserRemove).click({ timeout: UI_TIMEOUT_MS });
    await entry.waitFor({ state: "detached", timeout: UI_TIMEOUT_MS });
  });
  page = await ctx.step("fan: back to the channel", () => openChannel(session, channel));
  const back = await say("after unblock");
  await ctx.step("fan sees the troll's message again", () => message(back).waitFor({ timeout: UI_TIMEOUT_MS }));
}
