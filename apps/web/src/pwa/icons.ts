// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The app icons in `apps/web/public/icons/` (rendered from `icon.svg` by
 * `harness/src/tools/render-pwa-icons.ts`). One list for the manifest, the service worker's
 * precache and its notifications, so they cannot drift apart.
 */
export const PWA_ICONS = {
  svg: "/icons/icon.svg",
  icon192: "/icons/icon-192.png",
  icon512: "/icons/icon-512.png",
  maskable512: "/icons/maskable-512.png",
  appleTouch: "/icons/apple-touch-icon.png",
} as const;

/** Every icon path, sorted (the service worker precaches them all). */
export const PWA_ICON_PATHS: readonly string[] = Object.values(PWA_ICONS).sort();
