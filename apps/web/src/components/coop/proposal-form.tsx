// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Skeleton, SkeletonGroup } from "@commonair/ui";
import { ProposalChangeEditor } from "@commonair/ui/blocks/coop";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { CharacterCountField, FormSection, SwitchField } from "@commonair/ui/blocks/forms";
import { Breadcrumbs, PageHeader, Section } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import {
  PROPOSAL_BODY_MAX,
  PROPOSAL_TITLE_MAX,
  changeKeyOptions,
  deriveKind,
  kindHint,
  kindLabel,
  proposalInput,
  rowError,
  rowErrorText,
  settingJson,
  type ChangeRow,
  type ProposalDraft,
  type SettingDto,
} from "../../lib/coop.ts";

export interface ProposalFormProps {
  mode: "new" | "edit";
  /** The setting keys to change (null while loading). */
  settings: SettingDto[] | null;
  draft: ProposalDraft;
  onDraftChange: (draft: ProposalDraft) => void;
  /** Called with the validated input; the API decides (and re-classifies). */
  onSave: (input: NonNullable<ReturnType<typeof proposalInput>>) => void | Promise<void>;
  onCancel: () => void;
  saving: boolean;
  /** A refusal to show above the actions. */
  error: string | null;
}

let rowSeq = 0;
const newRowId = () => `new-${++rowSeq}`;

/**
 * `/coop/proposals/new` and `/coop/proposals/$id/edit`: title, body, setting changes (whole JSON
 * values) and "affects creators". A protected key makes the proposal protected and forces
 * "affects creators" on, as the API does.
 */
export function ProposalForm({
  mode,
  settings,
  draft,
  onDraftChange,
  onSave,
  onCancel,
  saving,
  error,
}: ProposalFormProps): React.JSX.Element {
  const kind = settings ? deriveKind(draft.rows, settings) : "ordinary";
  const isProtected = kind === "protected";
  const input = proposalInput(draft, kind);
  const set = (patch: Partial<ProposalDraft>) => onDraftChange({ ...draft, ...patch });
  const setRows = (rows: ChangeRow[]) => set({ rows });
  const shown = draft.rows.map((row) => {
    const problem = rowError(row, draft.rows);
    // "No key yet" needs no message: the select shows its placeholder.
    return problem && problem !== "noKey" ? { ...row, error: rowErrorText(problem) } : row;
  });
  const title = mode === "new" ? t("coop.form.newTitle") : t("coop.form.editTitle");
  return (
    <PageContainer width="narrow" className="flex flex-col gap-6 py-8">
      <PageHeader
        breadcrumbs={
          <Breadcrumbs
            label={t("coop.breadcrumb")}
            items={[
              { label: t("coop.title"), render: <Link to="/coop" /> },
              { label: t("coop.proposals.title"), render: <Link to="/coop/proposals" /> },
              { label: title },
            ]}
          />
        }
        title={title}
        description={mode === "new" ? t("coop.form.newIntro") : t("coop.form.editIntro")}
      />
      {settings === null ? (
        <SkeletonGroup label={t("coop.loading")}>
          <Skeleton className="h-64 w-full" />
        </SkeletonGroup>
      ) : (
        <FormSection
          data-testid="proposal-form"
          title={t("coop.form.section")}
          onSubmit={(event) => {
            event.preventDefault();
            if (input && !saving) void onSave(input);
          }}
          actions={{
            saveLabel: mode === "new" ? t("coop.form.saveNew") : t("coop.form.saveEdit"),
            cancelLabel: t("coop.form.cancel"),
            onCancel,
            disabled: saving || input === null,
            saveProps: { "data-testid": "proposal-save" },
          }}
        >
          <CharacterCountField
            label={t("coop.form.title")}
            hint={t("coop.form.titleHint")}
            maxLength={PROPOSAL_TITLE_MAX}
            value={draft.title}
            onValueChange={(value) => set({ title: value })}
            inputProps={{ "data-testid": "proposal-title", disabled: saving }}
          />
          <CharacterCountField
            label={t("coop.form.body")}
            hint={t("coop.form.bodyHint")}
            multiline
            maxLength={PROPOSAL_BODY_MAX}
            value={draft.body}
            onValueChange={(value) => set({ body: value })}
            textareaProps={{ "data-testid": "proposal-body", rows: 8, disabled: saving }}
          />
          <SwitchField
            label={t("coop.form.affectsCreators")}
            description={isProtected ? t("coop.form.affectsCreatorsForced") : t("coop.form.affectsCreatorsHint")}
            checked={draft.affectsCreators || isProtected}
            disabled={isProtected || saving}
            onCheckedChange={(checked) => set({ affectsCreators: checked })}
            switchProps={{ "data-testid": "proposal-affects-creators" }}
          />
          <Section heading={t("coop.form.changes")} headingLevel={3}>
            <ProposalChangeEditor
              rows={shown}
              keyOptions={changeKeyOptions(settings)}
              disabled={saving}
              labels={{
                key: t("coop.form.changeKey"),
                keyPlaceholder: t("coop.form.changeKeyPlaceholder"),
                value: t("coop.form.changeValue"),
                valueHint: t("coop.form.changeValueHint"),
                protected: t("coop.form.changeProtected"),
                remove: t("coop.form.changeRemove"),
                add: t("coop.form.changeAdd"),
                empty: t("coop.form.changesEmpty"),
              }}
              kind={{
                kind,
                label: kindLabel(kind),
                description: kindHint(kind),
                props: { "data-testid": "proposal-kind" },
              }}
              rowProps={{ "data-testid": "proposal-change" }}
              keyTriggerProps={{ "data-testid": "proposal-change-key" }}
              valueProps={{ "data-testid": "proposal-change-value" }}
              removeProps={{ "data-testid": "proposal-change-remove" }}
              addProps={{ "data-testid": "proposal-change-add" }}
              onAdd={() => setRows([...draft.rows, { id: newRowId(), key: "", value: "" }])}
              onRemove={(id) => setRows(draft.rows.filter((row) => row.id !== id))}
              onRowChange={(id, patch) =>
                setRows(
                  draft.rows.map((row) => {
                    if (row.id !== id) return row;
                    const next = { ...row, ...patch };
                    // A new key starts from its whole current value: a change replaces the setting.
                    if (patch.key !== undefined && patch.key !== row.key && (row.value.trim() === "" || row.key !== ""))
                      next.value = settingJson(settings, patch.key);
                    return next;
                  }),
                )
              }
            />
          </Section>
          {isProtected && (
            <AlertCallout
              tone="warning"
              title={t("coop.form.protectedTitle")}
              description={t("coop.form.protectedHint")}
            />
          )}
          {error && <AlertCallout tone="danger" description={error} />}
        </FormSection>
      )}
    </PageContainer>
  );
}

/** An empty draft for `/coop/proposals/new`. */
export function emptyDraft(): ProposalDraft {
  return { title: "", body: "", affectsCreators: false, rows: [] };
}
