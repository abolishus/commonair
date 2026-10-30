// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Server side of the root loader: public config, instance info, the visitor's session and locale. */
import type { Me } from "@commonair/contracts/dto";
import { localeDirection } from "@commonair/i18n";
import { type LocaleDeps, requestLocale } from "../i18n/server.ts";
import { serverApi } from "../lib/api.ts";
import type { Bootstrap, SessionUser } from "../lib/bootstrap-types.ts";
import { parseConsent } from "../lib/consent.ts";
import { themeFromCookie } from "../lib/theme.ts";
import { safeHttpUrl } from "../lib/url.ts";
import { loadWebEnv, publicConfig } from "./env.ts";

let envCache: ReturnType<typeof loadWebEnv> | null = null;
export const webEnv = () => (envCache ??= loadWebEnv());
let instanceCache: { value: Bootstrap["instance"]; at: number } | null = null;
const INSTANCE_TTL_MS = 60_000;

/** `me.get` with the visitor's cookie (rejects when signed out). */
export function fetchMe(cookie: string): Promise<Me> {
  return serverApi(webEnv().API_INTERNAL_URL, { cookie }).me.get();
}

/** What the request middleware negotiates with. */
export function localeDeps(): LocaleDeps {
  return { fetchMe, instanceDefault: webEnv().INSTANCE_DEFAULT_LOCALE };
}

export async function loadBootstrap(cookie: string | undefined): Promise<Bootstrap> {
  const env = webEnv();
  const config = publicConfig(env);

  const instance = async (): Promise<Bootstrap["instance"]> => {
    if (instanceCache && Date.now() - instanceCache.at < INSTANCE_TTL_MS) return instanceCache.value;
    try {
      const info = await serverApi(env.API_INTERNAL_URL).instance.info();
      instanceCache = {
        value: {
          name: info.name,
          sourceUrl: safeHttpUrl(info.sourceUrl),
          p2pDefault: info.features.p2pDefault,
          chatSafety: info.features.watchGate || info.features.surgeGuard,
        },
        at: Date.now(),
      };
      return instanceCache.value;
    } catch {
      // The footer still renders the instance name; the source link waits for the API, and P2P stays opt-in.
      return { name: config.instanceName, sourceUrl: null, p2pDefault: "off", chatSafety: false };
    }
  };

  const store = requestLocale();
  const [instanceInfo, user, { locale, fromUser }] = await Promise.all([
    instance(),
    loadSessionUser(cookie),
    store && store.cookie === cookie ? store.sessionLocale() : Promise.resolve({ locale: "en", fromUser: false }),
  ]);
  return {
    config,
    instance: instanceInfo,
    me: user,
    theme: themeFromCookie(cookie),
    now: Date.now(),
    locale,
    dir: localeDirection(locale),
    localeFromUser: fromUser,
    consent: parseConsent(cookie),
  };
}

/** The signed-in user for this cookie, or null (no cookie, expired session, API unreachable). */
export async function loadSessionUser(cookie: string | undefined): Promise<SessionUser | null> {
  if (!cookie) return null;
  // Inside a request the middleware's memoized lookup answers, so a document costs one `me.get`.
  const store = requestLocale();
  const m = store && store.cookie === cookie ? await store.me() : await fetchMe(cookie).catch(() => null);
  if (!m) return null;
  return { id: m.id, username: m.username, displayName: m.displayName, channelSlug: m.channelSlug, role: m.role };
}
