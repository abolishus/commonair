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
 * Runs in the `w3` shard, on the harness stack with the batch 7 overrides
 * (`bun scripts/infra.ts stack --harness --w3`: harness/compose.n4.yaml turns federation on).
 */
import { parseVia } from "../src/money.ts";
import { FEDERATION_STEP_RUNNERS, newFederationRun } from "../src/n4/index.ts";
import { defineScenario } from "../src/scenario.ts";
import {
  FEDERATION_STEP_PREREQUISITES,
  federationTitle,
  parseFederationSteps,
  withPrerequisites,
} from "../src/w3/steps.ts";

export default defineScenario({
  name: "federation",
  description:
    "federation on for a channel → WebFinger and actor → a peer's Follow accepted → go-live Note and VOD delivered, signed → Undo stops delivery → a blocked domain refused → suspension deletes the actor → a removed follower gets nothing",
  needs: ["api", "web", "media", "origin", "worker", "ffmpeg", "browser"],
  inFull: true,
  timeoutMs: 20 * 60_000,
  async run(ctx) {
    const selected = parseFederationSteps(ctx.param("steps", "all"));
    const { steps, added } = withPrerequisites(selected, FEDERATION_STEP_PREREQUISITES);
    const via = parseVia(ctx.param("via", "web"));
    ctx.data("steps", { selected, run: steps, addedPrerequisites: added });
    ctx.data("via", via);
    if (steps.length === 0) {
      ctx.skipStep("federation", "no step selected; name one with --set steps=");
      return;
    }
    const run = await newFederationRun(ctx, { via });
    for (const n of steps) await ctx.step(federationTitle(n, "run"), () => FEDERATION_STEP_RUNNERS[n](run));
  },
});
