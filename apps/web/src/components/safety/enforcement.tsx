// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Statements of reasons on `/settings/appeals` (ADR 0019 decision 7, docs/testing/w0-selectors.md
 * "Test ids"): every restriction of the viewer's content or account, why, and the appeal it
 * allows. The clause title and explanation come from the API (the operator's notice text); the
 * page renders them as text. Readable while suspended (the list is a GET; filing the appeal is the
 * one write a suspended account may make).
 */
import type * as D from "@commonair/contracts/dto";
import { EmptyState, RelativeTime, SkeletonGroup, SkeletonText, StatusBadge } from "@commonair/ui";
import { Section } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { Dialog, DialogContent } from "@commonair/ui/components/dialog";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@commonair/ui/components/item";
import { Textarea } from "@commonair/ui/components/textarea";
import { LegalDocument01Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { FormError } from "../form-error.tsx";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { APPEAL_BODY_MAX, APPEAL_BODY_MIN, AppealBodyForm } from "./appeals.tsx";
import type { AppealDto } from "./client.ts";

/** One item of `me.enforcement.list`. */
export type EnforcementStatementDto = D.EnforcementStatement & {
  clauseTitle: string;
  explanation: string;
  noticeIsDraft: boolean;
  moderatorNote: string | null;
  appealId: string | null;
  reversedAt: string | null;
};
export type StatementAppeal = NonNullable<D.EnforcementStatement["appeal"]>;

export interface EnforcementPage {
  items: EnforcementStatementDto[];
  nextCursor: string | null;
}

export interface EnforcementClient {
  list(cursor?: string): Promise<EnforcementPage>;
  appeal(subject: StatementAppeal, body: string): Promise<AppealDto>;
}

export const PAGE_SIZE = 20;

export const enforcementClient = (): EnforcementClient => ({
  list: (cursor) => api().me.enforcement.list({ limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) }),
  appeal: (a, body) => api().appeals.create({ kind: a.kind, subjectType: a.subjectType, subjectId: a.subjectId, body }),
});

/** The restriction in plain words (Art. 17(3)(a)). */
export function restrictionLabel(r: EnforcementStatementDto["restriction"]): string {
  switch (r.detail) {
    case "removed":
      return t("safety.enforcement.restriction.removed");
    case "disabled":
      return t("safety.enforcement.restriction.disabled");
    case "restricted":
      return t("safety.enforcement.restriction.restricted");
    case "age_gated":
      return t("safety.enforcement.restriction.ageGated");
    case "suspended":
      return r.kind === "service"
        ? t("safety.enforcement.restriction.channelSuspended")
        : t("safety.enforcement.restriction.accountSuspended");
    case "none":
      return t("safety.enforcement.restriction.warning");
  }
}

/** Art. 17(3)(c), in one sentence. */
export function automationLabel(s: Pick<EnforcementStatementDto, "automatedDecision" | "automatedDetection">): string {
  if (s.automatedDecision === "fully") return t("safety.enforcement.automation.fully");
  if (s.automatedDecision === "partially") return t("safety.enforcement.automation.partially");
  return s.automatedDetection ? t("safety.enforcement.automation.notDetected") : t("safety.enforcement.automation.not");
}

/** The "Appeal" control shows only when an internal appeal applies and none was filed yet. */
export const mayAppealStatement = (s: EnforcementStatementDto): boolean =>
  s.appeal !== null && s.appealId === null && s.reversedAt === null;

function Fact({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
      <dt className="shrink-0 text-muted-foreground sm:w-40">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

export function EnforcementStatementItem({
  statement: s,
  onAppeal,
}: {
  statement: EnforcementStatementDto;
  onAppeal: () => void;
}): React.JSX.Element {
  const reversed = s.reversedAt !== null;
  const headingId = React.useId();
  return (
    <Item
      data-testid="enforcement-statement"
      data-statement-id={s.id}
      data-source-action={s.sourceAction}
      data-restriction-kind={s.restriction.kind}
      data-restriction-detail={s.restriction.detail}
      data-clause-id={s.ground.clauseId}
      data-clause-version={String(s.ground.clauseVersion)}
      data-automated-decision={s.automatedDecision}
      data-reversed={reversed ? "true" : "false"}
      aria-labelledby={headingId}
      render={<article />}
      variant="outline"
      className="flex-col items-stretch gap-3 sm:flex-row sm:items-start"
    >
      <ItemContent className="min-w-0 gap-2">
        <ItemTitle id={headingId}>{restrictionLabel(s.restriction)}</ItemTitle>
        <ItemDescription>
          {t("safety.enforcement.applied")} <RelativeTime date={s.createdAt} />
        </ItemDescription>
        {s.noticeIsDraft && (
          <p data-testid="enforcement-draft-notice" className="text-xs text-muted-foreground">
            {t("safety.enforcement.draft")}
          </p>
        )}
        <dl className="flex flex-col gap-1.5 text-sm">
          <Fact
            label={s.ground.kind === "illegal" ? t("safety.enforcement.ruleIllegal") : t("safety.enforcement.rule")}
          >
            <span className="font-medium">{s.clauseTitle}</span>
            {s.explanation && (
              <span className="mt-1 block whitespace-pre-line text-muted-foreground">{s.explanation}</span>
            )}
          </Fact>
          {s.restriction.kind !== "warning" && (
            <Fact label={t("safety.enforcement.duration")}>
              {s.restriction.endsAt ? (
                <>
                  {t("safety.enforcement.until")} <RelativeTime date={s.restriction.endsAt} />
                </>
              ) : (
                t("safety.enforcement.indefinite")
              )}
              <span className="block text-muted-foreground">{t("safety.enforcement.everywhere")}</span>
            </Fact>
          )}
          <Fact label={t("safety.enforcement.automation")}>
            {automationLabel(s)}{" "}
            {s.source === "notice_art16" ? t("safety.enforcement.source.notice") : t("safety.enforcement.source.own")}
          </Fact>
          {s.moderatorNote && (
            <Fact label={t("safety.enforcement.moderatorNote")}>
              <span className="whitespace-pre-line">{s.moderatorNote}</span>
            </Fact>
          )}
        </dl>
        {s.appeal === null && <p className="text-xs text-muted-foreground">{t("safety.enforcement.noAppeal")}</p>}
      </ItemContent>
      <ItemActions className="flex-row flex-wrap items-center gap-2 sm:flex-col sm:items-end">
        {reversed && <StatusBadge tone="success">{t("safety.enforcement.reversed")}</StatusBadge>}
        {!reversed && s.appealId !== null && (
          <StatusBadge tone="info">{t("safety.enforcement.appealFiled")}</StatusBadge>
        )}
        {/* Only an appealable statement without an appeal carries the control (w0-selectors). */}
        {mayAppealStatement(s) && (
          <Button data-testid="enforcement-appeal-open" variant="outline" size="sm" onClick={onAppeal}>
            {t("safety.enforcement.appeal")}
          </Button>
        )}
      </ItemActions>
    </Item>
  );
}

/** `enforcement-appeal-dialog`: the shared appeal form, its subject prefilled from the statement. */
export function EnforcementAppealForm({ onSubmit }: { onSubmit: (body: string) => Promise<void> }): React.JSX.Element {
  return (
    <AppealBodyForm
      renderBody={(p) => <Textarea data-testid="enforcement-appeal-body" {...p} />}
      renderSubmit={(p) => <Button data-testid="enforcement-appeal-submit" {...p} />}
      onSubmit={onSubmit}
      text={{
        title: t("safety.enforcement.appealTitle"),
        description: t("safety.enforcement.appealDescription"),
        body: t("safety.enforcement.appealBody"),
        hint: t("safety.enforcement.appealBodyHint", { min: APPEAL_BODY_MIN, max: APPEAL_BODY_MAX }),
        submit: t("safety.enforcement.appealSubmit"),
        done: t("safety.enforcement.appealDone"),
        failed: t("safety.enforcement.appealFailed"),
      }}
    />
  );
}

export interface EnforcementListProps {
  /** `null` while loading. */
  statements: readonly EnforcementStatementDto[] | null;
  onAppeal: (statement: EnforcementStatementDto, body: string) => Promise<void>;
  /** Shown when there is an older page. */
  onMore?: (() => void) | undefined;
}

/** `enforcement-list`: the statements, or `enforcement-empty`. */
export function EnforcementList({ statements, onAppeal, onMore }: EnforcementListProps): React.JSX.Element {
  const [appealing, setAppealing] = React.useState<EnforcementStatementDto | null>(null);
  let content: React.ReactNode;
  if (statements === null)
    content = (
      <SkeletonGroup label={t("safety.enforcement.loading")}>
        <SkeletonText lines={3} />
      </SkeletonGroup>
    );
  else if (statements.length === 0)
    content = (
      <EmptyState
        data-testid="enforcement-empty"
        icon={LegalDocument01Icon}
        title={t("safety.enforcement.empty")}
        description={t("safety.enforcement.emptyHint")}
        headingLevel={3}
      />
    );
  else
    content = (
      <ItemGroup className="gap-3">
        {statements.map((s) => (
          <EnforcementStatementItem key={s.id} statement={s} onAppeal={() => setAppealing(s)} />
        ))}
      </ItemGroup>
    );
  return (
    <Section heading={t("safety.enforcement.title")} description={t("safety.enforcement.intro")}>
      <div data-testid="enforcement-list" className="flex flex-col gap-3">
        {content}
        {onMore && (
          <Button variant="ghost" size="sm" className="self-start" onClick={onMore}>
            {t("safety.enforcement.more")}
          </Button>
        )}
      </div>
      <Dialog open={appealing !== null} onOpenChange={(open) => !open && setAppealing(null)}>
        {appealing && (
          <DialogContent
            data-testid="enforcement-appeal-dialog"
            data-statement-id={appealing.id}
            data-subject-type={appealing.appeal?.subjectType}
            data-subject-id={appealing.appeal?.subjectId}
            className="sm:max-w-lg"
          >
            <EnforcementAppealForm
              onSubmit={async (body) => {
                await onAppeal(appealing, body);
                setAppealing(null);
              }}
            />
          </DialogContent>
        )}
      </Dialog>
    </Section>
  );
}

/** Loads the statements page by page; a filed appeal marks its statement (and any on the same subject). */
export function useEnforcement(client: EnforcementClient): {
  statements: EnforcementStatementDto[] | null;
  failed: boolean;
  more: (() => void) | undefined;
  appeal: (s: EnforcementStatementDto, body: string) => Promise<void>;
} {
  const [statements, setStatements] = React.useState<EnforcementStatementDto[] | null>(null);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);
  const clientRef = React.useRef(client);
  const load = React.useCallback((after?: string) => {
    clientRef.current
      .list(after)
      .then((page) => {
        setStatements((prev) => [...(after ? (prev ?? []) : []), ...page.items]);
        setCursor(page.nextCursor);
      })
      .catch(() => setFailed(true));
  }, []);
  React.useEffect(() => load(), [load]);
  return {
    statements,
    failed,
    more: cursor ? () => load(cursor) : undefined,
    appeal: async (s, body) => {
      if (!s.appeal) return;
      const subject = s.appeal;
      const created = await clientRef.current.appeal(subject, body);
      setStatements((list) =>
        (list ?? []).map((x) =>
          x.appeal?.subjectType === subject.subjectType && x.appeal.subjectId === subject.subjectId
            ? { ...x, appealId: created.id }
            : x,
        ),
      );
    },
  };
}

/** The "Statements of reasons" section of `/settings/appeals`, above `MyAppeals`. */
export function EnforcementSection({
  client = enforcementClient(),
}: {
  client?: EnforcementClient;
}): React.JSX.Element {
  const data = useEnforcement(client);
  if (data.failed) return <FormError>{t("safety.enforcement.loadFailed")}</FormError>;
  return <EnforcementList statements={data.statements} onAppeal={data.appeal} onMore={data.more} />;
}
