// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Cookie consent (the cookie policy, `packages/db/src/legal/cookies.md`). The browser keeps the
 * visitor's choice in an essential cookie, because `legal.consent` is write-only: no procedure
 * reads a stored choice back. Preferences cookies (theme, language, sidebar) are written only
 * while `preferencesAllowed()`; otherwise those choices live in this tab's `sessionStorage`.
 *
 * Every cookie and storage access is wrapped: a browser that blocks storage still renders, and
 * the banner simply asks again next time.
 */
import * as React from "react";
import { LOCALE_COOKIE, forgetLocaleCookie, rememberLocale, tabLocale } from "../i18n/client.ts";
import { api, errorCode, type Api } from "./api.ts";
import { isOverlayPath } from "./overlay-page.ts";
import { expireThemeCookie, setTabTheme, takeTabTheme, themeCookieValue, writeThemeCookie } from "./theme.ts";

/** Essential: the consent record (policy version, preferences, how the server recorded it). */
export const CONSENT_COOKIE = "commonair-consent";
/** Essential: the random id of a signed-out visitor's consent records. */
export const CONSENT_ID_COOKIE = "commonair-consent-id";
/** Mirrors `CONSENT_CATEGORIES` in `@commonair/db` (web code must not import it; a test compares). */
export const CONSENT_CATEGORIES = ["essential", "preferences"] as const;
export type ConsentCategory = (typeof CONSENT_CATEGORIES)[number];
/** shadcn's sidebar used to write this; nothing reads it, so a withdrawal expires any left over. */
export const SIDEBAR_COOKIE = "sidebar_state";
/** `sessionStorage`: the one silent retry of a `pending` record was spent in this tab. */
export const CONSENT_RETRY_KEY = "commonair-consent-retry";
/** 365 days: the server deletes signed-out records after 395 (`ANONYMOUS_CONSENT_RETENTION_DAYS`). */
export const CONSENT_MAX_AGE_SECONDS = 31_536_000;
const FORMAT = "1";

export type ConsentRecorded = "user" | "anonymous" | "pending";
/**
 * Why the last save was not recorded: `unrecorded` (the policy version was unknown, so the banner
 * asks again once it is), `rejected` (refused for another reason; retrying will not help).
 */
export type ConsentErrorCode = "rate_limited" | "network" | "policy_changed" | "unrecorded" | "rejected";
export type ConsentPrompt = "none" | "policy-changed";

export interface StoredConsent {
  /** The cookie policy version the choice was made for ("" when it was unknown at the time). */
  version: string;
  preferences: boolean;
  recorded: ConsentRecorded;
}

type CookiePolicy = Awaited<ReturnType<Api["legal"]["get"]>>;

// --- the cookie format --------------------------------------------------------------------

const RECORDED: readonly ConsentRecorded[] = ["user", "anonymous", "pending"];

/** `1.<0|1>.<recorded>.<encoded version>`: the version last, since it may contain dots. */
export function serializeConsent(consent: StoredConsent): string {
  return [FORMAT, consent.preferences ? "1" : "0", consent.recorded, encodeURIComponent(consent.version)].join(".");
}

