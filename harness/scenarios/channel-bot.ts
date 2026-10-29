// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Milestone E8, the channel bot (docs/testing/e8-selectors.md, scenario `channel-bot`; ADR 0026):
 *
 * 1. Commands (E8-bot-engine): `!hello` answers once from the channel's bot account, honours its
 *    cooldown and its user level.
 * 2. Points cost (E8-bot-engine): a command costing points refuses without them and charges
 *    with them (`channel.points.change`, reason `command`).
 * 3. Timer (E8-bot-engine): silent in an empty room, posts once after enough chat lines.
 * 4. Viewbots earn nothing (E8-points): a verified viewer earns whole blocks, a swarm nothing.
 * 5. Song requests (E8-bot-engine): `!sr` queues a link, refuses text, `setStatus` moves it.
 * 6. Studio (E8-studio): steps 1 and 3 set up on `/bot`.
 *
 * `--set steps=1,3` picks steps (`all` runs every step not pending); `--set via=api` drives the
 * setup through the API. Steps whose unit has not merged are pending (`src/e8/steps.ts`) and run
 * only when named. Owned by the orchestrator: units fill their step modules in `src/e8/`.
 *
 * Needs `DATABASE_URL` (outbox and ledger checks, the role CLI) and the harness stack
 * (harness/compose.e8.yaml, and harness/compose.e5-coop.yaml's one-minute points blocks).
 */
import { parseVia } from "../src/money.ts";
import { type BotStep, BOT_STEP_PREREQUISITES, botTitle, parseBotSteps, withPrerequisites } from "../src/e8/steps.ts";
import { stepCommands, stepPointsCost, stepSongRequests, stepTimer } from "../src/e8/bot.ts";
import { type E8Run, newE8Run } from "../src/e8/kit.ts";
import { stepViewbots } from "../src/e8/points.ts";
import { stepBotStudio } from "../src/e8/studio.ts";
import { defineScenario } from "../src/scenario.ts";

const STEPS: Readonly<Record<BotStep, (run: E8Run) => Promise<void>>> = {
  1: stepCommands,
  2: stepPointsCost,
  3: stepTimer,
  4: stepViewbots,
  5: stepSongRequests,
  6: stepBotStudio,
};

export default defineScenario({
  name: "channel-bot",
  description:
    "Commands answer from the bot account with cooldowns and levels → a command's points cost → a timer that waits for chat lines → viewbots earn no points → song request links → the same set up from /bot",
  needs: ["api", "web", "chat", "mail", "media", "origin", "worker", "ffmpeg", "browser"],
  // The milestone's end adds it to FULL_REQUIRED and the `interact` shard (contract step §9).
  inFull: false,
  timeoutMs: 20 * 60_000,
  async run(ctx) {
    const selected = parseBotSteps(ctx.param("steps", "all"));
    const { steps, added } = withPrerequisites(selected, BOT_STEP_PREREQUISITES);
    const via = parseVia(ctx.param("via", "web"));
    ctx.data("steps", { selected, run: steps, addedPrerequisites: added });
    ctx.data("via", via);
    if (steps.length === 0) {
      ctx.skipStep("channel-bot", "every step is pending (no E8 unit merged yet); name one with --set steps=");
      return;
    }
    const run = await newE8Run(ctx, { via, prefix: "e8b" });
    for (const n of steps) await ctx.step(botTitle(n, "run"), () => STEPS[n](run));
  },
});
