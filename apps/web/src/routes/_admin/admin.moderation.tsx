// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { AdminPage } from "@commonair/ui/layouts";
import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { isPlatformModerator } from "../../components/safety/access.ts";
import { locationOf, ModQueue, moderationSearch, parseModerationSearch } from "../../components/safety/mod-queue.tsx";
import { t } from "../../i18n/index.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";
import { titleHead } from "../../lib/page-title.ts";

/**
 * Moderators, admins and `legal`: the `_admin` layout's guard answered everyone else with not-found.
 * `?tab=<tab>&case=<id>` opens a tab and a case (or report) directly, as a jury flag links here
 * (docs/testing/b8-selectors.md); selecting rewrites them in place. `?assignee=me|unassigned`
 * (overhaul wave 4, D7.5) filters the cases and labels tabs by claim.
 */
export const Route = createFileRoute("/_admin/admin/moderation")({
  head: () => titleHead(t("safety.modq.title")),
  validateSearch: parseModerationSearch,
  component: ModerationPage,
});

function ModerationPage(): React.JSX.Element {
  const { me } = useBootstrap();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <AdminPage width="queue">
      <PageHeader title={t("safety.modq.title")} description={t("safety.modq.intro")} />
      <ModQueue
        canReports={isPlatformModerator(me)}
        me={me}
        location={locationOf(search)}
        // `replace`: the URL follows the selection without a history entry per click.
        onLocationChange={(next) => void navigate({ search: moderationSearch(next), replace: true })}
      />
    </AdminPage>
  );
}
