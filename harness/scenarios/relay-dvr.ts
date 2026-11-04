// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The relay's DVR, purge feed and captions, split out of `e2e-relay` (batch 8 decision (o): the
 * two together ran 15m01s on push run 41736761538, over the ~12 min shard cap). It stands up its own relay with
 * `e2e-relay`'s `setUpRelay` (a streamer live over RTMP, a member's relay registered and active on
 * the LAN address), so it runs alone on a fresh stack, then runs:
 *
 * - the W3 extensions (`--set w3=`, `src/w3/steps.ts`; ADR 0016 amendment 1, `src/w3/dvr-relay/`):
 *   `dvr-relay`, `dvr-purge` (adds `dvr-relay`) and `relay-vtt`, each on its own streamer;
 * - the B8 extension (`--set b8=`, `src/b8/steps.ts`; batch 8 contract step §4.3):
 *   `relay-dvr-switch` (B8-player, `src/b8/player.ts`): the relay stops mid-DVR session and the
 *   player keeps DVR from the origin.
 *
 * Knobs: `--set via=api|web` (default `api`: the extensions need only the member's API session,
 * so the member signs up through the API and no browser opens), `relayHost=` and `relayPort=`
 * (see src/relay-plan.ts).
 */
import { setUpRelay, runRelayScenario } from "./e2e-relay.ts";
import type { RelayDvrB8Extension } from "../src/b8/kit.ts";
import { stepRelayDvrSwitch } from "../src/b8/player.ts";
import { type B8Extension, b8ExtensionTitle, b8Extensions } from "../src/b8/steps.ts";
import { buildRelayPlan } from "../src/relay-plan.ts";
import { defineScenario } from "../src/scenario.ts";
import { stepDvrPurge, stepDvrRelay, stepRelayVtt } from "../src/w3/dvr-relay/index.ts";
import type { RelayW3Extension } from "../src/w3/kit.ts";
import { type W3Extension, w3ExtensionTitle, w3Extensions } from "../src/w3/steps.ts";

/** What this scenario covers, in order (the step-union test in `tests/b8-harness.test.ts`). */
export const RELAY_DVR_PHASES = ["setup", "dvr through the relay", "relay switch mid-DVR"] as const;

const OFFLINE_TIMEOUT_MS = 60_000;

const W3_STEPS: Readonly<Record<W3Extension<"relay-dvr">, (ext: RelayW3Extension) => Promise<void>>> = {
  "dvr-relay": stepDvrRelay,
  "dvr-purge": stepDvrPurge,
  "relay-vtt": stepRelayVtt,
};

const B8_STEPS: Readonly<Record<B8Extension<"relay-dvr">, (ext: RelayDvrB8Extension) => Promise<void>>> = {
  "relay-dvr-switch": stepRelayDvrSwitch,
};

export default defineScenario({
  name: "relay-dvr",
  description:
    "member's Go relay on the LAN, active → a relay-assigned viewer rewinds through the relay (DVR from the relay, receipts credit it, the session verifies) → a removed recording is purged from the relay within 5 s → .vtt through the relay is uncounted and short-lived → the relay stops mid-DVR and the player keeps DVR from the origin",
  needs: ["api", "web", "mail", "media", "origin", "worker", "relay", "ffmpeg", "browser"],
  // Needs Go and OUTBOUND_ALLOW_PRIVATE_NETWORKS=true (the harness stack sets it), like e2e-relay.
  inFull: true,
  timeoutMs: 25 * 60_000,
  async run(ctx) {
    // The extensions need no browser: unless asked, the member signs up through the API.
    const plan = buildRelayPlan({ ...ctx.params, via: ctx.params.via ?? "api" });
    ctx.data("plan", { via: plan.via, relayHost: plan.relayHost ?? null, relayPort: plan.relayPort ?? null });
    // `--set w3=` / `--set b8=` name pending ones; by default only merged extensions run.
    const w3 = w3Extensions("relay-dvr", ctx.param("w3", ""));
    ctx.data("w3.extensions", w3);
    const b8 = b8Extensions("relay-dvr", ctx.param("b8", ""));
    ctx.data("b8.extensions", b8);
    if (w3.run.length === 0 && b8.run.length === 0) {
      ctx.log.warn("relay-dvr: no extension selected; the relay setup still runs");
    }

    await runRelayScenario(ctx, async (run) => {
      // ── 1. setup (shared with e2e-relay) ──────────────────────────────────────────────────────
      const base = await setUpRelay(ctx, plan, run);
      const ext: RelayW3Extension = {
        ctx,
        platform: ctx.platform,
        check: run.check,
        channel: base.channel,
        streamer: base.streamer,
        member: base.member,
        relay: base.goRelay,
        relayId: base.relayId,
        openHttpViewer: base.openHttp,
        onRelay: (v) => base.onRelay(v, base.relayId),
      };

      // ── 2. DVR from the relay, purges, relay captions ─────────────────────────────────────────
      for (const name of w3.run) await ctx.step(w3ExtensionTitle(name, "run"), () => W3_STEPS[name](ext));

      // ── 3. The relay stops mid-DVR session (B8-player) ────────────────────────────────────────
      for (const name of b8.run) await ctx.step(b8ExtensionTitle(name, "run"), () => B8_STEPS[name](ext));

      await ctx.step("stop viewers", () => Promise.allSettled(base.http.map((v) => v.stop())));
      await ctx.step("stop publishing", () => base.encoder.stop());
      ctx.metric(
        "time_to_offline",
        await ctx.step("channel goes offline (API)", () =>
          ctx.platform.waitForLive(base.channel, false, OFFLINE_TIMEOUT_MS),
        ),
        "ms",
      );
    });
  },
});
