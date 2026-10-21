// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Startup entry point for trust & safety. `main.ts` awaits `startModeration` before serving, so a
 * missing key, an unreadable hash list, a classifier that will not load or a private key that
 * does not match the public key stops the API (fail closed).
 */
import type { Deps } from "../deps.ts";
import { checkOpeningKey } from "./evidence.ts";
import { initModeration, type ModerationOverrides, type ModerationRuntime } from "./runtime.ts";

export async function startModeration(deps: Deps, overrides?: ModerationOverrides): Promise<ModerationRuntime> {
  const rt = await initModeration(deps, overrides);
  await checkOpeningKey(deps, rt.sealing.keyId);
  return rt;
}

/** For `/healthz` and `/readyz`: whether the harness-only test hooks are on. */
export const moderationHealth = (deps: Deps) => ({ moderationTestHooks: deps.env.MODERATION_TEST_HOOKS });

export { closeModeration, moderationRuntime } from "./runtime.ts";
