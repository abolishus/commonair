// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The studio analytics page (W2-rollup-analytics, decision (k), feature-wins §4.9;
 * docs/testing/w2-selectors.md "Analytics"): a period and a broadcast picker, the period's totals,
 * and per broadcast its verified and unverified watch time, the audience chart (with a table
 * fallback), excluded groups by category (each with the group-appeal action), the delivery mix, the
 * marginal cost and share links. Groups under 5 sessions arrive from the API already hidden.
 */
import type { AnalyticsRange, AnalyticsShareLink, BroadcastAnalytics } from "@commonair/contracts/dto";
import {
  ConfirmDialog,
  EmptyState,
  MoneyAmount,
  RelativeTime,
  SkeletonGroup,
  SkeletonText,
  ViewerCount,
  formatBytes,
  formatDateTime,
  formatNumber,
  formatPercent,
  useLocale,
} from "@commonair/ui";
import { DataTable, type DataTableColumn, StatCard, StatGrid, TrendChart } from "@commonair/ui/blocks/data";
import { CopyField } from "@commonair/ui/blocks/forms";
import { Section } from "@commonair/ui/blocks/headers";
import { ToggleGroup, ToggleGroupItem } from "@commonair/ui/components/toggle-group";
import { Button } from "@commonair/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@commonair/ui/components/collapsible";
import { Label } from "@commonair/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@commonair/ui/components/select";
import { toast } from "@commonair/ui/toast";
import { Chart01Icon, Clock01Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { AttestationsPanel } from "../attestations/panel.tsx";
import { FormError } from "../form-error.tsx";
import { useLoad } from "../money/use-load.ts";
import { type AnalyticsClient, analyticsClient, isPending } from "./client.ts";
import {
  DEFAULT_RANGE_DAYS,
  RANGE_DAYS,
  type RangeBroadcast,
  deliveryShares,
  hoursOf,
  minuteRows,
  parseRangeDays,
  pickBroadcast,
  rangeFor,
} from "./data.ts";
import { GroupAppealAction } from "./group-appeal.tsx";
import { audienceTrend, formatDayLabel, periodDelta, previousPeriod } from "../studio/trends.ts";

export interface AnalyticsViewProps {
  channel: string;
  /** The request time: the period ends here (server render and hydration agree). */
  now: number;
  client?: AnalyticsClient;
  /**
   * The page header, which lives in the route (F26); it gets the period picker for its actions.
   * Without it the picker renders on its own.
   */
  header?: (rangePicker: React.ReactNode) => React.ReactNode;
  /** The empty period's way forward (F25); the route passes "Open stream manager". */
  emptyAction?: React.ReactNode;
}

export function AnalyticsView({
  channel,
  now,
  client: clientProp,
  header,
  emptyAction,
}: AnalyticsViewProps): React.JSX.Element {
  const [client] = React.useState(() => clientProp ?? analyticsClient());
  const [days, setDays] = React.useState(DEFAULT_RANGE_DAYS);
  const [wanted, setWanted] = React.useState<string | null>(null);
  const period = rangeFor(days, now);
  const before = previousPeriod(period);
  const range = useLoad(`${channel}|${days}`, () => client.range({ channel, ...period }));
  // The previous period, for each card's delta; a failure only drops the deltas.
  const previous = useLoad(`prev|${channel}|${days}`, () => client.range({ channel, ...before }));
  const follows = useLoad(`follows|${channel}|${days}`, () =>
    client.followsSince ? client.followsSince({ channel, since: before.from }) : Promise.resolve(null),
  );
  const selected = range.data ? pickBroadcast(range.data.broadcasts, wanted) : null;
  const picker = <RangePicker days={days} onChange={setDays} />;

  return (
    <div data-testid="analytics-page" className="flex flex-col gap-6">
      {header ? header(picker) : picker}
      {range.failed ? (
        <div className="flex flex-col items-start gap-3">
          <FormError>{t("analytics.loadFailed")}</FormError>
          <Button variant="outline" size="sm" onClick={range.reload}>
            {t("analytics.retry")}
          </Button>
        </div>
      ) : range.data === null ? (
        <SkeletonGroup label={t("analytics.loading")}>
          <SkeletonText lines={6} />
        </SkeletonGroup>
      ) : range.data.broadcasts.length === 0 ? (
        <EmptyState
          data-testid="analytics-empty"
          icon={Chart01Icon}
          title={t("analytics.empty.title")}
          description={t("analytics.empty.description")}
          headingLevel={2}
          action={emptyAction}
        />
      ) : (
        <>
          <RangeSummary
            range={range.data}
            previous={previous.data}
            follows={follows.data ? splitFollows(follows.data, period) : null}
          />
          <RangeTrend
            period={period}
            range={range.data}
            followedAt={follows.data && follows.data.complete ? follows.data.at : null}
          />
          <BroadcastPicker broadcasts={range.data.broadcasts} value={selected} onChange={setWanted} />
          {selected ? (
            <BroadcastSection key={selected} channel={channel} broadcastId={selected} client={client} />
          ) : null}
        </>
      )}
    </div>
  );
}

export interface FollowSplit {
  current: number;
  /** Null when the list did not reach back past this period's start. */
  previous: number | null;
  /** The paging cap stopped inside this period: `current` is a floor, not the figure. */
  capped: boolean;
}

/**
 * Follows in this period and, when the list reached back that far, in the one before. The list is
 * newest first, so when the cap stopped it and its oldest entry is still inside the period, the
 * count is only "at least".
 */
export function splitFollows(
  follows: { at: string[]; complete: boolean },
  period: { from: string; to: string },
): FollowSplit {
  const from = Date.parse(period.from);
  const to = Date.parse(period.to);
  const current = follows.at.filter((a) => {
    const ms = Date.parse(a);
    return ms >= from && ms < to;
  }).length;
  const previous = follows.at.filter((a) => Date.parse(a) < from).length;
  const oldest = follows.at.at(-1);
  const capped = !follows.complete && (oldest === undefined || Date.parse(oldest) >= from);
  return { current, previous: follows.complete ? previous : null, capped };
}

type TrendMetric = "hours" | "peak" | "followers";
const METRICS: readonly TrendMetric[] = ["hours", "peak", "followers"];

/** F24: the period by day, one metric at a time (their scales differ), with a table fallback. */
export function RangeTrend({
  period,
  range,
  followedAt,
}: {
  period: { from: string; to: string };
  range: AnalyticsRange;
  /** Null when the follower list is not available (or not complete): the metric is then not offered. */
  followedAt: readonly string[] | null;
}): React.JSX.Element {
  const { locale } = useLocale();
  const [metric, setMetric] = React.useState<TrendMetric>("hours");
  const metrics = followedAt === null ? METRICS.filter((m) => m !== "followers") : METRICS;
  const shown = metrics.includes(metric) ? metric : "hours";
  const rows = audienceTrend(period, range.broadcasts, followedAt ?? []).map((r) => ({
    ...r,
    day: formatDayLabel(r.date, locale),
  }));
  const labels: Record<TrendMetric, string> = {
    hours: t("studio.trend.hours"),
    peak: t("studio.trend.peak"),
    followers: t("studio.trend.followers"),
  };
  const color: Record<TrendMetric, "--chart-1" | "--chart-2" | "--chart-4"> = {
    hours: "--chart-1",
    peak: "--chart-2",
    followers: "--chart-4",
  };
  const format = (v: number) => formatNumber(v, locale);
  type Row = (typeof rows)[number];
  const columns: DataTableColumn<Row>[] = [
    { id: "day", header: t("studio.trend.day"), cell: ({ row }) => row.original.day },
    ...metrics.map((m): DataTableColumn<Row> => ({
      id: m,
      header: labels[m],
      align: "numeric",
      cell: ({ row }) => format(row.original[m]),
    })),
  ];
  const id = React.useId();
  return (
    <Section heading={t("studio.trend.heading")} description={t("studio.trend.hint")}>
      <div data-testid="analytics-trend" data-metric={shown} data-days={rows.length} className="flex flex-col gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <Label id={`${id}-metric`} className="text-xs text-muted-foreground">
            {t("studio.trend.metric")}
          </Label>
          <ToggleGroup
            aria-labelledby={`${id}-metric`}
            value={[shown]}
            onValueChange={(next: unknown[]) => {
              const v = next[0];
              if (v === "hours" || v === "peak" || v === "followers") setMetric(v);
            }}
            variant="outline"
            size="sm"
            className="flex-wrap"
          >
            {metrics.map((m) => (
              <ToggleGroupItem key={m} value={m} data-testid="analytics-trend-metric" data-value={m}>
                {labels[m]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        <TrendChart
          data={rows}
          xKey="day"
          legend="bottom"
          allowDecimals={shown === "hours"}
          formatValue={format}
          ariaLabel={t("studio.trend.label", { metric: labels[shown] })}
          series={[{ key: shown, label: labels[shown], color: color[shown] }]}
        />
        <Collapsible>
          <CollapsibleTrigger render={<Button variant="outline" size="sm" />}>
            {t("studio.trend.showTable")}
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3">
            <DataTable
              data-testid="analytics-trend-table"
              caption={t("studio.trend.heading")}
              columns={columns}
              rows={rows}
              getRowId={(r) => r.date}
            />
          </CollapsibleContent>
        </Collapsible>
      </div>
    </Section>
  );
}

function RangePicker({ days, onChange }: { days: number; onChange: (days: number) => void }): React.JSX.Element {
  const id = React.useId();
  const items = Object.fromEntries(RANGE_DAYS.map((d) => [String(d), t("analytics.range.option", { days: d })]));
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {t("analytics.range.label")}
      </Label>
      <Select<string>
        value={String(days)}
        items={items}
        onValueChange={(v) => v !== null && onChange(parseRangeDays(v))}
      >
        <SelectTrigger id={id} data-testid="analytics-range" data-value={String(days)} className="w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {RANGE_DAYS.map((d) => (
            <SelectItem key={d} value={String(d)} data-value={String(d)}>
              {items[String(d)]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function BroadcastPicker({
  broadcasts,
  value,
  onChange,
}: {
  broadcasts: readonly RangeBroadcast[];
  value: string | null;
  onChange: (id: string) => void;
}): React.JSX.Element {
  const { locale } = useLocale();
  const id = React.useId();
  const items = Object.fromEntries(
    broadcasts.map((b) => [
      b.broadcastId,
      t("analytics.broadcast.option", {
        title: b.title.trim() || t("analytics.broadcast.untitled"),
        date: formatDateTime(new Date(b.startedAt), locale),
      }),
    ]),
  );
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id} className="text-sm font-medium">
        {t("analytics.broadcast.label")}
      </Label>
      <Select<string> value={value} items={items} onValueChange={(v) => v !== null && onChange(v)}>
        <SelectTrigger
          id={id}
          data-testid="analytics-broadcast-select"
          data-value={value ?? ""}
          className="w-full max-w-xl"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {broadcasts.map((b) => (
            <SelectItem key={b.broadcastId} value={b.broadcastId} data-value={b.broadcastId}>
              {items[b.broadcastId]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function RangeSummary({
  range,
  previous,
  follows,
}: {
  range: AnalyticsRange;
  /** The period before, for the deltas; null while it loads or when it failed (no deltas then). */
  previous: AnalyticsRange | null;
  follows: FollowSplit | null;
}): React.JSX.Element {
  const { locale } = useLocale();
  const hours = (s: number) => t("analytics.hours", { hours: hoursOf(s, locale) });
  const prev = previous?.totals;
  return (
    <Section
      heading={t("analytics.range.heading")}
      description={t("analytics.range.broadcasts", { count: range.broadcasts.length })}
    >
      <StatGrid cols={4}>
        <StatCard
          size="sm"
          data-testid="analytics-range-verified"
          label={t("analytics.stat.verified")}
          value={hours(range.totals.verifiedViewerSeconds)}
          delta={periodDelta(range.totals.verifiedViewerSeconds, prev?.verifiedViewerSeconds, locale)}
        />
        <StatCard
          size="sm"
          data-testid="analytics-range-peak"
          label={t("analytics.stat.peak")}
          value={<ViewerCount count={range.totals.peakVerifiedConcurrent} icon={false} />}
          delta={periodDelta(range.totals.peakVerifiedConcurrent, prev?.peakVerifiedConcurrent, locale)}
        />
        {follows ? (
          <StatCard
            size="sm"
            data-testid="analytics-range-followers"
            label={t("studio.trend.followers")}
            data-capped={follows.capped || undefined}
            value={
              follows.capped
                ? t("studio.trend.followersAtLeast", { count: formatNumber(follows.current, locale) })
                : formatNumber(follows.current, locale)
            }
            // The list is today's followers: people who followed and left are not in either period.
            hint={follows.capped ? t("studio.trend.followersCappedHint") : t("studio.trend.followersHint")}
            delta={follows.capped ? undefined : periodDelta(follows.current, follows.previous, locale)}
          />
        ) : null}
        <StatCard
          size="sm"
          label={t("analytics.stat.unverified")}
          value={hours(range.totals.unverifiedViewerSeconds)}
        />
        <StatCard
          size="sm"
          label={t("analytics.stat.excluded")}
          value={hours(range.totals.excludedViewerSeconds)}
          hint={t("analytics.stat.excludedHint")}
          // More excluded time is not better: the arrow keeps its meaning, the colour flips.
          delta={periodDelta(range.totals.excludedViewerSeconds, prev?.excludedViewerSeconds, locale, {
            higherIsBetter: false,
          })}
        />
        {range.cost ? (
          <StatCard size="sm" label={t("analytics.stat.cost")} value={<MoneyAmount value={range.cost} />} />
        ) : null}
      </StatGrid>
    </Section>
  );
}

type Loaded = { kind: "ok"; data: BroadcastAnalytics } | { kind: "pending" };

function BroadcastSection({
  channel,
  broadcastId,
  client,
}: {
  channel: string;
  broadcastId: string;
  client: AnalyticsClient;
}): React.JSX.Element {
  const view = useLoad<Loaded>(`${channel}|${broadcastId}`, () =>
    client
      .broadcast({ channel, broadcastId })
      .then((data): Loaded => ({ kind: "ok", data }))
      .catch((err: unknown): Loaded => {
        if (isPending(err)) return { kind: "pending" };
        throw err;
      }),
  );
  if (view.failed)
    return (
      <div className="flex flex-col items-start gap-3">
        <FormError>{t("analytics.loadFailed")}</FormError>
        <Button variant="outline" size="sm" onClick={view.reload}>
          {t("analytics.retry")}
        </Button>
      </div>
    );
  if (view.data === null)
    return (
      <SkeletonGroup label={t("analytics.loading")}>
        <SkeletonText lines={8} />
      </SkeletonGroup>
    );
  if (view.data.kind === "pending")
    return (
      <EmptyState
        data-testid="analytics-pending"
        icon={Clock01Icon}
        title={t("analytics.pending.title")}
        description={t("analytics.pending.description")}
        headingLevel={2}
      />
    );
  return <BroadcastView analytics={view.data.data} channel={channel} client={client} />;
}

export function BroadcastView({
  analytics: a,
  channel,
  client,
}: {
  analytics: BroadcastAnalytics;
  channel: string;
  client: AnalyticsClient;
}): React.JSX.Element {
  const { locale } = useLocale();
  const hours = (s: number) => t("analytics.hours", { hours: hoursOf(s, locale) });
  return (
    <div className="flex flex-col gap-8" data-broadcast-id={a.broadcastId}>
      <StatGrid cols={a.cost ? 4 : 3}>
        <StatCard
          data-testid="analytics-verified"
          data-seconds={a.totals.verifiedViewerSeconds}
          label={t("analytics.stat.verified")}
          value={hours(a.totals.verifiedViewerSeconds)}
          hint={t("analytics.stat.verifiedHint")}
        />
        <StatCard
          data-testid="analytics-unverified"
          data-seconds={a.totals.unverifiedViewerSeconds}
          label={t("analytics.stat.unverified")}
          value={hours(a.totals.unverifiedViewerSeconds)}
          hint={t("analytics.stat.unverifiedHint")}
        />
        <StatCard
          label={t("analytics.stat.peak")}
          value={<ViewerCount count={a.totals.peakVerifiedConcurrent} icon={false} />}
          hint={t("analytics.stat.sessions", { count: a.totals.sessions })}
        />
        {a.cost ? (
          <StatCard
            data-testid="analytics-cost"
            data-cents={a.cost.cents}
            label={t("analytics.stat.cost")}
            value={<MoneyAmount value={a.cost} />}
            hint={t("analytics.stat.costHint")}
          />
        ) : null}
      </StatGrid>
      <AudienceChart analytics={a} />
      <Exclusions analytics={a} />
      <Delivery analytics={a} />
      <ShareLinks channel={channel} broadcastId={a.broadcastId} client={client} />
      <AttestationsPanel channel={channel} broadcastId={a.broadcastId} />
    </div>
  );
}

type MinuteRow = ReturnType<typeof minuteRows>[number];

function AudienceChart({ analytics: a }: { analytics: BroadcastAnalytics }): React.JSX.Element {
  const { locale } = useLocale();
  const rows = minuteRows(a);
  const series = [
    { key: "verified", label: t("analytics.chart.verified"), color: "--chart-1" as const },
    { key: "unverified", label: t("analytics.chart.unverified"), color: "--chart-3" as const },
    { key: "excluded", label: t("analytics.chart.excluded"), color: "--chart-5" as const },
  ];
  const columns: DataTableColumn<MinuteRow>[] = [
    { id: "offset", header: t("analytics.chart.minute"), cell: ({ row: { original: r } }) => r.offset },
    ...series.map((s): DataTableColumn<MinuteRow> => ({
      id: s.key,
      header: s.label,
      align: "numeric",
      cell: ({ row: { original: r } }) => formatNumber(r[s.key as "verified" | "unverified" | "excluded"], locale),
    })),
  ];
  return (
    <Section heading={t("analytics.chart.heading")}>
      {!a.minutesRetained ? (
        <p className="text-sm text-muted-foreground">{t("analytics.chart.notRetained")}</p>
      ) : (
        <>
          <TrendChart
            data={rows}
            series={series}
            xKey="offset"
            ariaLabel={t("analytics.chart.label")}
            legend="bottom"
            directLabels
            allowDecimals={false}
          />
          <Collapsible>
            <CollapsibleTrigger render={<Button variant="outline" size="sm" />}>
              {t("analytics.chart.showTable")}
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-3">
              <DataTable
                data-testid="analytics-chart-table"
                caption={t("analytics.chart.tableCaption")}
                columns={columns}
                rows={rows}
                getRowId={(r) => r.at}
              />
            </CollapsibleContent>
          </Collapsible>
        </>
      )}
    </Section>
  );
}

function Exclusions({ analytics: a }: { analytics: BroadcastAnalytics }): React.JSX.Element {
  const { locale } = useLocale();
  return (
    <Section heading={t("analytics.exclusions.heading")} description={t("analytics.exclusions.description")}>
      {a.exclusions.length === 0 && a.hiddenGroups === 0 ? (
        <p className="text-sm text-muted-foreground">{t("analytics.exclusions.none")}</p>
      ) : null}
      {a.exclusions.length > 0 ? (
        <ul className="flex flex-col divide-y rounded-lg border">
          {a.exclusions.map((g) => (
            <li
              key={g.category}
              data-testid="analytics-excluded-group"
              data-category={g.category}
              data-sessions={g.sessions}
              data-seconds={g.viewerSeconds}
              className="flex flex-wrap items-center justify-between gap-3 p-3"
            >
              <div className="flex min-w-0 flex-col">
                <span className="font-medium">{t("analytics.category", { category: g.category })}</span>
                <span className="text-sm text-muted-foreground">
                  {t("analytics.exclusions.group", { sessions: g.sessions, hours: hoursOf(g.viewerSeconds, locale) })}
                </span>
              </div>
              <GroupAppealAction broadcastId={a.broadcastId} category={g.category} sessions={g.sessions} />
            </li>
          ))}
        </ul>
      ) : null}
      {a.hiddenGroups > 0 ? (
        <p data-testid="analytics-small-groups-hidden" data-count={a.hiddenGroups} className="text-sm">
          {t("analytics.exclusions.hidden", { count: a.hiddenGroups })}{" "}
          <span className="text-muted-foreground">{t("analytics.exclusions.hiddenHint")}</span>
        </p>
      ) : null}
    </Section>
  );
}

function Delivery({ analytics: a }: { analytics: BroadcastAnalytics }): React.JSX.Element {
  const { locale } = useLocale();
  const shares = deliveryShares(a.delivery);
  return (
    <Section heading={t("analytics.delivery.heading")}>
      {a.delivery.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("analytics.delivery.none")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {a.delivery.map((d, i) => (
            <li
              key={d.source}
              data-testid="analytics-delivery-source"
              data-source={d.source}
              data-bytes={d.bytes}
              data-share-bps={shares[i] ?? 0}
              className="flex flex-col"
            >
              <span>
                {t("analytics.delivery.share", {
                  source: t("analytics.source", { source: d.source }),
                  share: formatPercent((shares[i] ?? 0) / 10_000, locale),
                })}
              </span>
              <span className="text-sm text-muted-foreground">
                {t("analytics.delivery.detail", {
                  bytes: formatBytes(d.bytes, locale),
                  hours: hoursOf(d.verifiedViewerSeconds, locale),
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function ShareLinks({
  channel,
  broadcastId,
  client,
}: {
  channel: string;
  broadcastId: string;
  client: AnalyticsClient;
}): React.JSX.Element {
  const links = useLoad(`links|${channel}`, () => client.shareLinks({ channel }));
  const [created, setCreated] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const mine = (links.data?.items ?? []).filter((l) => l.broadcastId === broadcastId);
  const create = () => {
    setBusy(true);
    client
      .createShareLink({ channel, broadcastId })
      .then((link) => {
        setCreated(link.url);
        toast.success(t("analytics.share.created"));
        links.reload();
      })
      .catch((err: unknown) => toastActionError(err, t("analytics.share.createFailed")))
      .finally(() => setBusy(false));
  };
  return (
    <Section
      heading={t("analytics.share.heading")}
      description={t("analytics.share.description")}
      action={
        <Button data-testid="analytics-share-create" size="sm" onClick={create} disabled={busy}>
          {t("analytics.share.create")}
        </Button>
      }
    >
      {created ? (
        <CopyField
          label={t("analytics.share.url")}
          value={created}
          hint={t("analytics.share.urlHint")}
          copyLabel={t("analytics.share.copy")}
          copiedLabel={t("analytics.share.copied")}
          copyFailedLabel={t("analytics.share.copyFailed")}
        />
      ) : null}
      {links.failed ? <FormError>{t("analytics.share.loadFailed")}</FormError> : null}
      {links.data && mine.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("analytics.share.none")}</p>
      ) : null}
      {mine.length > 0 ? (
        <ul className="flex flex-col divide-y rounded-lg border">
          {mine.map((l) => (
            <ShareLinkRow key={l.id} link={l} channel={channel} client={client} onRevoked={links.reload} />
          ))}
        </ul>
      ) : null}
    </Section>
  );
}

function ShareLinkRow({
  link,
  channel,
  client,
  onRevoked,
}: {
  link: AnalyticsShareLink;
  channel: string;
  client: AnalyticsClient;
  onRevoked: () => void;
}): React.JSX.Element {
  return (
    <li
      data-testid="analytics-share-link"
      data-link-id={link.id}
      data-expires-at={link.expiresAt}
      className="flex flex-wrap items-center justify-between gap-3 p-3"
    >
      <span className="text-sm">
        {link.revokedAt ? (
          <>
            {t("analytics.share.revoked")} <RelativeTime date={link.revokedAt} />
          </>
        ) : (
          <>
            {t("analytics.share.expires")} <RelativeTime date={link.expiresAt} />
          </>
        )}
      </span>
      {link.revokedAt ? null : (
        <ConfirmDialog
          trigger={
            <Button data-testid="analytics-share-revoke" variant="outline" size="sm">
              {t("analytics.share.revoke")}
            </Button>
          }
          title={t("analytics.share.revokeTitle")}
          description={t("analytics.share.revokeDescription")}
          confirmLabel={t("analytics.share.revokeConfirm")}
          variant="destructive"
          onConfirm={async () => {
            await client.revokeShareLink({ channel, id: link.id });
            toast.success(t("analytics.share.revokedToast"));
            onRevoked();
          }}
          onError={(err) => toastActionError(err, t("analytics.share.revokeFailed"))}
        />
      )}
    </li>
  );
}
