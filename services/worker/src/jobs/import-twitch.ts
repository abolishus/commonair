// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `TWITCH_JOBS.import` (ADR 0031): fetch the chosen emote images from Twitch's CDN, build the
 * `twitch` bundle and apply it with `applyBundle` (`../twitch-import/run.ts`). Enqueued by
 * `twitchImport.start`. Retries on a transport failure (the API's upload route down); the last
 * attempt fails the import.
 */
import { QUEUES, TWITCH_JOBS, TwitchImportJob } from "@commonair/contracts/internal";
import { defineJob } from "../runtime/registry.ts";
import { runTwitchImport } from "../twitch-import/run.ts";

const ATTEMPTS = 3;

export const job = defineJob({
  queue: QUEUES.portability,
  name: TWITCH_JOBS.import,
  description: "Fetch a channel's chosen emotes from Twitch, build a twitch bundle and apply it",
  data: TwitchImportJob,
  attempts: ATTEMPTS,
  backoffMs: 10_000,
  handler: async ({ importId }, ctx, meta) =>
    runTwitchImport(ctx, importId, { lastAttempt: meta.attemptsMade + 1 >= ATTEMPTS }),
});
