// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

export { StatCard, StatGrid, type StatCardProps, type StatDelta, type StatGridProps } from "./stat-card.tsx";
export {
  BreakdownBar,
  BreakdownTally,
  Legend,
  getSegmentShares,
  type BreakdownBarProps,
  type BreakdownSegment,
  type BreakdownTallyProps,
  type ChartColor,
  type LegendProps,
} from "./breakdown.tsx";
export {
  ProgressRow,
  ProgressList,
  PollCard,
  type ProgressRowProps,
  type ProgressListProps,
  type ProgressTone,
  type PollCardProps,
  type PollOption,
} from "./progress-row.tsx";
export { TrendChart, type TrendChartProps, type TrendSeries } from "./trend-chart.tsx";
export { DataTable, type DataTableProps, type DataTableColumn } from "./data-table.tsx";
export { Timeline, type TimelineProps, type TimelineStep, type TimelineUpdate } from "./timeline.tsx";
export { UptimeStrip, type UptimeStripProps, type UptimeDay } from "./uptime-strip.tsx";
export { FilterBar, type FilterBarProps, type FilterSelect, type FilterOption } from "./filter-bar.tsx";
export { ListPanel, type ListPanelProps, type ListPanelItem } from "./list-panel.tsx";
export { KeyValueList, type KeyValueListProps, type KeyValueRow } from "./key-value-list.tsx";
export { MetricPanel, type MetricPanelProps } from "./metric-panel.tsx";
