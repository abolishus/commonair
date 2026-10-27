// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Navigate, createFileRoute, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { CoopLoadGate } from "../../components/coop/load-error.tsx";
import { ProposalForm } from "../../components/coop/proposal-form.tsx";
import { coopLoads, isNotFound, useCoopLoad } from "../../components/coop/use-coop.ts";
import { NotFoundState } from "../../components/money/not-found.tsx";
import { t } from "../../i18n/index.ts";
import { isSessionExpired, toastActionError } from "../../lib/action-error.ts";
import { api } from "../../lib/api.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { draftFromProposal, editableBy, proposalSaveError, type ProposalDraft } from "../../lib/coop.ts";
import { requireSession } from "../../lib/guard.ts";

/** The author, while `draft` or `discussion`: edit the proposal (an edit in discussion restarts it). */
export const Route = createFileRoute("/_app/coop/proposals/$id/edit")({
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: EditProposalPage,
});

function EditProposalPage(): React.JSX.Element {
  const { id } = Route.useParams();
  const { me } = useBootstrap();
  const navigate = useNavigate();
  const proposal = useCoopLoad(id, () => api().coop.proposals.get({ id }));
  const settings = useCoopLoad("settings", () => api().coop.settings());
  const [draft, setDraft] = React.useState<ProposalDraft | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  if (!me) return <Navigate to="/signin" replace />;
  if (isNotFound(proposal)) return <NotFoundState />;
  const p = proposal.data;
  // Anyone but the author (or a proposal past discussion) gets the not-found page.
  if (p && !editableBy(p, me.id)) return <NotFoundState />;
  const current = draft ?? (p ? draftFromProposal(p) : null);
  return (
    <CoopLoadGate status={coopLoads([proposal, settings])} tab="proposals">
      <ProposalForm
        mode="edit"
        settings={current ? settings.data : null}
        draft={current ?? { title: "", body: "", affectsCreators: false, rows: [] }}
        onDraftChange={setDraft}
        saving={saving}
        error={error}
        onCancel={() => void navigate({ to: "/coop/proposals/$id", params: { id } })}
        onSave={async (input) => {
          setSaving(true);
          setError(null);
          try {
            await api().coop.proposals.update({ id, ...input });
            await navigate({ to: "/coop/proposals/$id", params: { id } });
          } catch (err) {
            if (isSessionExpired(err)) toastActionError(err, t("coop.form.failed"));
            else setError(proposalSaveError(err));
          } finally {
            setSaving(false);
          }
        }}
      />
    </CoopLoadGate>
  );
}
