// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * N4, ActivityPub federation (docs/testing/b7-selectors.md, scenario `federation`; ADR 0030), one
 * CommonAir instance against the minimal in-harness ActivityPub peer (batch 7 decision (c)):
 *
 * 1. Turn federation on for a channel (API, or the studio with `via=web`: `src/n4/web.ts`).
 * 2. The peer resolves `@slug@domain` through WebFinger and fetches the actor.
 * 3. The peer sends `Follow` and receives a signed `Accept`.
 * 4. Go live: the peer's inbox receives a signed `Create{Note}` that verifies.
 * 5. Publish a VOD: the peer receives `Create{Video}`.
 * 6. `Undo{Follow}`, go live again: nothing is delivered.
 * 7. A blocked domain's `Follow` is refused at the inbox.
 * 8. Suspend a channel: the peer receives `Delete` of the actor (a channel of its own).
 * 9. The streamer removes the peer as a follower: it is gone from the list and a go-live sends
 *    it nothing.
 *
 * `--set steps=1,3` picks steps (`all` runs every step not pending; each step adds the ones it
 * reads, `src/w3/steps.ts`); `--set via=api` drives the studio and admin steps through the API.
 * Steps whose unit has not merged are pending and run only when named. The steps live in
 * `src/n4/index.ts`, the peer in `src/mocks/activitypub/peer.ts` (N4-web fills `src/n4/web.ts`).
 *
 * B8 extension (`--set b8=`, `src/b8/steps.ts`): `actor-disabled-event` (B8-server,
 * `src/b8/server.ts`; adds step 3) runs after the steps.
 *
 * Runs in the `w3` shard, on the harness stack with the batch 7 overrides
 * (`bun scripts/infra.ts stack --harness --w3`: harness/compose.n4.yaml turns federation on).
 */
import type { FederationB8Extension } from "../src/b8/kit.ts";
import { stepActorDisabledEvent } from "../src/b8/server.ts";
import { type B8Extension, b8ExtensionTitle, b8Extensions, withB8Steps } from "../src/b8/steps.ts";
import { parseVia } from "../src/money.ts";
import { FEDERATION_STEP_RUNNERS, newFederationRun } from "../src/n4/index.ts";
import { defineScenario } from "../src/scenario.ts";
import {
  FEDERATION_STEP_PREREQUISITES,
  federationTitle,
  parseFederationSteps,
  withPrerequisites,
} from "../src/w3/steps.ts";

const B8_STEPS: Readonly<Record<B8Extension<"federation">, (run: FederationB8Extension) => Promise<void>>> = {
  "actor-disabled-event": stepActorDisabledEvent,
};

export default defineScenario({
  name: "federation",
  description:
    "federation on for a channel → WebFinger and actor → a peer's Follow accepted → go-live Note and VOD delivered, signed → Undo stops delivery → a blocked domain refused → suspension deletes the actor → a removed follower gets nothing",
  needs: ["api", "web", "media", "origin", "worker", "ffmpeg", "browser"],
  inFull: true,
  timeoutMs: 20 * 60_000,
  async run(ctx) {
    const selected = parseFederationSteps(ctx.param("steps", "all"));
    // `--set b8=` names a pending extension; by default only merged ones run (src/b8/steps.ts).
    const b8 = b8Extensions("federation", ctx.param("b8", ""));
    const forB8 = withB8Steps(selected, b8.run);
    const prerequisites = withPrerequisites(forB8.steps, FEDERATION_STEP_PREREQUISITES);
    const steps = prerequisites.steps;
    const added = [...new Set([...forB8.added, ...prerequisites.added])].sort((a, b) => a - b);
    const via = parseVia(ctx.param("via", "web"));
    ctx.data("steps", { selected, run: steps, addedPrerequisites: added });
    ctx.data("via", via);
    ctx.data("b8.extensions", b8);
    if (steps.length === 0 && b8.run.length === 0) {
      ctx.skipStep("federation", "no step selected; name one with --set steps=");
      return;
    }
    const run = await newFederationRun(ctx, { via });
    for (const n of steps) await ctx.step(federationTitle(n, "run"), () => FEDERATION_STEP_RUNNERS[n](run));
    for (const name of b8.run) await ctx.step(b8ExtensionTitle(name, "run"), () => B8_STEPS[name](run));
  },
});
