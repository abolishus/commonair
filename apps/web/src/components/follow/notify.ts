// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A follow's go-live alert switch (`follows.notify`, set through `channels.follow {notify}`), for
 * the bell and the Following menu. `Channel.viewer` does not carry it yet (a contract request), so
 * when the page cannot say, it is read from the caller's follows list, a bounded number of pages.
 */
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { api } from "../../lib/api.ts";
import { toast } from "@commonair/ui/toast";

export interface FollowsPage {
  items: readonly { channel: { slug: string }; notify: boolean }[];
  nextCursor: string | null;
}
export type FollowsPageLoader = (cursor: string | undefined) => Promise<FollowsPage>;

/** Pages of 100 read at most: past that the bell assumes the default (on). */
export const NOTIFY_LOOKUP_PAGES = 3;

/** `notify` for `slug` from the follows list, or null when it is not in the first pages. */
export async function findFollowNotify(
  slug: string,
  load: FollowsPageLoader,
  maxPages: number = NOTIFY_LOOKUP_PAGES,
): Promise<boolean | null> {
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await load(cursor);
    const hit = page.items.find((f) => f.channel.slug === slug);
    if (hit) return hit.notify;
    if (page.nextCursor === null) return null;
    cursor = page.nextCursor;
  }
  return null;
}

export type SetNotify = (channel: string, notify: boolean) => Promise<unknown>;

const apiFollowsPage: FollowsPageLoader = (cursor) =>
  api().me.follows(cursor === undefined ? { limit: 100 } : { cursor, limit: 100 });
const apiSetNotify: SetNotify = (channel, notify) => api().channels.follow({ channel, notify });

export interface FollowNotify {
  /** null while unknown (loading). */
  notify: boolean | null;
  pending: boolean;
  set: (next: boolean) => void;
}

export interface UseFollowNotifyOptions {
  channel: string;
  channelName: string;
  /** Following now: only then is there a switch to read or set. */
  following: boolean;
  /** What the page knows (`Channel.viewer.notify` once it exists); null or absent: look it up. */
  initial?: boolean | null | undefined;
  loadPage?: FollowsPageLoader;
  setNotify?: SetNotify;
}

/**
 * The bell's state. A follow made here starts with alerts on (`channels.follow` defaults
 * `notify` to true), so a fresh follow needs no lookup. Optimistic, rolled back on failure.
 */
export function useFollowNotify({
  channel,
  channelName,
  following,
  initial,
  loadPage = apiFollowsPage,
  setNotify = apiSetNotify,
}: UseFollowNotifyOptions): FollowNotify {
  const [notify, setLocal] = React.useState<boolean | null>(typeof initial === "boolean" ? initial : null);
  const [pending, setPending] = React.useState(false);
  // Synced while rendering (React's "adjust state on a prop change"): a new value from the page
  // wins, and a follow made on this page stored notify = true, so neither needs a lookup.
  const [seen, setSeen] = React.useState({ initial, following });
  if (seen.initial !== initial || seen.following !== following) {
    setSeen({ initial, following });
    if (typeof initial === "boolean" && seen.initial !== initial) setLocal(initial);
    else if (following && !seen.following) setLocal(true);
  }
  const unknown = notify === null;
  React.useEffect(() => {
    if (!following || !unknown) return;
    let live = true;
    const settle = (value: boolean) => {
      if (live) setLocal((current) => current ?? value);
    };
    findFollowNotify(channel, loadPage).then(
      (found) => settle(found ?? true),
      // Unknown: the default every follow starts with.
      () => settle(true),
    );
    return () => {
      live = false;
    };
  }, [channel, following, loadPage, unknown]);
  const set = (next: boolean) => {
    if (pending) return;
    const previous = notify;
    setLocal(next);
    setPending(true);
    setNotify(channel, next)
      .then(() =>
        toast.success(
          next
            ? t("d4Follow.alerts.onToast", { channel: channelName })
            : t("d4Follow.alerts.offToast", { channel: channelName }),
        ),
      )
      .catch((err: unknown) => {
        setLocal(previous);
        toastActionError(err, t("d4Follow.alerts.failed"));
      })
      .finally(() => setPending(false));
  };
  return { notify, pending, set };
}
