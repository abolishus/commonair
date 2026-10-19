<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

## Conventions for every E4a composition unit (U2–U5)

- **Built on U1.** U1 has merged: every shadcn component is in `packages/ui/src/components`
  (accordion … tooltip, plus `chart`, `sidebar`, `item`, `field`, `empty`, `combobox`, `drawer`),
  with the house primitives `StatusBadge`, `OverlayBadge`, `AccentButton` next to `StreamCard`,
  `ChannelAvatar`, `LiveBadge`, `ViewerCount`, `RelativeTime`, `MoneyAmount`, `EmptyState`,
  `Skeleton*`, `IconButton`, `ConfirmDialog`. Read `packages/ui/DEVIATIONS.md` and the stories in
  `packages/ui/stories/` to see what exists. Use them; never restyle them from outside with color
  or size overrides (layout classes such as `w-full`, `grow`, `self-start` are fine).
- **Router-agnostic links.** packages/ui never imports a router. Anything that navigates takes
  either `href` (renders a plain `<a>` through the shadcn component) or a `render` element in the
  Base UI convention (`render={<Link to="/x" />}`), which the shadcn parts (`Button`,
  `SidebarMenuButton`, `BreadcrumbLink`, `NavigationMenuLink`, `Item`) already support. "Current
  page" is a prop (`current` / `aria-current="page"`), never derived from `location`.
- **Strings are props.** Every visible string and every screen-reader label (icon buttons,
  landmarks, regions) is a prop; no English defaults inside the component, no new `UiMessages`
  keys (that file is shared). Stories pass fixture English; apps/web passes `t()`.
- **Data in, markup out.** Lists take typed arrays (`items`, `rows`, `segments`) plus optional
  render slots for the rare custom cell; no component fetches or formats money/time itself:
  use `MoneyAmount`/`formatMoney`, `RelativeTime`, `formatCompactNumber`, `ViewerCount` from
  `@commonair/ui`.
- **Variants via `cva`.** One component per repeated section; differences are `cva` variants or
  slots. Export the variants function when another composition could reuse it.
- **Test ids.** Accept and forward `data-testid` and other `data-*` props on the root (and on
  per-row elements via the row data or a `rowProps` callback) so apps/web can keep the e1–e3
  selector contracts (`docs/testing/e1-selectors.md`, `e2-selectors.md`, `e3-selectors.md`).
- **Layout.** Mobile first; nothing overflows at 320 px (wrap, stack, truncate, or scroll inside
  a `ScrollArea`/`Table` container — the table container scrolls horizontally, the page never
  does). Spacing from the Tailwind scale only; widths from the scale (`max-w-*`, `basis-*`,
  `w-64`), never arbitrary values.
- **Files.** One composition per file in your folder, `index.ts` re-exports them with their prop
  types. Stories in `packages/ui/stories/<folder>/`, tests in `packages/ui/tests/<folder>/`.
  Story titles: `Blocks/<Group>/<Name>` or `Layouts/<Name>`.
