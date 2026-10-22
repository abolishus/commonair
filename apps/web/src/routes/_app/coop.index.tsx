// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { CoopOverview } from "../../components/coop/overview.tsx";
import { useMyMembership } from "../../components/coop/use-coop.ts";
import { useLoad } from "../../components/money/use-load.ts";
import { api } from "../../lib/api.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";

/** Public: the co-op overview (your membership card when signed in). */
export const Route = createFileRoute("/_app/coop/")({ component: CoopPage });

const OPEN_LIMIT = 20;

function CoopPage(): React.JSX.Element {
  const { me } = useBootstrap();
  const membership = useMyMembership(me);
  const open = useLoad("open", async () => {
    const pages = await Promise.all(
      (["voting", "council_review", "discussion"] as const).map((status) =>
        api().coop.proposals.list({ status, limit: OPEN_LIMIT }),
      ),
    );
    return pages.flatMap((page) => page.items);
  });
  const council = useLoad("council", () => api().coop.council());
  const months = useLoad("months", () => api().coop.transparency({ months: 3 }));
  return (
    <CoopOverview
      signedIn={me !== null}
      membership={membership.data}
      openProposals={open.data ?? (open.failed ? [] : null)}
      council={council.data}
      months={months.data ?? (months.failed ? [] : null)}
    />
  );
}
