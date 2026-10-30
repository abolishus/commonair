// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The data-mode budget controller (ADR 0018, feature-wins §4.6), pure. The viewer sets a budget
 * in MB an hour; the ceiling it implies (`dataModeCeilingBps`) goes into the playback token, the
 * origin keeps only the variants under it, and on hls.js the same ceiling caps the levels. The
 * audio-only variant is the floor: it plays even when it costs more than the budget, and the
 * meter shows what is actually spent.
 *
 * MB here is 10^6 bytes, as in `dataModeCeilingBps`: MB/h = bit/s × 3600 / 8 000 000 = kbit/s × 0.45.
 */
import { DATA_MODE, dataModeCeilingBps } from "@commonair/contracts/enums";

export type DataModePreset = (typeof DATA_MODE.presetsMbPerHour)[number];
export const DATA_MODE_PRESETS: readonly DataModePreset[] = DATA_MODE.presetsMbPerHour;
/** The Audio preset: what a slow or metered connection is offered first. */
export const AUDIO_PRESET: DataModePreset = DATA_MODE.presetsMbPerHour[0];
/** The preset a new viewer starts from when nothing suggests the Audio one. */
export const DEFAULT_PRESET: DataModePreset = DATA_MODE.presetsMbPerHour[1];

/** The viewer's choice, kept per device. The budget is kept while the mode is off. */
export interface DataModeChoice {
  on: boolean;
  mbPerHour: number;
}

/** A playable level as the player sees it (hls.js `Level`, or a nominal rung on native HLS). */
export interface LevelInfo {
  /** Advertised bit/s (`BANDWIDTH`). */
  bitrate: number;
  audioOnly: boolean;
}

/** MB per hour for a stream of `bps` bit/s. */
export const mbPerHourOf = (bps: number): number => (bps * 3600) / 8_000_000;

/** A budget within the custom bounds, rounded to whole MB an hour; null when not a number. */
export function clampBudget(mbPerHour: number): number | null {
  if (!Number.isFinite(mbPerHour)) return null;
  return Math.min(DATA_MODE.maxMbPerHour, Math.max(DATA_MODE.minMbPerHour, Math.round(mbPerHour)));
}

/** The ceiling (bit/s) a choice puts in the token; null when data mode is off. */
export function ceilingOf(choice: DataModeChoice | null): number | null {
  if (!choice?.on) return null;
  const mb = clampBudget(choice.mbPerHour);
  return mb === null ? null : dataModeCeilingBps(mb);
}

/** Whether a budget is one of the presets (the picker shows the rest as Custom). */
export const isPreset = (mbPerHour: number): mbPerHour is DataModePreset =>
  (DATA_MODE_PRESETS as readonly number[]).includes(mbPerHour);

/**
 * The hls.js `autoLevelCapping` index for a ceiling: the highest level whose bitrate fits, or the
 * audio-only level when none does (the lowest level when there is no audio-only one either).
 * -1 (no cap) when data mode is off or there are no levels. hls.js caps by index, so the result
 * relies on its levels being sorted by bitrate, which hls.js does.
 */
export function capIndex(levels: readonly LevelInfo[], ceiling: number | null): number {
  if (ceiling === null || levels.length === 0) return -1;
  let best = -1;
  levels.forEach((l, i) => {
    if (l.bitrate <= ceiling && (best === -1 || l.bitrate >= (levels[best]?.bitrate ?? 0))) best = i;
  });
  if (best !== -1) return best;
  const audio = levels.findIndex((l) => l.audioOnly);
  if (audio !== -1) return audio;
  return levels.reduce((lo, l, i) => (l.bitrate < (levels[lo]?.bitrate ?? Number.POSITIVE_INFINITY) ? i : lo), 0);
}

/** Estimated MB an hour for a level of `bitrate` bit/s, container and playlist overhead included. */
export const estimateMbPerHour = (bitrate: number): number => mbPerHourOf(bitrate) * DATA_MODE.overheadFactor;

export interface BudgetPlan {
  /** The token's ceiling (bit/s). */
  ceiling: number;
  /** hls.js `autoLevelCapping` (-1 when there are no levels to cap). */
  capIndex: number;
  /** The level the player is expected to settle on, or null when no level is known yet. */
  level: LevelInfo | null;
  /** Estimated MB an hour at that level, or null when no level is known yet. */
  estimateMbPerHour: number | null;
  /** Even the floor (the audio-only variant, or the lowest level) costs more than the budget. */
  overBudget: boolean;
}

