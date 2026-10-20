// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Server side of the root loader: public config, instance info and the visitor's session. */
import { serverApi } from "../lib/api.ts";
import type { Bootstrap, SessionUser } from "../lib/bootstrap-types.ts";
import { themeFromCookie } from "../lib/theme.ts";
import { safeHttpUrl } from "../lib/url.ts";
import { loadWebEnv, publicConfig } from "./env.ts";

let envCache: ReturnType<typeof loadWebEnv> | null = null;
const webEnv = () => (envCache ??= loadWebEnv());
let instanceCache: { value: Bootstrap["instance"]; at: number } | null = null;
const INSTANCE_TTL_MS = 60_000;

export async function loadBootstrap(cookie: string | undefined): Promise<Bootstrap> {
  const env = webEnv();
  const config = publicConfig(env);

  const instance = async (): Promise<Bootstrap["instance"]> => {
    if (instanceCache && Date.now() - instanceCache.at < INSTANCE_TTL_MS) return instanceCache.value;
    try {
      const info = await serverApi(env.API_INTERNAL_URL).instance.info();
      instanceCache = { value: { name: info.name, sourceUrl: safeHttpUrl(info.sourceUrl) }, at: Date.now() };
      return instanceCache.value;
    } catch {
      // The footer still renders the instance name; the source link waits for the API.
      return { name: config.instanceName, sourceUrl: null };
    }
  };

  const [instanceInfo, user] = await Promise.all([instance(), loadSessionUser(cookie)]);
  return { config, instance: instanceInfo, me: user, theme: themeFromCookie(cookie), now: Date.now() };
}

/** The signed-in user for this cookie, or null (no cookie, expired session, API unreachable). */
export async function loadSessionUser(cookie: string | undefined): Promise<SessionUser | null> {
  if (!cookie) return null;
  try {
    const m = await serverApi(webEnv().API_INTERNAL_URL, { cookie }).me.get();
    return { id: m.id, username: m.username, displayName: m.displayName, channelSlug: m.channelSlug, role: m.role };
  } catch {
    return null;
  }
}
