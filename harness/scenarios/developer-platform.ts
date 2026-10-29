// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Milestone E9, the developer platform (docs/testing/e9-selectors.md, scenario
 * `developer-platform`; ADR 0027):
 *
 * 1. Apps (E9-apps): a confidential and a public app over the API; update; rotate the secret.
 * 2. OAuth (E9-oauth): PKCE code flow, refresh rotation and reuse, device flow, client credentials.
 * 3. Consent (E9-consent, web only): the same through `/oauth2/authorize`, `/activate`,
 *    `/settings/connections`.
 * 4. Webhook (E9-subs): a `channel.follow` webhook with the app token: challenge, signed delivery,
 *    log, test event, redelivery, refusals.
 * 5. WebSocket (E9-ws): welcome, chat, follow, poll and points notifications, keepalive, 4003, the
 *    session limit, revocation and 4008.
 * 6. SDK (E9-sdk): 2, 4 and 5 through `@commonair/sdk`.
 * 7. Console (E9-console, web only): `/developer`, `/developer/bots`, `/admin/apps`.
 * 8. Suspension (E9-apps): an admin suspends the app; tokens, webhook, socket, audit; delete.
 *
 * `--set steps=1-4` picks steps (`all` by default); `--set via=api` skips the web-only steps. A
 * step whose unit has not merged (`ready: false` in its module) is reported pending and skipped,
 * and so is a step whose `needs` do not all run. Owned by the orchestrator: units fill their step
 * modules in `src/e9/`.
 *
 * Needs `DATABASE_URL` (the operator role CLI) and the harness stack (harness/compose.e9.yaml:
 * EventSub may call the plain-http receiver on this machine through `HARNESS_WEBHOOK_HOST`).
 */
import { parseVia } from "../src/money.ts";
import { grantRole } from "../src/money-db.ts";
import { newE8Streamer } from "../src/e8/kit.ts";
import { step as app } from "../src/e9/app.ts";
import { step as consent } from "../src/e9/consent.ts";
import { step as devConsole } from "../src/e9/console.ts";
import { step as oauth } from "../src/e9/oauth.ts";
import { startReceiver } from "../src/e9/receiver.ts";
import { type E9Run, type E9Step, type E9StepNumber, parseE9Steps, planE9Steps } from "../src/e9/run.ts";
import { step as sdk } from "../src/e9/sdk.ts";
import { step as suspend } from "../src/e9/suspend.ts";
import { step as webhook } from "../src/e9/webhook.ts";
import { step as websocket } from "../src/e9/websocket.ts";
import { defineScenario } from "../src/scenario.ts";

const STEPS: Readonly<Record<E9StepNumber, E9Step>> = {
  1: app,
  2: oauth,
  3: consent,
  4: webhook,
  5: websocket,
  6: sdk,
  7: devConsole,
  8: suspend,
};

const ROLE_CLI_TIMEOUT_MS = 30_000;

export default defineScenario({
  name: "developer-platform",
  description:
    "OAuth apps → PKCE, refresh rotation, device flow and client credentials → consent pages → a signed webhook and its log → the EventSub WebSocket → the SDK → the developer console → an admin suspends the app",
  needs: ["api", "web", "chat", "mail", "worker", "browser"],
  // FULL_REQUIRED gains it when the last E9 unit merges; until then pending steps are skipped.
  timeoutMs: 15 * 60_000,
  async run(ctx) {
    const selected = parseE9Steps(ctx.param("steps", "all"));
    const via = parseVia(ctx.param("via", "web"));
    const plan = planE9Steps(selected, STEPS, via);
    ctx.data("steps", { selected, run: plan.run, skipped: plan.skipped });
    ctx.data("via", via);
    for (const s of plan.skipped) ctx.skipStep(`${s.step}. ${STEPS[s.step].name}`, s.reason);
    if (plan.run.length === 0) return;

    const databaseUrl = ctx.env.DATABASE_URL;
    if (databaseUrl === undefined)
      throw new Error("DATABASE_URL is not set (the operator role CLI; run from the repo root so Bun loads .env)");
    const p = ctx.platform;
    const signedUp = await ctx.step("sign up admin", () => p.signUp({ prefix: "e9adm" }));
    await ctx.step("grant admin (operator CLI)", () =>
      grantRole(databaseUrl, signedUp.username, "admin", ROLE_CLI_TIMEOUT_MS),
    );
    const admin = await ctx.step("admin: sign in again to pick up the role", () => p.users.signIn(signedUp));
    const developer = await ctx.step("sign up developer", () => p.signUp({ prefix: "e9dev" }));
    const streamer = await ctx.step("sign up streamer", () => newE8Streamer(ctx, "e9str"));
    const viewer = await ctx.step("sign up viewer", () => p.signUp({ prefix: "e9v" }));
    const receiver = startReceiver({ webhookHost: ctx.env.HARNESS_WEBHOOK_HOST });
    ctx.defer(() => receiver.close());

    const run: E9Run = {
      ctx,
      platform: p,
      log: ctx.log,
      env: ctx.env,
      via,
      actors: { developer, streamer, viewer, admin },
      state: { receiver },
      ...(via === "web" && plan.run.some((n) => STEPS[n].webOnly) ? { browser: p.fleet } : {}),
    };
    for (const n of plan.run) await ctx.step(`${n}. ${STEPS[n].name}`, () => STEPS[n].run(run));
  },
});
