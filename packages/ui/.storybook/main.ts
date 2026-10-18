// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  stories: ["../stories/**/*.stories.@(ts|tsx)"],
  addons: ["@storybook/addon-a11y"],
  framework: { name: "@storybook/react-vite", options: {} },
  // No network: no telemetry, no "what's new" fetches, no remote fonts or CDNs.
  core: { disableTelemetry: true, disableWhatsNewNotifications: true },
  async viteFinal(viteConfig) {
    const { default: tailwindcss } = await import("@tailwindcss/vite");
    viteConfig.plugins = [...(viteConfig.plugins ?? []), tailwindcss()];
    // The package's own vite.config.ts carries Vitest settings Storybook must not inherit.
    delete (viteConfig as { test?: unknown }).test;
    return viteConfig;
  },
};

export default config;
