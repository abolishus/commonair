<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing **E4a U6a — one page story per mockup board, plus the packages/ui source
policy test** for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md ("Design rules
(web)", "House primitives"), PLAN.md (E4a row), `packages/ui/README.md`,
`packages/ui/DEVIATIONS.md`, then `.claude/briefs/e4/_common.md` and
`.claude/briefs/e4/_compositions.md` (both are part of this brief). Read the U1–U5 compositions
and their stories (`packages/ui/src/{layouts,blocks,primitives}`, `packages/ui/stories/**`) before
you start: you compose them, you do not write new ones. Do not look outside the repository. You
work in your own git worktree: run `git merge main --no-edit` first, then `bun install` if
`node_modules` is missing. Another unit (U6b) migrates `apps/web` in parallel; do not touch it.

Canvas: <https://claude.ai/artifact/Ve5J5XjRZV42eRE2cdReVd>. **All 29 boards**: Main, Browse,
Category, Search, Following, SignIn, Settings, Channel, ChannelAbout, Vod, Clip, Support, Mobile,
StreamManager, StreamSetup, Analytics, Revenue, Community, ChatBot, Content, Overlays, Coop,
Proposal, Transparency, Developer, TrustSafety, Status, Finances, Expenses. Condensed copies:
`.claude/briefs/e4/boards/<Board>.html`, sample data `.claude/briefs/e4/boards/data/<Board>.js`.

## You own (write only these)

- `packages/ui/stories/pages/**` (new)
- `packages/ui/tests/source-policy.test.ts` (new)

## Contracts you must honor (read-only for you)

- Everything in `packages/ui/src/**` (U1–U5). If a board section cannot be built from the existing
  compositions without page-local styling, **do not** build it locally: leave a clearly labelled
  gap in the story (an `Alert` saying which composition is missing) and report a contract request
  naming the composition, its props and the boards that need it.

## Build

1. **One story file per board** (`stories/pages/<Board>.stories.tsx`, title `Pages/<Group>/<Board>`
   with groups Viewer, Channel, Creator studio, Co-op, Platform as in the canvas). Each reproduces
   its board **section by section, faithfully**: the same shell (AppShell + SiteHeader +
   ChannelSidebar for Main; StudioShell for the eight studio boards; AdminShell for TrustSafety;
   the phone layout for Mobile), the same sections in the same order, the same content and sample
   data (copy the board's fixtures into `stories/pages/fixtures/<Board>.ts`). A generic template
   that renders "some stats + a list" for every board is not acceptable. Interactive boards
   (Support tabs and tier choice, Proposal vote choice, Finances period toggle, Expenses cost basis
   toggle) keep that interaction through the compositions' controlled props and `React.useState`
   in the story.
2. **Pages only compose.** Story files may use only: imports from `@commonair/ui` and its
   `layouts`, `blocks/*`, `components/*` and `toast` entry points; layout utilities (`flex`,
   `grid`, `gap-*`, `grid-cols-1..12` with responsive prefixes, `min-w-0`, `max-w-*` from the
   scale, `col-span-*`, `order-*`, `hidden`/`sm:block`…, `sr-only`); no colors, no font sizes or
   weights, no borders/backgrounds/padding on page markup beyond `PageContainer`/`SplitLayout`/
   `ResponsiveGrid`, no arbitrary values, no raw interactive HTML, no `style`. Prefer the U2 layout
   blocks to raw grids. Shared header/footer/nav fixtures go in `stories/pages/shell.tsx` (one place).
3. **Each board exports** `Default` (dark), `Light` (`globals: { theme: "light" }`) and `Mobile320`
   (`globals: { viewport: { value: "mobile320", isRotated: false } }`, matching
   `.storybook/preview.tsx`). Mobile also gets `Phone390`.
4. **`tests/source-policy.test.ts`** scans `packages/ui/src/**` (except `src/components/**`, the
   shadcn layer, and `src/toast.tsx`) and `packages/ui/stories/**` and fails on, with the file and
   line in the message:
   - raw interactive elements in JSX: `<button`, `<input`, `<select`, `<textarea`, `<table`,
     `<dialog` (and their closing-tag-free forms), and `role=` on `<div`/`<span`;
   - arbitrary-value classes (`[a-z-]+-\[…\]`, including variants like `md:w-[…]`) and Tailwind
     arbitrary properties (`[--x:…]`);
   - color literals: `#rgb/#rrggbb/#rrggbbaa`, `rgb(`, `rgba(`, `hsl(`, `oklch(`, `oklab(`,
     `color-mix(` outside `src/styles/globals.css`;
   - imports of `@base-ui/react` or `sonner`;
   - native `title=` on lower-case JSX elements (reuse `nativeTitleAttributes` from
     `tests/guards.test.ts` — import it, do not copy it);
   - `style=` / `style={{` on JSX (dynamic geometry must go through a component prop).
     Existing house primitives and compositions that legitimately need an exception (e.g. a chart
     config color variable, a `useRender` link) get an explicit, commented allowlist entry
     `{ file, rule, reason }` in the test; keep it short and report every entry. If a rule finds
     real violations in U1–U5 code, do not fix them (you do not own those files): add them to the
     allowlist with `reason: "contract request"` and list them in your final message so the head
     agent fixes them.
     Include self-tests of each detector on small strings (positive and negative cases), like
     `nativeTitleAttributes` has.

## Tests you must add

- `tests/source-policy.test.ts` as above. Stories must import cleanly: add a smoke test
  (`tests/pages.test.tsx`) that renders every board's `Default` story under happy-dom with the
  Storybook decorators' providers (`LocaleProvider`, `TooltipProvider`) and asserts it renders a
  `main` landmark (or the dialog for Support) and no console errors.

## Done means

Per `_common.md` "Done means" (`bun run build-storybook` must pass). Final message also lists, per
board, which compositions each section uses (this becomes the composition map in HANDOFF.md), and
every gap/contract request.
