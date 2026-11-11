// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/admin/growth` (overhaul wave 2, D2.8; growth-funnels.md P7 C): the viewer and creator funnels,
 * a tile and trend per metric, sign-ups by intent and the UI counters, over the last 7 to 180
 * UTC days. Every number is an aggregate the API already floored: a hidden one reads "fewer than 5".
 */
import type * as D from "@commonair/contracts/dto";
import { GROWTH_K_FLOOR, type GrowthMetric, type SignupIntent } from "@commonair/contracts/enums";
import { EmptyState, SkeletonGroup, SkeletonText, useLocale } from "@commonair/ui";
import { DataTable, type DataTableColumn, FilterBar, StatGrid } from "@commonair/ui/blocks/data";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Chart01Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import type { z } from "zod";
import { t, type MessageKey } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { SectionLoadError } from "../../lib/section-load-error.tsx";
import { useLoad } from "../money/use-load.ts";
import { FunnelBars, GrowthStatTile, flooredText, type FunnelStep } from "./growth-charts.tsx";

export type GrowthReportDto = z.infer<typeof D.GrowthReport>;

export interface GrowthClient {
  report(days: number): Promise<GrowthReportDto>;
}
export const growthClient = (): GrowthClient => ({ report: (days) => api().admin.growth({ days }) });

/** The windows offered, in days (the API takes 7 to 180). */
export const GROWTH_WINDOWS = [7, 30, 90, 180] as const;
export type GrowthWindow = (typeof GROWTH_WINDOWS)[number];
export function parseGrowthWindow(value: string): GrowthWindow | null {
  const n = Number(value);
  return GROWTH_WINDOWS.find((w) => w === n) ?? null;
}

const METRIC_LABEL: Record<GrowthMetric, MessageKey> = {
  accounts_created: "d2Metrics.metric.accountsCreated",
  accounts_verified: "d2Metrics.metric.accountsVerified",
  first_follow_within_7d: "d2Metrics.metric.firstFollow",
  first_chat_within_7d: "d2Metrics.metric.firstChat",
  first_support_within_30d: "d2Metrics.metric.firstSupport",
  became_member: "d2Metrics.metric.becameMember",
  notify_optin: "d2Metrics.metric.notifyOptin",
  first_live: "d2Metrics.metric.firstLive",
  second_live_within_14d: "d2Metrics.metric.secondLive",
  imports_finished: "d2Metrics.metric.importsFinished",
  active_streamers: "d2Metrics.metric.activeStreamers",
  members_total: "d2Metrics.metric.membersTotal",
};
const METRIC_HINT: Record<GrowthMetric, MessageKey> = {
  accounts_created: "d2Metrics.hint.accountsCreated",
  accounts_verified: "d2Metrics.hint.accountsVerified",
  first_follow_within_7d: "d2Metrics.hint.firstFollow",
  first_chat_within_7d: "d2Metrics.hint.firstChat",
  first_support_within_30d: "d2Metrics.hint.firstSupport",
  became_member: "d2Metrics.hint.becameMember",
  notify_optin: "d2Metrics.hint.notifyOptin",
  first_live: "d2Metrics.hint.firstLive",
  second_live_within_14d: "d2Metrics.hint.secondLive",
  imports_finished: "d2Metrics.hint.importsFinished",
  active_streamers: "d2Metrics.hint.activeStreamers",
  members_total: "d2Metrics.hint.membersTotal",
};
const INTENT_LABEL: Record<SignupIntent, MessageKey> = {
  none: "d2Metrics.intent.none",
  follow: "d2Metrics.intent.follow",
  chat: "d2Metrics.intent.chat",
  support: "d2Metrics.intent.support",
  predict: "d2Metrics.intent.predict",
  clip: "d2Metrics.intent.clip",
  watch: "d2Metrics.intent.watch",
  stream: "d2Metrics.intent.stream",
  import: "d2Metrics.intent.import",
  join: "d2Metrics.intent.join",
};

export const metricLabel = (m: GrowthMetric): string => t(METRIC_LABEL[m]);
export const intentLabel = (i: SignupIntent): string => t(INTENT_LABEL[i]);

/** Viewer funnel, then creator funnel (growth-funnels.md P7 A). */
export const VIEWER_FUNNEL: readonly GrowthMetric[] = [
  "accounts_created",
  "accounts_verified",
  "first_follow_within_7d",
  "first_chat_within_7d",
  "first_support_within_30d",
  "became_member",
];
export const CREATOR_FUNNEL: readonly GrowthMetric[] = ["first_live", "second_live_within_14d"];

/** A funnel's steps from the report's totals, in funnel order. */
export function funnelSteps(report: GrowthReportDto, metrics: readonly GrowthMetric[]): FunnelStep[] {
  const total = new Map(report.totals.map((x) => [x.metric, x.value]));
  return metrics.map((metric) => ({ id: metric, label: metricLabel(metric), value: total.get(metric) ?? null }));
}

/** True when every number in the report is hidden or zero (a new instance). */
export function reportIsEmpty(report: GrowthReportDto): boolean {
  return report.totals.every((x) => x.value === null) && report.ui.every((x) => x.value === null);
}

type UiRow = GrowthReportDto["ui"][number];
type IntentRow = GrowthReportDto["signupsByIntent"][number];

