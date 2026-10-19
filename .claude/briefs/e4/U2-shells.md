<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing **E4a U2 — shells and headers** for CommonAir (repo: /Users/joshe/Repos/bcon).
Read AGENTS.md ("Design rules (web)", "House primitives"), PLAN.md (E4a row),
`packages/ui/README.md`, `packages/ui/DEVIATIONS.md`, then `.claude/briefs/e4/_common.md` and
`.claude/briefs/e4/_compositions.md` (both are part of this brief). Do not look outside the
repository. You work in your own git worktree: run `git merge main --no-edit` first, then
`bun install` if `node_modules` is missing. Other units build data blocks (U3), form blocks (U4)
and media/player/chat blocks (U5) in parallel; do not build those.

Canvas: <https://claude.ai/artifact/Ve5J5XjRZV42eRE2cdReVd>. Boards you cover (the shells appear on
all 29; read every board's header/sidebar/footer and page head): **Main, Browse, Category, Search,
Following, SignIn, Settings, Coop, Proposal, Transparency, Status, Finances, Expenses** (AppShell),
**StreamManager, StreamSetup, Analytics, Revenue, Community, ChatBot, Content, Overlays**
(StudioShell), **TrustSafety** (AdminShell), **Developer** (AppShell + SectionNav), **Mobile**
(phone header). Condensed copies: `.claude/briefs/e4/boards/<Board>.html`.

## You own (write only these)

- `packages/ui/src/layouts/**`, `packages/ui/src/blocks/headers/**`
- `packages/ui/stories/layouts/**`, `packages/ui/stories/headers/**`, `packages/ui/tests/layouts/**`,
  `packages/ui/tests/headers/**`

## Contracts you must honor (read-only for you)

- Everything in `packages/ui/src/components/**` and `src/primitives/**` (U1). AGENTS.md rules.
- apps/web keeps `data-testid="nav-directory"`, `nav-user` (+ `data-username`),
  `footer-source-link`: your components must let the app put those ids on the nav link, the
  user area and the source link (forward `data-*`).

## Build

All shells share ONE set of nav building blocks (`nav.tsx`): a typed `NavItem`
(`{ id, label, icon?, href? | render?, current?, badge?: { label, tone } , disabled? }`) and
`NavGroup` (`{ id, label?, items }`), rendered through shadcn `Sidebar` parts
(`SidebarMenu`, `SidebarMenuItem`, `SidebarMenuButton`, `SidebarMenuBadge`, `SidebarGroup`,
`SidebarGroupLabel`, `SidebarSeparator`). Every sidebar or vertical nav in the boards uses them.

1. **`AppShell`** (`layouts/app-shell.tsx`): slots `header`, `sidebar?`, `footer`, `children`;
   skip link ("Skip to content" — a prop string) targeting `main`; `main` landmark with an id.
   Optional sidebar uses `SidebarProvider` + `Sidebar collapsible="icon"` on desktop and the
   built-in sheet on mobile.
2. **`SiteHeader`** (`layouts/site-header.tsx`): `brand` (`Brand`: mark + instance name, link),
   `nav: NavItem[]` (horizontal, ghost buttons, `aria-current`), `search?` slot, `actions?` slot
   (notifications `IconButton`, "Go live" button, `ThemeToggle`), `user?` slot. Below `md` the nav
   collapses into a `Sheet` (or `Drawer`) opened by an `IconButton` with a label prop; search
   collapses to an icon button that the app wires to the `CommandPalette` (Mobile board).
3. **`HeaderSearch`**: `role="search"` form: `InputGroup` + search icon addon + `Kbd`/`Shortcut`
   hint; props `label`, `placeholder`, `shortcut?`, `onSubmit`, `onOpenPalette?`.
4. **`UserMenu`**: `DropdownMenu` trigger with `ChannelAvatar` + username, items as data
   (`{ id, label, icon?, href?|render?|onSelect?, destructive? }`), separators; forwards `data-*`
   on the trigger root (apps/web puts `nav-user` there).
5. **`SiteFooter`**: instance name, `links: { label, href|render }[]`, `sourceLink?`
   (`{ label, href, ...data-* }`, `rel="noopener"`), `license` text.
