// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The API's own user-facing strings for overlays: default alert messages, the anonymous label and
 * test-alert sample values. They end up on stream, so they go through a catalog like every other
 * user-facing string; a translation may be partial and falls back to English.
 */

const en = {
  "alert.anonymous": "Anonymous",
  "alert.default.follow": "${user} just followed!",
  "alert.default.subscription": "${user} subscribed at tier ${tier}!",
  "alert.default.tip": "${user} tipped ${amount}!",
  "alert.default.raid": "${user} is raiding with ${viewers} viewers!",
  "alert.sample.user": "A kind viewer",
  "alert.sample.message": "This is a test alert.",
} as const;

export type OverlayMessageKey = keyof typeof en;

const CATALOGS: Record<string, Partial<Record<OverlayMessageKey, string>>> = { en };

/** The instance has no locale setting yet; alerts render in English until it does. */
export const OVERLAY_LOCALE = "en";

/** Exact tag, then its language, then English. */
export function t(key: OverlayMessageKey, locale: string = OVERLAY_LOCALE): string {
  const lang = locale.split("-")[0] ?? locale;
  return CATALOGS[locale]?.[key] ?? CATALOGS[lang]?.[key] ?? en[key];
}
