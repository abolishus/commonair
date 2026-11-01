// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `twitch-import` steps 1–8 (docs/testing/b7-selectors.md, "Scenarios"; ADR 0031) and their run
 * state, against the in-harness Twitch mock (`src/mocks/twitch/`), never the real Twitch API.
 *
 * 1. Connect through the mock: the authorize URL asks for no scopes; the callback lands on
 *    `/import?twitch=connected`.
 * 2. The preview shows the fixture channel (title, emotes with the Bits emote skipped).
 * 3. Import title, tags, category, description and emotes, with the art assertion.
 * 4. The channel page shows the title.
 * 5. Accepted emotes work in chat; the T0 fixture emote is rejected and its T0 case opened.
 * 6. The schedule is carried, not applied.
 * 7. Paste panels (own actor) and see them on the channel.
 * 8. The mock recorded the revocation of every token it issued.
 *
 * Steps 1–6 and 8 share one streamer; step 7 uses its own. `--set via=web` (the default) drives
 * `/import` in a browser; `via=api` the same through the API (the authorization is then followed
 * with the streamer's own session cookies). The browser on this machine cannot resolve
 * `host.containers.internal` (the authorize base the containers use), so web steps rewrite that
 * origin to the mock's local address with `page.route`.
 *
 * Database access (the fixture category, T0 cases) needs `DATABASE_URL` (Bun loads it from `.env`).
 */
import type { PortabilityImport } from "@commonair/contracts/dto";
import type { Page } from "playwright";
import { startTwitchMock, TWITCH_FIXTURE, type TwitchMock } from "../mocks/twitch/server.ts";
import type { Via } from "../money.ts";
import { playerBundles } from "../player-server.ts";
import { fixturePath, FIXTURES } from "../safety.ts";
import { readFixture } from "../safety-io.ts";
import type { ScenarioContext } from "../scenario.ts";
import type { SignedInUser } from "../users.ts";
import { testIdSelector as tid } from "../w2/rehearsal/checks.ts";
import { twitchImportTitle, type TwitchImportStep } from "../w3/steps.ts";
import { waitFor } from "../wait.ts";
import { signInViaUi } from "../web/flows.ts";
import { ROUTES } from "../web/selectors.ts";
import { WebSession } from "../web/session.ts";
import { ensureCategory, t0CasesSince } from "./db.ts";

/**
 * The port the Twitch mock listens on, on this machine. `harness/compose.n3.yaml` points
 * `TWITCH_API_BASE_URL` and `TWITCH_AUTH_BASE_URL` at `host.containers.internal:<this>` (a test
 * keeps them in step), so it is fixed, not ephemeral.
 */
export const TWITCH_MOCK_PORT = 4791;

export const IMPORT_ROUTE = "/import";
const UI_TIMEOUT_MS = 30_000;
/** The worker applies the import: one image fetch and one upload-pipeline call per emote. */
const IMPORT_TIMEOUT_MS = 120_000;
const T0_TIMEOUT_MS = 60_000;
const CATEGORY_SLUG = "pixel-art-gardening";
/** Offered emotes that should land; the T0 one is offered too, and refused by the pipeline. */
const ACCEPTED = ["pgWave", "pgHype", "pgHi"] as const;

/** Pasted in step 7: two panels, one with markup that must not survive, one with a link. */
export const PANEL_PASTE = [
  "# About the garden",
  'Pixel <b onclick="steal()">sprites</b>, slow mornings.<script>alert(1)</script>',
  "",
  "## Seed shop",
  "Trade cuttings with the community.",
  "https://shop.example.org/seeds",
].join("\n");
/** What `panelPaste` makes of `PANEL_PASTE` (the web parses it; `via=api` saves this directly). */
export const PANEL_EXPECTED = [
  { title: "About the garden", body: "Pixel sprites, slow mornings.", imageKey: null, linkUrl: null },
  {
    title: "Seed shop",
    body: "Trade cuttings with the community.",
    imageKey: null,
    linkUrl: "https://shop.example.org/seeds",
  },
];

export interface TwitchImportRun {
  ctx: ScenarioContext;
  via: Via;
  databaseUrl: string | undefined;
  mock: TwitchMock | null;
  sessions: WebSession[];
  /** Steps 1–6 and 8. */
  streamer: SignedInUser | null;
  page: Page | null;
  /** Step 2's preview, step 3's finished import. */
  preview: PortabilityImport | null;
  done: PortabilityImport | null;
  /** When step 3 started, for the T0 case count. */
  startedAt: Date | null;
}

const title = (n: TwitchImportStep, what: string) => twitchImportTitle(n, what);
const channelOf = (u: SignedInUser) => u.me.channelSlug ?? u.username;

/** Set up what the selected steps share: the mock (steps that talk to Twitch), torn down at the end. */
export async function newTwitchImportRun(ctx: ScenarioContext, opts: { via: Via }): Promise<TwitchImportRun> {
  const run: TwitchImportRun = {
    ctx,
    via: opts.via,
    databaseUrl: ctx.env.DATABASE_URL,
    mock: null,
    sessions: [],
    streamer: null,
    page: null,
    preview: null,
    done: null,
    startedAt: null,
  };
  ctx.defer(async () => {
    await Promise.allSettled(run.sessions.map((s) => s.close()));
    await run.mock?.close();
  });
  return run;
}

async function mockOf(run: TwitchImportRun): Promise<TwitchMock> {
  run.mock ??= await startTwitchMock({
    port: TWITCH_MOCK_PORT,
    hostname: "0.0.0.0",
    publicHost: run.ctx.env.HARNESS_WEBHOOK_HOST,
    t0Image: readFixture(fixturePath(FIXTURES.t0Csam)),
  });
  return run.mock;
}

async function webSession(run: TwitchImportRun, user: SignedInUser, label: string): Promise<WebSession> {
  const { ctx } = run;
  const s = await WebSession.open({
    fleet: ctx.platform.fleet,
    engine: "chromium",
    webUrl: ctx.env.HARNESS_WEB_URL,
    probeScript: (await playerBundles()).probe,
    label,
    log: ctx.log,
  });
  run.sessions.push(s);
  const page = await s.goto(ROUTES.signin);
  await signInViaUi(page, user, UI_TIMEOUT_MS, ctx.signal);
  return s;
}

/**
 * The browser follows the authorize URL, whose host (`host.containers.internal`) only the
 * containers resolve: answer it from the mock on this machine, redirect included, untouched.
 */
async function routeAuthorize(page: Page, mock: TwitchMock, publicHost: string): Promise<void> {
  const containerOrigin = `http://${publicHost}:${mock.port}`;
  await page.route(
    (url) => url.origin === containerOrigin,
    async (route) => {
      const u = new URL(route.request().url());
      const local = `${mock.origin}${u.pathname}${u.search}`;
      const res = await route.fetch({ url: local, maxRedirects: 0 });
      await route.fulfill({ response: res });
    },
  );
}

async function streamerOf(run: TwitchImportRun): Promise<SignedInUser> {
  run.streamer ??= await run.ctx.step(title(1, "sign up a streamer"), () =>
    run.ctx.platform.signUp({ prefix: "n3_streamer" }),
  );
  return run.streamer;
}

async function importPage(run: TwitchImportRun, user: SignedInUser): Promise<Page> {
  if (!run.page) {
    const s = await webSession(run, user, "n3-import-streamer");
    run.page = await s.goto(IMPORT_ROUTE);
  }
  return run.page;
}

// ------------------------------------------------------------------ 1. connect

async function connect(run: TwitchImportRun): Promise<void> {
  const { ctx } = run;
  const mock = await mockOf(run);
  const streamer = await streamerOf(run);
  const channel = channelOf(streamer);
  const status = await streamer.api.client.twitchImport.status({ channel });
  ctx.assert("1. the import is available on this stack (compose.n3.yaml)", status.available, status);
  const before = mock.issued.length;

  if (run.via === "web") {
    const page = await importPage(run, streamer);
    await routeAuthorize(page, mock, ctx.env.HARNESS_WEBHOOK_HOST);
    await ctx.step(title(1, "connect on /import"), async () => {
      await page.locator(tid("import-connect")).click({ timeout: UI_TIMEOUT_MS });
      await page.waitForURL((u) => u.pathname === IMPORT_ROUTE && u.searchParams.get("twitch") !== null, {
        timeout: UI_TIMEOUT_MS,
      });
      await page.locator(tid("import-preview")).waitFor({ timeout: UI_TIMEOUT_MS });
    });
    ctx.assert(
      "1. the callback says connected",
      new URL(page.url()).searchParams.get("twitch") === "connected",
      page.url(),
    );
  } else {
    const outcome = await ctx.step(title(1, "connect through the API"), async () => {
      const { authorizeUrl } = await streamer.api.client.twitchImport.connect({ channel });
      const u = new URL(authorizeUrl);
      // The mock answers on this machine; the redirect goes to the instance's callback.
      const res = await fetch(`${mock.origin}${u.pathname}${u.search}`, { redirect: "manual", signal: ctx.signal });
      const cb = new URL(res.headers.get("location") ?? "");
      const api = new URL(streamer.api.baseUrl);
      const back = await streamer.api.fetch(
        new Request(`${api.origin}${cb.pathname}${cb.search}`, { redirect: "manual" }),
      );
      return new URL(back.headers.get("location") ?? "http://x/").searchParams.get("twitch");
    });
    ctx.assert("1. the callback says connected", outcome === "connected", { outcome });
  }
  const auth = mock.authorizations.at(-1);
  ctx.assert("1. the authorize request asked for no scopes", auth?.scope === "", auth);
  ctx.assert("1. one token was issued", mock.issued.length === before + 1, { issued: mock.issued.length - before });
  const after = await streamer.api.client.twitchImport.status({ channel });
  ctx.assert(
    "1. the import is connected as the fixture account",
    after.connected && after.twitchLogin === TWITCH_FIXTURE.login,
    after,
  );
}

// ------------------------------------------------------------------ 2. preview

async function previewShown(run: TwitchImportRun): Promise<void> {
  const { ctx } = run;
  ctx.assert("2. step 1 connected a streamer", run.streamer !== null);
  const streamer = run.streamer as SignedInUser;
  const channel = channelOf(streamer);
  const dto = await ctx.step(title(2, "read the preview"), () => streamer.api.client.twitchImport.preview({ channel }));
  run.preview = dto;
  const c = dto.preview.channel;
  ctx.assert(
    "2. the preview shows the fixture channel",
    c.title === TWITCH_FIXTURE.title && c.twitchLogin === TWITCH_FIXTURE.login,
    c,
  );
  ctx.check(
    "2. the category and description are previewed",
    c.category === TWITCH_FIXTURE.category && c.description === TWITCH_FIXTURE.description,
    c,
  );
  ctx.check("2. the mature label is suggested", c.matureSuggested === true, c);
  const offered = dto.preview.items.filter((i) => i.kind === "emote" && i.outcome === null).map((i) => i.ref);
  ctx.assert(
    "2. the fixture emotes are offered",
    [...ACCEPTED, TWITCH_FIXTURE.t0Emote].every((e) => offered.includes(e)),
    offered,
  );
  const bits = dto.preview.items.find((i) => i.ref === TWITCH_FIXTURE.bitsEmote);
  ctx.check("2. the Bits emote is skipped", bits?.outcome === "skipped" && bits.reason === "bits_emote", bits);

  if (run.via === "web") {
    const page = await importPage(run, streamer);
    await ctx.step(title(2, "the preview on /import"), async () => {
      await page.locator(tid("import-preview", { "import-id": dto.id })).waitFor({ timeout: UI_TIMEOUT_MS });
      await page.locator(tid("import-field", { field: "channel", state: "on" })).waitFor({ timeout: UI_TIMEOUT_MS });
      await page
        .locator(tid("import-emote", { code: TWITCH_FIXTURE.bitsEmote, "skip-reason": "bits_emote" }))
        .waitFor({ timeout: UI_TIMEOUT_MS });
      await page.locator(tid("import-emote", { code: "pgWave", tier: "1" })).waitFor({ timeout: UI_TIMEOUT_MS });
      await page.locator(tid("import-mature")).waitFor({ timeout: UI_TIMEOUT_MS });
    });
  }
}

// ------------------------------------------------------------------ 3. import

async function waitDone(run: TwitchImportRun, user: SignedInUser): Promise<PortabilityImport> {
  const channel = channelOf(user);
  return waitFor(
    "the import finished",
    async () => {
      const s = await user.api.client.twitchImport.status({ channel });
      const l = s.latest;
      return l && (l.status === "done" || l.status === "failed") ? l : null;
    },
    { timeoutMs: IMPORT_TIMEOUT_MS, intervalMs: 2_000, signal: run.ctx.signal },
  );
}

const outcomeOf = (dto: PortabilityImport | null, kind: string, ref: string) =>
  dto?.result?.find((i) => i.kind === kind && i.ref === ref) ?? null;

async function runImport(run: TwitchImportRun): Promise<void> {
  const { ctx } = run;
  ctx.assert("3. step 2 left a preview", run.streamer !== null && run.preview !== null);
  ctx.assert("3. DATABASE_URL is set (run from the repo root so Bun loads .env)", run.databaseUrl !== undefined);
  const streamer = run.streamer as SignedInUser;
  const preview = run.preview as PortabilityImport;
  const channel = channelOf(streamer);
  await ctx.step(title(3, "the fixture category exists"), () =>
    ensureCategory(run.databaseUrl as string, CATEGORY_SLUG, TWITCH_FIXTURE.category),
  );
  run.startedAt = new Date();
  if (run.via === "web") {
    const page = await importPage(run, streamer);
    await ctx.step(title(3, "assert the emote rights and start on /import"), async () => {
      await page.locator(tid("import-assertion")).click({ timeout: UI_TIMEOUT_MS });
      await page.locator(tid("import-start")).click({ timeout: UI_TIMEOUT_MS });
      await page.locator(tid("import-progress", { status: "done" })).waitFor({ timeout: IMPORT_TIMEOUT_MS });
    });
  } else {
    const emotes = preview.preview.items.filter((i) => i.kind === "emote" && i.outcome === null).map((i) => i.ref);
    await ctx.step(title(3, "start with the channel and every offered emote"), () =>
      streamer.api.client.twitchImport.start({
        channel,
        id: preview.id,
        choices: { channel: true, panels: false, emotes },
        assertEmoteRights: true,
      }),
    );
  }
  const done = await ctx.step(title(3, "the worker applies it"), () => waitDone(run, streamer));
  run.done = done;
  ctx.assert("3. the import finished", done.status === "done", { status: done.status, result: done.result });
  ctx.check("3. the emote-art assertion was recorded", done.assertedAt !== null);
  ctx.assert(
    "3. the channel details were imported",
    outcomeOf(done, "channel", "channel")?.outcome === "imported",
    done.result,
  );
  for (const code of ACCEPTED)
    ctx.assert(
      `3. ${code} was imported`,
      outcomeOf(done, "emote", code)?.outcome === "imported",
      outcomeOf(done, "emote", code),
    );
  if (run.via === "web" && run.page)
    for (const code of ACCEPTED)
      await run.page
        .locator(tid("import-result-item", { kind: "emote", ref: code, outcome: "imported" }))
        .waitFor({ timeout: UI_TIMEOUT_MS });
}

// ------------------------------------------------------------------ 4. the channel page

async function channelShowsTitle(run: TwitchImportRun): Promise<void> {
  const { ctx } = run;
  ctx.assert("4. step 3 imported", run.streamer !== null && run.done !== null);
  const streamer = run.streamer as SignedInUser;
  const channel = channelOf(streamer);
  const c = await ctx.platform.api().client.channels.get({ channel });
  ctx.assert("4. the title landed", c.title === TWITCH_FIXTURE.title, { title: c.title });
  ctx.check(
    "4. the tags landed through the studio's rules",
    ["pixelart", "cozy", "gardening"].every((t) => c.tags.includes(t)),
    c.tags,
  );
  ctx.check("4. the description landed", c.description === TWITCH_FIXTURE.description, { description: c.description });
  ctx.check("4. the category matched by name", c.category?.name === TWITCH_FIXTURE.category, c.category);
  ctx.check("4. the mature label was set", c.mature === true);
  if (run.via === "web") {
    const s =
      run.sessions.find((x) => x.label === "n3-import-streamer") ??
      (await webSession(run, streamer, "n3-import-streamer"));
    const page = await s.goto(`/${channel}`, "channel");
    await ctx.step(title(4, "the channel page shows the title"), () =>
      page.waitForFunction((t) => document.body.innerText.includes(t), TWITCH_FIXTURE.title, {
        timeout: UI_TIMEOUT_MS,
      }),
    );
  }
}

// ------------------------------------------------------------------ 5. emotes in chat, T0 refused

async function emotesInChat(run: TwitchImportRun): Promise<void> {
  const { ctx } = run;
  ctx.assert("5. step 3 imported", run.streamer !== null && run.done !== null && run.startedAt !== null);
  ctx.assert("5. DATABASE_URL is set (run from the repo root so Bun loads .env)", run.databaseUrl !== undefined);
  const streamer = run.streamer as SignedInUser;
  const channel = channelOf(streamer);
  const t0 = outcomeOf(run.done, "emote", TWITCH_FIXTURE.t0Emote);
  ctx.assert(
    "5. the T0 emote was refused with the opaque reason",
    t0?.outcome === "rejected" && t0.reason === "upload_rejected",
    t0,
  );
  const list = await ctx.platform.api().client.chat.emotes.list({ channel });
  ctx.assert(
    "5. the accepted emotes are the channel's",
    ACCEPTED.every((code) => list.some((e) => e.code === code)),
    list.map((e) => e.code),
  );
  ctx.assert("5. no T0 emote on the channel", !list.some((e) => e.code === TWITCH_FIXTURE.t0Emote));
  ctx.check(
    "5. the emotes are served from this instance, never Twitch",
    list.every((e) => !e.url.includes(String(run.mock?.port ?? TWITCH_MOCK_PORT)) && !e.url.includes("jtvnw")),
    list.map((e) => e.url),
  );

  const chat = await ctx.step(title(5, "the streamer joins chat"), () => ctx.platform.chat(streamer));
  ctx.defer(() => chat.close());
  await chat.join(channel);
  const body = `pgWave hello pgHi ${ctx.runId.slice(0, 6)}`;
  const seen = chat.next("message", (f) => f.message.body === body, UI_TIMEOUT_MS);
  // Chat caches emotes: the worker's invalidate is immediate, but give a loaded runner a moment.
  const ack = await ctx.step(title(5, "send a message with two imported emotes"), () => chat.send(channel, body));
  ctx.assert("5. the message was accepted", ack.id !== null, ack);
  const frame = await seen;
  const codes = frame.message.emotes.map((e) => body.slice(e.start, e.end)).sort();
  ctx.assert("5. both emotes are recognised in chat", codes.includes("pgWave") && codes.includes("pgHi"), codes);

  const channelId = (await ctx.platform.api().client.channels.get({ channel })).id;
  const cases = await ctx.step(title(5, "the refused image opened a T0 case"), () =>
    waitFor(
      "a T0 case for the channel",
      async () => {
        const n = await t0CasesSince(run.databaseUrl as string, channelId, run.startedAt as Date);
        return n > 0 ? n : null;
      },
      { timeoutMs: T0_TIMEOUT_MS, intervalMs: 2_000, signal: ctx.signal },
    ),
  );
  ctx.check("5. one T0 case", cases === 1, { cases });
}

// ------------------------------------------------------------------ 6. schedule carried

async function scheduleCarried(run: TwitchImportRun): Promise<void> {
  const { ctx } = run;
  ctx.assert("6. step 2 left a preview", run.streamer !== null && run.preview !== null);
  const streamer = run.streamer as SignedInUser;
  const preview = run.preview as PortabilityImport;
  const schedule = preview.preview.channel.schedule;
  ctx.assert(
    "6. the preview carries the fixture schedule",
    Array.isArray(schedule) && schedule.length === TWITCH_FIXTURE.scheduleSegments,
    schedule,
  );
  const item = preview.preview.items.find((i) => i.kind === "schedule");
  ctx.assert(
    "6. the preview says carried, not applied",
    item?.outcome === "skipped" && item.reason === "carried_not_applied",
    item,
  );
  if (run.done) {
    const r = outcomeOf(run.done, "schedule", "schedule");
    ctx.assert(
      "6. the result says carried, not applied",
      r?.outcome === "skipped" && r.reason === "carried_not_applied",
      r,
    );
  }
  if (run.via === "web") {
    const s =
      run.sessions.find((x) => x.label === "n3-import-streamer") ??
      (await webSession(run, streamer, "n3-import-streamer"));
    const page = await s.goto(IMPORT_ROUTE, "schedule");
    await ctx.step(title(6, "/import shows the schedule as carried"), () =>
      run.done
        ? page
            .locator(tid("import-result-item", { kind: "schedule", reason: "carried_not_applied" }))
            .waitFor({ timeout: UI_TIMEOUT_MS })
        : page
            .locator(tid("import-schedule", { count: String(TWITCH_FIXTURE.scheduleSegments) }))
            .waitFor({ timeout: UI_TIMEOUT_MS }),
    );
  }
}

// ------------------------------------------------------------------ 7. panels pasted

async function panelsPasted(run: TwitchImportRun): Promise<void> {
  const { ctx } = run;
  const owner = await ctx.step(title(7, "sign up a streamer"), () => ctx.platform.signUp({ prefix: "n3_panels" }));
  const channel = channelOf(owner);
  if (run.via === "web") {
    const s = await webSession(run, owner, "n3-import-panels");
    const page = await s.goto(IMPORT_ROUTE);
    await ctx.step(title(7, "paste, preview and save on /import"), async () => {
      await page.locator(tid("import-panels-paste")).fill(PANEL_PASTE, { timeout: UI_TIMEOUT_MS });
      await page.locator(tid("import-panels-preview", { count: "2" })).waitFor({ timeout: UI_TIMEOUT_MS });
      await page.locator(tid("import-panels-save")).click({ timeout: UI_TIMEOUT_MS });
      const dialog = page.locator(tid("import-panels-confirm"));
      await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
      await dialog.locator(tid("confirm-dialog-confirm")).click({ timeout: UI_TIMEOUT_MS });
      await page.locator(tid("import-panels-preview", { count: "0" })).waitFor({ timeout: UI_TIMEOUT_MS });
    });
  } else {
    await ctx.step(title(7, "save the parsed panels"), () =>
      owner.api.client.channels.setPanels({ channel, panels: PANEL_EXPECTED }),
    );
  }
  // The channel page reads its panels from `channels.get`.
  const c = await ctx.platform.api().client.channels.get({ channel });
  ctx.assert(
    "7. the channel has the pasted panels",
    c.panels.length === 2 &&
      c.panels.every((p, i) => p.title === PANEL_EXPECTED[i]?.title && p.body === PANEL_EXPECTED[i]?.body),
    c.panels,
  );
  ctx.check("7. the link was kept", c.panels[1]?.linkUrl === PANEL_EXPECTED[1]?.linkUrl, c.panels[1]);
  ctx.assert("7. no markup survived", !JSON.stringify(c.panels).match(/<|onclick|alert/), c.panels);
}

// ------------------------------------------------------------------ 8. token revoked

async function tokenRevoked(run: TwitchImportRun): Promise<void> {
  const { ctx } = run;
  ctx.assert("8. the mock ran (step 1)", run.mock !== null);
  const mock = run.mock as TwitchMock;
  ctx.assert("8. a token was issued", mock.issued.length > 0, { issued: mock.issued.length });
  const unrevoked = mock.issued.filter((t) => !mock.revocations.includes(t));
  ctx.assert("8. every issued token was revoked", unrevoked.length === 0, { unrevoked: unrevoked.length });
  const lastRevoke = mock.requests.findLastIndex((r) => r.path === "/oauth2/revoke");
  const lastRead = mock.requests.findLastIndex((r) => r.path.startsWith("/helix/"));
  ctx.check("8. the revocation followed the reads", lastRevoke > lastRead, { lastRevoke, lastRead });
}

export const TWITCH_IMPORT_STEP_RUNNERS: Readonly<Record<TwitchImportStep, (run: TwitchImportRun) => Promise<void>>> = {
  1: connect,
  2: previewShown,
  3: runImport,
  4: channelShowsTitle,
  5: emotesInChat,
  6: scheduleCarried,
  7: panelsPasted,
  8: tokenRevoked,
};
