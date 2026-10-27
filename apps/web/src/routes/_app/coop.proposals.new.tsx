// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Navigate, createFileRoute, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { NotMemberState } from "../../components/coop/not-member.tsx";
import { ProposalForm, emptyDraft } from "../../components/coop/proposal-form.tsx";
import { CoopLoadGate } from "../../components/coop/load-error.tsx";
import { coopLoads, useCoopLoad, useMyMembership } from "../../components/coop/use-coop.ts";
import { isSessionExpired, toastActionError } from "../../lib/action-error.ts";
import { api } from "../../lib/api.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { isMember, proposalSaveError, type ProposalDraft } from "../../lib/coop.ts";
import { requireSession } from "../../lib/guard.ts";
import { t } from "../../i18n/index.ts";

/** Members: draft a proposal (private until opened for discussion). */
export const Route = createFileRoute("/_app/coop/proposals/new")({
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: NewProposalPage,
});

function NewProposalPage(): React.JSX.Element {
  const { me } = useBootstrap();
  const navigate = useNavigate();
  const membership = useMyMembership(me);
  const settings = useCoopLoad("settings", () => api().coop.settings());
  const [draft, setDraft] = React.useState<ProposalDraft>(emptyDraft);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  if (!me) return <Navigate to="/signin" replace />;
  // The API decides membership too; this only spares a non-member the form.
  if (membership.data && !isMember(membership.data)) return <NotMemberState />;
  return (
    <CoopLoadGate status={coopLoads([membership, settings])} tab="proposals">
      <ProposalForm
        mode="new"
        settings={settings.data}
        draft={draft}
        onDraftChange={setDraft}
        saving={saving}
        error={error}
        onCancel={() => void navigate({ to: "/coop/proposals" })}
        onSave={async (input) => {
          setSaving(true);
          setError(null);
          try {
            const created = await api().coop.proposals.create(input);
            await navigate({ to: "/coop/proposals/$id", params: { id: created.id } });
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
