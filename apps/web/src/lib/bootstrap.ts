// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { getRouteApi } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { loadBootstrap, lookupSession } from "../server/bootstrap.ts";
import type { Bootstrap, SessionLookup, SessionUser } from "./bootstrap-types.ts";
import { noteSession, sessionUserOf } from "./session.ts";
import { type BootstrapView, type SessionRetry, useBootstrapView, useSessionRetryWith } from "./session-view.ts";

/** Runs on the web server (SSR or as an RPC from the browser) so it can read env and cookies. */
export const getBootstrap = createServerFn({ method: "GET" }).handler((): Promise<Bootstrap> =>
  loadBootstrap(getRequestHeader("cookie")),
);

/** The session as a value: a server function's result crosses to the browser intact, an error would not. */
const getSessionLookup = createServerFn({ method: "GET" }).handler((): Promise<SessionLookup> =>
  lookupSession(getRequestHeader("cookie")),
);

/**
 * Just the session, for route guards (`beforeLoad`): the user, or null when signed out. Throws
 * `SessionUnavailableError` when the API could not say (F1), so the route shows its error page
 * with Retry instead of redirecting a signed-in member to /signin.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const lookup = await getSessionLookup();
  noteSession(lookup);
  return sessionUserOf(lookup);
}

const rootApi = getRouteApi("__root__");

export type { BootstrapView, SessionRetry } from "./session-view.ts";

/**
 * The root loader's data. When the document could not check the session, a later lookup that
 * answers (a guard's, or the automatic retry started here, one at a time) fills `me` in, and
 * `sessionUnresolved` says so meanwhile, so a member is never shown as signed out because the API
 * was busy (F1).
 */
export function useBootstrap(): BootstrapView {
  return useBootstrapView(rootApi.useLoaderData(), getSessionUser);
}

/** For the shell's account placeholder while the session is unresolved (F1): Retry, and how it stands. */
export function useSessionRetry(): SessionRetry {
  return useSessionRetryWith(useBootstrap().sessionUnresolved, getSessionUser);
}
