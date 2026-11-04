// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The watch routes' document titles (F11, F15): "<title> · <channel> · <site>". The loader asks for
 * the item's title and the channel's display name only; the item itself (its URLs, per viewer)
 * still loads in the browser (`watch-page.tsx`). The visitor's cookie is forwarded, so an owner's
 * private VOD has its title for them and reads "not available" for everyone else.
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { t } from "../../i18n/index.ts";
import { errorCode, serverApi } from "../../lib/api.ts";
import { TITLE_SEPARATOR } from "../../lib/page-title.ts";
import { loadWebEnv } from "../../server/env.ts";
import type { WatchKind } from "../watch/share.ts";
import { clipState, vodState } from "./state.ts";

export type WatchHead =
  | { kind: "ok"; title: string; channelName: string }
  /** Missing, private, removed, or on another channel: the page says "not available". */
  | { kind: "missing" }
  /** The API failed; the page asks again in the browser. */
  | { kind: "error" };

const SLUG = /^[a-z0-9_]{3,25}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const getWatchHead = createServerFn({ method: "GET" })
  .validator((input: { kind: WatchKind; id: string; channel: string }) => ({
    kind: input.kind === "clip" ? ("clip" as const) : ("vod" as const),
    id: String(input.id).toLowerCase(),
    channel: String(input.channel).toLowerCase(),
  }))
  .handler(async ({ data }): Promise<WatchHead> => {
    if (!SLUG.test(data.channel) || !ID.test(data.id)) return { kind: "missing" };
    const cookie = getRequestHeader("cookie");
    const client = serverApi(loadWebEnv().API_INTERNAL_URL, cookie ? { cookie } : {});
    try {
      // Only the title leaves this function, never the DTO (its URLs are per viewer).
      const item =
        data.kind === "vod"
          ? client.vods.get({ id: data.id }).then((v) => ({ title: v.title, gone: vodState(v, data.channel) }))
          : client.clips.get({ id: data.id }).then((c) => ({ title: c.title, gone: clipState(c, data.channel) }));
      const [found, channel] = await Promise.all([item, client.channels.get({ channel: data.channel })]);
      if (found.gone === "not-found") return { kind: "missing" };
      return { kind: "ok", title: found.title, channelName: channel.displayName };
    } catch (err) {
      return { kind: errorCode(err) === "NOT_FOUND" ? "missing" : "error" };
    }
  });

/** The page part of the title; the routes pass it to `titleHead` (" · <site>" is added there). */
export function watchPageTitle(head: WatchHead | undefined, kind: WatchKind, channel: string): string {
  if (head?.kind === "missing") return t("watch.pageTitle.notAvailable");
  if (head?.kind !== "ok") {
    const label = kind === "vod" ? t("watch.pageTitle.video") : t("watch.pageTitle.clip");
    return `${label}${TITLE_SEPARATOR}${channel}`;
  }
  const untitled = kind === "vod" ? t("channel.tabs.untitledVideo") : t("channel.tabs.untitledClip");
  return `${head.title.trim() || untitled}${TITLE_SEPARATOR}${head.channelName}`;
}
