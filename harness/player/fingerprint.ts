// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Coarse capability fingerprint from `navigator`, same keys as `src/fingerprint.ts`. */
import type { Fingerprint } from "../src/fingerprint.ts";

interface NavigatorExtras {
  deviceMemory?: number;
}

export function collectFingerprint(nativeHls: boolean): Fingerprint {
  const nav = navigator as Navigator & NavigatorExtras;
  return {
    webdriver: nav.webdriver === true,
    headless: /Headless/i.test(nav.userAgent),
    platform: nav.platform,
    languages: nav.languages?.length ?? 0,
    plugins: nav.plugins?.length ?? 0,
    hardwareConcurrency: nav.hardwareConcurrency ?? null,
    deviceMemory: nav.deviceMemory ?? null,
    screenWidth: screen.width,
    screenHeight: screen.height,
    colorDepth: screen.colorDepth,
    touchPoints: nav.maxTouchPoints ?? 0,
    timezoneOffset: new Date().getTimezoneOffset(),
    nativeHls,
  };
}
