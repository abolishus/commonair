// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `headless`: coarse client capability fingerprint. Each flag is weighted and the
 * weights combine as a noisy-OR; every single weight is below the default exclusion
 * score (0.7), so no one quirk (an extension, a privacy browser) excludes a viewer.
 *
 * Fingerprint keys the player reports (CONTRACT-REQUEST: document these in
 * `Heartbeat.fingerprint` / `playback_sessions.fingerprint` in contracts):
 *   webdriver   boolean  navigator.webdriver
 *   automation  boolean  automation globals present (e.g. __playwright*, callPhantom, domAutomation, cdc_*)
 *   plugins     number   navigator.plugins.length
 *   webgl       boolean  a WebGL context could be created
 *   innerWidth  number   window.innerWidth
 *   innerHeight number   window.innerHeight
 *   audio       boolean  AudioContext is available
 * The user agent comes from `playback_sessions.user_agent` (or a `userAgent` key).
 */
import type { Signal } from "../types.ts";
import { noisyOr } from "./combine.ts";

export const HEADLESS_WEIGHTS = {
  webdriver: 0.6,
  headless_user_agent: 0.6,
  automation_globals: 0.5,
  zero_window: 0.3,
  no_webgl: 0.25,
  no_plugins_desktop: 0.2,
  no_audio_context: 0.15,
} as const;
export type HeadlessFlag = keyof typeof HEADLESS_WEIGHTS;

const MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile|CrOS|SmartTV|Tizen|Web0S|PlayStation|Xbox/i;
const DESKTOP_UA = /Windows NT|Macintosh|X11; Linux|X11; Ubuntu|X11; Fedora/i;
const HEADLESS_UA = /HeadlessChrome|PhantomJS|SlimerJS|Electron\/.*HeadlessChrome|\bheadless\b/i;

export function headlessFlags(fingerprint: Record<string, unknown>, userAgent: string | null): HeadlessFlag[] {
  const fp = fingerprint;
  const ua = userAgent ?? (typeof fp.userAgent === "string" ? fp.userAgent : "");
  const flags: HeadlessFlag[] = [];
  if (fp.webdriver === true) flags.push("webdriver");
  if (HEADLESS_UA.test(ua)) flags.push("headless_user_agent");
  if (fp.automation === true) flags.push("automation_globals");
  if (fp.innerWidth === 0 || fp.innerHeight === 0) flags.push("zero_window");
  if (fp.webgl === false) flags.push("no_webgl");
  if (fp.plugins === 0 && DESKTOP_UA.test(ua) && !MOBILE_UA.test(ua)) flags.push("no_plugins_desktop");
  if (fp.audio === false) flags.push("no_audio_context");
  return flags;
}

export function headlessSignal(fingerprint: Record<string, unknown>, userAgent: string | null): Signal | null {
  const flags = headlessFlags(fingerprint, userAgent);
  if (flags.length === 0) return null;
  return { code: "headless", score: noisyOr(flags.map((f) => HEADLESS_WEIGHTS[f])), details: { flags } };
}
