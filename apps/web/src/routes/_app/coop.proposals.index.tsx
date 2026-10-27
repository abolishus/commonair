// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { CoopLoadGate } from "../../components/coop/load-error.tsx";
import { ProposalList } from "../../components/coop/proposals.tsx";
import { coopLoads, pagedLoad, toastCoopError, useMyMembership } from "../../components/coop/use-coop.ts";
import { usePaged } from "../../components/money/use-load.ts";
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
    <CoopLoadGate status={coopLoads([pagedLoad(proposals), membership])} tab="proposals">
      <ProposalList
        proposals={proposals.items}
        filter={filter}
        onFilterChange={setFilter}
        member={isMember(membership.data)}
        hasMore={proposals.hasMore}
        loadingMore={proposals.loadingMore}
        onLoadMore={proposals.loadMore}
      />
    </CoopLoadGate>
  );
}
