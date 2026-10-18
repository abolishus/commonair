// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Server side of the root loader: public config, instance info and the visitor's session. */
import { serverApi } from "../lib/api.ts";
import type { Bootstrap, SessionUser } from "../lib/bootstrap-types.ts";
import { themeFromCookie } from "../lib/theme.ts";
import { loadWebEnv, publicConfig } from "./env.ts";

let envCache: ReturnType<typeof loadWebEnv> | null = null;
let instanceCache: { value: Bootstrap["instance"]; at: number } | null = null;
const INSTANCE_TTL_MS = 60_000;

export async function loadBootstrap(cookie: string | undefined): Promise<Bootstrap> {
  envCache ??= loadWebEnv();
  const env = envCache;
  const config = publicConfig(env);
  const anon = serverApi(env.API_INTERNAL_URL);

  const instance = async (): Promise<Bootstrap["instance"]> => {
    if (instanceCache && Date.now() - instanceCache.at < INSTANCE_TTL_MS) return instanceCache.value;
    try {
      const info = await anon.instance.info();
      instanceCache = { value: { name: info.name, sourceUrl: info.sourceUrl }, at: Date.now() };
      return instanceCache.value;
    } catch {
      // The footer still renders the instance name; the source link waits for the API.
      return { name: config.instanceName, sourceUrl: null };
    }
  };

  const me = async (): Promise<SessionUser | null> => {
    if (!cookie) return null;
    try {
      const m = await serverApi(env.API_INTERNAL_URL, { cookie }).me.get();
      return { id: m.id, username: m.username, displayName: m.displayName, channelSlug: m.channelSlug };
    } catch {
      return null;
    }
  };

  const [instanceInfo, user] = await Promise.all([instance(), me()]);
  return { config, instance: instanceInfo, me: user, theme: themeFromCookie(cookie), now: Date.now() };
}
