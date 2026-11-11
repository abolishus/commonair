// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { CoopLoadGate } from "../../components/coop/load-error.tsx";
import { PatronageExplainer, patronageStanding, patronageWeights } from "../../components/coop/patronage-explainer.tsx";
import { StatementsPage } from "../../components/coop/statements.tsx";
import { coopLoads, useCoopLoad } from "../../components/coop/use-coop.ts";
import { api } from "../../lib/api.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import type { SessionUser } from "../../lib/bootstrap-types.ts";
import { t } from "../../i18n/index.ts";
import { titleHead } from "../../lib/page-title.ts";

/** How many months of books the explainer sums for "where it stands". */
const STANDING_MONTHS = 12;

/**
 * Signed in: your patronage statements. Signed out: a public explainer (overhaul D2.5) instead of
 * a redirect to sign-in.
 */
export const Route = createFileRoute("/_app/coop/patronage/")({
  head: () => titleHead(t("pageTitle.coopPatronage")),
  // Resolves the session before the first render; when the API can't say (F1) this throws and the
  // route shows its error page with Retry rather than the explainer to a member.
  beforeLoad: async () => ({ me: await getSessionUser() }),
  component: PatronageRoute,
});

function PatronageRoute(): React.JSX.Element {
  const { me } = useBootstrap();
  return me ? <MemberPatronage me={me} /> : <PublicPatronage />;
}

function MemberPatronage({ me }: { me: SessionUser }): React.JSX.Element {
  const statements = useCoopLoad(`statements|${me.id}`, () => api().coop.patronage.statements());
  return (
    <CoopLoadGate status={coopLoads([statements])} tab="patronage">
      <StatementsPage statements={statements.data} />
    </CoopLoadGate>
  );
}

function PublicPatronage(): React.JSX.Element {
  // Both are optional detail: a failed load drops its section, the explanation stays.
  const settings = useCoopLoad("settings", () => api().coop.settings());
  const months = useCoopLoad(`months|${STANDING_MONTHS}`, () => api().coop.transparency({ months: STANDING_MONTHS }));
  return <PatronageExplainer weights={patronageWeights(settings.data)} standing={patronageStanding(months.data)} />;
}
