// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    printWidth: 120,
    ignorePatterns: [
      "**/drizzle/meta/**",
      "**/routeTree.gen.ts",
      "relay/**",
      "**/*.gen.*",
      ".claude/briefs/e4/boards/**",
    ],
  },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    plugins: ["typescript", "unicorn", "import", "promise"],
    ignorePatterns: [
      "**/drizzle/meta/**",
      "**/routeTree.gen.ts",
      "relay/**",
      "**/*.gen.*",
      ".claude/briefs/e4/boards/**",
    ],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      "typescript/no-explicit-any": "error",
      "typescript/no-floating-promises": "error",
      "typescript/no-misused-promises": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
      eqeqeq: "error",
    },
    options: { typeAware: true, typeCheck: true },
    overrides: [
      {
        files: ["apps/web/**", "packages/ui/**", "packages/email/**", "packages/player/**"],
        plugins: ["react", "jsx-a11y"],
        rules: {
          // Native dialogs and title tooltips are banned; use the shared Dialog/Tooltip.
          "no-alert": "error",
        },
      },
      {
        files: ["scripts/**", "harness/**"],
        rules: { "no-console": "off" },
      },
      {
        files: ["**/*.test.ts", "**/*.test.tsx"],
        plugins: ["vitest"],
        rules: {
          "vitest/no-disabled-tests": "error",
          "vitest/no-focused-tests": "error",
          "vitest/valid-expect": ["error", { maxArgs: 2 }],
          "vitest/expect-expect": ["error", { assertFunctionNames: ["expect", "expect*"] }],
        },
      },
    ],
  },
  run: {
    cache: true,
  },
});
