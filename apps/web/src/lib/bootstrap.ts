// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { getRouteApi } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { loadBootstrap } from "../server/bootstrap.ts";
import type { Bootstrap } from "./bootstrap-types.ts";

/** Runs on the web server (SSR or as an RPC from the browser) so it can read env and cookies. */
export const getBootstrap = createServerFn({ method: "GET" }).handler((): Promise<Bootstrap> =>
  loadBootstrap(getRequestHeader("cookie")),
);

const rootApi = getRouteApi("__root__");

export function useBootstrap(): Bootstrap {
  return rootApi.useLoaderData();
}
