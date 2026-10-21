// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/admin/moderation` pieces (moderators, admins, `legal`). T1/T2 frames are fetched one by one
 * with `moderation.frame`, shown blurred and grayscale, and revealed one at a time; the bytes
 * live only in this component tree's state. T0 cases never reach this page (the API answers
 * NOT_FOUND for them here); they are on `/admin/legal`.
 */
import { ConfirmDialog, EmptyState, RelativeTime, SkeletonGroup, SkeletonText, StatusBadge } from "@commonair/ui";
import { KeyValueList } from "@commonair/ui/blocks/data";
import { AlertCallout, DeadlineCountdown } from "@commonair/ui/blocks/feedback";
import { ChoiceToggle, SelectField } from "@commonair/ui/blocks/forms";
import { PageTabs, Section } from "@commonair/ui/blocks/headers";
import { FrameTile } from "@commonair/ui/blocks/media";
import { Button } from "@commonair/ui/components/button";
import { Field, FieldDescription, FieldLabel } from "@commonair/ui/components/field";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@commonair/ui/components/item";
import { Textarea } from "@commonair/ui/components/textarea";
import { toast } from "@commonair/ui/toast";
import { CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { FormError } from "../form-error.tsx";
import { useLoad, usePaged } from "../money/use-load.ts";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import {
  imageDataUrl,
  moderationClient,
  type ModerationCaseDetailDto,
  type ModerationCaseDto,
  type ModerationClient,
  type NciiDecision,
  type NciiRequestDto,
  type ReportDto,
  type ReviewDecision,
} from "./client.ts";
import { caseStatusBadge, categoryLabel, decisionLabel, nciiStatusBadge, reportReasonLabel } from "./labels.ts";

export const NOTE_MAX = 2000;
const SLA_WARN_MS = 5 * 60_000;
const NCII_WARN_MS = 12 * 60 * 60_000;

export type ModTab = "cases" | "labels" | "reports" | "ncii";
type Selection = { kind: "case" | "report" | "ncii"; id: string } | null;

export interface ModQueueProps {
  /** Platform moderators and admins (reports need them; `legal` alone does not). */
  canReports: boolean;
  client?: ModerationClient;
}

export function ModQueue({ canReports, client: clientProp }: ModQueueProps): React.JSX.Element {
  const [client] = React.useState(() => clientProp ?? moderationClient());
  const [tab, setTab] = React.useState<ModTab>("cases");
  const [selected, setSelected] = React.useState<Selection>(null);
  const moreFailed = (err: unknown) => toastActionError(err, t("safety.modq.loadMoreFailed"));
  const cases = usePaged("t1", (cursor) => client.cases({ tier: "t1", status: "open", cursor }), moreFailed);
  const labels = usePaged("t2", (cursor) => client.cases({ tier: "t2", status: "labelled", cursor }), moreFailed);
  // `legal` alone may not read reports: never ask.
  const reports = usePaged(
    canReports ? "reports" : "none",
    (cursor) => (canReports ? client.reports(cursor) : Promise.resolve({ items: [], nextCursor: null })),
    moreFailed,
  );
  const ncii = usePaged("ncii", (cursor) => client.ncii(cursor), moreFailed);

  const panel = (list: React.ReactNode) => <div className="flex flex-col gap-4 pt-4">{list}</div>;
  const select = (next: Selection) => setSelected(next);
  const caseList = (paged: typeof cases) =>
    panel(
      <>
        {paged.failed && <FormError>{t("safety.modq.loadFailed")}</FormError>}
        <CaseList
          cases={paged.items ?? (paged.failed ? [] : null)}
          selectedId={selected?.kind === "case" ? selected.id : null}
          onSelect={(id) => select({ kind: "case", id })}
        />
        {paged.hasMore && <LoadMore loading={paged.loadingMore} onClick={paged.loadMore} />}
      </>,
    );

  const items = [
    { id: "cases", label: t("safety.modq.tab.cases"), "data-testid": "modq-tab-cases", content: caseList(cases) },
    { id: "labels", label: t("safety.modq.tab.labels"), "data-testid": "modq-tab-labels", content: caseList(labels) },
    ...(canReports
      ? [
          {
            id: "reports",
            label: t("safety.modq.tab.reports"),
            "data-testid": "modq-tab-reports",
            content: panel(
              <>
                {reports.failed && <FormError>{t("safety.modq.loadFailed")}</FormError>}
                <ReportList
                  reports={reports.items ?? (reports.failed ? [] : null)}
                  selectedId={selected?.kind === "report" ? selected.id : null}
                  onSelect={(id) => select({ kind: "report", id })}
                />
                {reports.hasMore && <LoadMore loading={reports.loadingMore} onClick={reports.loadMore} />}
              </>,
            ),
          },
        ]
      : []),
    {
      id: "ncii",
      label: t("safety.modq.tab.ncii"),
      "data-testid": "modq-tab-ncii",
      content: panel(
        <>
          {ncii.failed && <FormError>{t("safety.modq.loadFailed")}</FormError>}
          <NciiList
            requests={ncii.items ?? (ncii.failed ? [] : null)}
            selectedId={selected?.kind === "ncii" ? selected.id : null}
            onSelect={(id) => select({ kind: "ncii", id })}
          />
          {ncii.hasMore && <LoadMore loading={ncii.loadingMore} onClick={ncii.loadMore} />}
        </>,
      ),
    },
  ];

  const report = selected?.kind === "report" ? reports.items?.find((r) => r.id === selected.id) : undefined;
  const request = selected?.kind === "ncii" ? ncii.items?.find((r) => r.id === selected.id) : undefined;

  return (
    <div data-testid="modq" className="flex flex-col gap-6">
      <PageTabs
        aria-label={t("safety.modq.tabs")}
        value={tab}
        onValueChange={(next) => {
          if (next === "cases" || next === "labels" || next === "reports" || next === "ncii") {
            setTab(next);
            setSelected(null);
          }
        }}
        items={items}
      />
      {selected?.kind === "case" && (
        // Keyed: a new case starts blurred, with its own frames.
        <CaseDetail
          key={selected.id}
          id={selected.id}
          client={client}
          // The decided case stays open, refreshed, so the moderator sees its new status and history.
          onDecided={() => {
            cases.reload();
            labels.reload();
          }}
        />
      )}
      {report && (
        <ReportDetail
          key={report.id}
          report={report}
          onResolve={async (status, resolution) => {
            await client.resolveReport({ id: report.id, status, resolution });
            setSelected(null);
            reports.reload();
          }}
        />
      )}
      {request && (
        <NciiDetail
          key={request.id}
          request={request}
          onDecide={async (decision, note) => {
            await client.decideNcii({ id: request.id, decision, note });
            setSelected(null);
            ncii.reload();
          }}
        />
      )}
    </div>
  );
}

function LoadMore({ onClick, loading }: { onClick: () => void; loading: boolean }): React.JSX.Element {
  return (
    <div>
      <Button variant="ghost" size="sm" disabled={loading} aria-busy={loading || undefined} onClick={onClick}>
        {t("safety.modq.loadMore")}
      </Button>
    </div>
  );
}

function Loading(): React.JSX.Element {
  return (
    <SkeletonGroup label={t("safety.modq.loading")}>
      <SkeletonText lines={3} />
    </SkeletonGroup>
  );
}

function Empty(): React.JSX.Element {
  return (
    <EmptyState
      icon={CheckmarkCircle02Icon}
      title={t("safety.modq.empty")}
      description={t("safety.modq.emptyHint")}
      headingLevel={3}
    />
  );
}

function OpenButton({ selected, onClick, label }: { selected: boolean; onClick: () => void; label: string }) {
  return (
    <Button
      size="sm"
      variant={selected ? "default" : "outline"}
      aria-pressed={selected}
      aria-label={label}
      onClick={onClick}
    >
      {t("safety.modq.open")}
    </Button>
  );
}

// ── Cases ────────────────────────────────────────────────────────────────────────────────────

export function CaseList({
  cases,
  selectedId,
  onSelect,
}: {
  cases: ModerationCaseDto[] | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  if (cases === null) return <Loading />;
  if (cases.length === 0) return <Empty />;
  return (
    <ItemGroup>
      {cases.map((c) => {
        const badge = caseStatusBadge(c.status);
        const subject = c.channel?.displayName ?? c.user?.username ?? t("safety.modq.unknownSubject");
        return (
          <Item
            key={c.id}
            data-testid="modq-item"
            data-case-id={c.id}
            data-tier={c.tier}
            data-category={c.category ?? ""}
            data-status={c.status}
            data-priority={c.priority}
            data-sla-due-at={c.tier === "t1" ? (c.slaDueAt ?? "") : undefined}
            variant={selectedId === c.id ? "muted" : "outline"}
            size="sm"
          >
            <ItemContent>
              <ItemTitle>
                <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
                {c.category ? categoryLabel(c.category) : t("safety.modq.noCategory")}
              </ItemTitle>
              <ItemDescription>{subject}</ItemDescription>
            </ItemContent>
            <ItemActions className="flex-wrap justify-end">
              {c.tier === "t1" && c.slaDueAt ? (
                <DeadlineCountdown
                  deadline={c.slaDueAt}
                  warnWithinMs={SLA_WARN_MS}
                  dueLabel={t("safety.modq.sla")}
                  overdueLabel={t("safety.modq.slaMissed")}
                />
              ) : (
                <RelativeTime date={c.createdAt} className="text-xs text-muted-foreground" />
              )}
              <OpenButton
                selected={selectedId === c.id}
                onClick={() => onSelect(c.id)}
                label={t("safety.modq.openCase", { subject })}
              />
            </ItemActions>
          </Item>
        );
      })}
    </ItemGroup>
  );
}

export function CaseDetail({
  id,
  client,
  onDecided,
}: {
  id: string;
  client: ModerationClient;
  onDecided: () => void;
}): React.JSX.Element {
  const loaded = useLoad(`case|${id}`, () => client.case(id));
  if (loaded.failed && !loaded.data) return <FormError>{t("safety.modq.caseFailed")}</FormError>;
  if (!loaded.data) return <Loading />;
  return (
    <CaseDetailView
      detail={loaded.data}
      loadFrame={(flagId) => client.frame(flagId)}
      onReview={async (input) => {
        await client.review({ id, ...input });
        loaded.reload();
        onDecided();
      }}
    />
  );
}

export interface ReviewInput {
  decision: ReviewDecision;
  note: string;
  suspendTarget: "channel" | "user" | "both";
  durationSeconds?: number;
}

export function CaseDetailView({
  detail,
  loadFrame,
  onReview,
}: {
  detail: ModerationCaseDetailDto;
  loadFrame: ModerationClient["frame"];
  onReview: (input: ReviewInput) => Promise<void>;
}): React.JSX.Element {
  // One revealed frame at a time; state only, so it re-blurs on navigation.
  const [revealed, setRevealed] = React.useState<string | null>(null);
  const frames = detail.flags.filter((f) => f.hasFrame && f.tier !== "t0");
  const subject = detail.channel?.displayName ?? detail.user?.username ?? t("safety.modq.unknownSubject");
  const badge = caseStatusBadge(detail.status);
  return (
    <Section
      data-testid="modq-detail"
      data-case-id={detail.id}
      data-status={detail.status}
      heading={t("safety.modq.caseTitle", { subject })}
      action={<StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>}
    >
      <div className="flex flex-col gap-4">
        <KeyValueList
          rows={[
            { term: t("safety.modq.category"), value: detail.category ? categoryLabel(detail.category) : "" },
            { term: t("safety.modq.subjectType"), value: detail.subjectType },
            { term: t("safety.modq.opened"), value: <RelativeTime date={detail.createdAt} /> },
            ...(detail.slaDueAt
              ? [
                  {
                    term: t("safety.modq.sla"),
                    value: (
                      <DeadlineCountdown
                        deadline={detail.slaDueAt}
                        warnWithinMs={SLA_WARN_MS}
                        dueLabel={t("safety.modq.sla")}
                        overdueLabel={t("safety.modq.slaMissed")}
                      />
                    ),
                  },
                ]
              : []),
          ]}
        />
        {detail.notScored.length > 0 && (
          <AlertCallout
            data-testid="modq-not-scored"
            tone="info"
            title={t("safety.modq.notScoredTitle")}
            description={t("safety.modq.notScored", {
              categories: detail.notScored.map(categoryLabel).join(t("common.listSeparator")),
            })}
          />
        )}
        {frames.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2">
            {frames.map((flag) => (
              <FlagFrame
                key={flag.id}
                flagId={flag.id}
                score={flag.score}
                provider={flag.provider}
                providerVersion={flag.providerVersion}
                capturedAt={flag.capturedAt}
                load={loadFrame}
                revealed={revealed === flag.id}
                onReveal={() => setRevealed(flag.id)}
              />
            ))}
          </div>
        )}
        <CaseHistory history={detail.history} />
        {detail.status === "open" && <ReviewForm onSubmit={onReview} />}
      </div>
    </Section>
  );
}

const revealButton = { "data-testid": "modq-frame-reveal" };

function FlagFrame({
  flagId,
  score,
  provider,
  providerVersion,
  capturedAt,
  load,
  revealed,
  onReveal,
}: {
  flagId: string;
  score: number | null;
  provider: string;
  providerVersion: string;
  capturedAt: string;
  load: ModerationClient["frame"];
  revealed: boolean;
  onReveal: () => void;
}): React.JSX.Element {
  const frame = useLoad(`frame|${flagId}`, () => load(flagId));
  const src = frame.data ? imageDataUrl(frame.data) : null;
  return (
    <FrameTile
      data-testid="modq-frame"
      data-flag-id={flagId}
      data-score={score ?? ""}
      data-provider={provider}
      data-provider-version={providerVersion}
      data-revealed={revealed ? "true" : "false"}
      src={src}
      alt={t("safety.modq.frameAlt")}
      revealed={revealed}
      onReveal={onReveal}
      revealLabel={t("safety.modq.reveal")}
      notice={t("safety.modq.frameBlurred")}
      revealButtonProps={revealButton}
      placeholder={
        frame.failed ? <p className="text-xs text-muted-foreground">{t("safety.modq.frameFailed")}</p> : undefined
      }
      caption={
        <>
          {t("safety.modq.frameCaption", { score: score ?? "", provider, version: providerVersion })}{" "}
          <RelativeTime date={capturedAt} />
        </>
      }
    />
  );
}

export function CaseHistory({ history }: { history: ModerationCaseDetailDto["history"] }): React.JSX.Element {
  return (
    <section data-testid="modq-history" aria-label={t("safety.modq.history")} className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{t("safety.modq.history")}</h3>
      <ItemGroup>
        {history.map((row) => (
          <Item
            key={row.id}
            data-testid="modq-history-row"
            data-action={row.action}
            data-actor-type={row.actorType}
            size="xs"
            variant="outline"
          >
            <ItemContent>
              <ItemTitle>{row.action}</ItemTitle>
              <ItemDescription>
                {row.actor ? row.actor.username : t("safety.modq.actorType", { type: row.actorType })}
                {row.reason ? `${t("common.listSeparator")}${row.reason}` : ""}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <RelativeTime date={row.createdAt} className="text-xs text-muted-foreground" />
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
    </section>
  );
}

const durationTrigger = { "data-testid": "modq-duration" };

export function ReviewForm({ onSubmit }: { onSubmit: (input: ReviewInput) => Promise<void> }): React.JSX.Element {
  const [decision, setDecision] = React.useState<ReviewDecision | "">("");
  const [duration, setDuration] = React.useState<string>("604800");
  const [target, setTarget] = React.useState<"channel" | "user" | "both">("channel");
  const [note, setNote] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const noteId = React.useId();
  const ready = decision !== "" && note.trim() !== "";
  const decisions: ReviewDecision[] = ["clear", "warn", "end_stream", "suspend", "escalate_legal"];

  const run = async () => {
    if (decision === "" || note.trim() === "") return;
    await onSubmit({
      decision,
      note: note.trim(),
      suspendTarget: target,
      durationSeconds: decision === "suspend" && duration !== "indefinite" ? Number(duration) : undefined,
    });
    toast.success(t("safety.modq.reviewed"));
  };
  const runDirect = async () => {
    if (pending || !ready) return;
    setPending(true);
    try {
      await run();
    } catch (err) {
      toastActionError(err, t("safety.modq.reviewFailed"));
    } finally {
      setPending(false);
    }
  };
  const needsConfirm = decision === "suspend" || decision === "end_stream";
  const submitButton = (
    <Button
      data-testid="modq-submit"
      type={needsConfirm ? "button" : "submit"}
      variant={needsConfirm ? "destructive" : "default"}
      disabled={!ready || pending}
      aria-busy={pending || undefined}
    >
      {t("safety.modq.submit")}
    </Button>
  );

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!needsConfirm) void runDirect();
      }}
      noValidate
    >
      <ChoiceToggle
        data-testid="modq-decision"
        label={t("safety.modq.decision")}
        value={decision}
        onValueChange={(v) => {
          const found = decisions.find((d) => d === v);
          if (found) setDecision(found);
        }}
        wrap
        options={decisions.map((d) => ({ value: d, label: decisionLabel(d), "data-testid": `modq-decision-${d}` }))}
      />
      {decision === "suspend" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label={t("safety.modq.duration")}
            value={duration}
            onValueChange={setDuration}
            triggerProps={durationTrigger}
            options={[
              { value: "86400", label: t("safety.modq.duration.day") },
              { value: "604800", label: t("safety.modq.duration.week") },
              { value: "2592000", label: t("safety.modq.duration.month") },
              { value: "indefinite", label: t("safety.modq.duration.indefinite") },
            ]}
          />
          <SelectField
            label={t("safety.modq.target")}
            value={target}
            onValueChange={(v) => {
              if (v === "channel" || v === "user" || v === "both") setTarget(v);
            }}
            options={[
              { value: "channel", label: t("safety.modq.target.channel") },
              { value: "user", label: t("safety.modq.target.user") },
              { value: "both", label: t("safety.modq.target.both") },
            ]}
          />
        </div>
      )}
      <Field>
        <FieldLabel htmlFor={noteId}>{t("safety.modq.note")}</FieldLabel>
        <Textarea
          id={noteId}
          data-testid="modq-note"
          rows={3}
          required
          maxLength={NOTE_MAX}
          value={note}
          onChange={(e) => setNote(e.currentTarget.value)}
        />
        <FieldDescription>{t("safety.modq.noteHint")}</FieldDescription>
      </Field>
      <div>
        {needsConfirm ? (
          <ConfirmDialog
            trigger={submitButton}
            title={decision === "suspend" ? t("safety.modq.confirmSuspend") : t("safety.modq.confirmEndStream")}
            description={t("safety.modq.confirmBody")}
            confirmLabel={decision === "suspend" ? decisionLabel("suspend") : decisionLabel("end_stream")}
            variant="destructive"
            onConfirm={run}
            onError={(err) => toastActionError(err, t("safety.modq.reviewFailed"))}
          />
        ) : (
          submitButton
        )}
      </div>
    </form>
  );
}

