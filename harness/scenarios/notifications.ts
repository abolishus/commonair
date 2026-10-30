// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * N1, go-live notifications and the installable PWA (docs/testing/n1-selectors.md, scenario
 * `notifications`; ADR 0028):
 *
 * 1. In-app (N1-fanout): a follower gets one `go_live` row and an unread count of 1.
 * 2. Email (N1-email): the go-live digest in Mailpit with RFC 8058 one-click unsubscribe.
 * 3. Cooldown (N1-fanout): a restart within the cooldown notifies no one again.
 * 4. Push over the API (N1-push; `webPush`): encrypted push to the harness receiver, VAPID
 *    verified, decrypted; a 410 deletes the subscription.
 * 5. Inbox (N1-inbox, web only): the bell, mark all read, the settings page.
 * 6. PWA (N1-pwa, web only): manifest, installability, the service worker and its push handler.
 * 7. Push from the browser (N1-pwa, web only; `webPush`): the toggle subscribes, a go-live
 *    arrives, sign-out removes it.
 *
 * `--set steps=1-3` picks steps (`all` by default: every step not pending in `src/n1/run.ts`;
 * named steps run even while pending); `--set via=api` skips the web-only steps. Steps 4 and 7
 * need `webPush` and are skipped under `--profile no-proprietary`. Owned by the orchestrator:
 * units fill their step modules in `src/n1/`.
 *
 * Needs the harness stack (harness/compose.n1.yaml: push on, http endpoints on this machine
 * through `HARNESS_WEBHOOK_HOST`; harness/compose.e5-coop.yaml: a one-minute email digest).
 */
import { parseVia } from "../src/money.ts";
import { newE8Streamer } from "../src/e8/kit.ts";
import { step as cooldown } from "../src/n1/cooldown.ts";
import { step as email } from "../src/n1/email.ts";
import { step as inapp } from "../src/n1/inapp.ts";
import { step as inbox } from "../src/n1/inbox.ts";
import { step as push } from "../src/n1/push.ts";
import { step as pushWeb } from "../src/n1/push-web.ts";
import { startPushReceiver } from "../src/n1/push-receiver.ts";
import { step as pwa } from "../src/n1/pwa.ts";
import { type N1Run, type N1Step, type N1StepNumber, parseN1Steps, planN1Steps } from "../src/n1/run.ts";
import { defineScenario } from "../src/scenario.ts";

const STEPS: Readonly<Record<N1StepNumber, N1Step>> = {
  1: inapp,
  2: email,
  3: cooldown,
  4: push,
  5: inbox,
  6: pwa,
  7: pushWeb,
};

export default defineScenario({
  name: "notifications",
  description:
    "follow → go live → in-app row → email digest with one-click unsubscribe → cooldown holds across a restart → encrypted web push to a local endpoint → bell and settings → installable PWA and the service worker's push → push from the browser toggle",
  needs: ["api", "web", "chat", "mail", "worker", "media", "ffmpeg", "browser"],
  // N1 milestone end: the orchestrator sets this true and adds it to FULL_REQUIRED and a shard.
  inFull: false,
  timeoutMs: 20 * 60_000,
  async run(ctx) {
    const selection = parseN1Steps(ctx.param("steps", "all"));
    const via = parseVia(ctx.param("via", "web"));
    const plan = planN1Steps(selection, STEPS, via);
    ctx.data("steps", {
      selected: selection.steps,
      explicit: selection.explicit,
      run: plan.run,
      skipped: plan.skipped,
    });
    ctx.data("via", via);
    for (const s of plan.skipped) ctx.skipStep(`${s.step}. ${STEPS[s.step].name}`, s.reason);
    if (plan.run.length === 0) return;

    const p = ctx.platform;
    const viewer = await ctx.step("sign up viewer", () => p.signUp({ prefix: "n1v" }));
    const streamers = await ctx.step("sign up four streamers", async () => {
      const made = [];
      for (let i = 1; i <= 4; i++) made.push(await newE8Streamer(ctx, `n1s${i}`));
      const [a, b, c, d] = made;
      if (!a || !b || !c || !d) throw new Error("four streamers expected");
      return [a, b, c, d] as N1Run["actors"]["streamers"];
    });
    const receiver = startPushReceiver({ webhookHost: ctx.env.HARNESS_WEBHOOK_HOST });
    ctx.defer(() => receiver.close());

    const run: N1Run = {
      ctx,
      platform: p,
      log: ctx.log,
      env: ctx.env,
      via,
      actors: { viewer, streamers },
      receiver,
      state: {},
      ...(via === "web" && plan.run.some((n) => STEPS[n].webOnly) ? { browser: p.fleet } : {}),
    };
    for (const n of plan.run) {
      const s = STEPS[n];
      const title = `${n}. ${s.name}`;
      if (s.requires)
        await ctx.optionalStep(title, s.requires, async () => {
          // The profile allows it; the stack must actually run it (e.g. compose.n1.yaml for webPush).
          for (const need of s.requires ?? []) {
            const problem = await p.probe(need);
            if (problem !== null) throw new Error(`${need}: ${problem}`);
          }
          await s.run(run);
        });
      else await ctx.step(title, () => s.run(run));
    }
  },
});
