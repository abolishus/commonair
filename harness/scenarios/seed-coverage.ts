// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * After `seed full`, every web route as its role (`SEED_ROUTES`) renders: no error boundary or
 * error response anywhere, and no empty state or 4xx where the route should show seeded data
 * (docs/testing/seeding.md). On a database with no users and `DEMO_SEED_FULL=true` (the `seed`
 * shard's fresh stack) it runs `seed full --scale small` itself first; on a database a separate
 * `seed full` filled, it reads that run's store file and signs in with DEMO_SEED_PASSWORD. On any
 * other database (an unsharded `full`, whose other scenarios made users) it reports every route as
 * skipped, with the reason: the seed needs a fresh database. During the walk streamer1 and
 * streamer2 stream with chat (`seed live`, stopped in the teardown), unless a separate `seed live`
 * already keeps streamer1 live. Logins are crawled `CRAWL_CONCURRENCY` at a time
 * (`--set crawlConcurrency=1` walks them one by one, as before), each paced under its own user's
 * rate limit, and their sign-ins under the shared per-address `auth` limit.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createDb } from "@commonair/db";
import { generatePassword } from "@commonair/db/demo";
import type { Page, Response } from "playwright";
import { DEFAULT_REPORT_DIR } from "../src/report.ts";
import { defineScenario, type ScenarioContext } from "../src/scenario.ts";
import { describeTarget } from "../src/seed/guard.ts";
import { COVERAGE_CHAT_GAP_MS, COVERAGE_LIVE_CHANNELS, fixedLiveSlugs } from "../src/seed/live.ts";
import { runSeedLiveCommand } from "../src/seed/media/live-io.ts";
import { SEED_ROUTES, type SeedRoute } from "../src/seed/routes.ts";
import { SEED_STORE_FILE, type SeedStoreFile, runSeedFull } from "../src/seed/run.ts";
import type { SeedStore } from "../src/seed/types.ts";
import {
  CRAWL_CONCURRENCY,
  CRAWL_PACE,
  SIGN_IN_PACE,
  type VisitObservation,
  crawlConcurrency,
  crawlQueue,
  crawlWaitMs,
  loginsOf,
  reportUrl,
  resolveSeedRoute,
  visitProblems,
} from "../src/seed/visit.ts";
import { signInViaUi } from "../src/web/flows.ts";
import { ROUTES, TEST_IDS as T } from "../src/web/selectors.ts";
import { sleep } from "../src/wait.ts";
import { WebSession, byTestId, waitForHydration } from "../src/web/session.ts";

const UI_TIMEOUT_MS = 30_000;
/** How long a page may keep fetching before it is judged as it stands. */
const SETTLE_MS = 15_000;
const EMPTY_STATE = '[data-slot="empty-state"]';
const SKELETON = '[data-slot="skeleton"]';
/** How long a route that should show data may take to fill an empty state (live chat arriving). */
const DATA_GRACE_MS = 10_000;
/** How long the coverage streams may take to show as live. */
const LIVE_TIMEOUT_MS = 90_000;
/** TanStack Router's default error component (the app sets no `defaultErrorComponent`). */
const ERROR_BOUNDARY_TEXT = /Something went wrong!/;

type Seeded = { store: SeedStore; password: string };

