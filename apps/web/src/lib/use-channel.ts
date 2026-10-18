// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { api } from "./api.ts";
import { summarize, type ChannelSummary } from "./channel-summary.ts";

export const CHANNEL_POLL_MS = 5_000;

/** Live/offline state of a channel: the loader's snapshot, then `channels.get` polled every 5 s. */
export function useChannel(slug: string, initial: ChannelSummary): ChannelSummary {
  // Polled data is tagged with the snapshot it follows, so a new snapshot (navigation) wins.
  const [polled, setPolled] = React.useState<{ after: ChannelSummary; value: ChannelSummary } | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const value = summarize(await api().channels.get({ channel: slug }));
        if (!cancelled) setPolled({ after: initial, value });
      } catch {
        // Keep the last known state; try again on the next tick.
      }
      if (!cancelled) timer = setTimeout(() => void poll(), CHANNEL_POLL_MS);
    };
    timer = setTimeout(() => void poll(), CHANNEL_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [slug, initial]);
  return polled?.after === initial ? polled.value : initial;
}
