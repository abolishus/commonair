// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { ProposalList } from "../../components/coop/proposals.tsx";
import { toastCoopError, useMyMembership } from "../../components/coop/use-coop.ts";
import { FormError } from "../../components/form-error.tsx";
import { usePaged } from "../../components/money/use-load.ts";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";
import { isMember, type ProposalFilter } from "../../lib/coop.ts";

/** Public: proposals by status; members get "New proposal". */
export const Route = createFileRoute("/_app/coop/proposals/")({ component: ProposalsPage });

const PAGE = 25;

function ProposalsPage(): React.JSX.Element {
  const { me } = useBootstrap();
  const membership = useMyMembership(me);
  const [filter, setFilter] = React.useState<ProposalFilter>("all");
  const proposals = usePaged(
    `proposals|${filter}`,
    (cursor) =>
      api().coop.proposals.list(filter === "all" ? { limit: PAGE, cursor } : { status: filter, limit: PAGE, cursor }),
    toastCoopError,
  );
  return (
    <>
      {proposals.failed && <FormError>{t("coop.loadFailed")}</FormError>}
      <ProposalList
        proposals={proposals.items ?? (proposals.failed ? [] : null)}
        filter={filter}
        onFilterChange={setFilter}
        member={isMember(membership.data)}
        hasMore={proposals.hasMore}
        loadingMore={proposals.loadingMore}
        onLoadMore={proposals.loadMore}
      />
    </>
  );
}
