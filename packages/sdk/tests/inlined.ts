// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The `@commonair/contracts` files the published bundle inlines (code or types), as the build
 * reports them. `build.test.ts` fails when the build's list changes, so a newly inlined file is
 * noticed and dual-licensed before it ships (ADR 0035).
 */
export const INLINED_CONTRACT_FILES = [
  "packages/contracts/src/api/common.ts",
  "packages/contracts/src/api/entities.ts",
  "packages/contracts/src/api/router.ts",
  "packages/contracts/src/chat.ts",
  "packages/contracts/src/enums.ts",
  "packages/contracts/src/events.ts",
  "packages/contracts/src/eventsub.ts",
  "packages/contracts/src/oauth.ts",
  "packages/contracts/src/scopes.ts",
  "packages/contracts/src/shapes.ts",
] as const;
