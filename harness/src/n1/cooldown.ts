// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Step 3 (N1-fanout): a restart within the cooldown notifies no one again (docs/testing/n1-selectors.md
 * "Scenarios" 3). The first streamer (step 1 left it offline) goes live again; after 45 s the
 * viewer still has exactly one `go_live` row for that channel, the one about step 1's broadcast,
 * and Mailpit has no go-live email about it since the restart.
 */
import type { MailMessage, MailSummary } from "../mailpit.ts";
import { sleep } from "../wait.ts";
import { goLiveRowsFor, publishUntilLive, stopUntilOffline, viewerNotifications } from "./inapp.ts";
import type { N1Run, N1Step } from "./run.ts";

/** How long the restart has to (not) produce a notification (contract step §8 step 3). */
export const COOLDOWN_WATCH_MS = 45_000;

/** Messages in `after` that were not in `before`. Pure. */
export function newMessages<T extends Pick<MailSummary, "id">>(
  before: readonly Pick<MailSummary, "id">[],
  after: readonly T[],
): T[] {
  const seen = new Set(before.map((m) => m.id));
  return after.filter((m) => !seen.has(m.id));
}

/**
 * True when a message links the channel page `/<slug>` (a path segment, not a prefix of a longer
 * slug or a deeper path's first segment of another channel). Pure.
 */
export function linksChannel(message: Pick<MailMessage, "text" | "html">, slug: string): boolean {
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`/${escaped}(?=$|[/?#"'<>\\s)\\]])`, "i");
  return re.test(message.text) || re.test(message.html);
}

async function run(r: N1Run): Promise<void> {
  const { ctx } = r;
  const { viewer } = r.actors;
  const s = r.actors.streamers[0];
  if (r.state.firstChannel !== s.channel) throw new Error("step 3 needs step 1's channel (state.firstChannel)");
  const mailpit = ctx.platform.mailpit;
  const toViewer = `to:"${viewer.email}"`;

  const before = await ctx.step("3. cooldown: the viewer's mail and rows before the restart", async () => {
    const rows = goLiveRowsFor(await viewerNotifications(viewer), s.channelId);
    ctx.assert("3. cooldown: step 1 left one go_live row", rows.length === 1, { count: rows.length });
    return { mail: await mailpit.search(toViewer), broadcastId: rows[0]?.payload.broadcastId };
  });

  const live = await ctx.step("3. cooldown: the first streamer goes live again", () => publishUntilLive(r, s));
  ctx.assert("3. cooldown: a new broadcast started", live.broadcastId !== before.broadcastId, {
    before: before.broadcastId,
    now: live.broadcastId,
  });

  await ctx.step("3. cooldown: 45 s later, still one row and no second email", async () => {
    await sleep(COOLDOWN_WATCH_MS, ctx.signal);
    const rows = goLiveRowsFor(await viewerNotifications(viewer), s.channelId);
    ctx.assert("3. cooldown: exactly one go_live row for the channel", rows.length === 1, { count: rows.length });
    ctx.assert(
      "3. cooldown: the row is still about step 1's broadcast",
      rows[0]?.payload.broadcastId === before.broadcastId,
      { broadcastId: rows[0]?.payload.broadcastId },
    );
    const fresh = newMessages(before.mail, await mailpit.search(toViewer));
    const about = [];
    for (const m of fresh) if (linksChannel(await mailpit.get(m.id), s.channel)) about.push(m.id);
    ctx.assert("3. cooldown: no go-live email about the channel since the restart", about.length === 0, {
      messages: about.length,
    });
  });

  await ctx.step("3. cooldown: the first streamer stops", () => stopUntilOffline(ctx, s, live.publisher));
}

export const step: N1Step = {
  name: "cooldown",
  owner: "N1-fanout",
  needs: [1],
  run,
};
