// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The chat panel's offline state (D2-chat): why the log is quiet, and when someone last spoke.
 * The panel loads no history, so the time comes from one `chat.history` call with `limit: 1`,
 * made only while this state shows. A refusal or an empty answer shows no time at all.
 */
import { EmptyState, RelativeTime } from "@commonair/ui";
import { Message01Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { t } from "../i18n/index.ts";
import { api } from "../lib/api.ts";

/** When the channel's newest kept message was sent (ISO), or null with none. */
export type LastMessageAt = (channel: string) => Promise<string | null>;

/** The newest `createdAt` of a history page; null when it is empty. */
export function newestAt(messages: readonly { createdAt: string }[]): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const m of messages) {
    const ms = Date.parse(m.createdAt);
    if (Number.isFinite(ms) && ms > bestMs) {
      best = m.createdAt;
      bestMs = ms;
    }
  }
  return best;
}

export const historyLastMessageAt: LastMessageAt = async (channel) =>
  newestAt(await api().chat.history({ channel, limit: 1 }));

export function ChatOffline({
  channel,
  name,
  lastMessageAt = historyLastMessageAt,
}: {
  channel: string;
  /** The channel's display name (or slug). */
  name: string;
  lastMessageAt?: LastMessageAt;
}): React.JSX.Element {
  const [at, setAt] = React.useState<{ channel: string; at: string } | null>(null);
  const load = React.useRef(lastMessageAt);
  React.useEffect(() => {
    let live = true;
    // Async, so a client that cannot make the call at all fails like a refusal.
    Promise.resolve()
      .then(() => load.current(channel))
      .then(
        (iso) => {
          if (live && iso) setAt({ channel, at: iso });
        },
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [channel]);
  const shown = at?.channel === channel ? at.at : null;
  return (
    <EmptyState
      data-testid="chat-offline"
      className="flex-1"
      icon={Message01Icon}
      title={t("chat.column.offlineTitle", { name })}
      description={
        shown ? (
          <span data-testid="chat-offline-last" data-at={shown}>
            {t("chat.offline.lastMessage")} <RelativeTime date={shown} />
          </span>
        ) : undefined
      }
      headingLevel={3}
    />
  );
}
