// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Calm Chat's per-device settings in localStorage: on/off (off by default for everyone, also with
 * `prefers-reduced-motion`), new rows per second (1–10, default 3) and subscriber priority (off by
 * default). Storage can be missing, blocked or throwing (private windows, embeds, tests): every
 * access is wrapped, and the page then keeps the choice for this page only. A change notifies
 * every subscriber on the page and, through the `storage` event, other tabs.
 */
import { RATE_DEFAULT, clampRate } from "./governor.ts";

export const CALM_SETTINGS_KEY = "commonair:calm-chat";

export interface CalmSettings {
  enabled: boolean;
  rowsPerSecond: number;
  subscriberPriority: boolean;
}

export const DEFAULT_CALM_SETTINGS: CalmSettings = Object.freeze({
  enabled: false,
  rowsPerSecond: RATE_DEFAULT,
  subscriberPriority: false,
});

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

let storageSource: () => StorageLike | null = browserStorage;
let memory: CalmSettings | null = null;
let cached: { raw: string | null; value: CalmSettings } = { raw: null, value: DEFAULT_CALM_SETTINGS };
const listeners = new Set<() => void>();

/** Tests swap the storage (`null` restores the browser's) and forget this page's choice. */
export function setCalmStorage(source: (() => StorageLike | null) | null): void {
  storageSource = source ?? browserStorage;
  memory = null;
  cached = { raw: null, value: DEFAULT_CALM_SETTINGS };
}

/** Parses a stored value; anything malformed falls back field by field to the defaults. */
export function parseCalmSettings(raw: string | null): CalmSettings {
  if (!raw) return DEFAULT_CALM_SETTINGS;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return DEFAULT_CALM_SETTINGS;
  }
  if (typeof v !== "object" || v === null) return DEFAULT_CALM_SETTINGS;
  const o = v as Record<string, unknown>;
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : DEFAULT_CALM_SETTINGS.enabled,
    rowsPerSecond: typeof o.rowsPerSecond === "number" ? clampRate(o.rowsPerSecond) : RATE_DEFAULT,
    subscriberPriority:
      typeof o.subscriberPriority === "boolean" ? o.subscriberPriority : DEFAULT_CALM_SETTINGS.subscriberPriority,
  };
}

function readRaw(): string | null {
  try {
    return storageSource()?.getItem(CALM_SETTINGS_KEY) ?? null;
  } catch {
    return null;
  }
}

/** The current settings; the same object while nothing changed (for `useSyncExternalStore`). */
export function readCalmSettings(): CalmSettings {
  if (memory) return memory;
  const raw = readRaw();
  if (raw !== cached.raw) cached = { raw, value: parseCalmSettings(raw) };
  return cached.value;
}

/** Saves a change; returns false when storage refused it (the choice still holds on this page). */
export function writeCalmSettings(patch: Partial<CalmSettings>): boolean {
  const next: CalmSettings = { ...readCalmSettings(), ...patch };
  next.rowsPerSecond = clampRate(next.rowsPerSecond);
  const raw = JSON.stringify(next);
  let saved = false;
  try {
    const s = storageSource();
    if (s) {
      s.setItem(CALM_SETTINGS_KEY, raw);
      saved = true;
    }
  } catch {
    saved = false;
  }
  memory = saved ? null : next;
  cached = { raw, value: next };
  for (const fn of listeners) fn();
  return saved;
}

export function subscribeCalmSettings(fn: () => void): () => void {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key === CALM_SETTINGS_KEY) fn();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(fn);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}
