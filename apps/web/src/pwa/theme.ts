// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Browser chrome colours for the manifest and `theme-color` (ADR 0028 decision 7). These are the only
 * colour literals in the app: a manifest and a meta tag cannot read CSS variables. They mirror the
 * zinc base of the design tokens (`--background` in dark and light).
 */
export const PWA_THEME_COLORS = { dark: "#09090b", light: "#ffffff" } as const;
