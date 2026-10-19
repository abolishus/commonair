<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing **E4a U7 — packages/ui follow-ups from the board stories** for CommonAir
(repo: /Users/joshe/Repos/bcon). Read AGENTS.md ("Design rules (web)", "House primitives"),
PLAN.md (E4a row), `packages/ui/README.md`, `packages/ui/DEVIATIONS.md`, then
`.claude/briefs/e4/_common.md` and `.claude/briefs/e4/_compositions.md` (both are part of this
brief). Read `packages/ui/tests/source-policy.test.ts` (its allowlist lists the violations you fix)
and the board stories in `packages/ui/stories/pages/**`. Do not look outside the repository. You
work in your own git worktree: run `git merge main --no-edit` first, then `bun install` if
`node_modules` is missing. Nobody else writes packages/ui while you run.

Canvas: <https://claude.ai/artifact/Ve5J5XjRZV42eRE2cdReVd>; condensed boards in
`.claude/briefs/e4/boards/`.

## You own (write only these)

- `packages/ui/src/blocks/**`, `packages/ui/src/primitives/{overlay-badge,viewer-count,stream-card}.tsx`,
  `packages/ui/src/lib/format.ts`, `packages/ui/src/layouts/**`,
  `packages/ui/stories/**`, `packages/ui/tests/**`, `packages/ui/README.md`
- Not `packages/ui/src/components/**` (shadcn layer), not `src/index.ts`/`package.json` exports
  (report new root exports for the head agent), not `apps/web/**`.

## Build

1. **Remove every "contract request" allowlist entry** in `tests/source-policy.test.ts` by fixing
   the code, then delete the entry (unused entries fail the test):
   - `blocks/data/key-value-list.tsx` `grid-cols-[minmax(0,1fr)_auto]`, `blocks/data/timeline.tsx`
     `grid-cols-[auto_1fr]` ×2: use scale utilities (`grid-cols-subgrid`, flex with `min-w-0`/
     `shrink-0`, or `Item` parts).
   - `blocks/data/progress-row.tsx` `[&_[data-slot=progress-indicator]]:bg-*` ×5: tone through the
     shadcn `Progress` parts (`ProgressTrack`/`ProgressIndicator` with a `className`), not a
     descendant selector.
   - `blocks/data/uptime-strip.tsx`: `role="img"` wraps focusable tooltip triggers — an a11y bug.
     Use a list (`ul`/`li`) with an accessible name, each day a labelled tooltip trigger.
   - `primitives/overlay-badge.tsx` `[&>svg]:size-3!`, `primitives/viewer-count.tsx` `[&_svg]:size-*`
     ×2: size the icon element directly (Hugeicons `className`/`size`).
   - Raw `<label>` (e.g. `blocks/forms/copy-field.tsx`) and any other raw-element hits U6a's
     review round allowlisted → `FieldLabel`/`Label`/`Collapsible` parts.
   - Older stories: `Formatting.stories.tsx` raw `<table>` → `Table` parts; `StreamCard.stories.tsx`
     and `ThemeAndShortcuts.stories.tsx` arbitrary `grid-cols-[…]` → `ResponsiveGrid`/scale utilities.
2. **New compositions requested by the boards** (stories + tests for each, both themes, 320 px):
   - `SelectField` (`blocks/forms`): `{ label, value | defaultValue, options, onValueChange,
     description?, error?, orientation?, disabled?, data-* }` on `Field` + `Select`; replace
     `stories/pages/select-field.tsx` everywhere and delete it.
   - `StreamCard`/`StreamGrid`: an optional uptime overlay (`uptimeLabel` per card via `cardProps`,
     rendered with `OverlayBadge` bottom-end) — Following board. (StreamCard is a primitive in
     `src/primitives/stream-card.tsx`: you may extend it with this one optional prop; keep its
     public API otherwise unchanged.)
   - `ChannelSidebar` "show all" per-group footer link (`moreLink?: { label, href | render }`) — Main.
   - `DataTable` controlled and default row selection (`rowSelection`, `defaultRowSelection`,
     `onRowSelectionChange`) — Content "2 selected".
   - `StatCard` `footer` slot — Revenue available-balance progress.
   - `TrendChart` `legend` (uses the existing `Legend`) — Finances.
   - `Legend` items without values (key only) — Status.
   - A warning tone for alerts: compose `AlertCallout` (`blocks/feedback` is new — create
     `src/blocks/feedback/index.ts`) on shadcn `Alert` with `tone: info | warning | danger` using
     the `--warning`/`--info` tokens (AA), icon slot, title, description, action — StreamSetup leak
     warning, Content copyright notice, ChatBot/Developer info notes.
   - Repeated card patterns the boards build from parts: `QueueItemCard` (Community moderation
     queue), `ProposalCard` (Coop open proposals), `CommentItem` (Proposal discussion),
     `IncidentCard` (Status incidents, uses `Timeline` updates). Put them where they fit
     (`blocks/data` or `blocks/media`) or in `blocks/feedback`.
   - `formatMoney` sub-minor-unit precision (e.g. `maximumFractionDigits` option or a
     `formatUnitCost(micros, currency)` helper in `src/lib/format.ts` — you may edit that file and
     `tests/format.test.ts`) so the Expenses per-viewer-hour/per-1K costs stop being strings.
   - `SiteHeader` context segment (`context?: { label, href | render }` shown after the brand,
     e.g. "Creator studio", "Admin") — studio and admin boards.
3. **Use them in the board stories** (`stories/pages/**`) so no board rebuilds these patterns from
   parts any more, and update the composition map comments if any.
4. README: list the new compositions under the E4a section.

## Tests you must add

- Behaviour + a11y + SSR/hydration for every new composition and changed block (UptimeStrip list
  semantics and keyboard tooltips, DataTable controlled/default selection, SelectField labelling,
  AlertCallout tones AA via `tests/tokens.test.ts` if new token pairs are used).
- `tests/source-policy.test.ts`: the contract-request entries are gone; the remaining allowlist is
  only the legitimate exceptions.

## Done means

Per `_common.md` "Done means" (`bun run test`, `tsc`, lint, fmt, `bun run build-storybook` in
packages/ui). Final message: components added/changed, allowlist before/after, test counts, root
export lines for the head agent, stories to open.
