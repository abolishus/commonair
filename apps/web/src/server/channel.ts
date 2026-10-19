// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { errorCode, serverApi } from "../lib/api.ts";
import { summarize, type ChannelSummary } from "../lib/channel-summary.ts";
import { loadWebEnv } from "./env.ts";

const SLUG = /^[a-z0-9_]{3,25}$/;

/**
 * `null` when the channel does not exist (or the slug cannot be one). The visitor's cookie is
 * forwarded so `viewer.following` reflects them.
 */
export async function loadChannel(slug: string, cookie?: string): Promise<ChannelSummary | null> {
  if (!SLUG.test(slug)) return null;
  try {
    return summarize(
      await serverApi(loadWebEnv().API_INTERNAL_URL, cookie ? { cookie } : {}).channels.get({ channel: slug }),
    );
  } catch (err) {
    if (errorCode(err) === "NOT_FOUND") return null;
    throw err;
  }
}