/** What a budget means on these levels. */
export function planBudget(mbPerHour: number, levels: readonly LevelInfo[]): BudgetPlan {
  const budget = clampBudget(mbPerHour) ?? DEFAULT_PRESET;
  const ceiling = dataModeCeilingBps(budget);
  const cap = capIndex(levels, ceiling);
  const level = levels[cap] ?? null;
  const estimate = level ? estimateMbPerHour(level.bitrate) : null;
  return {
    ceiling,
    capIndex: cap,
    level,
    estimateMbPerHour: estimate,
    overBudget: estimate !== null && estimate > budget,
  };
}

/**
 * Nominal levels for native HLS, which exposes none: the ladder's rungs (services/media
 * `transcode/ladder.ts`: video plus its AAC track) for the renditions `playback.start` lists. The
 * source's bitrate is unknown on the client and is left out; without an `audio` rendition the
 * origin derives an audio-only variant advertised at 192 kbit/s.
 */
export const NOMINAL_RENDITION_BPS: Readonly<Record<string, number>> = {
  audio: 96_000,
  "480p": 1_296_000,
  "720p": 3_128_000,
  "1080p": 6_160_000,
};
export const DERIVED_AUDIO_BPS = 192_000;

export function nominalLevels(renditions: readonly string[]): LevelInfo[] {
  const levels: LevelInfo[] = [];
  for (const r of renditions) {
    const bps = NOMINAL_RENDITION_BPS[r];
    if (bps !== undefined) levels.push({ bitrate: bps, audioOnly: r === "audio" });
  }
  if (!renditions.includes("audio")) levels.push({ bitrate: DERIVED_AUDIO_BPS, audioOnly: true });
  return levels.sort((a, b) => a.bitrate - b.bitrate);
}

/** What the browser says about the connection (Network Information API, where it exists). */
export interface ConnectionHints {
  saveData?: boolean | undefined;
  effectiveType?: string | undefined;
}

const SLOW_TYPES = new Set(["slow-2g", "2g", "3g"]);

/** The Audio preset when the browser reports Save-Data or a slow connection; null otherwise. */
export function suggestedPreset(hints: ConnectionHints | null | undefined): DataModePreset | null {
  if (!hints) return null;
  if (hints.saveData === true) return AUDIO_PRESET;
  return hints.effectiveType !== undefined && SLOW_TYPES.has(hints.effectiveType) ? AUDIO_PRESET : null;
}

/** `navigator.connection`, where the browser has it. */
export function connectionHints(nav: Navigator | undefined = globalThis.navigator): ConnectionHints | null {
  const c = (nav as (Navigator & { connection?: ConnectionHints }) | undefined)?.connection;
  return c ? { saveData: c.saveData, effectiveType: c.effectiveType } : null;
}

export const DATA_MODE_STORAGE_KEY = "commonair-data-mode";

/**
 * The saved choice, or the starting point when there is none: off, with the Audio preset when
 * the connection suggests it. Data mode is never turned on for the viewer; the choice is theirs.
 */
export function readDataModeChoice(
  storage: Pick<Storage, "getItem"> | null | undefined,
  hints: ConnectionHints | null = null,
): { choice: DataModeChoice; saved: boolean; suggested: DataModePreset | null } {
  const suggested = suggestedPreset(hints);
  const fallback = { choice: { on: false, mbPerHour: suggested ?? DEFAULT_PRESET }, saved: false, suggested };
  let raw: string | null = null;
  try {
    raw = storage?.getItem(DATA_MODE_STORAGE_KEY) ?? null;
  } catch {
    return fallback;
  }
  if (raw === null) return fallback;
  try {
    const parsed = JSON.parse(raw) as { on?: unknown; mbPerHour?: unknown };
    const mb = typeof parsed.mbPerHour === "number" ? clampBudget(parsed.mbPerHour) : null;
    if (typeof parsed.on !== "boolean" || mb === null) return fallback;
    return { choice: { on: parsed.on, mbPerHour: mb }, saved: true, suggested };
  } catch {
    return fallback;
  }
}

/** Keep the choice on this device; false when storage refused it (private mode, quota). */
export function saveDataModeChoice(
  storage: Pick<Storage, "setItem"> | null | undefined,
  choice: DataModeChoice,
): boolean {
  const mb = clampBudget(choice.mbPerHour);
  if (!storage || mb === null) return false;
  try {
    storage.setItem(DATA_MODE_STORAGE_KEY, JSON.stringify({ on: choice.on, mbPerHour: mb }));
    return true;
  } catch {
    return false;
  }
}

/** `localStorage`, or null where reading it throws. */
export function localStore(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
