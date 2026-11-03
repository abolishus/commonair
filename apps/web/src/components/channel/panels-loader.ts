// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { errorCode, serverApi } from "../../lib/api.ts";
import { summarize, type ChannelSummary } from "../../lib/channel-summary.ts";
import { loadWebEnv } from "../../server/env.ts";
import { channelExtras, type ChannelExtras } from "./panels-data.ts";

const SLUG = /^[a-z0-9_]{3,25}$/;

export interface ChannelPage {
  summary: ChannelSummary;
  extras: ChannelExtras;
}

/**
 * The channel page's first render: the summary (as `getChannel`) plus the banner, panels and
 * suspension, from one `channels.get`. `null` when the channel does not exist. The visitor's cookie
 * is forwarded so `viewer.following` reflects them. The body stays inside the handler so the
 * compiler drops `server/env.ts` from the client bundle.
 */
export const getChannelPage = createServerFn({ method: "GET" })
  .validator((input: { channel: string }) => ({ channel: String(input.channel).toLowerCase() }))
  .handler(async ({ data }): Promise<ChannelPage | null> => {
    if (!SLUG.test(data.channel)) return null;
    const cookie = getRequestHeader("cookie");
    try {
      const dto = await serverApi(loadWebEnv().API_INTERNAL_URL, cookie ? { cookie } : {}).channels.get({
        channel: data.channel,
      });
      return { summary: summarize(dto), extras: channelExtras(dto) };
    } catch (err) {
      if (errorCode(err) === "NOT_FOUND") return null;
      throw err;
    }
  });
