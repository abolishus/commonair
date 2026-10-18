// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Heartbeat fingerprints and timing for simulated viewers. Well-behaved viewers look like
 * ordinary headful browsers with human-ish timing jitter; viewbots deliberately carry the
 * tells integrity looks for (webdriver flag, headless UA, no plugins/languages, perfectly
 * periodic heartbeats). The keys mirror what the browser player collects (`player/fingerprint.ts`
 * builds the same shape from `navigator`).
 */

export type Fingerprint = Record<string, string | number | boolean | null>;

const DESKTOPS = [
  { platform: "Win32", screenWidth: 1920, screenHeight: 1080, hardwareConcurrency: 8, deviceMemory: 8 },
  { platform: "MacIntel", screenWidth: 1512, screenHeight: 982, hardwareConcurrency: 10, deviceMemory: 8 },
  { platform: "Linux x86_64", screenWidth: 2560, screenHeight: 1440, hardwareConcurrency: 16, deviceMemory: 8 },
  { platform: "Win32", screenWidth: 1366, screenHeight: 768, hardwareConcurrency: 4, deviceMemory: 4 },
] as const;
const MOBILES = [
  { platform: "iPhone", screenWidth: 390, screenHeight: 844, hardwareConcurrency: 6, deviceMemory: null },
  { platform: "Linux armv8l", screenWidth: 412, screenHeight: 915, hardwareConcurrency: 8, deviceMemory: 4 },
] as const;
const TIMEZONES = [-480, -300, -240, 0, 60, 120, 330, 540];

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length) % items.length] as T;
}

/** A plausible headful browser fingerprint. */
export function realisticFingerprint(random: () => number = Math.random): Fingerprint {
  const mobile = random() < 0.3;
  const device = mobile ? pick(MOBILES, random) : pick(DESKTOPS, random);
  return {
    webdriver: false,
    headless: false,
    platform: device.platform,
    languages: 1 + Math.floor(random() * 3),
    plugins: mobile ? 0 : 5,
    hardwareConcurrency: device.hardwareConcurrency,
    deviceMemory: device.deviceMemory,
    screenWidth: device.screenWidth,
    screenHeight: device.screenHeight,
    colorDepth: 24,
    touchPoints: mobile ? 5 : 0,
    timezoneOffset: pick(TIMEZONES, random),
    nativeHls: device.platform === "iPhone",
  };
}

/** The fingerprint of an unmodified headless automation browser. */
export function headlessFingerprint(): Fingerprint {
  return {
    webdriver: true,
    headless: true,
    platform: "Linux x86_64",
    languages: 0,
    plugins: 0,
    hardwareConcurrency: 2,
    deviceMemory: null,
    screenWidth: 800,
    screenHeight: 600,
    colorDepth: 24,
    touchPoints: 0,
    timezoneOffset: 0,
    nativeHls: false,
  };
}

/** Is this fingerprint carrying obvious automation tells? (Used by tests and reports.) */
export function looksHeadless(fp: Fingerprint): boolean {
  return fp.webdriver === true || fp.headless === true || (fp.plugins === 0 && fp.languages === 0);
}

export interface HeartbeatTiming {
  /** Fractional jitter around the interval (0.15 = ±15 %). 0 = perfectly periodic. */
  jitter: number;
  /** Probability that a beat is late by 1–3 intervals (tab throttled, network hiccup). */
  lateProbability: number;
}

export const HUMAN_TIMING: HeartbeatTiming = { jitter: 0.15, lateProbability: 0.03 };
export const BOT_TIMING: HeartbeatTiming = { jitter: 0, lateProbability: 0 };

/** Delay before the next heartbeat. */
export function nextHeartbeatDelay(
  intervalMs: number,
  timing: HeartbeatTiming,
  random: () => number = Math.random,
): number {
  let delay = intervalMs * (1 + (random() * 2 - 1) * timing.jitter);
  if (timing.lateProbability > 0 && random() < timing.lateProbability) delay += intervalMs * (1 + random() * 2);
  return Math.max(250, Math.round(delay));
}

/** A random device id in the contract's 16–64 character range. */
export function newDeviceId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}
