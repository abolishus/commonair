// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A session's device, coarsely, from its user agent, parsed in the browser (D7.2): the browser
 * family, the system and whether it is a phone, a tablet or a computer. Never a version, a model or
 * a network address (the API keeps none).
 */
import { t } from "../../i18n/index.ts";

export type DeviceKind = "phone" | "tablet" | "computer";

export interface SessionDevice {
  browser: string | null;
  os: string | null;
  kind: DeviceKind;
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

export function parseUserAgent(userAgent: string | null | undefined): SessionDevice {
  const ua = (userAgent ?? "").slice(0, 512);
  const os = first(ua, SYSTEMS);
  const kind: DeviceKind =
    os === "iPad" || (os === "Android" && !/\bMobile\b/.test(ua))
      ? "tablet"
      : os === "iPhone" || os === "Android" || /\bMobile\b/.test(ua)
        ? "phone"
        : "computer";
  return { browser: first(ua, BROWSERS), os, kind };
}

/** "Firefox on macOS", in the reader's language; brand names stay as they are. */
export function deviceText(device: SessionDevice): string {
  if (device.browser && device.os) return t("d7Security.sessions.device", { browser: device.browser, os: device.os });
  if (device.browser) return device.browser;
  if (device.os) return t("d7Security.sessions.deviceOsOnly", { os: device.os });
  return t("d7Security.sessions.deviceUnknown");
}

/** A session as better-auth's `list-sessions` answers (the fields the page reads). */
export interface AuthSessionRow {
  id: string;
  token: string;
  userAgent: string | null;
  createdAt: string;
  updatedAt: string;
}

/** This device first, then the most recently active. */
export function orderSessions<T extends Pick<AuthSessionRow, "id" | "updatedAt">>(
  sessions: readonly T[],
  currentId: string | null,
): T[] {
  return sessions.toSorted((a, b) => {
    if (a.id === currentId) return -1;
    if (b.id === currentId) return 1;
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
}
