// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit D1-SEED's `d-surfaces` steps (.claude/briefs/d/): the seed's identity as the public API
 * serves it. The showcase channels have an avatar, a banner and 3–5 panels linking to example.org;
 * the live cards carry avatars and, while `seed live` runs, a verified viewer count above 0. Box art
 * waits on a contract request (no procedure sets it), so that check is reported as skipped.
 */
import { PANEL_LINK_ORIGIN, SHOWCASE_STREAMERS } from "../seed/social/identity.ts";
import { waitFor } from "../wait.ts";
import type { DContext } from "./context.ts";

/** `seed live`'s viewers arrive within a minute and verify after three heartbeats. */
const VERIFIED_WITHIN_MS = 4 * 60_000;

export async function steps(ctx: DContext): Promise<void> {
  const s = ctx.scenario;
  const api = s.platform.api().client;

  await s.step("d1-seed: showcase channels have an avatar, a banner and panels", async () => {
    for (const handle of SHOWCASE_STREAMERS) {
      const slug = ctx.store.channels.find((c) => c.ownerHandle === handle)?.slug;
      if (!slug) {
        s.check(`d1-seed: the store has ${handle}'s channel`, false);
        continue;
      }
      const c = await api.channels.get({ channel: slug });
      s.check(`d1-seed: ${handle} has an avatar`, c.avatarUrl !== null, { avatarUrl: c.avatarUrl });
      s.check(`d1-seed: ${handle} has a banner`, c.bannerUrl !== null, { bannerUrl: c.bannerUrl });
      const links = c.panels.flatMap((p) => (p.linkUrl ? [p.linkUrl] : []));
      s.check(`d1-seed: ${handle} has 3–5 panels`, c.panels.length >= 3 && c.panels.length <= 5, {
        panels: c.panels.length,
      });
      s.check(
        `d1-seed: ${handle}'s panel links go to example.org only`,
        links.length > 0 && links.every((l) => l.startsWith(`${PANEL_LINK_ORIGIN}/`)),
        { links },
      );
    }
  });

  const home = await s.step("d1-seed: the front page", () => api.directory.home({}));
  const cards = [...home.live, ...home.recentlyLive];
  s.check(
    "d1-seed: every card on the front page has an avatar",
    cards.length > 0 && cards.every((c) => c.channel.avatarUrl !== null),
    { missing: cards.filter((c) => c.channel.avatarUrl === null).map((c) => c.channel.slug) },
  );

  if (home.live.length === 0)
    s.skipStep("d1-seed: verified viewers on live cards", "no channel is live (run `seed live`)");
  else
    await s.step("d1-seed: verified viewers on live cards", async () => {
      const counted = await waitFor(
        "a live card with a verified count above 0",
        async () => {
          const live = (await api.directory.home({})).live;
          return live.some((c) => c.broadcast.viewerCount > 0) ? live : null;
        },
        { timeoutMs: VERIFIED_WITHIN_MS, intervalMs: 5_000, signal: s.signal },
      ).catch(() => null);
      s.check("d1-seed: a live card shows a verified viewer count above 0", counted !== null, {
        counts: (counted ?? home.live).map((c) => [c.channel.slug, c.broadcast.viewerCount]),
      });
    });

  s.skipStep(
    "d1-seed: categories have boxArtUrl",
    "no procedure sets a category's box art yet (D1-seed contract request); D1-web's fallback tile covers it",
  );
}