/** Seed the empty database, or read a separate run's store, or say why neither applies. */
async function seeded(ctx: ScenarioContext): Promise<Seeded | { skip: string }> {
  const url = ctx.env.DATABASE_URL;
  if (!url) return { skip: "DATABASE_URL is not set" };
  const db = createDb({ url, max: 1, applicationName: "harness-seed-coverage" });
  let users: number;
  try {
    users = (await db.sql<{ n: number }[]>`select count(*)::int as n from users`)[0]?.n ?? 0;
  } finally {
    await db.close();
  }

  if (users === 0) {
    if (process.env.DEMO_SEED_FULL !== "true")
      return { skip: "the database is empty but DEMO_SEED_FULL is not true, so it cannot be seeded" };
    const password = process.env.DEMO_SEED_PASSWORD || generatePassword();
    const scale = ctx.param("scale", "small");
    if (scale !== "small" && scale !== "medium" && scale !== "large")
      throw new Error(`--set scale=${scale}: small, medium or large`);
    let store: SeedStore | null = null;
    const lines: string[] = [];
    const code = await ctx.step(`seed full --scale ${scale}`, () =>
      runSeedFull({
        scale,
        seed: ctx.intParam("seed", 1),
        confirm: describeTarget(url),
        env: ctx.env,
        log: ctx.log.child({ seed: "full" }),
        signal: ctx.signal,
        source: { ...process.env, DEMO_SEED_PASSWORD: password },
        storeFile: join(ctx.env.HARNESS_REPORT_DIR ?? DEFAULT_REPORT_DIR, SEED_STORE_FILE),
        onStore: (s) => (store = s),
        out: (l) => {
          // The generated password never reaches the report.
          if (!l.startsWith("Password")) lines.push(l);
          ctx.log.info(l);
        },
      }),
    );
    ctx.data("seed.output", lines);
    ctx.assert("seed full succeeded", code === 0, { code, last: lines.slice(-5) });
    if (!store) throw new Error("seed full returned no store");
    return { store, password };
  }

  const file = join(ctx.env.HARNESS_REPORT_DIR ?? DEFAULT_REPORT_DIR, SEED_STORE_FILE);
  const fromFile = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as SeedStoreFile) : null;
  if (!fromFile?.store.users.some((u) => u.handle === "admin"))
    return {
      skip: `the database has ${users} user(s) but no full seed (${file} missing); seed-coverage needs a fresh database (the seed shard) or a separate \`seed full\``,
    };
  const password = process.env.DEMO_SEED_PASSWORD;
  if (!password) return { skip: "a separate `seed full` filled the database: set DEMO_SEED_PASSWORD to its password" };
  return { store: fromFile.store, password };
}

/**
 * Keep streamer1 and streamer2 live with chat for the walk (/, the channel page, the embed and the
 * dashboard show a live stream), stopped in the teardown. When streamer1 is already live, a
 * separate `seed live` runs (staging seed mode starts one after `seed full`), and that one is used.
 */
async function keepLive(ctx: ScenarioContext, store: SeedStore, password: string): Promise<void> {
  const slugs = fixedLiveSlugs(store.channels, COVERAGE_LIVE_CHANNELS);
  const first = slugs[0];
  if (!first) throw new Error("seed-coverage: the store has no fixed streamer to keep live");
  if ((await ctx.platform.api().client.channels.get({ channel: first })).live !== null) {
    ctx.log.info("seed-coverage: streamer1 is already live; using the running `seed live`");
    return;
  }
  const controller = new AbortController();
  const running = runSeedLiveCommand({
    channels: COVERAGE_LIVE_CHANNELS,
    source: { ...process.env, DEMO_SEED_PASSWORD: password },
    signal: controller.signal,
    chatGapMs: COVERAGE_CHAT_GAP_MS,
    out: (l) => ctx.log.info(l),
  });
  ctx.defer(async () => {
    controller.abort();
    const code = await running;
    ctx.log.info("seed-coverage: seed live stopped", { code });
  });
  const ended = running.then((code) => {
    throw new Error(`seed live exited (code ${code}) before ${slugs.join(", ")} went live`);
  });
  ended.catch(() => undefined);
  await ctx.step(`seed live: ${slugs.join(", ")} live with chat`, () =>
    Promise.race([Promise.all(slugs.map((s) => ctx.platform.waitForLive(s, true, LIVE_TIMEOUT_MS))), ended]),
  );
}

