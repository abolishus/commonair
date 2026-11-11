// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/creators` first render, server-side: the co-op facts the page quotes (from the settings and
 * the fee schedule) and one live stream for the hero. The bodies stay inside the handlers so the
 * compiler drops `server/env.ts` from the client bundle. Nothing here needs the visitor's cookie:
 * every call is public.
 */
import type { StreamCard } from "@commonair/contracts/dto";
import { createServerFn } from "@tanstack/react-start";
import { serverApi } from "../../lib/api.ts";
import { loadWebEnv } from "../../server/env.ts";
import { loaderFailed, loaderOk, type LoaderResult } from "../discovery/loaders.ts";
import { coopFacts, type CoopFacts } from "./facts.ts";

export interface CreatorsPageData {
  /** Parsed on the server: a fee schedule that did not load only drops the change count. */
  facts: CoopFacts;
  /** The busiest live stream, or null (none live, or the directory did not answer). */
  live: StreamCard | null;
}

export const getCreatorsPage = createServerFn({ method: "GET" }).handler(
  async (): Promise<LoaderResult<CreatorsPageData>> => {
    try {
      const api = serverApi(loadWebEnv().API_INTERNAL_URL);
      const [settings, feeSchedule, live] = await Promise.all([
        api.coop.settings(),
        api.coop.feeSchedule().catch(() => null),
        api.directory
          .live({ limit: 1, sort: "viewers_desc" })
          .then((page) => page.items[0] ?? null)
          .catch(() => null),
      ]);
      return loaderOk({ facts: coopFacts(settings, feeSchedule), live });
    } catch (err) {
      return loaderFailed(err);
    }
  },
);