function cookieValue(cookieHeader: string | null | undefined, name: string): string | undefined {
  for (const part of (cookieHeader ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** The stored consent in a `Cookie` header or `document.cookie`; anything malformed is null. */
export function parseConsent(cookieHeader: string | null | undefined): StoredConsent | null {
  const raw = cookieValue(cookieHeader, CONSENT_COOKIE);
  if (!raw) return null;
  const [format, prefs, recorded, ...rest] = raw.split(".");
  if (format !== FORMAT || (prefs !== "0" && prefs !== "1")) return null;
  const mark = RECORDED.find((r) => r === recorded);
  if (!mark || rest.length === 0) return null;
  let version: string;
  try {
    version = decodeURIComponent(rest.join("."));
  } catch {
    return null;
  }
  if (version.length > 64) return null;
  return { version, preferences: prefs === "1", recorded: mark };
}

function secureAttr(): string {
  try {
    return window.location.protocol === "https:" ? "; secure" : "";
  } catch {
    return "";
  }
}

/** A first-party cookie the client writes (not HttpOnly) with the consent attributes. */
export function consentCookieString(name: string, value: string): string {
  return `${name}=${value}; path=/; max-age=${CONSENT_MAX_AGE_SECONDS}; samesite=lax${secureAttr()}`;
}

function setCookie(cookie: string): void {
  try {
    document.cookie = cookie;
  } catch {
    // Cookies blocked: the choice applies to this page only.
  }
}

function readCookies(): string {
  try {
    return document.cookie;
  } catch {
    return "";
  }
}

/** Expire a cookie on `/` (used for Preferences cookies when consent is declined or withdrawn). */
export function expireCookie(name: string): void {
  setCookie(`${name}=; path=/; max-age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT; samesite=lax`);
}

function writeConsentCookie(consent: StoredConsent): void {
  setCookie(consentCookieString(CONSENT_COOKIE, serializeConsent(consent)));
}

/** 32 lowercase hex characters (the contract takes 16-64). */
export function newAnonymousId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The signed-out visitor's consent id, created on first use. */
export function anonymousId(): string {
  const existing = cookieValue(readCookies(), CONSENT_ID_COOKIE);
  if (existing && /^[0-9a-f]{32}$/.test(existing)) return existing;
  const id = newAnonymousId();
  setCookie(consentCookieString(CONSENT_ID_COOKIE, id));
  return id;
}

// --- the store ----------------------------------------------------------------------------

export interface ConsentState {
  /** The client has read its cookie (before that, render from `Bootstrap.consent`). */
  ready: boolean;
  stored: StoredConsent | null;
  /** The current cookie policy, once this tab has fetched it. */
  policy: CookiePolicy | null;
  signedIn: boolean;
  dialogOpen: boolean;
  error: ConsentErrorCode | null;
}

const INITIAL: ConsentState = {
  ready: false,
  stored: null,
  policy: null,
  signedIn: false,
  dialogOpen: false,
  error: null,
};

let state: ConsentState = INITIAL;
const listeners = new Set<() => void>();

function update(patch: Partial<ConsentState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function subscribeConsent(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function consentSnapshot(): ConsentState {
  return state;
}

function serverSnapshot(): ConsentState {
  return INITIAL;
}

export function useConsent(): ConsentState {
  return React.useSyncExternalStore(subscribeConsent, consentSnapshot, serverSnapshot);
}

/** False once a consent cookie this tab wrote did not stick (cookies blocked). */
let cookieBacked = true;

/**
 * The stored consent this tab acts on. In the browser it is always the cookie, so a choice made
 * in another tab (a withdrawal above all) applies here at once; only when cookies are blocked
 * does this tab's in-memory choice stand in.
 */
function storedConsent(): StoredConsent | null {
  if (typeof document === "undefined") return state.stored;
  if (state.ready && !cookieBacked) return state.stored;
  return parseConsent(readCookies());
}

/** Bring the store (and so the banner) in line with a cookie another tab may have changed. */
export function syncConsentFromCookie(): void {
  if (!state.ready || !cookieBacked) return;
  const stored = parseConsent(readCookies());
  const same =
    stored === null || state.stored === null
      ? stored === state.stored
      : serializeConsent(stored) === serializeConsent(state.stored);
  if (!same) update({ stored });
}

function onVisibilityChange(): void {
  if (document.visibilityState === "visible") syncConsentFromCookie();
}

/** OBS overlays and third-party embeds: no banner, and no preference is written there. */
export function isConsentFreePath(pathname: string): boolean {
  return isOverlayPath(pathname) || pathname === "/embed" || pathname.startsWith("/embed/");
}

/** Whether to ask, and why: no choice yet, or one made for another policy version. */
export function consentPrompt(stored: StoredConsent | null, policyVersion: string | null): ConsentPrompt | null {
  if (!stored) return "none";
  if (policyVersion === null) return null;
  // Saved while the policy was unreachable: never recorded, so it is a first ask, not a change.
  if (stored.version === "") return "none";
  if (stored.version !== policyVersion) return "policy-changed";
  return null;
}

/**
 * True only when a choice is stored, is for the current policy version as far as this tab
 * knows, and allows preferences.
 */
export function preferencesAllowed(): boolean {
  const stored = storedConsent();
  if (!stored?.preferences) return false;
  return consentPrompt(stored, state.policy?.version ?? null) === null;
}

export function openCookieSettings(): void {
  update({ dialogOpen: true });
  // The dialog links the policy text and records its version (cached after the first fetch).
  void loadCookiePolicy();
}

export function closeCookieSettings(): void {
  update({ dialogOpen: false });
}

export function dismissConsentError(): void {
  update({ error: null });
}

// --- the cookie policy, fetched once per tab ----------------------------------------------

let policyRequest: Promise<CookiePolicy | null> | null = null;

/** The current cookie policy (cached; `refresh` asks again, e.g. after a stale-version refusal). */
export function loadCookiePolicy(refresh = false): Promise<CookiePolicy | null> {
  if (!policyRequest || refresh) {
    policyRequest = api()
      .legal.get({ kind: "cookies" })
      .then(
        (doc) => {
          update({ policy: doc });
          return doc;
        },
        () => {
          // Unreachable API: ask again next time; until then the stored choice stands.
          policyRequest = null;
          return null;
        },
      );
  }
  return policyRequest;
}

// --- side effects of a choice -------------------------------------------------------------

/** Preferences allowed: this tab's theme and language move into their cookies. */
export function grantPreferences(): void {
  const theme = takeTabTheme();
  if (theme) writeThemeCookie(theme);
  const locale = tabLocale();
  if (locale) rememberLocale(locale, { preferencesAllowed: true });
}

/**
 * Preferences declined or withdrawn: keep what this tab shows (theme, language) for the tab
 * only, then expire every Preferences cookie. The next visit uses defaults.
 */
export function withdrawPreferences(): void {
  const cookies = readCookies();
  const theme = themeCookieValue(cookies);
  if (theme) setTabTheme(theme);
  const locale = cookieValue(cookies, LOCALE_COOKIE);
  if (locale && !tabLocale()) {
    let tag = locale;
    try {
      tag = decodeURIComponent(locale);
    } catch {
      // Keep the raw value; `tabLocale()` ignores an unsupported one.
    }
    rememberLocale(tag, { preferencesAllowed: false });
  }
  expireThemeCookie();
  forgetLocaleCookie();
  expireCookie(SIDEBAR_COOKIE);
}

// --- recording on the server --------------------------------------------------------------

function retrySpent(): boolean {
  try {
    return sessionStorage.getItem(CONSENT_RETRY_KEY) === "1";
  } catch {
    return true;
  }
}

function spendRetry(): void {
  try {
    sessionStorage.setItem(CONSENT_RETRY_KEY, "1");
  } catch {
    // Storage blocked: `retrySpent` reports it spent, so there is no retry loop either way.
  }
}

function setStored(consent: StoredConsent): void {
  writeConsentCookie(consent);
  cookieBacked = cookieValue(readCookies(), CONSENT_COOKIE) === serializeConsent(consent);
  update({ stored: consent });
}

/** Send `consent` to `legal.consent`; marks it recorded, pending, or re-asks on a policy change. */
async function record(consent: StoredConsent, opts: { silent?: boolean } = {}): Promise<void> {
  const signedIn = state.signedIn;
  try {
    await api().legal.consent({
      choices: { essential: true, preferences: consent.preferences },
      policyVersion: consent.version,
      ...(signedIn ? {} : { anonymousId: anonymousId() }),
    });
    setStored({ ...consent, recorded: signedIn ? "user" : "anonymous" });
    update({ error: null });
  } catch (err) {
    const code = errorCode(err);
    if (code === "BAD_REQUEST") {
      const policy = await loadCookiePolicy(true);
      if (policy && policy.version !== consent.version) {
        // The banner asks again (`policy-changed`): the stored version is no longer current.
        setStored({ ...consent, recorded: "pending" });
        update({ error: "policy_changed" });
        return;
      }
    }
    setStored({ ...consent, recorded: "pending" });
    // A background retry fails quietly: the visitor already saw the notice when they chose.
    if (opts.silent) return;
    update({ error: code === "RATE_LIMITED" ? "rate_limited" : code === "BAD_REQUEST" ? "rejected" : "network" });
  }
}

async function save(choice: { preferences: boolean }): Promise<ConsentErrorCode | null> {
  const version = state.policy?.version ?? (await loadCookiePolicy())?.version ?? "";
  const consent: StoredConsent = { version, preferences: choice.preferences, recorded: "pending" };
  setStored(consent);
  update({ ready: true, dialogOpen: false, error: null });
  if (choice.preferences) grantPreferences();
  else withdrawPreferences();
  if (version === "") {
    // `legal.consent` refuses an unknown version: keep it local; the banner asks again later.
    update({ error: "unrecorded" });
  } else {
    await record(consent);
  }
  return state.error;
}

let saving: { preferences: boolean; promise: Promise<ConsentErrorCode | null> } | null = null;

/**
 * Save the visitor's choice: the cookie first (the choice applies at once whatever the network
 * does), then the side effects, then one `legal.consent` call. Resolves to the notice shown, or
 * null when it was recorded. A repeat of an in-flight save shares it (one request from the
 * shared rate budget); a different choice waits for it, then saves.
 */
export function saveConsent(choice: { preferences: boolean }): Promise<ConsentErrorCode | null> {
  if (saving) {
    if (saving.preferences === choice.preferences) return saving.promise;
    return saving.promise.then(() => saveConsent(choice));
  }
  const promise = save(choice).finally(() => {
    if (saving?.promise === promise) saving = null;
  });
  saving = { preferences: choice.preferences, promise };
  return promise;
}

let initialized = false;

/**
 * Once per page load, after hydration: read the cookie, enforce a stored "no", fetch the current
 * policy, and record a choice the server has not got (one silent retry per tab; a signed-in
 * visitor's anonymous record is recorded once as the user).
 */
export async function initConsent(opts: { signedIn: boolean }): Promise<void> {
  // Kept current on every call, so a client-side sign-in or sign-out records the right way.
  if (state.signedIn !== opts.signedIn) update({ signedIn: opts.signedIn });
  if (initialized) return;
  initialized = true;
  const stored = parseConsent(readCookies());
  update({ ready: true, stored });
  try {
    document.addEventListener("visibilitychange", onVisibilityChange);
  } catch {
    // No document events: the cookie is still read on every Preferences write.
  }
  if (stored && !stored.preferences) withdrawPreferences();
  const policy = await loadCookiePolicy();
  if (!stored || !policy || stored.version !== policy.version) return;
  if (stored.recorded === "pending") {
    if (retrySpent()) return;
    spendRetry();
    await record(stored, { silent: true });
  } else if (stored.recorded === "anonymous" && opts.signedIn) {
    await record(stored, { silent: true });
  }
}

/** Tests only: forget this module's state. */
export function resetConsentForTests(): void {
  state = INITIAL;
  policyRequest = null;
  initialized = false;
  saving = null;
  cookieBacked = true;
  if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibilityChange);
}
