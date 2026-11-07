// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { CoopSectionError } from "../../components/coop/load-error.tsx";
import { CoopOverview } from "../../components/coop/overview.tsx";
import { useCoopLoad, useMyMembership, type CoopRetryable } from "../../components/coop/use-coop.ts";
import { api } from "../../lib/api.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";
import { t } from "../../i18n/index.ts";
import { titleHead } from "../../lib/page-title.ts";

/** Public: the co-op overview (your membership card when signed in). */
export const Route = createFileRoute("/_app/coop/")({
  head: () => titleHead(t("pageTitle.coop")),
  component: CoopPage,
});

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
  // F3: each section fails on its own; the header, intro and every loaded section stay.
  const alone = [open, council, months].every((l) => l.state === "failed");
  const error = (load: CoopRetryable, section: string) =>
    load.state === "failed" ? <CoopSectionError section={section} load={load} alone={alone} /> : null;
  return (
    <CoopOverview
      signedIn={me !== null}
      membership={membership.data}
      openProposals={open.data}
      council={council.data}
      months={months.data}
      membershipError={
        // The card has no heading of its own on the page, so the error is a section heading.
        membership.failed ? (
          <CoopSectionError section={t("coop.card.title")} load={membership} headingLevel={2} />
        ) : null
      }
      sectionErrors={{
        open: error(open, t("coop.open.title")),
        decisions: error(months, t("coop.decisions.title")),
        council: error(council, t("coop.council.title")),
        byClass: error(months, t("coop.byClass.title")),
      }}
    />
  );
}
