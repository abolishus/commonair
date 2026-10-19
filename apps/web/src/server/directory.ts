// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { serverApi } from "../lib/api.ts";
import type { DirectoryHome } from "../lib/directory-sections.ts";
import { loadWebEnv } from "./env.ts";

/**
 * `directory.home` as the visitor sees it (the cookie makes the `following` section theirs), or
 * null when the API is unreachable, so the page can say so instead of claiming nothing is live.
 */
export async function loadDirectory(cookie: string | undefined): Promise<DirectoryHome | null> {
  try {
    const home = await serverApi(loadWebEnv().API_INTERNAL_URL, cookie ? { cookie } : {}).directory.home({});
    return { spotlight: home.spotlight, newAndLive: home.newAndLive, live: home.live, following: home.following };
  } catch {
    return null;
  }
}
