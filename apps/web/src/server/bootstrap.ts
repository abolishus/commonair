// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Server side of the root loader: public config, instance info, the visitor's session and locale. */
import type { Me } from "@commonair/contracts/dto";
import { localeDirection } from "@commonair/i18n";
import { type LocaleDeps, requestLocale } from "../i18n/server.ts";
import { errorCode, serverApi } from "../lib/api.ts";
import type { Bootstrap, SessionLookup, SessionUser } from "../lib/bootstrap-types.ts";
import { parseConsent } from "../lib/consent.ts";
import { errorStatus, retryAfterSeconds } from "../lib/load-failure.ts";
import { sessionUserOf } from "../lib/session.ts";
import { themeFromCookie } from "../lib/theme.ts";
import { safeHttpUrl } from "../lib/url.ts";
import { loadWebEnv, publicConfig } from "./env.ts";

let envCache: ReturnType<typeof loadWebEnv> | null = null;
export const webEnv = () => (envCache ??= loadWebEnv());
let instanceCache: { value: Bootstrap["instance"]; at: number } | null = null;
const INSTANCE_TTL_MS = 60_000;

/**
 * Whether the cookie header carries better-auth's session cookie (`commonair.session_token`, or
 * with the `__Secure-` prefix over HTTPS). Without one nobody is signed in, whatever the API says,
 * so a visitor with only a theme or consent cookie never waits for (or is rate limited on) `me.get`.
 */
export function hasSessionCookie(cookie: string | undefined): boolean {
  if (!cookie) return false;
  return cookie.split(";").some((part) => {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(eq + 1).trim() === "") return false;
    return /(?:^|\.)session_token$/.test(part.slice(0, eq).trim());
  });
}

const SIGNED_OUT: SessionLookup = { status: "signedOut" };

/** Codes that are a definitive "no" even without a status. */
const SIGNED_OUT_CODES = new Set(["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "BAD_REQUEST"]);

/**
 * What a failed `me.get` says about the session (F1). A 4xx other than 408 and 429 is the API's
 * answer: signed out. A 429, any 5xx, a network failure or anything unknown means nobody could say.
 */
export function sessionFailure(err: unknown): SessionLookup {
  const status = errorStatus(err);
  const definitive =
    status !== null
      ? status >= 400 && status < 500 && status !== 408 && status !== 429
      : SIGNED_OUT_CODES.has(errorCode(err) ?? "");
  return definitive ? SIGNED_OUT : { status: "unavailable", retryAfterSeconds: retryAfterSeconds(err) };
}

function signedIn(m: Me): SessionLookup {
  return {
    status: "signedIn",
    user: {
      id: m.id,
      username: m.username,
      displayName: m.displayName,
      channelSlug: m.channelSlug,
      role: m.role,
      pendingLegal: m.pendingLegal,
      settingsSummary: m.settingsSummary,
    },
  };
}

/** What `fetchMe` rejects with, without asking, when the cookie header has no session cookie. */
class NoSessionCookie extends Error {
  readonly code = "UNAUTHORIZED";
  readonly status = 401;
}

function callMe(cookie: string): Promise<Me> {
  return serverApi(webEnv().API_INTERNAL_URL, { cookie }).me.get();
}

/**
 * The request middleware's memoized lookup swallows `me.get` failures (it only needs a locale), so
 * `fetchMe` notes why one failed, keyed by the cookie header, for `lookupSession` to read in the
 * same request. A note is taken once, expires quickly and the map is capped: a lost note only costs
 * one more `me.get`.
 */
const failures = new Map<string, { lookup: SessionLookup; at: number }>();
const FAILURE_TTL_MS = 10_000;
const FAILURE_CAP = 256;

function noteFailure(cookie: string, lookup: SessionLookup): void {
  failures.delete(cookie);
  failures.set(cookie, { lookup, at: Date.now() });
  while (failures.size > FAILURE_CAP) {
    const oldest = failures.keys().next();
    if (oldest.done) break;
    failures.delete(oldest.value);
  }
}

function takeFailure(cookie: string): SessionLookup | null {
  const entry = failures.get(cookie);
  failures.delete(cookie);
  return entry && Date.now() - entry.at < FAILURE_TTL_MS ? entry.lookup : null;
}

/** `me.get` with the visitor's cookie (rejects when signed out or when the API could not answer). */
export async function fetchMe(cookie: string): Promise<Me> {
  if (!hasSessionCookie(cookie)) throw new NoSessionCookie("no session cookie");
  try {
    const m = await callMe(cookie);
    failures.delete(cookie);
    return m;
  } catch (err) {
    noteFailure(cookie, sessionFailure(err));
    throw err;
  }
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
          twitchImport: info.features.twitchImport,
          federation: info.features.federation,
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
  const [instanceInfo, session, { locale, fromUser }] = await Promise.all([
    instance(),
    lookupSession(cookie),
    store && store.cookie === cookie ? store.sessionLocale() : Promise.resolve({ locale: "en", fromUser: false }),
  ]);
  return {
    config,
    instance: instanceInfo,
    me: session.status === "signedIn" ? session.user : null,
    // Only when unknown, so a settled bootstrap has exactly the fields it always had.
    ...(session.status === "unavailable" ? { sessionUnavailable: true as const } : {}),
    theme: themeFromCookie(cookie),
    now: Date.now(),
    locale,
    dir: localeDirection(locale),
    localeFromUser: fromUser,
    consent: parseConsent(cookie),
  };
}

/** One classified lookup per request store: the root loader and every guard share it. */
const storeLookups = new WeakMap<object, Promise<SessionLookup>>();

async function lookupDirect(cookie: string): Promise<SessionLookup> {
  try {
    return signedIn(await callMe(cookie));
  } catch (err) {
    return sessionFailure(err);
  }
}

/**
 * Whose session this cookie is (F1): signed in, signed out (no session cookie, or the API said
 * so), or unavailable (the API was busy, failing or unreachable). Inside a request the
 * middleware's memoized `me.get` answers, so a document still costs one call.
 */
export function lookupSession(cookie: string | undefined): Promise<SessionLookup> {
  if (!cookie || !hasSessionCookie(cookie)) return Promise.resolve(SIGNED_OUT);
  const store = requestLocale();
  if (!store || store.cookie !== cookie) return lookupDirect(cookie);
  let lookup = storeLookups.get(store);
  if (!lookup) {
    lookup = store.me().then((m) => (m ? signedIn(m) : (takeFailure(cookie) ?? lookupDirect(cookie))));
    storeLookups.set(store, lookup);
  }
  return lookup;
}

/**
 * The signed-in user for this cookie, or null when signed out. Throws `SessionUnavailableError`
 * when the API could not say: a guard then renders its error page with Retry, never /signin.
 */
export async function loadSessionUser(cookie: string | undefined): Promise<SessionUser | null> {
  return sessionUserOf(await lookupSession(cookie));
}