function GrowthReportView({ report }: { report: GrowthReportDto }): React.JSX.Element {
  const { locale } = useLocale();
  const series = new Map(report.series.map((s) => [s.metric, s.points.map((p) => p.value)]));
  const intentColumns: DataTableColumn<IntentRow>[] = [
    { id: "intent", header: t("d2Metrics.intents.intent"), cell: ({ row }) => intentLabel(row.original.intent) },
    {
      id: "value",
      header: t("d2Metrics.intents.accounts"),
      align: "numeric",
      cell: ({ row }) => flooredText(row.original.value, locale),
    },
  ];
  // Admin console: the closed-list ids are the names admins search the code and docs by.
  const uiColumns: DataTableColumn<UiRow>[] = [
    { id: "surface", header: t("d2Metrics.ui.surface"), cell: ({ row }) => <code>{row.original.surface}</code> },
    { id: "action", header: t("d2Metrics.ui.action"), cell: ({ row }) => <code>{row.original.action}</code> },
    { id: "step", header: t("d2Metrics.ui.step"), cell: ({ row }) => <code>{row.original.step}</code> },
    {
      id: "value",
      header: t("d2Metrics.ui.count"),
      align: "numeric",
      cell: ({ row }) => flooredText(row.original.value, locale),
    },
  ];
  return (
    <div data-testid="growth-report" data-from={report.from} data-to={report.to} className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">{t("d2Metrics.window", { from: report.from, to: report.to })}</p>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("d2Metrics.funnel.viewerTitle")}</CardTitle>
            <CardDescription>{t("d2Metrics.funnel.viewerIntro")}</CardDescription>
          </CardHeader>
          <CardContent>
            <FunnelBars label={t("d2Metrics.funnel.viewerTitle")} steps={funnelSteps(report, VIEWER_FUNNEL)} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("d2Metrics.funnel.creatorTitle")}</CardTitle>
            <CardDescription>{t("d2Metrics.funnel.creatorIntro")}</CardDescription>
          </CardHeader>
          <CardContent>
            <FunnelBars label={t("d2Metrics.funnel.creatorTitle")} steps={funnelSteps(report, CREATOR_FUNNEL)} />
          </CardContent>
        </Card>
      </div>
      <section aria-labelledby="growth-metrics" className="flex flex-col gap-3">
        <h2 id="growth-metrics" className="text-base font-semibold">
          {t("d2Metrics.metrics.title")}
        </h2>
        <StatGrid cols={4}>
          {report.totals.map((x) => (
            <GrowthStatTile
              key={x.metric}
              data-testid="growth-metric"
              data-metric={x.metric}
              label={metricLabel(x.metric)}
              hint={t(METRIC_HINT[x.metric])}
              value={x.value}
              series={series.get(x.metric) ?? []}
            />
          ))}
        </StatGrid>
      </section>
      <DataTable
        data-testid="growth-intents"
        caption={t("d2Metrics.intents.title")}
        columns={intentColumns}
        rows={report.signupsByIntent}
        getRowId={(r) => r.intent}
        rowProps={(r) => ({ "data-intent": r.intent, "data-value": r.value ?? "floored" })}
      />
      <DataTable
        data-testid="growth-ui"
        caption={t("d2Metrics.ui.title")}
        columns={uiColumns}
        rows={report.ui}
        getRowId={(r) => `${r.surface}|${r.action}|${r.step}`}
        rowProps={(r) => ({ "data-surface": r.surface, "data-action": r.action, "data-value": r.value ?? "floored" })}
        empty={<p className="py-4 text-sm text-muted-foreground">{t("d2Metrics.ui.empty")}</p>}
      />
      <p className="text-xs text-muted-foreground">{t("d2Metrics.floorNote", { floor: GROWTH_K_FLOOR })}</p>
    </div>
  );
}

/** The page body: the window picker, then the report (or its loading, empty and failed states). */
export function GrowthPage({ client: clientProp }: { client?: GrowthClient }): React.JSX.Element {
  const [client] = React.useState(() => clientProp ?? growthClient());
  const [days, setDays] = React.useState<GrowthWindow>(30);
  const report = useLoad(String(days), () => client.report(days));
  return (
    <div className="flex flex-col gap-6">
      <FilterBar
        filters={[
          {
            id: "growth-window",
            label: t("d2Metrics.windowLabel"),
            value: String(days),
            "data-testid": "growth-window",
            options: GROWTH_WINDOWS.map((w) => ({ value: String(w), label: t("d2Metrics.windowDays", { days: w }) })),
            onValueChange: (value) => setDays(parseGrowthWindow(value) ?? 30),
          },
        ]}
      />
      {report.data ? (
        reportIsEmpty(report.data) ? (
          <EmptyState
            data-testid="growth-empty"
            icon={Chart01Icon}
            title={t("d2Metrics.empty.title")}
            description={t("d2Metrics.empty.body")}
          />
        ) : (
          <GrowthReportView report={report.data} />
        )
      ) : report.failed ? (
        <SectionLoadError data-testid="growth-failed" section={t("d2Metrics.section")} load={report} alone />
      ) : (
        <SkeletonGroup label={t("d2Metrics.loading")}>
          <SkeletonText lines={6} />
        </SkeletonGroup>
      )}
    </div>
  );
}
