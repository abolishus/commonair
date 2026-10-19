<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing **E4a U3 — data blocks** (stats, breakdowns, tables, charts, lists) for
CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md ("Design rules (web)", "House
primitives", "Code style": money is integer cents), PLAN.md (E4a row), `packages/ui/README.md`,
`packages/ui/DEVIATIONS.md`, then `.claude/briefs/e4/_common.md` and
`.claude/briefs/e4/_compositions.md` (both are part of this brief). Do not look outside the
repository except npm/GitHub to verify the one dependency below. You work in your own git
worktree: run `git merge main --no-edit` first, then `bun install` if `node_modules` is missing.
Other units build shells/headers (U2), form blocks (U4) and media/player/chat blocks (U5) in
parallel; do not build those.

Canvas: <https://claude.ai/artifact/Ve5J5XjRZV42eRE2cdReVd>. Boards you cover: **StreamManager**
(stat row, stream-health key/values + bitrate sparkline, quick actions, activity feed),
**Analytics** (stats, viewers-per-day bars, sources progress list, integrity table, streams table),
**Revenue** (balance cards, by-source stacked bar + legend, subscribers table, ledger table),
**Transparency** (stats, "every dollar" stacked bar + table with swatches, statement table, three
metric panels), **Finances** (KPIs, income vs expenses grouped bars, income statement table with
group rows, budget vs actual progress list, reserves progress), **Expenses** (stats, 7-segment
run-rate bar + legend, services table with per-month / per-unit toggle, cost-per-hour progress
list, invoices list, wages table with total row, commitments list), **Coop** (membership stats,
members-by-class bar, council list, "coming up"), **Proposal** (live tally: two stacked yes/no/abstain
bars with quorum + pass/fail, timeline), **Status** (component list with 90-day uptime strip,
legend, incident timelines), **Channel** (poll in chat, sub goal), **Overlays** (sub goal),
**Community** (user-card mini stats, recent actions list), **ChannelAbout** (schedule list),
**Vod** (chapters list), **Content** (selectable videos table), **ChatBot** (commands table,
rewards list), **Developer** (subscriptions + deliveries tables), **Browse/Category/Content/
Search** (filter bars), **TrustSafety** (report queue list). Condensed copies:
`.claude/briefs/e4/boards/<Board>.html`, sample data in `.claude/briefs/e4/boards/data/`.

## You own (write only these)

- `packages/ui/src/blocks/data/**`, `packages/ui/stories/data/**`, `packages/ui/tests/data/**`
- `packages/ui/package.json` **dependencies** (one addition, below) and `bun.lock` for it

## Contracts you must honor (read-only for you)

- `packages/ui/src/components/**` (U1: `chart` = shadcn `ChartContainer`/`ChartTooltip`/
  `ChartLegend` on recharts 3.8.0, `table`, `progress`, `item`, `card`, `toggle-group`,
  `input-group`, `select`, `switch`, `checkbox`, `tooltip`, `badge`, `empty`, `skeleton`),
  house primitives (`StatusBadge`, `MoneyAmount`/`formatMoney`, `formatCompactNumber`,
  `RelativeTime`, `ChannelAvatar`, `EmptyState`, `Skeleton*`), tokens `--chart-1…8`,
  `--success/--warning/--info` (U1; see `globals.css` comments for which chart colors are
  text-safe). AGENTS.md: money is integer cents + currency; never floats.
- apps/web will render the E3 relays table through `DataTable`: per-row `data-testid="relay-row"`,
  `data-relay-id`, `data-status`, `data-bytes` must be settable (a `rowProps(row)` callback).

## Build

1. **`StatCard`** + **`StatGrid`**: label, value (string or node — pass `MoneyAmount`), optional
   `delta` (`{ direction: "up" | "down" | "flat", label, sentiment?: "positive" | "negative" }` —
   colour comes from sentiment, not direction: fewer hours streamed can be neutral), `hint`, `icon?`,
   `size: default | sm` (Community user card), `tone` for the membership card. `StatGrid`
   (`cols` 2/3/4/6 responsive). Built on `Card`.
2. **`BreakdownBar`** + **`Legend`**: one horizontal 100 % stacked bar from `segments:
   { id, label, value, color?: ChartColor }[]` (value in any unit; shares computed), built on
   `ChartContainer` + recharts `BarChart layout="vertical"` (or another shadcn chart pattern —
   no div-width hand rolling), accessible: `role="img"` with an `aria-label` built from a
   `formatLabel` prop, and the `Legend` (list with swatch, label, formatted value/share) is the
   text alternative. `Legend` is reusable alone (Status, Finances trend legend, Expenses inline
   legend `layout="inline" | "list"`). `BreakdownTally` variant for the Proposal tally (row label,
   quorum note, `StatusBadge` pass/fail, yes/no/abstain bar, vote count).
3. **`ProgressRow`** + **`ProgressList`**: label, value text, `Progress value`, `note?` with tone,
   `tone: default | accent | success | warning | danger` (accent = channel accent: sub goals).
   Covers Analytics sources, Finances budget, Expenses cost/hour, Reserves (with min/max captions),
   Revenue payout progress, goals. **`PollCard`** (Channel chat): question, time left, total votes,
   options as `ProgressRow`s (percent), voted/closed states; Card `size="sm"`.
4. **`TrendChart`**: `ChartContainer` bar/line chart with `series` (`{ key, label, color }`) and
   `data`, x labels, optional `compact` sparkline mode (StreamManager bitrate, no axes), grouped bars
   (Finances income vs expenses), tooltip via `ChartTooltipContent`, `aria-label` prop, no hard-coded
   colors (chart tokens via the `config`).
5. **`DataTable`**: the shadcn data-table pattern on `@tanstack/react-table` — column defs,
   alignment (`numeric` right-aligned + `tabular-nums`), optional sorting, optional row selection
   with `Checkbox` + a selection toolbar slot (Content: "2 selected · Highlight · Delete"), group
   rows (Finances "Money in / Passed through / Operating expenses"), total/footer rows, empty state
   (`EmptyState` slot), loading (`Skeleton` rows), `rowProps(row)` for `data-*`, caption (visible or
   `sr-only`), horizontal scroll container at 320 px. Plain `Table` stays usable for tiny static
   tables; `DataTable` is the one composition for data tables.
6. **`Timeline`**: ordered steps `{ id, label, meta?, state: done | current | upcoming }` with
   `Checkbox`-like/radio-like markers from icons (Proposal), and an `updates` variant
   (`{ status, time, text }`, Status incident updates).
7. **`UptimeStrip`**: per-day status cells for 90 days (`ok | degraded | outage | none`) with a
   `Tooltip` per cell (date + status), `role="img"` summary label, compressing to fewer days at
   320 px (prop `daysOnMobile`); built from chart or `Tooltip` + tokens (no hex).
8. **`FilterBar`**: search (`InputGroup` with icon), any number of `Select` filters
   (`{ id, label, value, options, onValueChange }`, label sr-only), an optional `ToggleGroup`
   (sort / range / period: Analytics range, Finances period, Category sort, Expenses cost basis),
   optional tag chips (`ToggleGroup` multiple, outline badge look, Browse), optional switch
   (Category "Hide mature"), trailing `actions` slot (Export CSV), wraps cleanly at 320 px.
9. **`ListPanel`**: titled `Card` (`size="sm"`) with `title`, `action?`, `items` rendered as `Item`
   rows (`media?` avatar/badge/icon/date block, `title`, `description?`, `meta?`, `actions?`,
   `href|render?`, `highlighted?`) and optional footer; `variant: card | bare` (bare = bordered
   `ItemGroup` without the Card, for Search/Following/Expenses invoice lists). Covers activity feed,
   recent actions, council, coming up, schedule (date block media), chapters (time + current
   badge), invoices, commitments, rewards, report queue, FOSS list.
10. **`KeyValueList`**: `dl` rows (`{ term, value }`, value may be a `StatusBadge`), dense mode
    (stream health).
11. **`MetricPanel`**: Card `size="sm"` with icon + title, big value + caption, body text
    (Transparency integrity/relays/T&S; Analytics integrity summary). Reuse `StatCard` internals.

Dependency: **`@tanstack/react-table@8.21.3`** (MIT, published 2025-04-14; the 9.x line changed the
API the shadcn data-table pattern documents). Verify the license at that tag in its repository and
its one dependency (`@tanstack/table-core@8.21.3`), pin exactly, `bun install`, run
`bun scripts/check-licenses.ts`, and report the root `catalog` line for the head agent.

## Tests you must add

- Unit: share computation (zero total, one segment, rounding so shares sum to 100 % in the label),
  delta sentiment, ProgressRow clamps 0–100, Timeline states, UptimeStrip mobile day count,
  DataTable sorting/selection/group rows/rowProps/empty/loading, FilterBar callbacks, ListPanel
  link rows. a11y: chart `role="img"` labels, table headers `scope`, selection checkboxes labelled,
  toggle group pressed state. SSR + hydration without warnings for every block (charts render an
  empty container on the server; assert no warning).

## Stories

One story file per block under `stories/data/` with fixtures from the boards (Revenue ledger,
Finances income statement, Expenses services, Analytics streams, Status components, Proposal
tally …), each with `Light` and `Mobile320` stories, plus loading/empty states.

## Done means

Per `_common.md` "Done means". Also list every export for `src/blocks/data/index.ts` (you write it).
