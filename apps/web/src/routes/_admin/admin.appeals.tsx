// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { AdminPage } from "@commonair/ui/layouts";
import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { AppealQueue } from "../../components/safety/appeal-queue.tsx";
import { t } from "../../i18n/index.ts";
import { titleHead } from "../../lib/page-title.ts";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AppealsSearch = { case?: string };

/** `validateSearch`: a malformed id is dropped, never trusted. */
export function parseAppealsSearch(raw: Record<string, unknown>): AppealsSearch {
  return typeof raw.case === "string" && ID.test(raw.case) ? { case: raw.case.toLowerCase() } : {};
}

/**
 * Platform moderators and admins: the `_admin` layout's guard answered everyone else with not-found.
 * `?case=<appeal id>` opens that appeal (the audit log links here); selecting rewrites it in place.
 */
export const Route = createFileRoute("/_admin/admin/appeals")({
  head: () => titleHead(t("pageTitle.adminAppeals")),
  validateSearch: parseAppealsSearch,
  component: AppealsQueuePage,
});

function AppealsQueuePage(): React.JSX.Element {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <AdminPage width="queue">
      <PageHeader title={t("safety.appealq.title")} description={t("appeals.account.queueIntro")} />
      <AppealQueue
        openId={search.case ?? null}
        // `replace`: the URL follows the selection without a history entry per click.
        onOpenChange={(id) => void navigate({ search: id ? { case: id } : {}, replace: true })}
      />
    </AdminPage>
  );
}
