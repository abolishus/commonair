// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Twitch OAuth redirect for the import (`TWITCH_IMPORT_CALLBACK_PATH`, ADR 0031, decision (b)).
 * `http.ts` answers 404 itself unless the import is available (`TWITCH_IMPORT_ENABLED` and both
 * `OAUTH_TWITCH_*` credentials), so this module is reached only then. The request keeps its
 * first-party cookies: the `state` is bound to the session.
 *
 * It does the authorization (`completeAuthorization`: state, code, account, read, store, revoke)
 * and answers a 303 to the studio's import page with an opaque outcome
 * (`/import?twitch=connected|denied|invalid|mismatch|failed`). It never echoes the code, the state
 * or anything Twitch answered.
 */
import { resolveSession } from "../lib/caller.ts";
import type { BaseContext } from "../lib/orpc.ts";
import { type CallbackOutcome, completeAuthorization } from "./service.ts";

export const IMPORT_PAGE_PATH = "/import";

export async function twitchImportCallback(ctx: BaseContext, _req: Request, url: URL): Promise<Response> {
  const { deps, auth, req } = ctx;
  let outcome: CallbackOutcome;
  try {
    const caller = await resolveSession(deps, auth, req.headers);
    const session = caller?.kind === "session" ? { id: caller.sessionId, userId: caller.user.id } : null;
    outcome = await completeAuthorization(deps, {
      state: url.searchParams.get("state"),
      code: url.searchParams.get("code"),
      error: url.searchParams.get("error"),
      session,
    });
  } catch (err) {
    deps.logger.error("twitch import callback failed", { err: (err as Error).name });
    outcome = "failed";
  }
  const to = new URL(IMPORT_PAGE_PATH, `${deps.site.publicUrl}/`);
  to.searchParams.set("twitch", outcome);
  return new Response(null, {
    status: 303,
    headers: { location: to.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}
