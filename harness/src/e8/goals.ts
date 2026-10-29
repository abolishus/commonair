// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `interact` step 4 (goal overlay) (docs/testing/e8-selectors.md, "Scenarios"). The streamer opens
 * the overlay stream (`harness/src/e6/sse.ts`) with a token from `interact.overlays.token`, starts
 * a followers goal of 2, and two viewers follow: the stream gets `goal` frames 0 → 1 → 2, the last
 * one ended, and the outbox has `channel.goal.end` with `is_achieved: true`. Owned by
 * E8-raids-goals.
 */
import { SseStream, overlayEventsUrl } from "../e6/sse.ts";
import type { E8Run } from "./kit.ts";

/** Goal progress is written by the outbox relay, then relayed in its next batch (well under a second). */
const FRAME_TIMEOUT_MS = 20_000;

interface GoalFrame {
  id: string;
  type: string;
  current: number;
  target: number;
  endedAt: string | null;
}

export async function stepGoal(run: E8Run): Promise<void> {
  const { ctx, streamer: s } = run;
  const [v1, v2] = run.viewers;
  if (!v1 || !v2) throw new Error("the E8 run has fewer than two viewers");
  const client = s.user.api.client;

  const stream = await ctx.step("goal: open the overlay stream", async () => {
    const { token } = await client.interact.overlays.token({ channel: s.channel });
    const st = await SseStream.open(`overlay ${s.channel}`, overlayEventsUrl(ctx.env.HARNESS_API_URL, token));
    ctx.defer(() => st.close());
    ctx.assert("goal: the overlay stream is open", st.status === 200, { status: st.status, failure: st.failure });
    return st;
  });

  const goal = await ctx.step("goal: a followers goal of 2 → frame at 0", async () => {
    const g = await client.interact.goals.create({
      channel: s.channel,
      type: "followers",
      title: "Two follows",
      target: 2,
    });
    ctx.assert("goal: starts at 0, open", g.current === 0 && g.endedAt === null, g);
    await stream.waitEvent<GoalFrame>("goal", (f) => f.id === g.id && f.current === 0, FRAME_TIMEOUT_MS, ctx.signal);
    return g;
  });

  await ctx.step("goal: a follow → frame at 1", async () => {
    await v1.api.client.channels.follow({ channel: s.channel, notify: false });
    const f = await stream.waitEvent<GoalFrame>(
      "goal",
      (x) => x.id === goal.id && x.current === 1,
      FRAME_TIMEOUT_MS,
      ctx.signal,
    );
    ctx.assert("goal: still open at 1", f.data.endedAt === null, f.data);
  });

  await ctx.step("goal: a second follow → frame at 2, ended and achieved", async () => {
    await v2.api.client.channels.follow({ channel: s.channel, notify: false });
    const f = await stream.waitEvent<GoalFrame>(
      "goal",
      (x) => x.id === goal.id && x.current === 2,
      FRAME_TIMEOUT_MS,
      ctx.signal,
    );
    ctx.assert("goal: ended at the target", f.data.endedAt !== null, f.data);
    const frames = stream
      .ofType<GoalFrame>("goal")
      .filter((x) => x.data.id === goal.id)
      .map((x) => x.data.current);
    ctx.assert("goal: frames advanced 0 → 1 → 2", frames.join(",").startsWith("0,1,") && frames.at(-1) === 2, frames);
    const ends = await run.db.query.events.findMany({
      where: (e, { and, eq }) => and(eq(e.type, "channel.goal.end"), eq(e.channelId, s.channelId)),
    });
    const end = ends.find((e) => (e.payload as { id?: string }).id === goal.id);
    ctx.assert(
      "goal: channel.goal.end with is_achieved",
      (end?.payload as { is_achieved?: boolean } | undefined)?.is_achieved === true,
      end,
    );
    const listed = await client.interact.goals.list({ channel: s.channel });
    ctx.assert(
      "goal: listed as ended",
      listed.some((g) => g.id === goal.id && g.endedAt !== null && g.current === 2),
      listed,
    );
  });
}
