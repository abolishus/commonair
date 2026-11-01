// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Twitch OAuth redirect for the import (`TWITCH_IMPORT_CALLBACK_PATH`, ADR 0031, decision (b)).
 * `http.ts` answers 404 itself unless the import is available (`TWITCH_IMPORT_ENABLED` and both
 * `OAUTH_TWITCH_*` credentials), so this module is reached only then. The request keeps its
 * first-party cookies: the `state` is bound to the session.
 *
 * Contract-step stub: N3-import fills it (validate `state`, exchange the code, read the public
 * data into `portability_imports`, revoke the token, redirect to the studio). Until then it
 * answers 501.
 */
import type { BaseContext } from "../lib/orpc.ts";

export async function twitchImportCallback(_ctx: BaseContext, _req: Request, _url: URL): Promise<Response> {
  return Response.json(
    { code: "NOT_IMPLEMENTED", message: "Not implemented yet" },
    { status: 501, headers: { "cache-control": "no-store" } },
  );
}