/** Load one route and judge it as the page stands once it settles. */
async function visit(
  page: Page,
  url: string,
  apiUrl: string,
  webUrl: string,
  expectData: boolean,
): Promise<VisitObservation> {
  const errors: { url: string; status: number }[] = [];
  const origins = [new URL(apiUrl).origin, new URL(webUrl).origin];
  const onResponse = (r: Response) => {
    if (r.status() >= 400 && origins.some((o) => r.url().startsWith(o)))
      errors.push({ url: reportUrl(r.url()), status: r.status() });
  };
  page.on("response", onResponse);
  try {
    const doc = await page.goto(new URL(url, webUrl).toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
    await waitForHydration(page);
    await page.waitForLoadState("networkidle", { timeout: SETTLE_MS }).catch(() => undefined);
    await page
      .locator(SKELETON)
      .first()
      .waitFor({ state: "detached", timeout: SETTLE_MS })
      .catch(() => undefined);
    // Data that arrives after the page settles (live chat comes only over the socket) gets a moment.
    if (expectData)
      await page
        .waitForFunction(
          (sel) => [...document.querySelectorAll(sel)].every((el) => el.getClientRects().length === 0),
          EMPTY_STATE,
          { timeout: DATA_GRACE_MS },
        )
        .catch(() => undefined);
    const empties = page.locator(`${EMPTY_STATE}:visible`);
    const emptyStates = await empties.evaluateAll((els) =>
      els.map((el) => el.querySelector('[data-slot="empty-title"]')?.textContent?.trim() ?? ""),
    );
    const errorBoundary = ERROR_BOUNDARY_TEXT.test((await page.locator("body").textContent()) ?? "");
    return { documentStatus: doc?.status() ?? null, errorResponses: errors, emptyStates, errorBoundary };
  } finally {
    page.off("response", onResponse);
  }
}

/** What the crawl's workers share. */
interface Crawl {
  store: SeedStore;
  password: string;
  /** Sign-in times across every worker (one per-address `auth` bucket). */
  signIns: number[];
  /** A worker failed hard: the others start nothing more. */
  stopped: boolean;
  failed: number;
  loginMs: Record<string, number>;
}

/** Sign in as `as` (unless anonymous) and visit its routes, paced under its own rate limit. */
async function crawlLogin(
  ctx: ScenarioContext,
  crawl: Crawl,
  as: string,
  routes: readonly [string, SeedRoute][],
): Promise<void> {
  const started = Date.now();
  const session = await WebSession.open({
    fleet: ctx.platform.fleet,
    engine: "chromium",
    webUrl: ctx.env.HARNESS_WEB_URL,
    probeScript: "",
    label: `seed-${as}`,
    log: ctx.log,
  });
  ctx.defer(() => session.close());
  const page = await session.page();
  // This login's API calls (one user's rate-limit bucket), so the crawl can keep under it.
  const calls: number[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/rpc/")) calls.push(Date.now());
  });
  if (as !== "anonymous") {
    const user = crawl.store.users.find((u) => u.handle === as);
    ctx.assert(`the seed made ${as}`, user !== undefined);
    if (!user) return;
    // Re-checked after every sleep, and recorded with no await in between, so two workers
    // waking together cannot both take the last slot.
    for (let wait = crawlWaitMs(crawl.signIns, Date.now(), SIGN_IN_PACE); wait > 0;) {
      ctx.log.info("seed-coverage: pacing sign-ins under the auth limit", { as, waitMs: wait });
      await sleep(wait, ctx.signal);
      wait = crawlWaitMs(crawl.signIns, Date.now(), SIGN_IN_PACE);
    }
    crawl.signIns.push(Date.now());
    await ctx.step(`${as}: sign in through the web UI`, async () => {
      const page = await session.goto(ROUTES.signin);
      await signInViaUi(page, { email: user.email, password: crawl.password }, UI_TIMEOUT_MS, ctx.signal);
      await byTestId(page, T.navUser).first().waitFor({ timeout: UI_TIMEOUT_MS });
    });
  }
  for (const [path, route] of routes) {
    if (crawl.stopped) return;
    const resolved = resolveSeedRoute(path, route, crawl.store);
    if (!resolved.ok) {
      // A route that should show data and has no value to visit with is a seed gap.
      if (route.expectData) crawl.failed += ctx.check(`${path} as ${as}`, false, { missing: resolved.missing }) ? 0 : 1;
      else ctx.skipStep(`${path} as ${as}`, `no ${resolved.missing}`);
      continue;
    }
    const wait = crawlWaitMs(calls, Date.now());
    if (wait > 0) {
      ctx.log.info("seed-coverage: pacing under the API rate limit", { as, path, waitMs: wait });
      await sleep(wait, ctx.signal);
    }
    const now = Date.now();
    for (let i = 0; i < CRAWL_PACE.serverCallsPerPage; i++) calls.push(now);
    const seen = await visit(page, resolved.url, ctx.env.HARNESS_API_URL, ctx.env.HARNESS_WEB_URL, route.expectData);
    const problems = visitProblems(route, seen);
    const ok = ctx.check(`${path} as ${as}`, problems.length === 0, {
      url: reportUrl(new URL(resolved.url, ctx.env.HARNESS_WEB_URL).toString()),
      expectData: route.expectData,
      problems,
    });
    if (!ok) crawl.failed++;
  }
  crawl.loginMs[as] = Date.now() - started;
}

