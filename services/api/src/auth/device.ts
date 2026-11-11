// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A coarse device summary from a session's user agent, for the new-sign-in mail (D7.2): the browser
 * family and the operating system, nothing finer (no versions, no device model, never an IP). The
 * web's sessions list parses the same way in the browser (apps/web components/security).
 */

export interface DeviceSummary {
  browser: string | null;
  os: string | null;
}

/** First match wins: Edge and Opera also say Chrome, Chrome also says Safari. */
const BROWSERS: readonly [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\b/, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bChrome\/|\bCriOS\/|\bChromium\//, "Chrome"],
  [/\bSafari\//, "Safari"],
];

const SYSTEMS: readonly [RegExp, string][] = [
  [/\biPhone\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bWindows\b/, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bLinux\b/, "Linux"],
];

const first = (ua: string, table: readonly [RegExp, string][]) => table.find(([re]) => re.test(ua))?.[1] ?? null;

export function deviceSummary(userAgent: string | null | undefined): DeviceSummary {
  const ua = (userAgent ?? "").slice(0, 512);
  return { browser: first(ua, BROWSERS), os: first(ua, SYSTEMS) };
}

/** "Firefox · Linux", one part when only one is known, null when neither is. */
export function deviceLabel(d: DeviceSummary): string | null {
  const parts = [d.browser, d.os].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Two sessions are the same device for the new-sign-in mail when their summaries match. */
export const sameDevice = (a: DeviceSummary, b: DeviceSummary) => a.browser === b.browser && a.os === b.os;

/** better-auth paths (relative to its base path) whose new session is someone signing in. */
const SIGN_IN_PATHS = new Set([
  "/sign-in/email",
  "/sign-in/username",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  "/two-factor/verify-otp",
  "/passkey/verify-authentication",
  "/magic-link/verify",
]);
/** The password step, whose session better-auth deletes again while two-step sign-in is pending. */
const PASSWORD_PATHS = new Set(["/sign-in/email", "/sign-in/username"]);

export const isSignInPath = (path: string | undefined): boolean =>
  path !== undefined && (SIGN_IN_PATHS.has(path) || path.startsWith("/callback/"));

/**
 * Whether a new session earns the new-sign-in mail: a sign-in (not a sign-up's first session, an
 * email confirmation or a session better-auth re-issues after a settings change), from a device
 * none of the member's other sessions has. With no other session there is nothing to compare
 * against (the first sign-in after verifying, or after signing out everywhere), so no mail. The
 * password step of a two-step sign-in is skipped: the code step that follows makes the session.
 */
export function earnsNewSignInMail(input: {
  path: string | undefined;
  twoFactorEnabled: boolean;
  current: string | null | undefined;
  others: readonly (string | null | undefined)[];
}): boolean {
  if (!isSignInPath(input.path)) return false;
  if (input.twoFactorEnabled && input.path !== undefined && PASSWORD_PATHS.has(input.path)) return false;
  if (input.others.length === 0) return false;
  const current = deviceSummary(input.current);
  return !input.others.some((ua) => sameDevice(deviceSummary(ua), current));
}
