// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { toast } from "@commonair/ui/toast";
import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { CoopLoadGate } from "../../components/coop/load-error.tsx";
import { activeMemberClasses } from "../../components/coop/rules.ts";
import { coopLoads, toastCoopError, useCoopLoad, useMyMembership } from "../../components/coop/use-coop.ts";
import { JuryPage } from "../../components/jury/jury-page.tsx";
import { ineligibleReason } from "../../components/jury/model.ts";
import { isSafetyStaff } from "../../components/safety/access.ts";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";
import { titleHead } from "../../lib/page-title.ts";

/**
 * `/coop/jury`: the advisory jury (ADR 0038): opt in or out, and a seated juror's cases and votes.
 * Staff also see the cases a jury majority disagreed with.
 */
export const Route = createFileRoute("/_app/coop/jury")({
  beforeLoad: () => requireSession(() => getSessionUser()),
  head: () => titleHead(t("pageTitle.coopJury")),
  component: JuryRoute,
});

function JuryRoute(): React.JSX.Element {
  const { me } = useBootstrap();
  const staff = isSafetyStaff(me);
  const status = useCoopLoad(`jury-status|${me?.id ?? "-"}`, () => api().jury.status());
  const seated = status.data?.seat?.panelId ?? null;
  const panel = useCoopLoad(`jury-panel|${seated ?? "-"}`, () => (seated ? api().jury.panel() : Promise.resolve(null)));
  const cases = useCoopLoad(`jury-cases|${seated ?? "-"}`, () => (seated ? api().jury.cases() : Promise.resolve([])));
  const flags = useCoopLoad(`jury-flags|${staff ? "staff" : "-"}`, () =>
    staff ? api().jury.flags.list({ open: true, limit: 50 }) : Promise.resolve(null),
  );
  const membership = useMyMembership(me);
  const classes = membership.state === "loaded" ? activeMemberClasses(membership.data) : null;

  return (
    <CoopLoadGate status={coopLoads([status, panel, cases, flags])} tab="jury">
      <JuryPage
        status={status.data}
        ineligible={ineligibleReason(me, classes)}
        panel={panel.data}
        cases={seated ? cases.data : []}
        flags={staff ? (flags.data?.items ?? []) : null}
        onOptInChange={async (on) => {
          try {
            if (on) await api().jury.optIn();
            else await api().jury.optOut();
            toast.success(on ? t("jury.optin.done") : t("jury.optout.done"));
            status.reload();
          } catch (err) {
            toastCoopError(err);
          }
        }}
        onVote={async (id, vote, reasonCode) => {
          await api().jury.vote({ id, vote, reasonCode });
          toast.success(t("jury.vote.done"));
          cases.reload();
        }}
      />
    </CoopLoadGate>
  );
}