export default defineScenario({
  name: "seed-coverage",
  description: "after `seed full`: every web route as its role shows seeded data (no empty state, no error)",
  needs: ["api", "web", "worker", "media", "mail", "ffmpeg", "browser"],
  // Its own CI shard (`seed`, harness/src/shards.ts): `seed full` needs a database with no users.
  inFull: true,
  // seed full at small (about 10 min on CI), then 72 page loads over 11 logins, three at a time.
  timeoutMs: 45 * 60_000,
  async run(ctx) {
    const s = await seeded(ctx);
    if ("skip" in s) {
      ctx.log.info("seed-coverage: skipped", { reason: s.skip });
      for (const path of Object.keys(SEED_ROUTES)) ctx.skipStep(path, s.skip);
      return;
    }
    const { store, password } = s;
    await keepLive(ctx, store, password);
    const queue = crawlQueue(SEED_ROUTES);
    ctx.metric("seed-coverage.logins", loginsOf(SEED_ROUTES).length);
    const workers = crawlConcurrency(ctx.intParam("crawlConcurrency", CRAWL_CONCURRENCY), queue.length);
    ctx.metric("seed-coverage.crawl_concurrency", workers);

    // Logins side by side, each in its own browser context and rate-limit bucket. After a hard
    // failure no worker starts another route; the first error is rethrown once all have stopped.
    const crawl: Crawl = { store, password, signIns: [], stopped: false, failed: 0, loginMs: {} };
    const crawlStarted = Date.now();
    let next = 0;
    const settled = await Promise.allSettled(
      Array.from({ length: workers }, async () => {
        while (!crawl.stopped && !ctx.signal.aborted && next < queue.length) {
          const [as, routes] = queue[next++] as (typeof queue)[number];
          try {
            await crawlLogin(ctx, crawl, as, routes);
          } catch (err) {
            crawl.stopped = true;
            throw err;
          }
        }
      }),
    );
    ctx.metric("seed-coverage.crawl", Date.now() - crawlStarted, "ms");
    // Per login, so the next CI run says where the crawl's time went.
    ctx.data("seed-coverage.loginMs", crawl.loginMs);
    const rejected = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (rejected) throw rejected.reason;
    const failed = crawl.failed;
    ctx.metric("seed-coverage.routes", Object.keys(SEED_ROUTES).length);
    ctx.metric("seed-coverage.failed", failed);
  },
});
