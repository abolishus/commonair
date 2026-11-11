// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/admin/moderation` pieces (moderators, admins, `legal`). T1/T2 frames are fetched one by one
 * with `moderation.frame`, shown blurred and grayscale, and revealed one at a time; the bytes
 * live only in this component tree's state. T0 cases never reach this page (the API answers
 * NOT_FOUND for them here); they are on `/admin/legal`.
 *
 * Overhaul wave 4 (D7.5): every tab is a `QueueLayout` (the list beside the open item at lg and
 * up, j/k/Enter/e/?), with claiming (`moderation.assign`, `?assignee=`) and the two bulk actions
 * policy allows: assigning cases and dismissing reports. Decisions are never made in bulk.
 */
import {
  ConfirmDialog,
  EmptyState,
  IconButton,
  RelativeTime,
  SkeletonGroup,
  SkeletonText,
  StatusBadge,
} from "@commonair/ui";
import { FilterBar, KeyValueList } from "@commonair/ui/blocks/data";
import { AlertCallout, DeadlineCountdown } from "@commonair/ui/blocks/feedback";
import { ChoiceToggle, NoteDialog, SelectField } from "@commonair/ui/blocks/forms";
import { PageTabs, Section } from "@commonair/ui/blocks/headers";
import { FrameTile } from "@commonair/ui/blocks/media";
import { Button } from "@commonair/ui/components/button";
import { Checkbox } from "@commonair/ui/components/checkbox";
import { Field, FieldDescription, FieldLabel } from "@commonair/ui/components/field";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@commonair/ui/components/item";
import { Label } from "@commonair/ui/components/label";
import { Textarea } from "@commonair/ui/components/textarea";
import { QueueLayout, type QueueShortcutsCopy } from "@commonair/ui/layouts";
import { toast } from "@commonair/ui/toast";
import { Cancel01Icon, CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { auditActionLabel } from "../admin/console-labels.ts";
import { FormError } from "../form-error.tsx";
import { useLoad, usePaged } from "../money/use-load.ts";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { errorCode } from "../../lib/api.ts";
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
import { WatchRoomEvidence } from "./watch-room-evidence.tsx";

export const NOTE_MAX = 2000;
const SLA_WARN_MS = 5 * 60_000;
const NCII_WARN_MS = 12 * 60 * 60_000;

export const MOD_TABS = ["cases", "labels", "reports", "ncii"] as const;
export type ModTab = (typeof MOD_TABS)[number];
type Selection = { kind: "case" | "report" | "ncii"; id: string } | null;

/** D7.5 claiming: the cases and labels tabs show everyone's cases, the caller's, or unclaimed ones. */
export const ASSIGNEE_FILTERS = ["me", "unassigned"] as const;
export type AssigneeFilter = (typeof ASSIGNEE_FILTERS)[number];
const isAssigneeFilter = (v: unknown): v is AssigneeFilter =>
  typeof v === "string" && (ASSIGNEE_FILTERS as readonly string[]).includes(v);

/** Where the queue is: its tab, the selected case, report or NCII request (null = none), and the claim filter. */
export interface ModQueueLocation {
  tab: ModTab;
  case: string | null;
  assignee?: AssigneeFilter;
}

/** `/admin/moderation`'s search params (docs/testing/b8-selectors.md): all optional. */
export type ModerationSearch = {
  tab?: ModTab;
  case?: string;
  assignee?: AssigneeFilter;
};

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isModTab = (v: unknown): v is ModTab => typeof v === "string" && (MOD_TABS as readonly string[]).includes(v);

/** `validateSearch` for `/admin/moderation`: an unknown tab or filter, or a malformed id, is dropped, never trusted. */
export function parseModerationSearch(raw: Record<string, unknown>): ModerationSearch {
  const out: ModerationSearch = {};
  if (isModTab(raw.tab)) out.tab = raw.tab;
  if (typeof raw.case === "string" && ID.test(raw.case)) out.case = raw.case.toLowerCase();
  if (isAssigneeFilter(raw.assignee)) out.assignee = raw.assignee;
  return out;
}

/** The search params for a location; the defaults (`cases`, nothing selected, every claim) are left out. */
export function moderationSearch(loc: ModQueueLocation): ModerationSearch {
  const out: ModerationSearch = {};
  if (loc.tab !== "cases") out.tab = loc.tab;
  if (loc.case !== null) out.case = loc.case;
  if (loc.assignee) out.assignee = loc.assignee;
  return out;
}

export function locationOf(search: ModerationSearch): ModQueueLocation {
  const loc: ModQueueLocation = { tab: search.tab ?? "cases", case: search.case ?? null };
  if (search.assignee) loc.assignee = search.assignee;
  return loc;
}

/** A location with the filter carried over (the key is left out when there is none). */
const withAssignee = (loc: ModQueueLocation, assignee: AssigneeFilter | undefined): ModQueueLocation =>
  assignee ? { ...loc, assignee } : loc;

/** The `?` dialog's list (QueueLayout); built per render so it follows the locale. */
export function queueShortcuts(): QueueShortcutsCopy {
  return {
    title: t("d7Admin.keys.title"),
    description: t("d7Admin.keys.description"),
    items: [
      { keys: ["j"], label: t("d7Admin.keys.next") },
      { keys: ["k"], label: t("d7Admin.keys.previous") },
      { keys: ["Enter"], label: t("d7Admin.keys.open") },
      { keys: ["e"], label: t("d7Admin.keys.decide") },
      { keys: ["?"], label: t("d7Admin.keys.help") },
    ],
  };
}

const KIND_OF_TAB: Record<ModTab, NonNullable<Selection>["kind"]> = {
  cases: "case",
  labels: "case",
  reports: "report",
  ncii: "ncii",
};

export interface ModQueueProps {
  /** Platform moderators and admins (reports need them; `legal` alone does not). */
  canReports: boolean;
  client?: ModerationClient;
  /**
   * The tab and selection from the URL (`?tab=&case=`); with `onLocationChange` the queue is
   * controlled by them, so a shared or reloaded URL reopens the same view (the route replaces the
   * history entry, so selections do not pile up in back and forward). Without, it keeps its own.
   */
  location?: ModQueueLocation;
  onLocationChange?: (next: ModQueueLocation) => void;
  /** The signed-in staff member (D7.5 claiming); without it the queue shows claims but offers none. */
  me?: { id: string; role: string } | null;
}

/** Runs `act` for each id in turn; how many succeeded (a conflict on one never stops the rest). */
export async function forEachSelected(ids: readonly string[], act: (id: string) => Promise<unknown>): Promise<number> {
  let done = 0;
  for (const id of ids) {
    try {
      await act(id);
      done += 1;
    } catch {
      // Reported once, as a count, by the caller.
    }
  }
  return done;
}

export function ModQueue({
  canReports,
  client: clientProp,
  location,
  onLocationChange,
  me,
}: ModQueueProps): React.JSX.Element {
  const [client] = React.useState(() => clientProp ?? moderationClient());
  const [own, setOwn] = React.useState<ModQueueLocation>(() => location ?? { tab: "cases", case: null });
  const controlled = onLocationChange !== undefined && location !== undefined;
  const loc = controlled ? location : own;
  const setLoc = (next: ModQueueLocation) => (controlled ? onLocationChange(next) : setOwn(next));
  // `legal` alone has no reports tab: a link to one opens the cases tab with nothing selected.
  const tab: ModTab = loc.tab === "reports" && !canReports ? "cases" : loc.tab;
  const assignee = loc.assignee;
  const selected: Selection = loc.case !== null && tab === loc.tab ? { kind: KIND_OF_TAB[tab], id: loc.case } : null;
  const setTab = (next: ModTab) => setLoc(withAssignee({ tab: next, case: null }, assignee));
  const setSelected = (next: Selection) => setLoc(withAssignee({ tab, case: next?.id ?? null }, assignee));
  const setAssignee = (next: AssigneeFilter | undefined) => setLoc(withAssignee({ tab, case: null }, next));
  // Rows ticked for a bulk action, per tab (switching tabs starts over).
  const [ticked, setTicked] = React.useState<{ tab: ModTab; ids: ReadonlySet<string> }>({ tab, ids: new Set() });
  const checked = ticked.tab === tab ? ticked.ids : new Set<string>();
  const check = (id: string, on: boolean) => {
    const ids = new Set(checked);
    if (on) ids.add(id);
    else ids.delete(id);
    setTicked({ tab, ids });
  };
  const clearChecked = () => setTicked({ tab, ids: new Set() });
  const selectAllId = React.useId();
  const canClaim = me !== null && me !== undefined && client.assign !== undefined;

  const moreFailed = (err: unknown) => toastActionError(err, t("safety.modq.loadMoreFailed"));
  const claimFilter = assignee ? { assignee } : {};
  const cases = usePaged(
    `t1|${assignee ?? ""}`,
    (cursor) => client.cases({ tier: "t1", status: "open", cursor, ...claimFilter }),
    moreFailed,
  );
  // Labelled cases are decided: they cannot be claimed, so the claim filter never applies to them.
  const labels = usePaged("t2", (cursor) => client.cases({ tier: "t2", status: "labelled", cursor }), moreFailed);
  // `legal` alone may not read reports: never ask.
  const reports = usePaged(
    canReports ? "reports" : "none",
    (cursor) => (canReports ? client.reports(cursor) : Promise.resolve({ items: [], nextCursor: null })),
    moreFailed,
  );
  const ncii = usePaged("ncii", (cursor) => client.ncii(cursor), moreFailed);

  const report = selected?.kind === "report" ? reports.items?.find((r) => r.id === selected.id) : undefined;
  const request = selected?.kind === "ncii" ? ncii.items?.find((r) => r.id === selected.id) : undefined;

  // A linked report or NCII request (a shared URL) not on the loaded pages: load the next page while
  // there is one; once the open queue is exhausted, there is no procedure to read one by id, so say
  // so and clear the selection.
  const unseenReport = selected?.kind === "report" && reports.items !== null && report === undefined;
  const unseenNcii = selected?.kind === "ncii" && ncii.items !== null && request === undefined;
  const missing = (unseenReport && !reports.hasMore) || (unseenNcii && !ncii.hasMore);
  const seekRef = React.useRef(() => {});
  React.useEffect(() => {
    seekRef.current = () => {
      if (unseenReport && reports.hasMore && !reports.loadingMore) reports.loadMore();
      if (unseenNcii && ncii.hasMore && !ncii.loadingMore) ncii.loadMore();
    };
  });
  const seeking =
    (unseenReport && reports.hasMore && !reports.loadingMore) || (unseenNcii && ncii.hasMore && !ncii.loadingMore);
  const loadedCount = (reports.items?.length ?? 0) + (ncii.items?.length ?? 0);
  React.useEffect(() => {
    if (seeking) seekRef.current();
  }, [seeking, loadedCount]);
  // The latest `setSelected` (a fresh closure every render), so the effect runs once per miss.
  const clearRef = React.useRef(() => setSelected(null));
  React.useEffect(() => {
    clearRef.current = () => setSelected(null);
  });
  React.useEffect(() => {
    if (!missing) return;
    toast.error(t("jury.link.notInQueue"));
    clearRef.current();
  }, [missing]);

  const reloadCases = () => {
    cases.reload();
    labels.reload();
  };
  const detail: React.ReactNode | null =
    selected?.kind === "case" ? (
      // Keyed: a new case starts blurred, with its own frames.
      <CaseDetail
        key={selected.id}
        id={selected.id}
        client={client}
        me={canClaim ? me : null}
        // The decided case stays open, refreshed, so the moderator sees its new status and history.
        onDecided={reloadCases}
        // A linked case (`?case=`) that does not exist, or is not this page's (T0): clear it.
        onMissing={() => {
          toast.error(t("jury.link.caseNotFound"));
          setSelected(null);
        }}
      />
    ) : report ? (
      <ReportDetail
        key={report.id}
        report={report}
        lookup={client.userNames}
        onResolve={async (status, resolution) => {
          await client.resolveReport({ id: report.id, status, resolution });
          setSelected(null);
          reports.reload();
        }}
      />
    ) : request ? (
      <NciiDetail
        key={request.id}
        request={request}
        onDecide={async (decision, note) => {
          await client.decideNcii({ id: request.id, decision, note });
          setSelected(null);
          ncii.reload();
        }}
      />
    ) : null;

  const shortcuts = queueShortcuts();
  const loadedLabel = (paged: { items: unknown[] | null; hasMore: boolean }) =>
    paged.items === null
      ? undefined
      : paged.hasMore
        ? t("d7Admin.queue.countMore", { count: paged.items.length })
        : paged.items.length;
  const resultsLine = (paged: { items: unknown[] | null; hasMore: boolean }, selectable: boolean, ids: string[]) =>
    paged.items === null ? null : (
      <>
        <span data-testid="modq-count">
          {paged.hasMore
            ? t("d7Admin.queue.resultsMore", { count: paged.items.length })
            : t("d7Admin.queue.results", { count: paged.items.length })}
        </span>
        {selectable && ids.length > 0 ? (
          <span className="flex items-center gap-2">
            <Checkbox
              id={selectAllId}
              data-testid="modq-select-all"
              checked={ids.every((id) => checked.has(id))}
              onCheckedChange={(on) => setTicked({ tab, ids: on ? new Set(ids) : new Set() })}
            />
            <Label htmlFor={selectAllId} className="text-xs">
              {t("d7Admin.queue.selectAll")}
            </Label>
          </span>
        ) : null}
      </>
    );
  const claimFilterBar = (
    <FilterBar
      data-testid="modq-filter-assignee"
      toggleLabel={t("d7Admin.claim.filter")}
      toggleValue={assignee ?? "all"}
      toggleOptions={[
        { value: "all", label: t("d7Admin.claim.filterAll") },
        { value: "me", label: t("d7Admin.claim.filterMine") },
        { value: "unassigned", label: t("d7Admin.claim.filterUnassigned") },
      ]}
      onToggleChange={(v) => setAssignee(isAssigneeFilter(v) ? v : undefined)}
    />
  );

  const assignChecked = async () => {
    if (!canClaim || !me || !client.assign) return;
    const assign = client.assign;
    const ids = [...checked];
    const done = await forEachSelected(ids, (id) => assign(id, me.id));
    if (done === ids.length) toast.success(t("d7Admin.bulk.assigned", { count: done }));
    else toast.error(t("d7Admin.bulk.assignedSome", { done, count: ids.length }));
    clearChecked();
    reloadCases();
  };
  const dismissChecked = async (note: string) => {
    const ids = [...checked];
    const done = await forEachSelected(ids, (id) =>
      client.resolveReport({ id, status: "dismissed", resolution: note }),
    );
    if (done === ids.length) toast.success(t("d7Admin.bulk.dismissed", { count: done }));
    else toast.error(t("d7Admin.bulk.dismissedSome", { done, count: ids.length }));
    clearChecked();
    if (selected?.kind === "report" && checked.has(selected.id)) setSelected(null);
    reports.reload();
  };
  const bulkBar = (actions: React.ReactNode) =>
    checked.size === 0 ? null : (
      <>
        <span data-testid="modq-bulk-count" className="text-sm font-medium tabular-nums">
          {t("d7Admin.bulk.selected", { count: checked.size })}
        </span>
        {actions}
        <IconButton
          className="ms-auto"
          variant="ghost"
          size="icon-sm"
          icon={Cancel01Icon}
          label={t("d7Admin.bulk.clear")}
          data-testid="modq-bulk-clear"
          onClick={clearChecked}
        />
      </>
    );
  const caseBulk = bulkBar(
    canClaim ? (
      <Button data-testid="modq-bulk-assign" variant="outline" size="sm" onClick={() => void assignChecked()}>
        {t("d7Admin.claim.assignMe")}
      </Button>
    ) : null,
  );
  const reportBulk = bulkBar(
    <NoteDialog
      trigger={
        <Button data-testid="modq-bulk-dismiss" variant="outline" size="sm">
          {t("d7Admin.bulk.dismiss")}
        </Button>
      }
      title={t("d7Admin.bulk.dismissTitle", { count: checked.size })}
      description={t("d7Admin.bulk.dismissBody")}
      noteLabel={t("safety.modq.note")}
      noteHint={t("safety.modq.noteHint")}
      noteRequired
      maxLength={NOTE_MAX}
      submitLabel={t("d7Admin.bulk.dismiss")}
      noteProps={{ "data-testid": "modq-bulk-dismiss-note" }}
      submitProps={{ "data-testid": "modq-bulk-dismiss-submit" }}
      onSubmit={dismissChecked}
    />,
  );

  const queue = (opts: {
    listLabel: string;
    list: React.ReactNode;
    count: React.ReactNode;
    filters?: React.ReactNode;
    bulk?: React.ReactNode;
  }) => (
    <QueueLayout
      className="pt-4"
      listLabel={opts.listLabel}
      detailLabel={t("d7Admin.queue.detail")}
      filters={opts.filters}
      count={opts.count}
      list={opts.list}
      detail={detail}
      detailEmpty={t("d7Admin.queue.pick")}
      onBack={() => setSelected(null)}
      backLabel={t("d7Admin.queue.back")}
      bulk={opts.bulk}
      bulkLabel={t("d7Admin.bulk.label")}
      shortcuts={shortcuts}
    />
  );
  // Only open cases can be claimed (planAssign), so the labels tab gets no selection, bulk bar or claim filter.
  const caseTab = (paged: typeof cases, label: string, claimable: boolean) =>
    queue({
      listLabel: label,
      filters: claimable ? claimFilterBar : undefined,
      count: resultsLine(
        paged,
        claimable,
        (paged.items ?? []).map((c) => c.id),
      ),
      bulk: claimable ? caseBulk : undefined,
      list: (
        <>
          {paged.failed && <FormError>{t("safety.modq.loadFailed")}</FormError>}
          <CaseList
            cases={paged.items ?? (paged.failed ? [] : null)}
            selectedId={selected?.kind === "case" ? selected.id : null}
            onSelect={(id) => setSelected({ kind: "case", id })}
            checked={claimable ? checked : undefined}
            onCheck={claimable ? check : undefined}
            meId={me?.id ?? null}
          />
          {paged.hasMore && <LoadMore loading={paged.loadingMore} onClick={paged.loadMore} />}
        </>
      ),
    });

  const items = [
    {
      id: "cases",
      label: t("safety.modq.tab.cases"),
      "data-testid": "modq-tab-cases",
      count: loadedLabel(cases),
      content: caseTab(cases, t("safety.modq.tab.cases"), true),
    },
    {
      id: "labels",
      label: t("safety.modq.tab.labels"),
      "data-testid": "modq-tab-labels",
      count: loadedLabel(labels),
      content: caseTab(labels, t("safety.modq.tab.labels"), false),
    },
    ...(canReports
      ? [
          {
            id: "reports",
            label: t("safety.modq.tab.reports"),
            "data-testid": "modq-tab-reports",
            count: loadedLabel(reports),
            content: queue({
              listLabel: t("safety.modq.tab.reports"),
              count: resultsLine(
                reports,
                true,
                (reports.items ?? []).map((r) => r.id),
              ),
              bulk: reportBulk,
              list: (
                <>
                  {reports.failed && <FormError>{t("safety.modq.loadFailed")}</FormError>}
                  <ReportList
                    reports={reports.items ?? (reports.failed ? [] : null)}
                    selectedId={selected?.kind === "report" ? selected.id : null}
                    onSelect={(id) => setSelected({ kind: "report", id })}
                    checked={checked}
                    onCheck={check}
                  />
                  {reports.hasMore && <LoadMore loading={reports.loadingMore} onClick={reports.loadMore} />}
                </>
              ),
            }),
          },
        ]
      : []),
    {
      id: "ncii",
      label: t("safety.modq.tab.ncii"),
      "data-testid": "modq-tab-ncii",
      count: loadedLabel(ncii),
      // NCII decisions are each a reasoned legal decision: no bulk actions here.
      content: queue({
        listLabel: t("safety.modq.tab.ncii"),
        count: resultsLine(ncii, false, []),
        list: (
          <>
            {ncii.failed && <FormError>{t("safety.modq.loadFailed")}</FormError>}
            <NciiList
              requests={ncii.items ?? (ncii.failed ? [] : null)}
              selectedId={selected?.kind === "ncii" ? selected.id : null}
              onSelect={(id) => setSelected({ kind: "ncii", id })}
            />
            {ncii.hasMore && <LoadMore loading={ncii.loadingMore} onClick={ncii.loadMore} />}
          </>
        ),
      }),
    },
  ];

  return (
    <div data-testid="modq" className="flex flex-col gap-6">
      <p className="hidden text-xs text-muted-foreground lg:block">{t("d7Admin.keys.hint")}</p>
      <PageTabs
        aria-label={t("safety.modq.tabs")}
        value={tab}
        onValueChange={(next) => {
          if (isModTab(next)) setTab(next);
        }}
        items={items}
      />
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
      // QueueLayout's j/k move between these; Enter opens the focused one.
      data-queue-row=""
      onClick={onClick}
    >
      {t("safety.modq.open")}
    </Button>
  );
}

// ── Cases ────────────────────────────────────────────────────────────────────────────────────

/** The row's bulk-selection box (D7.5), named after what the row opens. */
function RowCheck({
  id,
  label,
  checked,
  onCheck,
}: {
  id: string;
  label: string;
  checked?: ReadonlySet<string>;
  onCheck?: (id: string, on: boolean) => void;
}): React.JSX.Element | null {
  if (!checked || !onCheck) return null;
  return (
    <Checkbox
      data-testid="modq-item-check"
      aria-label={t("d7Admin.bulk.select", { item: label })}
      checked={checked.has(id)}
      onCheckedChange={(on) => onCheck(id, on)}
    />
  );
}

/** Who holds the case: "You", their username, or nothing while it is unclaimed. */
function ClaimBadge({ assignee, meId }: { assignee: ModerationCaseDto["assignee"]; meId: string | null }) {
  if (!assignee) return null;
  return (
    <StatusBadge data-testid="modq-item-assignee" data-assignee-id={assignee.id} tone="neutral">
      {assignee.id === meId ? t("d7Admin.claim.you") : `@${assignee.username}`}
    </StatusBadge>
  );
}

export function CaseList({
  cases,
  selectedId,
  onSelect,
  checked,
  onCheck,
  meId = null,
}: {
  cases: ModerationCaseDto[] | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Bulk selection (assign); without it the rows have no boxes. */
  checked?: ReadonlySet<string>;
  onCheck?: (id: string, on: boolean) => void;
  meId?: string | null;
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
            data-assignee-id={c.assignee?.id ?? ""}
            variant={selectedId === c.id ? "muted" : "outline"}
            size="sm"
          >
            <RowCheck id={c.id} label={subject} checked={checked} onCheck={onCheck} />
            <ItemContent>
              <ItemTitle>
                <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
                {c.category ? categoryLabel(c.category) : t("safety.modq.noCategory")}
              </ItemTitle>
              <ItemDescription>{subject}</ItemDescription>
              <ClaimBadge assignee={c.assignee} meId={meId} />
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
  onMissing,
  me = null,
}: {
  id: string;
  client: ModerationClient;
  onDecided: () => void;
  /** The API answered NOT_FOUND for `id` (a stale or mistyped link). */
  onMissing?: () => void;
  /** The signed-in staff member: with `client.assign`, the case offers Assign to me / Unassign. */
  me?: { id: string; role: string } | null;
}): React.JSX.Element {
  const missingRef = React.useRef(onMissing);
  React.useEffect(() => {
    missingRef.current = onMissing;
  });
  // Fetched by id, so a case that is not on the loaded page (a closed one from a jury flag) opens
  // too; a closed case is read-only, as `CaseDetailView` shows no review form for it.
  const loaded = useLoad(`case|${id}`, () =>
    client.case(id).catch((err: unknown) => {
      if (errorCode(err) === "NOT_FOUND") missingRef.current?.();
      throw err;
    }),
  );
  if (loaded.failed && !loaded.data) return <FormError>{t("safety.modq.caseFailed")}</FormError>;
  if (!loaded.data) return <Loading />;
  const assign = client.assign;
  return (
    <CaseDetailView
      detail={loaded.data}
      loadFrame={(flagId) => client.frame(flagId)}
      onReview={async (input) => {
        await client.review({ id, ...input });
        loaded.reload();
        onDecided();
      }}
      claim={
        me && assign
          ? {
              meId: me.id,
              isAdmin: me.role === "admin",
              onAssign: async (assigneeId) => {
                await assign(id, assigneeId);
                loaded.reload();
                onDecided();
              },
            }
          : undefined
      }
    />
  );
}

export interface ClaimControl {
  meId: string;
  isAdmin: boolean;
  onAssign: (assigneeId: string | null) => Promise<void>;
}

/**
 * D7.5 claiming: who holds the case, and Assign to me or Unassign, so two moderators never decide
 * the same case. Someone else's claim can only be taken over by an admin (the API's rule too).
 */
export function CaseClaim({
  assignee: given,
  open,
  claim,
}: {
  /** Undefined from a stub that predates claiming: shown as unclaimed. */
  assignee: ModerationCaseDto["assignee"] | undefined;
  open: boolean;
  claim?: ClaimControl;
}): React.JSX.Element {
  const [pending, setPending] = React.useState(false);
  const assignee = given ?? null;
  const mine = assignee !== null && assignee.id === claim?.meId;
  const run = async (assigneeId: string | null) => {
    if (!claim || pending) return;
    setPending(true);
    try {
      await claim.onAssign(assigneeId);
      toast.success(assigneeId ? t("d7Admin.claim.claimed") : t("d7Admin.claim.released"));
    } catch (err) {
      toastActionError(err, t("d7Admin.claim.failed"));
    } finally {
      setPending(false);
    }
  };
  const canTake = claim !== undefined && open && !mine && (assignee === null || claim.isAdmin);
  return (
    <div
      data-testid="modq-claim"
      data-assignee-id={assignee?.id ?? ""}
      className="flex min-w-0 flex-wrap items-center gap-2 text-sm"
    >
      <span className="text-muted-foreground">
        {assignee === null
          ? t("d7Admin.claim.unassigned")
          : mine
            ? t("d7Admin.claim.assignedYou")
            : t("d7Admin.claim.assignedTo", { username: assignee.username })}
      </span>
      {canTake ? (
        <Button
          data-testid="modq-claim-me"
          variant="outline"
          size="sm"
          disabled={pending}
          aria-busy={pending || undefined}
          onClick={() => void run(claim.meId)}
        >
          {t("d7Admin.claim.assignMe")}
        </Button>
      ) : null}
      {claim && assignee !== null && (mine || claim.isAdmin) ? (
        <Button
          data-testid="modq-claim-release"
          variant="ghost"
          size="sm"
          disabled={pending}
          aria-busy={pending || undefined}
          onClick={() => void run(null)}
        >
          {t("d7Admin.claim.release")}
        </Button>
      ) : null}
    </div>
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
  claim,
}: {
  detail: ModerationCaseDetailDto;
  loadFrame: ModerationClient["frame"];
  onReview: (input: ReviewInput) => Promise<void>;
  claim?: ClaimControl;
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
        <CaseClaim assignee={detail.assignee} open={detail.status === "open"} claim={claim} />
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
              <ItemTitle>{auditActionLabel(row.action) ?? row.action}</ItemTitle>
              {auditActionLabel(row.action) ? (
                <span className="text-xs text-muted-foreground tabular-nums">{row.action}</span>
              ) : null}
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
      {/* QueueLayout's `e` focuses the decision. */}
      <div data-queue-decision="">
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
      </div>
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
  checked,
  onCheck,
}: {
  reports: ReportDto[] | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Bulk selection (dismiss); without it the rows have no boxes. */
  checked?: ReadonlySet<string>;
  onCheck?: (id: string, on: boolean) => void;
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
          <RowCheck id={r.id} label={reportReasonLabel(r.reason)} checked={checked} onCheck={onCheck} />
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
  lookup,
}: {
  report: ReportDto;
  onResolve: (status: "actioned" | "dismissed", resolution: string) => Promise<void>;
  /** Usernames for evidence user ids (stable across renders: the evidence effect depends on it). */
  lookup?: ModerationClient["userNames"];
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
        {report.subjectType === "watch_room" ? (
          <WatchRoomEvidence reportId={report.id} evidence={report.evidence} lookup={lookup} />
        ) : null}
        <div data-queue-decision="">
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
        </div>
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
      <div data-queue-decision="">
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
      </div>
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
