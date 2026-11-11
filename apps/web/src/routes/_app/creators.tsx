// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { CreatorsPage } from "../../components/creators/creators-page.tsx";
import { instanceHost } from "../../components/creators/host.ts";
import { getCreatorsPage } from "../../components/creators/loaders.ts";
import { t } from "../../i18n/index.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";
import { titleHead } from "../../lib/page-title.ts";
import { siteFromMatches } from "../../lib/seo.ts";

/** Public (overhaul D2.4): stream here, with the sourced fee calculator. `creators` is a reserved username (F10). */
export const Route = createFileRoute("/_app/creators")({
  loader: () => getCreatorsPage(),
  head: ({ matches }) => titleHead(t("d2Pages.creators.pageTitle", { site: siteFromMatches(matches).name })),
  // The co-op settings change only by vote; one visit's answer is fresh enough for the next.
  staleTime: 60_000,
  component: Creators,
});

function Creators(): React.JSX.Element {
  const result = Route.useLoaderData();
  const { instance, config } = useBootstrap();
  const data = result.status === "ok" ? result.data : null;
  return (
    <CreatorsPage
      facts={data?.facts ?? null}
      live={data?.live ?? null}
      site={instance.name}
      host={instanceHost(config.publicUrl)}
      twitchImport={instance.twitchImport === true}
    />
  );
}
