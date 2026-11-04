// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { errorCode, serverApi } from "../../lib/api.ts";
import { summarize, type ChannelSummary } from "../../lib/channel-summary.ts";
import { loadWebEnv } from "../../server/env.ts";
import {
  CHANNEL_MEDIA_PAGE,
  channelAbout,
  type ChannelAbout,
  type ClipItem,
  type MediaPage,
  type VodItem,
} from "./channel-data.ts";
import { channelExtras, type ChannelExtras } from "./panels-data.ts";

const SLUG = /^[a-z0-9_]{3,25}$/;

export interface ChannelPage {
  summary: ChannelSummary;
  extras: ChannelExtras;
  about: ChannelAbout;
  /** Null when the list failed to load; the page asks again in the browser. */
  vods: MediaPage<VodItem> | null;
  clips: MediaPage<ClipItem> | null;
}

/**
 * The channel page's first render: the summary (as `getChannel`) plus the banner, panels,
 * suspension, bio and live metadata from one `channels.get`, and the first page of VODs and clips
 * beside it. `null` when the channel does not exist. The visitor's cookie is forwarded so
 * `viewer.following` and what the visitor may watch reflect them. The body stays inside the handler
 * so the compiler drops `server/env.ts` from the client bundle.
 */
export const getChannelPage = createServerFn({ method: "GET" })
  .validator((input: { channel: string }) => ({ channel: String(input.channel).toLowerCase() }))
  .handler(async ({ data }): Promise<ChannelPage | null> => {
    if (!SLUG.test(data.channel)) return null;
    const cookie = getRequestHeader("cookie");
    const client = serverApi(loadWebEnv().API_INTERNAL_URL, cookie ? { cookie } : {});
    const ref = { channel: data.channel };
    // A failed list never fails the page: the grid asks again in the browser.
    const [dto, vods, clips] = await Promise.all([
      client.channels.get(ref).catch((err: unknown) => {
        if (errorCode(err) === "NOT_FOUND") return null;
        throw err;
      }),
      client.vods.list({ ...ref, limit: CHANNEL_MEDIA_PAGE }).catch(() => null),
      client.clips.list({ ...ref, limit: CHANNEL_MEDIA_PAGE, sort: "recent" }).catch(() => null),
    ]);
    if (!dto) return null;
    return { summary: summarize(dto), extras: channelExtras(dto), about: channelAbout(dto), vods, clips };
  });
