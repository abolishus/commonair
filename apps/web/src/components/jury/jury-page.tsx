// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmptyState, RelativeTime, Skeleton, SkeletonGroup } from "@commonair/ui";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { PageHeader, Section } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { Field, FieldDescription, FieldLabel } from "@commonair/ui/components/field";
import { Switch } from "@commonair/ui/components/switch";
import { PageContainer } from "@commonair/ui/layouts";
import { CheckListIcon, JusticeScale01Icon } from "@hugeicons/core-free-icons";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t, type MessageKey } from "../../i18n/index.ts";
import { CoopTabs } from "../coop/nav.tsx";
import { JuryCaseCard, type OnVote } from "./case-card.tsx";
import {
  flagCaseSearch,
  INELIGIBLE_KEYS,
  KIND_KEYS,
  panelClosesAt,
  type IneligibleReason,
  type JuryCaseDto,
  type JuryFlagDto,
  type JuryPanelDto,
  type JuryStatusDto,
} from "./model.ts";

const EXPLAINER: readonly MessageKey[] = [
  "jury.explainer.cases",
  "jury.explainer.blur",
  "jury.explainer.names",
  "jury.explainer.votes",
  "jury.explainer.results",
  "jury.explainer.optout",
];

/** The draw switch, with its saving state. */
function DrawSwitch({
  optedIn,
  onOptInChange,
}: {
  optedIn: boolean;
  onOptInChange: (on: boolean) => Promise<void>;
}): React.JSX.Element {
  const [busy, setBusy] = React.useState(false);
  const switchId = React.useId();
  const change = async (on: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      await onOptInChange(on);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Field orientation="horizontal">
      <Switch
        id={switchId}
        data-testid="jury-optin"
        data-state={optedIn ? "on" : "off"}
        checked={optedIn}
        disabled={busy}
        onCheckedChange={(on: boolean) => void change(on)}
      />
      <div className="flex flex-col gap-1">
        <FieldLabel htmlFor={switchId}>{t("jury.optin.label")}</FieldLabel>
        <FieldDescription>{optedIn ? t("jury.optin.on") : t("jury.optin.off")}</FieldDescription>
      </div>
    </Field>
  );
}

