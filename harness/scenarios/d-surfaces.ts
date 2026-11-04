// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The design batches' surfaces (.claude/briefs/d/), on a seeded stack: signs in as the seeded
 * viewer and streamer, then runs each D unit's steps from `harness/src/d/<unit>.ts` in wave order.
 * It needs a database a separate `seed full` filled (its store file and DEMO_SEED_PASSWORD), as
 * seed-coverage's second mode does. On any other database (an empty one, or an unsharded `full`'s)
 * it reports every unit as skipped, with the reason, rather than judging pages with no data.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createDb } from "@commonair/db";
import type { DContext, DSteps } from "../src/d/context.ts";
import { steps as d1Api } from "../src/d/d1-api.ts";
import { steps as d1Seed } from "../src/d/d1-seed.ts";
import { steps as d1Web } from "../src/d/d1-web.ts";
import { steps as d2Channel } from "../src/d/d2-channel.ts";
import { steps as d2Chat } from "../src/d/d2-chat.ts";
import { steps as d2Player } from "../src/d/d2-player.ts";
import { steps as d3Watch } from "../src/d/d3-watch.ts";
import { steps as d4 } from "../src/d/d4.ts";
import { steps as d5Settings } from "../src/d/d5-settings.ts";
import { steps as d5Studio } from "../src/d/d5-studio.ts";
import { DEFAULT_REPORT_DIR } from "../src/report.ts";
import { defineScenario, type ScenarioContext } from "../src/scenario.ts";
import { SEED_STORE_FILE, type SeedStoreFile } from "../src/seed/run.ts";
import type { SeedStore } from "../src/seed/types.ts";
import { signInViaUi } from "../src/web/flows.ts";
import { ROUTES, TEST_IDS as T } from "../src/web/selectors.ts";
import { WebSession, byTestId } from "../src/web/session.ts";

const UI_TIMEOUT_MS = 30_000;

/** Wave order (.claude/briefs/d/README.md). */
const UNITS: readonly [string, DSteps][] = [
  ["d4", d4],
  ["d1-seed", d1Seed],
  ["d1-api", d1Api],
  ["d1-web", d1Web],
  ["d2-channel", d2Channel],
  ["d2-player", d2Player],
  ["d2-chat", d2Chat],
  ["d3-watch", d3Watch],
  ["d5-studio", d5Studio],
  ["d5-settings", d5Settings],
];

/** The separate `seed full` run's store and password, or why there is none. */
async function seeded(ctx: ScenarioContext): Promise<{ store: SeedStore; password: string } | { skip: string }> {
  const url = ctx.env.DATABASE_URL;
  if (!url) return { skip: "DATABASE_URL is not set" };
  const db = createDb({ url, max: 1, applicationName: "harness-d-surfaces" });
  let users: number;
  try {
    users = (await db.sql<{ n: number }[]>`select count(*)::int as n from users`)[0]?.n ?? 0;
  } finally {
    await db.close();
  }
  if (users === 0) return { skip: "the database is empty: run `seed full` first" };
  const file = join(ctx.env.HARNESS_REPORT_DIR ?? DEFAULT_REPORT_DIR, SEED_STORE_FILE);
  const fromFile = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as SeedStoreFile) : null;
  if (!fromFile?.store.users.some((u) => u.handle === "viewer1"))
    return { skip: `the database has ${users} user(s) but no full seed (${file} missing): run \`seed full\` first` };
  const password = process.env.DEMO_SEED_PASSWORD;
  if (!password) return { skip: "set DEMO_SEED_PASSWORD to the `seed full` run's password" };
  return { store: fromFile.store, password };
}

export default defineScenario({
  name: "d-surfaces",
  description: "design batches D1–D5: discovery, channel, player, chat, watch, polish and studio on a seeded stack",
  needs: ["api", "web", "browser"],
  timeoutMs: 15 * 60_000,
  async run(ctx) {
    const s = await seeded(ctx);
    if ("skip" in s) {
      ctx.log.info("d-surfaces: skipped", { reason: s.skip });
      for (const [unit] of UNITS) ctx.skipStep(unit, s.skip);
      return;
    }
    const { store, password } = s;

    const open = async (label: string) => {
      const session = await WebSession.open({
        fleet: ctx.platform.fleet,
        engine: "chromium",
        webUrl: ctx.env.HARNESS_WEB_URL,
        probeScript: "",
        label: `d-${label}`,
        log: ctx.log,
      });
      ctx.defer(() => session.close());
      return session;
    };
    const signedIn = async (handle: string) => {
      const user = store.users.find((u) => u.handle === handle);
      if (!user) throw new Error(`d-surfaces: the seed made no ${handle}`);
      const session = await open(handle);
      const page = await session.goto(ROUTES.signin);
      await ctx.step(`${handle}: sign in through the web UI`, async () => {
        await signInViaUi(page, { email: user.email, password }, UI_TIMEOUT_MS, ctx.signal);
        await byTestId(page, T.navUser).first().waitFor({ timeout: UI_TIMEOUT_MS });
      });
      return page;
    };

    const d: DContext = {
      scenario: ctx,
      store,
      anonymous: await (await open("anonymous")).page(),
      viewer: await signedIn("viewer1"),
      streamer: await signedIn("streamer1"),
    };
    for (const [unit, run] of UNITS) await ctx.step(unit, () => run(d));
  },
});
