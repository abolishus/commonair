// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The action a visitor signed up (or signed in) to take, kept in this browser until they are back
 * on that page and confirm or dismiss it (README D2.1: "it never follows or pays on its own").
 * `localStorage`, because the verification link often opens in a new tab. An enum, a path and a
 * slug only: nothing personal. Opened on another device, there is simply no confirm.
 */
import type { SignupIntent } from "@commonair/contracts/enums";
import { safeRedirect } from "../../lib/auth-return.ts";
import { CONFIRMABLE_INTENTS, channelSlugOf, signupIntentOf } from "./intents.ts";

export const PENDING_INTENT_KEY = "commonair.intent.v1";
/** Longer than the verification link lives (60 minutes), short enough to never surprise. */
export const PENDING_INTENT_TTL_MS = 24 * 60 * 60 * 1000;

export interface PendingIntent {
  intent: SignupIntent;
  /** The page to confirm on (a same-origin path, without its search). */
  path: string;
  channel?: string;
  at: number;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStore(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

const pathOnly = (target: string): string => target.split(/[?#]/)[0] ?? target;

/** Remember the intent for `target` (only those confirmed on the page they came from). */
export function savePendingIntent(
  p: { intent: SignupIntent | undefined; target: string | undefined; channel?: string | undefined },
  now: number = Date.now(),
  store: Store | null = browserStore(),
): boolean {
  const target = safeRedirect(p.target);
  if (!store || !p.intent || !CONFIRMABLE_INTENTS.has(p.intent) || target === undefined) return false;
  const value: PendingIntent = { intent: p.intent, path: pathOnly(target), at: now };
  const channel = channelSlugOf(p.channel);
  if (channel !== undefined) value.channel = channel;
  try {
    store.setItem(PENDING_INTENT_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** The pending intent, if it is still fresh and well formed; a stale or broken one is removed. */
export function readPendingIntent(
  now: number = Date.now(),
  store: Store | null = browserStore(),
): PendingIntent | null {
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(PENDING_INTENT_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  const out = parsePendingIntent(raw, now);
  if (!out) clearPendingIntent(store);
  return out;
}

/** The stored value, if it is fresh and well formed (pure: never touches storage). */
export function parsePendingIntent(raw: string | null, now: number = Date.now()): PendingIntent | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const v = (parsed ?? {}) as Record<string, unknown>;
  const intent = signupIntentOf(v.intent);
  const path = safeRedirect(v.path);
  const at = typeof v.at === "number" ? v.at : NaN;
  const fresh = Number.isFinite(at) && at <= now && now - at < PENDING_INTENT_TTL_MS;
  if (!intent || !CONFIRMABLE_INTENTS.has(intent) || path === undefined || !fresh) return null;
  const out: PendingIntent = { intent, path, at };
  const channel = channelSlugOf(v.channel);
  if (channel !== undefined) out.channel = channel;
  return out;
}

/** The raw stored value (for `useSyncExternalStore`: a string is a stable snapshot). */
export function pendingIntentSnapshot(store: Store | null = browserStore()): string | null {
  try {
    return store?.getItem(PENDING_INTENT_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Whether `p` is the pending intent for this action on this page. */
export const pendingMatches = (p: PendingIntent | null, intent: SignupIntent, pathname: string): boolean =>
  p !== null && p.intent === intent && p.path === pathOnly(pathname);

export function clearPendingIntent(store: Store | null = browserStore()): void {
  try {
    store?.removeItem(PENDING_INTENT_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** The pending intent for this action on this page, or null. */
export function pendingIntentFor(
  intent: SignupIntent,
  pathname: string,
  now: number = Date.now(),
  store: Store | null = browserStore(),
): PendingIntent | null {
  const p = readPendingIntent(now, store);
  return pendingMatches(p, intent, pathname) ? p : null;
}
