// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/admin/legal` pieces, for the `legal` role only. Evidence bytes are fetched only when
 * `legal-evidence-view` is pressed, shown blurred and grayscale until `legal-evidence-reveal`,
 * and kept only in component state (never a cache, storage or URL), so they are gone on unmount.
 * Holds are listed without any release control: release needs the operator CLI.
 */
import {
  ConfirmDialog,
  EmptyState,
  RelativeTime,
  SkeletonGroup,
  SkeletonText,
  StatusBadge,
  useRequestNow,
} from "@commonair/ui";
import { KeyValueList } from "@commonair/ui/blocks/data";
import { Section } from "@commonair/ui/blocks/headers";
import { FrameTile } from "@commonair/ui/blocks/media";
import { Button } from "@commonair/ui/components/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Field, FieldDescription, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@commonair/ui/components/item";
import { Textarea } from "@commonair/ui/components/textarea";
import { toast } from "@commonair/ui/toast";
import { CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { FormError } from "../form-error.tsx";
import { usePaged } from "../money/use-load.ts";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import {
  imageDataUrl,
  legalClient,
  type EvidenceObjectDto,
  type ImageData,
  type LegalCaseDto,
  type LegalClient,
  type LegalHoldDto,
  type NcmecReportDetailDto,
  type NcmecReportDto,
} from "./client.ts";
import { caseStatusBadge, evidenceKindLabel, holdReasonLabel, ncmecStatusBadge } from "./labels.ts";
import { CaseHistory, NOTE_MAX } from "./mod-queue.tsx";

export interface LegalQueueProps {
  /** The signed-in legal reviewer (the first reviewer cannot also give the second dismissal). */
  meId: string;
  client?: LegalClient;
}

export function LegalQueue({ meId, client: clientProp }: LegalQueueProps): React.JSX.Element {
  const [client] = React.useState(() => clientProp ?? legalClient());
  const moreFailed = (err: unknown) => toastActionError(err, t("safety.legal.loadMoreFailed"));
  const cases = usePaged("t0", (cursor) => client.cases(cursor), moreFailed);
  const reports = usePaged("ncmec", (cursor) => client.reports(cursor), moreFailed);
  const holds = usePaged("holds", (cursor) => client.holds(cursor), moreFailed);
  const more = (paged: { hasMore: boolean; loadingMore: boolean; loadMore: () => void }) =>
    paged.hasMore ? (
      <div>
        <Button variant="ghost" size="sm" disabled={paged.loadingMore} onClick={paged.loadMore}>
          {t("safety.modq.loadMore")}
        </Button>
      </div>
    ) : null;

  return (
    <div className="flex flex-col gap-8">
      <Section heading={t("safety.legal.cases")}>
        <div className="flex flex-col gap-4">
          {cases.failed && <FormError>{t("safety.legal.loadFailed")}</FormError>}
          <List items={cases.items ?? (cases.failed ? [] : null)} empty={t("safety.legal.casesEmpty")}>
            {(c) => (
              <LegalCaseCard
                key={c.id}
                legalCase={c}
                meId={meId}
                loadEvidence={(id) => client.evidence(id)}
                onConfirm={async (note) => {
                  await client.confirmCase(c.id, note);
                  cases.reload();
                  reports.reload();
                }}
                onDismiss={async (note) => {
                  const result = await client.dismiss(c.id, note);
                  cases.reload();
                  reports.reload();
                  return result.case.status;
                }}
              />
            )}
          </List>
          {more(cases)}
        </div>
      </Section>
      <Section heading={t("safety.legal.ncmec")} description={t("safety.legal.ncmecHint")}>
        <div className="flex flex-col gap-4">
          {reports.failed && <FormError>{t("safety.legal.loadFailed")}</FormError>}
          <List items={reports.items ?? (reports.failed ? [] : null)} empty={t("safety.legal.ncmecEmpty")}>
            {(r) => (
              <NcmecCard
                key={r.id}
                report={r}
                loadDetail={(id) => client.report(id)}
                onFile={async (externalReportId, filedAt) => {
                  await client.file({ id: r.id, externalReportId, filedAt });
                  reports.reload();
                  holds.reload();
                }}
              />
            )}
          </List>
          {more(reports)}
        </div>
      </Section>
      <Section heading={t("safety.legal.holds")} description={t("safety.legal.holdsHint")}>
        <div className="flex flex-col gap-4">
          {holds.failed && <FormError>{t("safety.legal.loadFailed")}</FormError>}
          <HoldList holds={holds.items ?? (holds.failed ? [] : null)} />
          {more(holds)}
        </div>
      </Section>
    </div>
  );
}

function List<T>({
  items,
  empty,
  children,
}: {
  items: T[] | null;
  empty: string;
  children: (item: T) => React.ReactNode;
}): React.JSX.Element {
  if (items === null)
    return (
      <SkeletonGroup label={t("safety.legal.loading")}>
        <SkeletonText lines={3} />
      </SkeletonGroup>
    );
  if (items.length === 0) return <EmptyState icon={CheckmarkCircle02Icon} title={empty} headingLevel={3} />;
  return <div className="flex flex-col gap-4">{items.map(children)}</div>;
}

// ── Cases ────────────────────────────────────────────────────────────────────────────────────

export interface LegalCaseCardProps {
  legalCase: LegalCaseDto;
  meId: string;
  loadEvidence: (id: string) => Promise<ImageData>;
  onConfirm: (note: string) => Promise<void>;
  /** Resolves with the case's new status (`dismissal_pending` after the first, `dismissed` after the second). */
  onDismiss: (note: string) => Promise<string>;
}

export function LegalCaseCard({ legalCase: c, meId, loadEvidence, onConfirm, onDismiss }: LegalCaseCardProps) {
  const [note, setNote] = React.useState("");
  const noteId = React.useId();
  const blockedId = React.useId();
  const badge = caseStatusBadge(c.status);
  const decidable = c.status === "open" || c.status === "dismissal_pending";
  const iDismissedFirst = c.status === "dismissal_pending" && c.firstReviewer?.id === meId;
  const subject = c.channel?.displayName ?? c.user?.username ?? t("safety.modq.unknownSubject");
  const hasNote = note.trim() !== "";
  return (
    <Card
      size="sm"
      data-testid="legal-case"
      data-case-id={c.id}
      data-status={c.status}
      data-list={c.list}
      data-first-reviewer={c.firstReviewer?.id ?? ""}
    >
      <CardHeader>
        <CardTitle>{t("safety.legal.caseTitle", { subject })}</CardTitle>
        <CardAction>
          <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <KeyValueList
          rows={[
            {
              term: t("safety.legal.list"),
              value:
                c.list === "csam"
                  ? t("safety.legal.list.csam")
                  : c.list === "ncii"
                    ? t("safety.legal.list.ncii")
                    : t("safety.legal.list.human"),
            },
            { term: t("safety.modq.subjectType"), value: c.subjectType },
            { term: t("safety.modq.opened"), value: <RelativeTime date={c.createdAt} /> },
            ...c.flags.map((f) => ({
              term: t("safety.legal.match"),
              value: t("safety.legal.matchValue", {
                distance: f.distance ?? "",
                provider: f.provider,
                version: f.providerVersion,
              }),
            })),
            ...(c.firstReviewer ? [{ term: t("safety.legal.firstReviewer"), value: c.firstReviewer.username }] : []),
          ]}
        />
        {c.firstReviewNote ? <p className="text-sm whitespace-pre-wrap">{c.firstReviewNote}</p> : null}
        <div className="flex flex-col gap-3">
          <h4 className="text-sm font-medium">{t("safety.legal.evidence")}</h4>
          {c.evidence.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("safety.legal.noEvidence")}</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {c.evidence.map((e) => (
                <EvidenceItem key={e.id} evidence={e} load={loadEvidence} />
              ))}
            </div>
          )}
        </div>
        <CaseHistory history={c.history} />
        {decidable && (
          <div className="flex flex-col gap-3">
            <Field>
              <FieldLabel htmlFor={noteId}>{t("safety.legal.note")}</FieldLabel>
              <Textarea
                id={noteId}
                data-testid="legal-note"
                rows={3}
                maxLength={NOTE_MAX}
                value={note}
                onChange={(e) => setNote(e.currentTarget.value)}
              />
              <FieldDescription>{t("safety.legal.noteHint")}</FieldDescription>
            </Field>
            <div className="flex flex-wrap gap-2">
              {c.status === "open" && (
                <ConfirmDialog
                  trigger={
                    <Button data-testid="legal-confirm" variant="destructive" size="sm" disabled={!hasNote}>
                      {t("safety.legal.confirm")}
                    </Button>
                  }
                  title={t("safety.legal.confirmTitle")}
                  description={t("safety.legal.confirmBody")}
                  confirmLabel={t("safety.legal.confirm")}
                  variant="destructive"
                  onConfirm={async () => {
                    await onConfirm(note.trim());
                    setNote("");
                    toast.success(t("safety.legal.confirmed"));
                  }}
                  onError={(err) => toastActionError(err, t("safety.legal.actionFailed"))}
                />
              )}
              <ConfirmDialog
                trigger={
                  <Button
                    data-testid="legal-dismiss"
                    variant="outline"
                    size="sm"
                    disabled={!hasNote || iDismissedFirst}
                    aria-describedby={iDismissedFirst ? blockedId : undefined}
                  >
                    {c.status === "dismissal_pending" ? t("safety.legal.dismissSecond") : t("safety.legal.dismiss")}
                  </Button>
                }
                title={
                  c.status === "dismissal_pending"
                    ? t("safety.legal.dismissSecondTitle")
                    : t("safety.legal.dismissTitle")
                }
                description={t("safety.legal.dismissBody")}
                confirmLabel={t("safety.legal.dismiss")}
                onConfirm={async () => {
                  const status = await onDismiss(note.trim());
                  setNote("");
                  toast.success(
                    status === "dismissed" ? t("safety.legal.dismissed") : t("safety.legal.dismissPending"),
                  );
                }}
                onError={(err) => toastActionError(err, t("safety.legal.actionFailed"))}
              />
            </div>
            {iDismissedFirst ? (
              <p id={blockedId} className="text-sm text-muted-foreground">
                {t("safety.legal.secondReviewerNeeded")}
              </p>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const evidenceReveal = { "data-testid": "legal-evidence-reveal" };

export function EvidenceItem({
  evidence,
  load,
}: {
  evidence: EvidenceObjectDto;
  load: (id: string) => Promise<ImageData>;
}): React.JSX.Element {
  const [data, setData] = React.useState<ImageData | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [revealed, setRevealed] = React.useState(false);
  const live = React.useRef(true);
  React.useEffect(() => {
    live.current = true;
    return () => {
      // Drop the decrypted bytes with the component.
      live.current = false;
    };
  }, []);
  const view = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const loaded = await load(evidence.id);
      if (live.current) setData(loaded);
    } catch (err) {
      toastActionError(err, t("safety.legal.evidenceFailed"));
    } finally {
      if (live.current) setLoading(false);
    }
  };
  const src = data ? imageDataUrl(data) : null;
  return (
    <div
      data-testid="legal-evidence"
      data-evidence-id={evidence.id}
      data-kind={evidence.kind}
      data-storage={evidence.storage}
      className="flex min-w-0 flex-col gap-2"
    >
      <p className="text-sm font-medium">{evidenceKindLabel(evidence.kind)}</p>
      {evidence.storage === "bucket" ? (
        <p className="text-xs text-muted-foreground">{t("safety.legal.bucketEvidence")}</p>
      ) : data && !src ? (
        <p className="text-xs text-muted-foreground">{t("safety.legal.evidenceNotImage")}</p>
      ) : (
        <FrameTile
          src={src}
          alt={t("safety.legal.evidenceAlt")}
          revealed={revealed}
          onReveal={() => setRevealed(true)}
          revealLabel={t("safety.legal.reveal")}
          notice={t("safety.legal.evidenceBlurred")}
          revealButtonProps={evidenceReveal}
          placeholder={
            <Button
              data-testid="legal-evidence-view"
              variant="outline"
              size="sm"
              disabled={loading}
              aria-busy={loading || undefined}
              onClick={() => void view()}
            >
              {t("safety.legal.view")}
            </Button>
          }
        />
      )}
      <p className="truncate text-xs text-muted-foreground">
        {t("safety.legal.sha256", { sha: evidence.sha256 })} <RelativeTime date={evidence.capturedAt} />
      </p>
    </div>
  );
}

// ── NCMEC drafts ─────────────────────────────────────────────────────────────────────────────

export function NcmecCard({
  report,
  loadDetail,
  onFile,
}: {
  report: NcmecReportDto;
  loadDetail: (id: string) => Promise<NcmecReportDetailDto>;
  onFile: (externalReportId: string, filedAt: string) => Promise<void>;
}): React.JSX.Element {
  const [detail, setDetail] = React.useState<NcmecReportDetailDto | null>(null);
  const [loading, setLoading] = React.useState(false);
  const badge = ncmecStatusBadge(report.status);
  const open = async () => {
    if (loading) return;
    setLoading(true);
    try {
      setDetail(await loadDetail(report.id));
    } catch (err) {
      toastActionError(err, t("safety.legal.ncmecFailed"));
    } finally {
      setLoading(false);
    }
  };
  return (
    <Card size="sm" data-testid="legal-ncmec" data-report-id={report.id} data-status={report.status}>
      <CardHeader>
        <CardTitle>{t("safety.legal.ncmecTitle")}</CardTitle>
        <CardAction>
          <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <KeyValueList
          rows={[
            { term: t("safety.legal.incidentAt"), value: <RelativeTime date={report.incidentAt} /> },
            { term: t("safety.legal.target"), value: report.target },
            ...(report.externalReportId
              ? [{ term: t("safety.legal.externalId"), value: report.externalReportId }]
              : []),
            ...(report.filedAt
              ? [{ term: t("safety.legal.filedAt"), value: <RelativeTime date={report.filedAt} /> }]
              : []),
          ]}
        />
        {detail ? (
          <SnapshotView detail={detail} />
        ) : (
          <div>
            <Button
              data-testid="legal-ncmec-open"
              variant="outline"
              size="sm"
              disabled={loading}
              aria-busy={loading || undefined}
              onClick={() => void open()}
            >
              {t("safety.legal.ncmecOpen")}
            </Button>
          </div>
        )}
        {report.status === "draft" && <NcmecFilingForm onFile={onFile} />}
      </CardContent>
    </Card>
  );
}

function SnapshotView({ detail }: { detail: NcmecReportDetailDto }): React.JSX.Element {
  const s = detail.snapshot;
  return (
    <KeyValueList
      data-testid="legal-ncmec-snapshot"
      rows={[
        { term: t("safety.legal.snapshot.incidentType"), value: s.incidentType },
        { term: t("safety.legal.snapshot.account"), value: `${s.account.username} (${s.account.id})` },
        { term: t("safety.legal.snapshot.displayName"), value: s.account.displayName },
        { term: t("safety.legal.snapshot.email"), value: s.account.email },
        { term: t("safety.legal.snapshot.created"), value: <RelativeTime date={s.account.createdAt} /> },
        { term: t("safety.legal.snapshot.ips"), value: s.account.ips.join(t("common.listSeparator")) },
        { term: t("safety.legal.snapshot.subject"), value: `${s.subject.type} ${s.subject.id}` },
        { term: t("safety.legal.snapshot.channel"), value: s.subject.channelSlug ?? "" },
        ...(s.match
          ? [
              {
                term: t("safety.legal.match"),
                value: t("safety.legal.matchValue", {
                  distance: s.match.distance,
                  provider: s.match.provider,
                  version: s.match.listVersion,
                }),
              },
            ]
          : []),
        { term: t("safety.legal.snapshot.evidence"), value: String(s.evidenceIds.length) },
      ]}
    />
  );
}

/** `datetime-local` text (the reviewer's local time) to an ISO timestamp, or null when empty or invalid. */
export function localDateTimeToIso(value: string): string | null {
  if (value.trim() === "") return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function NcmecFilingForm({
  onFile,
}: {
  onFile: (externalReportId: string, filedAt: string) => Promise<void>;
}): React.JSX.Element {
  const [reportId, setReportId] = React.useState("");
  const [filedAt, setFiledAt] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const idId = React.useId();
  const atId = React.useId();
  const iso = localDateTimeToIso(filedAt);
  const ready = reportId.trim() !== "" && iso !== null;
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!ready || iso === null || pending) return;
    setPending(true);
    try {
      await onFile(reportId.trim(), iso);
      toast.success(t("safety.legal.filed"));
    } catch (err) {
      toastActionError(err, t("safety.legal.fileFailed"));
    } finally {
      setPending(false);
    }
  };
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)} noValidate>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={idId}>{t("safety.legal.externalId")}</FieldLabel>
          <Input
            id={idId}
            data-testid="legal-ncmec-report-id"
            maxLength={100}
            autoComplete="off"
            value={reportId}
            onChange={(e) => setReportId(e.currentTarget.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={atId}>{t("safety.legal.filedAt")}</FieldLabel>
          <Input
            id={atId}
            data-testid="legal-ncmec-filed-at"
            type="datetime-local"
            value={filedAt}
            onChange={(e) => setFiledAt(e.currentTarget.value)}
          />
        </Field>
      </div>
      <div>
        <Button
          data-testid="legal-ncmec-file"
          type="submit"
          size="sm"
          disabled={!ready || pending}
          aria-busy={pending || undefined}
        >
          {t("safety.legal.file")}
        </Button>
      </div>
    </form>
  );
}

// ── Holds ────────────────────────────────────────────────────────────────────────────────────

/** `data-eligible-at` is set only once the hold may be released (one year after filing). */
export function eligibleAt(hold: LegalHoldDto, nowMs: number): string {
  const at = hold.eligibleForReleaseAt;
  return at !== null && Date.parse(at) <= nowMs ? at : "";
}

export function HoldList({ holds, now }: { holds: LegalHoldDto[] | null; now?: number }): React.JSX.Element {
  // The request clock keeps SSR deterministic; missing clock context fails closed.
  const requestNow = useRequestNow();
  const nowMs = now ?? requestNow ?? Number.NaN;
  if (holds === null)
    return (
      <SkeletonGroup label={t("safety.legal.loading")}>
        <SkeletonText lines={3} />
      </SkeletonGroup>
    );
  if (holds.length === 0)
    return <EmptyState icon={CheckmarkCircle02Icon} title={t("safety.legal.holdsEmpty")} headingLevel={3} />;
  return (
    <ItemGroup>
      {holds.map((hold) => (
        <Item
          key={hold.id}
          data-testid="legal-hold"
          data-hold-id={hold.id}
          data-reason={hold.reasonCode}
          data-eligible-at={eligibleAt(hold, nowMs)}
          variant="outline"
          size="sm"
        >
          <ItemContent>
            <ItemTitle>{holdReasonLabel(hold.reasonCode)}</ItemTitle>
            <ItemDescription>
              {hold.filedAt ? t("safety.legal.holdFiled") : t("safety.legal.holdNotFiled")}
              {hold.reason ? `${t("common.listSeparator")}${hold.reason}` : ""}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <RelativeTime date={hold.createdAt} className="text-xs text-muted-foreground" />
          </ItemActions>
        </Item>
      ))}
    </ItemGroup>
  );
}
