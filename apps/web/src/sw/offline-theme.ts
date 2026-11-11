// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The offline page's colours (`offline.ts`): which design tokens it reads. Its own module with no
 * imports, because the build hook (`scripts/vite-pwa.ts`) reads it while Node loads the Vite
 * config, where workspace packages' TypeScript cannot run.
 */

/** The token colours the page needs, as CSS colour values (`--background` and friends). */
export interface OfflinePalette {
  background: string;
  foreground: string;
  mutedForeground: string;
  border: string;
  primary: string;
  primaryForeground: string;
  ring: string;
}

export interface OfflineTheme {
  dark: OfflinePalette;
  light: OfflinePalette;
}

/** The token each palette entry reads, in `packages/ui/src/styles/globals.css`. */
export const OFFLINE_TOKENS: Readonly<Record<keyof OfflinePalette, string>> = {
  background: "--background",
  foreground: "--foreground",
  mutedForeground: "--muted-foreground",
  border: "--border",
  primary: "--primary",
  primaryForeground: "--primary-foreground",
  ring: "--ring",
};