// ── Reports ──────────────────────────────────────────────────────────────────────────────────

export function ReportList({
  reports,
  selectedId,
  onSelect,
}: {
  reports: ReportDto[] | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  if (reports === null) return <Loading />;
  if (reports.length === 0) return <Empty />;
  return (
    <ItemGroup>
      {reports.map((r) => (
        <Item
          key={r.id}
          data-testid="modq-item"
          data-report-id={r.id}
          data-category={r.reason}
          data-status={r.status}
          data-priority={r.priority}
          variant={selectedId === r.id ? "muted" : "outline"}
          size="sm"
        >
          <ItemContent>
            <ItemTitle>{reportReasonLabel(r.reason)}</ItemTitle>
            <ItemDescription>{r.channelSlug ?? r.subjectType}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <RelativeTime date={r.createdAt} className="text-xs text-muted-foreground" />
            <OpenButton
              selected={selectedId === r.id}
              onClick={() => onSelect(r.id)}
              label={t("safety.modq.openReport", { reason: reportReasonLabel(r.reason) })}
            />
          </ItemActions>
        </Item>
      ))}
    </ItemGroup>
  );
}

export function ReportDetail({
  report,
  onResolve,
}: {
  report: ReportDto;
  onResolve: (status: "actioned" | "dismissed", resolution: string) => Promise<void>;
}): React.JSX.Element {
  const [status, setStatus] = React.useState<"actioned" | "dismissed" | "">("");
  const [note, setNote] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const noteId = React.useId();
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (status === "" || note.trim() === "" || pending) return;
    setPending(true);
    try {
      await onResolve(status, note.trim());
      toast.success(t("safety.modq.reportResolved"));
    } catch (err) {
      toastActionError(err, t("safety.modq.reportFailed"));
    } finally {
      setPending(false);
    }
  };
  return (
    <Section
      data-testid="modq-detail"
      data-report-id={report.id}
      data-status={report.status}
      heading={reportReasonLabel(report.reason)}
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)} noValidate>
        <KeyValueList
          rows={[
            { term: t("safety.modq.subjectType"), value: report.subjectType },
            { term: t("safety.modq.channel"), value: report.channelSlug ?? "" },
            { term: t("safety.modq.reporter"), value: report.reporter?.username ?? "" },
            { term: t("safety.modq.opened"), value: <RelativeTime date={report.createdAt} /> },
          ]}
        />
        {report.details ? <p className="text-sm whitespace-pre-wrap">{report.details}</p> : null}
        <ChoiceToggle
          label={t("safety.modq.resolveAs")}
          value={status}
          onValueChange={(v) => {
            if (v === "actioned" || v === "dismissed") setStatus(v);
          }}
          options={[
            { value: "actioned", label: t("safety.modq.actioned") },
            { value: "dismissed", label: t("safety.modq.dismissed") },
          ]}
        />
        <Field>
          <FieldLabel htmlFor={noteId}>{t("safety.modq.note")}</FieldLabel>
          <Textarea
            id={noteId}
            rows={3}
            maxLength={NOTE_MAX}
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
          />
          <FieldDescription>{t("safety.modq.noteHint")}</FieldDescription>
        </Field>
        <div>
          <Button
            type="submit"
            disabled={status === "" || note.trim() === "" || pending}
            aria-busy={pending || undefined}
          >
            {t("safety.modq.resolve")}
          </Button>
        </div>
      </form>
    </Section>
  );
}

