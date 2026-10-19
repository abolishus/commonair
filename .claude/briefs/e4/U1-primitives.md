<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing **E4a U1 — primitives under one theme** for CommonAir (repo:
/Users/joshe/Repos/bcon). Read AGENTS.md (especially "Design rules (web)" and "House
primitives"), HANDOFF.md, PLAN.md (E4a row), `packages/ui/README.md`, and then
`.claude/briefs/e4/_common.md` (shared rules, the mockup→component map and the done criteria; it
is part of this brief). Read `packages/ui` end to end: `components.json`, `src/styles/*`,
`src/components/*`, `src/primitives/*`, `src/lib/*`, `scripts/shadcn-add.ts`, `tests/`,
`.storybook/`, `stories/`. Do not look outside the repository except the shadcn registry through
the pinned CLI. You work in your own git worktree: run `git merge main --no-edit` first, then
`bun install` if `node_modules` is missing. Boards (all 29) are the reference for which primitives
are needed: `.claude/briefs/e4/boards/*.html`, canvas <https://claude.ai/artifact/Ve5J5XjRZV42eRE2cdReVd>.

U1 must land before U2–U5 start, so keep to this scope and finish.

## You own (write only these)

- `packages/ui/components.json`, `packages/ui/scripts/shadcn-add.ts`
- `packages/ui/src/components/**`, `packages/ui/src/hooks/**` (new; the CLI writes `use-mobile.ts`)
- `packages/ui/src/styles/**`
- `packages/ui/src/primitives/**` (existing house primitives: alignment with the new components only)
- new house primitives `packages/ui/src/primitives/status-badge.tsx`, `overlay-badge.tsx`,
  `accent-button.tsx`
- `packages/ui/src/lib/messages.ts` (new design-system strings, if any)
- `packages/ui/tests/tokens.test.ts`, `tests/shadcn-add.test.ts`, `tests/support/**`,
  `tests/primitives.test.tsx`, `tests/ssr.test.tsx`, new `tests/components.test.tsx`
- `packages/ui/stories/Components.stories.tsx` and new `packages/ui/stories/primitives/**`
- `packages/ui/DEVIATIONS.md` (new), `packages/ui/README.md`, `packages/ui/upstream/**` (new; store
  the files so lint and typecheck skip them, e.g. `upstream/components/<name>.tsx.txt`)
- `packages/ui/tests/deviations.test.ts` (new), `packages/ui/tests/guards.test.ts` (radius guard)
- `packages/ui/package.json` (dependencies only; leave `exports` to the head agent)

## Contracts you must honor (read-only for you)

- `@commonair/contracts` (`ACCENTS`, `minorUnits`), the existing public API of every house
  primitive in `src/index.ts` (props stay compatible; apps/web uses them), the selectors
  `data-testid="live-badge"`, `confirm-dialog-confirm`, `stream-card` rendered inside packages/ui.
- AGENTS.md design rules. No Radix anywhere (`tests/guards.test.ts`): `cmdk` and `vaul` stay out.

## Build

1. **Pin the CLI to `shadcn@4.21.1`** (published 2026-10-01; 4.21.2+ are under two weeks old on
   2026-10-18) in `scripts/shadcn-add.ts` and the README. The README's mention of 4.22.1 is wrong;
   fix it.
2. **Confirm the registry for the preset.** In a scratch directory **outside the repo** (your
   session scratchpad or `$TMPDIR`), run
   `bunx shadcn@4.21.1 init -t vite -b base -p b1ZhhFNpx -n probe --no-monorepo -y`, set its
   `components.json` `iconLibrary` to `hugeicons`, and `add` the full list below. That project is
   the upstream reference. The preset writes `style: base-lyra`, `baseColor: zinc`,
   `menuColor: inverted`, `menuAccent: bold`, `iconLibrary: lucide`, Instrument Sans, a blue
   primary. Adopt in `packages/ui/components.json`: `menuColor: "inverted"` and
   `menuAccent: "bold"` (the preset's menu style) and keep `iconLibrary: "hugeicons"`; the font
   (Rubik) and colors (CommonAir tokens) stay ours — record each preset difference in
   DEVIATIONS.md.
3. **Add every primitive with the wrapper** (`bun scripts/shadcn-add.ts <names…> --overwrite`) in
   `packages/ui`: accordion, alert, alert-dialog, aspect-ratio, avatar, badge, breadcrumb, button,
   button-group, card, chart, checkbox, collapsible, combobox, command, context-menu, dialog,
   drawer, dropdown-menu, empty, field, hover-card, input, input-group, item, kbd, label,
   navigation-menu, pagination, popover, progress, radio-group, scroll-area, select, separator,
   sheet, sidebar, skeleton, slider, sonner, spinner, switch, table, tabs, textarea, toggle,
   toggle-group, tooltip. (`combobox` is for the tag/category pickers in StreamManager.) Re-add the
   ones already present with `--overwrite` so every file is current CLI output, then re-apply only
   the deliberate deviations. The probe showed: `drawer` is Base UI (`@base-ui/react/drawer`, no
   vaul); `command` pulls `cmdk` (Radix) — keep CommonAir's Base UI `Autocomplete` version (an
   existing deviation); `sonner` pulls `next-themes` — keep the theme-prop version; `chart` pulls
   `recharts@3.8.0` (MIT, published 2026-03-06); `sidebar` writes `src/hooks/use-mobile.ts`.
   Teach `scripts/shadcn-add.ts` anything the new files need (e.g. rewriting
   `@commonair/ui/hooks/use-mobile` imports if the alias needs a `.ts` suffix or a `paths` entry —
   the package already exports `./hooks/*` → `src/hooks/*.ts`, and `tsconfig.json` maps
   `@commonair/ui/*` → `src/*`; you may not edit either — report a contract request if needed) and extend `tests/shadcn-add.test.ts`.
4. **New dependency `recharts@3.8.0`** (exact pin) in `packages/ui/package.json`; verify its MIT
   license from its repository at v3.8.0 and the licenses of what it pulls in (`@reduxjs/toolkit`,
   `immer`, `react-redux`, `reselect`, `victory-vendor`, `es-toolkit`, `decimal.js-light`,
   `eventemitter3`, `tiny-invariant`, `use-sync-external-store`; all expected MIT/ISC) and check
   each resolved version is ≥ 2 weeks old. Run `bun install` and `bun scripts/check-licenses.ts`;
   report the result. You may commit `bun.lock` for this dependency only. Report the root-catalog
   entry the head agent should add (`"recharts": "3.8.0"`).
5. **DEVIATIONS.md** (`packages/ui/DEVIATIONS.md`, CC-BY-SA header): one row per deliberate
   difference from the upstream reference project (file, what differs, why, the test that guards
   it). Expected: full-opacity focus rings in `button` (and any other component whose ring must
   meet 3:1 — check `input`, `select`, `textarea`, `checkbox`, `switch`, `radio-group`, `slider`,
   `toggle`, `tabs`, `input-group`, `combobox`, `sidebar` menu buttons, `item` links, and apply the
   same fix where the upstream ring is translucent; extend the token test to cover each), Base UI
   `command`, theme-prop `sonner`, `UiMessages` strings in `dialog`/`sheet`/`pagination`/
   `breadcrumb`/`sonner` (and any new component with hard-coded English, e.g. `sidebar` "Toggle
   Sidebar", `drawer`, `spinner` "Loading", `carousel`-style sr-only text), `field` string errors,
   vendored `shadcn.css`, the `cn` import, the components.json differences vs the preset, file-level
   lint exceptions. Store the upstream reference output (each file normalized with
   `normalizeComponentSource`, then `vp fmt`) under `packages/ui/upstream/components/` (same
   MIT + AGPL header as the components; test data, never exported), add a `--snapshot` mode to
   `scripts/shadcn-add.ts` that regenerates it from a scratch preset project, and add
   `tests/deviations.test.ts`: every `src/components/*.tsx` either equals its upstream file or has
   a DEVIATIONS.md row, and every file a row names exists.
6. **Theme, one source (`src/styles/globals.css`).**
   - Sidebar tokens the `sidebar` component needs (`--sidebar`, `--sidebar-foreground`,
     `--sidebar-primary(-foreground)`, `--sidebar-accent(-foreground)`, `--sidebar-border`,
     `--sidebar-ring`) in dark, light and the `system` block, mapped to CommonAir's zinc surfaces,
     plus `@theme inline` color entries.
   - Status tones for `StatusBadge` and stat deltas: `--success`, `--warning`, `--info` (text on
     `--background` and `--card` and on their own 10–15 % tint over card ≥ 4.5:1 in both themes).
   - Chart palette `--chart-1`…`--chart-8` (the Expenses board has seven segments): each ≥ 3:1
     against `--card` and `--background` (non-text graphics) in both themes, and mutually
     distinguishable (adjacent ΔE noticeable; at minimum, no two identical). If any chart color is
     ever used as text, it must also be 4.5:1 — say which ones are safe for text in a comment.
   - `--font-mono` → the Rubik stack (Rubik is the only face; mono-styled codes and timestamps use
     `tabular-nums`). Keep the light/system blocks identical (existing test).
   - Radius: base-lyra is square. Keep `--radius` (CLI files reference the radius scale) but make
     sure no house primitive uses `rounded-sm/md/lg/xl`; only `rounded-none` and `rounded-full`
     (avatars, dots). Add a guard test.
   - Extend `tests/tokens.test.ts` for every new token pair, in both themes, plus the sidebar
     foreground pairs and `--sidebar-ring` 3:1.
7. **House primitives on the new parts** (`src/primitives/`): `StatusBadge` (Badge + cva `tone`:
   `neutral | success | warning | info | danger | accent`, optional leading Hugeicon), `OverlayBadge`
   (Badge with the `--overlay` tokens for text over video/thumbnails, optional icon; then make
   `StreamCard` and `ViewerCount variant="overlay"` use it instead of their inline classes),
   `AccentButton` (Button with `bg-channel-accent text-channel-accent-foreground` and hover/focus
   tokens, all Button sizes, AA in every accent × theme, ring 3:1). Re-check every existing
   primitive against the re-added components (e.g. `EmptyState` should compose shadcn `Empty`;
   `Skeleton*` compose `Skeleton`; `ConfirmDialog` composes `AlertDialog`; `IconButton` composes
   `Button` + `Tooltip`; `CommandPalette` composes `command`) and fix drift without changing
   their public props. Export the three new primitives from `src/primitives/` files only; the head
   agent adds them to `src/index.ts` (report the exact export lines).
8. **Stories.** `stories/Components.stories.tsx` (or `stories/primitives/*.stories.tsx`): a
   gallery story per shadcn component (all variants/sizes, disabled, invalid, both themes, 320 px),
   plus stories for the three new primitives.
9. **Tests.** `tests/components.test.tsx`: each new component renders, key a11y (labels, roles,
   keyboard where Base UI provides it: tabs arrow keys, toggle-group pressed state, switch,
   radio-group, select opens with keyboard, drawer/dialog focus trap and Escape), SSR + hydration
   without warnings for every component and the new primitives (extend `tests/ssr.test.tsx`).
   `recharts`' `ResponsiveContainer` renders nothing on the server: assert the chart container
   hydrates without a warning.

## Tests you must add

- Token AA tests for every new pair (both themes), ring 3:1 for every focusable component.
- `tests/deviations.test.ts` (component files equal upstream or are listed).
- New primitives behaviour + SSR; components smoke + a11y + SSR; `shadcn-add` post-processing.

## Done means

Per `_common.md` "Done means". In your final message also give: the primitive inventory (component
→ file → which boards use it), every DEVIATIONS.md row, the license check output, the root
`catalog` line and `src/index.ts` export lines for the head agent, and any `tsconfig.json`
contract request.
