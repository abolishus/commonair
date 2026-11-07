// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { getRouteApi } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import * as React from "react";
import { loadBootstrap, lookupSession } from "../server/bootstrap.ts";
import type { Bootstrap, SessionLookup, SessionUser } from "./bootstrap-types.ts";
import {
  latestSession,
  noteSession,
  recoverSession,
  serverSession,
  sessionUserOf,
  subscribeSession,
  withLatestSession,
} from "./session.ts";

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

/**
 * The root loader's data. When the document could not check the session, a later lookup that
 * answers (a guard's, or the automatic retry started here, one at a time) fills `me` in, so a
 * member is never shown as signed out because the API was busy.
 */
export function useBootstrap(): Bootstrap {
  const boot = rootApi.useLoaderData();
  const latest = React.useSyncExternalStore(subscribeSession, latestSession, serverSession);
  const unavailable = boot.sessionUnavailable === true;
  React.useEffect(() => {
    if (unavailable) void recoverSession(() => getSessionUser());
  }, [unavailable]);
  return React.useMemo(() => withLatestSession(boot, latest), [boot, latest]);
}