// ── NCII requests ────────────────────────────────────────────────────────────────────────────

const undecided = (r: NciiRequestDto) => r.decidedAt === null;

export function NciiList({
  requests,
  selectedId,
  onSelect,
}: {
  requests: NciiRequestDto[] | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  if (requests === null) return <Loading />;
  if (requests.length === 0) return <Empty />;
  // Undecided first, by deadline; decided ones after.
  const sorted = [...requests].sort((a, b) =>
    undecided(a) === undecided(b) ? a.deadlineAt.localeCompare(b.deadlineAt) : undecided(a) ? -1 : 1,
  );
  return (
    <ItemGroup>
      {sorted.map((r) => {
        const badge = nciiStatusBadge(r.status);
        return (
          <Item
            key={r.id}
            data-testid="modq-item"
            data-ncii-id={r.id}
            data-status={r.status}
            data-deadline-at={r.deadlineAt}
            variant={selectedId === r.id ? "muted" : "outline"}
            size="sm"
          >
            <ItemContent>
              <ItemTitle>
                <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
                {t("safety.modq.nciiItems", { count: r.items.length })}
              </ItemTitle>
            </ItemContent>
            <ItemActions className="flex-wrap justify-end">
              {undecided(r) ? (
                <DeadlineCountdown
                  deadline={r.deadlineAt}
                  warnWithinMs={NCII_WARN_MS}
                  dueLabel={t("safety.modq.nciiDue")}
                  overdueLabel={t("safety.modq.nciiOverdue")}
                />
              ) : null}
              <OpenButton
                selected={selectedId === r.id}
                onClick={() => onSelect(r.id)}
                label={t("safety.modq.openNcii", { count: r.items.length })}
              />
            </ItemActions>
          </Item>
        );
      })}
    </ItemGroup>
  );
}

export function NciiDetail({
  request,
  onDecide,
}: {
  request: NciiRequestDto;
  onDecide: (decision: NciiDecision, note: string) => Promise<void>;
}): React.JSX.Element {
  const badge = nciiStatusBadge(request.status);
  return (
    <Section
      data-testid="modq-detail"
      data-ncii-id={request.id}
      data-status={request.status}
      heading={t("safety.modq.nciiTitle")}
      action={<StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>}
    >
      <div className="flex flex-col gap-4">
        <KeyValueList
          rows={[
            { term: t("safety.modq.received"), value: <RelativeTime date={request.receivedAt} /> },
            {
              term: t("safety.modq.deadline"),
              value: (
                <DeadlineCountdown
                  deadline={request.deadlineAt}
                  warnWithinMs={NCII_WARN_MS}
                  dueLabel={t("safety.modq.nciiDue")}
                  overdueLabel={t("safety.modq.nciiOverdue")}
                />
              ),
            },
            { term: t("safety.modq.requester"), value: `${request.requesterName} <${request.requesterEmail}>` },
            {
              term: t("safety.modq.relationship"),
              value:
                request.relationship === "self"
                  ? t("safety.takedown.relationship.self")
                  : t("safety.takedown.relationship.representative"),
            },
            { term: t("safety.modq.signature"), value: request.signature },
          ]}
        />
        <p className="text-sm whitespace-pre-wrap">{request.description}</p>
        <ItemGroup>
          {request.items.map((item) => (
            <Item key={item.id} size="xs" variant="outline">
              <ItemContent>
                <ItemTitle className="break-all">{item.url}</ItemTitle>
                <ItemDescription>
                  {item.subjectType ? item.subjectType : t("safety.modq.unresolved")}
                  {item.removedAt
                    ? `${t("common.listSeparator")}${t("safety.modq.removed")}`
                    : item.hiddenAt
                      ? `${t("common.listSeparator")}${t("safety.modq.hidden")}`
                      : ""}
                </ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
        {request.decidedAt === null && <NciiDecisionForm onSubmit={onDecide} />}
      </div>
    </Section>
  );
}

export function NciiDecisionForm({
  onSubmit,
}: {
  onSubmit: (decision: NciiDecision, note: string) => Promise<void>;
}): React.JSX.Element {
  const [decision, setDecision] = React.useState<NciiDecision | "">("");
  const [note, setNote] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const noteId = React.useId();
  const ready = decision !== "" && note.trim() !== "";
  const run = async () => {
    if (decision === "" || note.trim() === "") return;
    await onSubmit(decision, note.trim());
    toast.success(t("safety.modq.nciiDecided"));
  };
  const runDirect = async () => {
    if (pending || !ready) return;
    setPending(true);
    try {
      await run();
    } catch (err) {
      toastActionError(err, t("safety.modq.nciiFailed"));
    } finally {
      setPending(false);
    }
  };
  const removing = decision === "removed";
  const submitButton = (
    <Button
      data-testid="ncii-decide-submit"
      type={removing ? "button" : "submit"}
      variant={removing ? "destructive" : "default"}
      disabled={!ready || pending}
      aria-busy={pending || undefined}
    >
      {t("safety.modq.nciiSubmit")}
    </Button>
  );
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!removing) void runDirect();
      }}
      noValidate
    >
      <ChoiceToggle
        data-testid="ncii-decision"
        label={t("safety.modq.nciiDecision")}
        value={decision}
        onValueChange={(v) => {
          if (v === "removed" || v === "rejected") setDecision(v);
        }}
        options={[
          { value: "removed", label: t("safety.modq.nciiRemove"), "data-testid": "ncii-decision-removed" },
          { value: "rejected", label: t("safety.modq.nciiReject"), "data-testid": "ncii-decision-rejected" },
        ]}
      />
      <Field>
        <FieldLabel htmlFor={noteId}>{t("safety.modq.note")}</FieldLabel>
        <Textarea
          id={noteId}
          data-testid="ncii-note"
          rows={3}
          required
          maxLength={NOTE_MAX}
          value={note}
          onChange={(e) => setNote(e.currentTarget.value)}
        />
        <FieldDescription>{t("safety.modq.nciiNoteHint")}</FieldDescription>
      </Field>
      <div>
        {removing ? (
          <ConfirmDialog
            trigger={submitButton}
            title={t("safety.modq.nciiConfirmTitle")}
            description={t("safety.modq.nciiConfirmBody")}
            confirmLabel={t("safety.modq.nciiRemove")}
            variant="destructive"
            onConfirm={run}
            onError={(err) => toastActionError(err, t("safety.modq.nciiFailed"))}
          />
        ) : (
          submitButton
        )}
      </div>
    </form>
  );
}