function OptIn({
  status,
  ineligible,
  onOptInChange,
}: {
  status: JuryStatusDto;
  ineligible: IneligibleReason;
  onOptInChange: (on: boolean) => Promise<void>;
}): React.JSX.Element {
  return (
    <Section heading={t("jury.optin.title")}>
      <div className="flex flex-col gap-4">
        {!status.eligible && (
          <AlertCallout
            data-testid="jury-ineligible"
            data-reason={ineligible}
            tone="info"
            title={t("jury.ineligible.title")}
            description={t(INELIGIBLE_KEYS[ineligible])}
            action={
              ineligible === "not_member" ? (
                <Button variant="outline" size="sm" nativeButton={false} render={<Link to="/coop/membership" />}>
                  {t("coop.tab.membership")}
                </Button>
              ) : undefined
            }
          />
        )}
        {/* Someone who opted in and has since lost eligibility can still leave the draw. */}
        {(status.eligible || status.optedIn) && <DrawSwitch optedIn={status.optedIn} onOptInChange={onOptInChange} />}
        <div data-testid="jury-optin-explainer" className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">{t("jury.explainer.title")}</h3>
          <ul className="flex max-w-prose list-disc flex-col gap-1 ps-5 text-sm text-muted-foreground">
            {EXPLAINER.map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ul>
        </div>
      </div>
    </Section>
  );
}

/** While the jury is off, someone still in its draw can leave it (opting out is always open). */
function DisabledOptOut({ onOptInChange }: { onOptInChange: (on: boolean) => Promise<void> }): React.JSX.Element {
  return (
    <Section heading={t("jury.optin.title")} description={t("jury.disabled.stillIn")}>
      <DrawSwitch optedIn onOptInChange={onOptInChange} />
    </Section>
  );
}

function Panel({
  panel,
  cases,
  onVote,
}: {
  panel: JuryPanelDto;
  cases: JuryCaseDto[] | null;
  onVote: OnVote;
}): React.JSX.Element {
  const closesAt = panelClosesAt(panel.openedAt);
  return (
    <Section
      heading={t("jury.panel.title")}
      data-testid="jury-panel"
      data-panel-id={panel.id}
      data-closes-at={closesAt}
      description={t("jury.panel.summary", { period: panel.period, seats: panel.seats })}
    >
      <div className="flex flex-col gap-4">
        <dl className="flex flex-col gap-2 text-sm sm:flex-row sm:gap-6">
          <div className="flex gap-2">
            <dt className="text-muted-foreground">{t("jury.panel.closes")}</dt>
            <dd>
              <RelativeTime date={closesAt} />
            </dd>
          </div>
          <div className="flex min-w-0 gap-2">
            <dt className="shrink-0 text-muted-foreground">{t("jury.panel.commitment")}</dt>
            <dd className="min-w-0 font-mono text-xs break-all">{panel.seedCommitment}</dd>
          </div>
        </dl>
        {cases === null ? (
          <SkeletonGroup label={t("jury.loading")}>
            <Skeleton className="h-48 w-full" />
          </SkeletonGroup>
        ) : cases.length === 0 ? (
          <EmptyState
            icon={CheckListIcon}
            headingLevel={3}
            title={t("jury.panel.empty.title")}
            description={t("jury.panel.empty.description")}
          />
        ) : (
          <div className="flex flex-col gap-4">
            {cases.map((c) => (
              <JuryCaseCard key={c.id} kase={c} onVote={onVote} />
            ))}
          </div>
        )}
      </div>
    </Section>
  );
}

/** Staff only: cases a jury majority disagreed with, for re-review through the usual queue. */
export function JuryFlags({ flags }: { flags: JuryFlagDto[] }): React.JSX.Element {
  return (
    <Section heading={t("jury.flags.title")} description={t("jury.flags.intro")}>
      {flags.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("jury.flags.empty")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {flags.map((f) => (
            <li
              key={f.id}
              data-testid="jury-flag"
              data-case-id={f.caseId}
              className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 flex-col gap-1 text-sm">
                <span>
                  {t("jury.flags.item", {
                    kind: t(KIND_KEYS[f.subjectKind]),
                    disagree: String(f.disagree),
                    votes: String(f.votes),
                  })}
                </span>
                <span className="font-mono text-xs break-all text-muted-foreground">{f.subjectId}</span>
                <RelativeTime date={f.createdAt} className="text-xs text-muted-foreground" />
              </div>
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                render={
                  <Link
                    to="/admin/moderation"
                    search={flagCaseSearch(f)}
                    data-testid="jury-flag-case-link"
                    data-case-id={f.subjectId}
                    data-kind={f.subjectKind}
                  />
                }
              >
                {t("jury.flags.open")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export interface JuryPageProps {
  /** null while loading. */
  status: JuryStatusDto | null;
  ineligible: IneligibleReason;
  panel: JuryPanelDto | null;
  cases: JuryCaseDto[] | null;
  /** Staff only (null for everyone else). */
  flags: JuryFlagDto[] | null;
  onOptInChange: (on: boolean) => Promise<void>;
  onVote: OnVote;
}

/**
 * `/coop/jury` (ADR 0038): while `jury.enabled` is false, why there is no jury; otherwise the
 * opt-in with what jurors see, and a seated juror's panel, cases and votes. Staff also see the
 * re-review flags.
 */
export function JuryPage({
  status,
  ineligible,
  panel,
  cases,
  flags,
  onOptInChange,
  onVote,
}: JuryPageProps): React.JSX.Element {
  return (
    <PageContainer data-testid="jury-page" width="default" className="flex flex-col gap-6 py-8">
      <PageHeader title={t("jury.page.title")} description={t("jury.page.intro")} tabs={<CoopTabs current="jury" />} />
      {status === null ? (
        <SkeletonGroup label={t("jury.loading")}>
          <Skeleton className="h-32 w-full" />
        </SkeletonGroup>
      ) : !status.enabled ? (
        <>
          <EmptyState
            data-testid="jury-disabled"
            icon={JusticeScale01Icon}
            title={t("jury.disabled.title")}
            description={t("jury.disabled.description")}
          />
          {status.optedIn && <DisabledOptOut onOptInChange={onOptInChange} />}
        </>
      ) : (
        <>
          <OptIn status={status} ineligible={ineligible} onOptInChange={onOptInChange} />
          {panel ? (
            <Panel panel={panel} cases={cases} onVote={onVote} />
          ) : (
            status.optedIn && <p className="text-sm text-muted-foreground">{t("jury.notSeated")}</p>
          )}
        </>
      )}
      {flags !== null && <JuryFlags flags={flags} />}
    </PageContainer>
  );
}
