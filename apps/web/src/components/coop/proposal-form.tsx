// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Skeleton, SkeletonGroup } from "@commonair/ui";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { CharacterCountField, FormSection, SwitchField } from "@commonair/ui/blocks/forms";
import { Breadcrumbs, PageHeader, Section } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import {
  PROPOSAL_BODY_MAX,
  PROPOSAL_TITLE_MAX,
  PROPOSAL_TITLE_MIN,
  deriveKind,
  proposalInput,
  type ProposalDraft,
  type SettingDto,
} from "../../lib/coop.ts";
import { ChangeEditor, typedProblems } from "../governance/change-editor.tsx";

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

/**
 * `/coop/proposals/new` and `/coop/proposals/$id/edit`: title, body, setting changes (typed fields
 * per known setting, JSON as the advanced fallback) and "affects creators". A protected key makes
 * the proposal protected and forces "affects creators" on, as the API does. Problems show once a
 * field is left or saving is tried; a save with problems shows them all and saves nothing.
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
  // Typed fields whose text does not parse (an amount keeps its last good value in the draft).
  const [unparsed, setUnparsed] = React.useState<ReadonlySet<string>>(() => new Set());
  const onFieldValidity = React.useCallback((field: string, valid: boolean) => {
    setUnparsed((s) => {
      if (valid !== s.has(field)) return s;
      const next = new Set(s);
      if (valid) next.delete(field);
      else next.add(field);
      return next;
    });
  }, []);
  const input = unparsed.size > 0 || typedProblems(draft.rows).size > 0 ? null : proposalInput(draft, kind);
  const set = (patch: Partial<ProposalDraft>) => onDraftChange({ ...draft, ...patch });
  const [submitted, setSubmitted] = React.useState(false);
  const [titleTouched, setTitleTouched] = React.useState(false);
  const [bodyTouched, setBodyTouched] = React.useState(false);
  const formRef = React.useRef<HTMLDivElement>(null);
  const titleLength = draft.title.trim().length;
  const titleError =
    (submitted || titleTouched) && (titleLength < PROPOSAL_TITLE_MIN || titleLength > PROPOSAL_TITLE_MAX)
      ? t("d6Governance.form.error.title", { min: PROPOSAL_TITLE_MIN, max: PROPOSAL_TITLE_MAX })
      : undefined;
  const bodyError =
    (submitted || bodyTouched) && draft.body.trim().length === 0 ? t("d6Governance.form.error.body") : undefined;
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
        <div ref={formRef} className="contents">
          <FormSection
            data-testid="proposal-form"
            title={t("coop.form.section")}
            onSubmit={(event) => {
              event.preventDefault();
              if (saving) return;
              if (input) {
                void onSave(input);
                return;
              }
              // Show every problem and take the member to the first one.
              setSubmitted(true);
              requestAnimationFrame(() =>
                formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
              );
            }}
            actions={{
              saveLabel: mode === "new" ? t("coop.form.saveNew") : t("coop.form.saveEdit"),
              cancelLabel: t("coop.form.cancel"),
              onCancel,
              disabled: saving,
              saveProps: { "data-testid": "proposal-save", "data-valid": String(input !== null) },
            }}
          >
            <CharacterCountField
              label={t("coop.form.title")}
              hint={t("coop.form.titleHint")}
              maxLength={PROPOSAL_TITLE_MAX}
              value={draft.title}
              onValueChange={(value) => set({ title: value })}
              errors={titleError}
              inputProps={{ "data-testid": "proposal-title", disabled: saving, onBlur: () => setTitleTouched(true) }}
            />
            <CharacterCountField
              label={t("coop.form.body")}
              hint={t("coop.form.bodyHint")}
              multiline
              maxLength={PROPOSAL_BODY_MAX}
              value={draft.body}
              onValueChange={(value) => set({ body: value })}
              errors={bodyError}
              textareaProps={{
                "data-testid": "proposal-body",
                rows: 8,
                disabled: saving,
                onBlur: () => setBodyTouched(true),
              }}
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
              <ChangeEditor
                rows={draft.rows}
                settings={settings}
                kind={kind}
                disabled={saving}
                submitted={submitted}
                onFieldValidity={onFieldValidity}
                onRowsChange={(rows) => set({ rows })}
              />
            </Section>
            {isProtected && (
              <AlertCallout
                tone="warning"
                title={t("coop.form.protectedTitle")}
                description={t("coop.form.protectedHint")}
              />
            )}
            {submitted && input === null ? (
              <AlertCallout
                data-testid="proposal-form-problems"
                tone="danger"
                description={t("d6Governance.form.fixProblems")}
              />
            ) : null}
            {error && <AlertCallout tone="danger" description={error} />}
          </FormSection>
        </div>
      )}
    </PageContainer>
  );
}

/** An empty draft for `/coop/proposals/new`. */
export function emptyDraft(): ProposalDraft {
  return { title: "", body: "", affectsCreators: false, rows: [] };
}
