// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Api } from "./api.ts";

type ChannelDto = Awaited<ReturnType<Api["channels"]["get"]>>;

export interface ChannelSummary {
  slug: string;
  displayName: string;
  title: string;
  avatarUrl: string | null;
  live: { title: string; viewerCount: number; startedAt: string } | null;
}

export function summarize(c: ChannelDto): ChannelSummary {
  return {
    slug: c.slug,
    displayName: c.displayName,
    title: c.title,
    avatarUrl: c.avatarUrl,
    live: c.live ? { title: c.live.title, viewerCount: c.live.viewerCount, startedAt: c.live.startedAt } : null,
  };
}
