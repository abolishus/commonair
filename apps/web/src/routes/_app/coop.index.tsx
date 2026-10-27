// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { CoopLoadError, CoopLoadGate } from "../../components/coop/load-error.tsx";
import { CoopOverview } from "../../components/coop/overview.tsx";
import { coopLoads, useCoopLoad, useMyMembership } from "../../components/coop/use-coop.ts";
import { api } from "../../lib/api.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";

/** Public: the co-op overview (your membership card when signed in). */
export const Route = createFileRoute("/_app/coop/")({ component: CoopPage });

const OPEN_LIMIT = 20;

function CoopPage(): React.JSX.Element {
  const { me } = useBootstrap();
  const membership = useMyMembership(me);
  const open = useCoopLoad("open", async () => {
    const pages = await Promise.all(
      (["voting", "council_review", "discussion"] as const).map((status) =>
        api().coop.proposals.list({ status, limit: OPEN_LIMIT }),
      ),
    );
    return pages.flatMap((page) => page.items);
  });
  const council = useCoopLoad("council", () => api().coop.council());
  const months = useCoopLoad("months", () => api().coop.transparency({ months: 3 }));
  return (
    // The caller's membership only feeds the card: its failure shows there, not over the public page.
    <CoopLoadGate status={coopLoads([open, council, months])} tab="overview">
      <CoopOverview
        signedIn={me !== null}
        membership={membership.data}
        openProposals={open.data}
        council={council.data}
        months={months.data}
        membershipError={membership.failed ? <CoopLoadError onRetry={membership.reload} /> : null}
      />
    </CoopLoadGate>
  );
}
