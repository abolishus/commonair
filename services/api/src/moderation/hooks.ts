// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Harness-only test hooks (`/internal/moderation/*`, docs/testing/e4c-selectors.md). They exist
 * only while `MODERATION_TEST_HOOKS=true`; otherwise every path answers 404 as if it were unknown,
 * so a public instance cannot script classifier scores, move the NCII clock or shorten the DMCA
 * waiting period (`dmca-tick` is the only way to run the restore early, and only here).
 */
import { DmcaTickBody, INTERNAL_ROUTES, KEYS, ModerationScriptBody, NciiTickBody } from "@commonair/contracts/internal";
import type { Deps } from "../deps.ts";
import { moderationRuntime } from "./runtime.ts";

/** Scripts outlive a scenario by a day at most; the harness clears them by writing `{}`. */
const SCRIPT_TTL_SECONDS = 86_400;

export const isTestHookPath = (path: string) =>
  path === INTERNAL_ROUTES.moderationScript || path === INTERNAL_ROUTES.nciiTick || path === INTERNAL_ROUTES.dmcaTick;

/**
 * Serve one hook for a caller that already passed the internal-secret check. `body` is the parsed
 * JSON (null when missing, too large or malformed). The hooks-off 404 is repeated here so no
 * other caller can reach them on a public instance.
 */
export async function testHook(deps: Deps, path: string, method: string, body: unknown): Promise<Response> {
  if (!deps.env.MODERATION_TEST_HOOKS) return new Response(null, { status: 404 });
  if (path === INTERNAL_ROUTES.moderationScript) {
    if (method !== "PUT") return new Response(null, { status: 405 });
    const parsed = ModerationScriptBody.safeParse(body);
    if (!parsed.success) return new Response(null, { status: 400 });
    const { channelId, scores } = parsed.data;
    await deps.valkey.set(KEYS.moderationScript(channelId), JSON.stringify(scores), "EX", SCRIPT_TTL_SECONDS);
    return new Response(null, { status: 204 });
  }
  if (method !== "POST") return new Response(null, { status: 405 });
  if (path === INTERNAL_ROUTES.dmcaTick) {
    const tick = DmcaTickBody.safeParse(body);
    if (!tick.success) return new Response(null, { status: 400 });
    const rt = await moderationRuntime(deps);
    try {
      return Response.json(await rt.queue.dmcaRestoreTick(tick.data.asOf));
    } catch (err) {
      deps.logger.warn("dmca-tick test hook failed", { err: (err as Error).name });
      return new Response(null, { status: 504 });
    }
  }
  const parsed = NciiTickBody.safeParse(body);
  if (!parsed.success) return new Response(null, { status: 400 });
  const rt = await moderationRuntime(deps);
  try {
    return Response.json(await rt.queue.nciiClock(parsed.data.asOf));
  } catch (err) {
    deps.logger.warn("ncii-tick test hook failed", { err: (err as Error).name });
    return new Response(null, { status: 504 });
  }
}
