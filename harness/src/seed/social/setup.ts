// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-social's checklist marks (overhaul wave 3, d5-dashboard): the established demo streamers
 * have done "Bring your audience" (`stream.setupMark`, the only writer of `channel_setup_steps`);
 * the new streamer (`streamer3`) has not, so its studio shows the step still open.
 */
import type { SessionSource } from "./api.ts";
import type { SocialPlan } from "./plan.ts";

/** Who has marked "Bring your audience". */
export const AUDIENCE_MARKED = ["streamer1", "streamer2"] as const;

export async function seedSetupMarks(
  sessions: SessionSource,
  plan: SocialPlan,
  signal: AbortSignal,
): Promise<{ rows: { channel_setup_steps: number } }> {
  let marked = 0;
  for (const h of AUDIENCE_MARKED) {
    const c = plan.channels.find((x) => x.ownerHandle === h);
    if (!c) continue;
    signal.throwIfAborted();
    const u = await sessions.as(h);
    try {
      await u.api.client.stream.setupMark({ channel: c.slug, step: "bring_your_audience" });
    } catch (err) {
      throw new Error(`seed-social: mark "bring your audience" as ${h} failed: ${String(err)}`);
    }
    marked++;
  }
  return { rows: { channel_setup_steps: marked } };
}