6. **`ChannelSidebar`** (Main board: "Followed live", "Spotlight", "Show all 38 followed", the
   verified-counts callout): `NavGroup`s whose items are channels (`ChannelAvatar` with accent,
   name, category, live `ViewerCount`) via a `SidebarChannelItem` built from the same
   `SidebarMenuButton`; collapsed state shows avatars only with a `Tooltip`; footer slot for the
   callout (`Alert`).
7. **`StudioShell`** and **`AdminShell`** (`layouts/studio-shell.tsx`, `admin-shell.tsx`):
   `SiteHeader` + `Sidebar` with `groups: NavGroup[]` (icons + badges, e.g. Moderation "3",
   Report queue "27") + `SidebarInset` main. Both are thin wrappers over one shared
   `DashboardShell` (sidebar label prop, groups, header, children) — no copied markup.
8. **`SectionNav`** (Settings sections, Overlays list with On/Off badges, Developer applications
   list): a vertical in-page nav using the same `NavItem` + Sidebar menu parts (no provider
   needed, or a local provider), with an optional heading + action (`IconButton` "New
   application"); below `md` it becomes a `Select` or horizontal `ScrollArea` of buttons (pick
   one, explain why in a comment).
9. **`PageHeader`** (`blocks/headers/page-header.tsx`): `title` (the one `h1` style), `description?`,
   `actions?`, `meta?` (e.g. "Ledger closed through …"), `breadcrumbs?` slot, `tabs?` slot, `size`
   variant `page` (viewer pages: Browse, Following, Settings, Coop, Transparency, Finances) |
   `compact` (studio pages, Search) — the only two heading sizes; wraps at 320 px.
10. **`Section`**: `heading` (h2, the one section size) or `headingLevel`, `description?`,
    `action?` (e.g. "Show all" ghost link, a `Select`, a `ToggleGroup`), `children`, `aria-labelledby`
    wired automatically (`useId`).
11. **`Breadcrumbs`**: `items: { label, href?|render? }[]`, last is current, separator icon;
    collapses the middle into `BreadcrumbEllipsis` + `DropdownMenu` when more than 4 items.
12. **`PageTabs`**: route-level tabs as links (Channel, Following, Category, Search, Coop,
    Finances, Community, ChatBot, Content, Developer): `Tabs` + `TabsList variant="line"|"default"`
    whose triggers render links (`render`) with `aria-current`, optional count `Badge`; horizontal
    scroll on overflow at 320 px. Also support panel tabs (`value`/`onValueChange` with
    `TabsContent`) for in-page switching (Support dialog, SignIn) — same component, two modes.
13. **Page layouts** (`layouts/page-layout.tsx`): `PageContainer` (max width `default | narrow |
    wide`, 16 px gutter on mobile), `SplitLayout` (`main` + `aside`, aside stacks below at < `lg`,
    aside width from the scale), `ResponsiveGrid` (`cols: 2 | 3 | 4`, collapses to 1 at 320 px,
    gap from the scale). These replace every `g2/g3/g4/split/wrap` in the boards.

## Tests you must add

- Each component: renders slots, landmarks (`banner`, `navigation` with labels, `main`,
  `contentinfo`, `search`), `aria-current` on the current item, keyboard (Tab order, sheet opens
  and closes with Escape and returns focus, dropdown menu arrow keys, sidebar toggle with its
  keyboard shortcut), `data-*` forwarding, Breadcrumbs collapse, PageTabs link and panel modes,
  SSR + hydration without warnings.

## Stories

`Layouts/AppShell` (with and without ChannelSidebar, signed in/out), `Layouts/StudioShell`,
`Layouts/AdminShell`, `Layouts/SiteHeader` (desktop + Mobile320 with the sheet open),
`Layouts/SectionNav`, `Blocks/Headers/PageHeader` (both sizes, with tabs/breadcrumbs/actions),
`Section`, `Breadcrumbs`, `PageTabs`, `PageLayout`; each with a `Light` and `Mobile320` story.

## Done means

Per `_common.md` "Done means". Also list every export for `src/layouts/index.ts` /
`src/blocks/headers/index.ts` (you write those) and the root exports you propose (head agent).
