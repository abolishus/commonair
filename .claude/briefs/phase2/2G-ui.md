<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Unit 2G: Design system (`packages/ui`)

## You own

- `packages/ui/**` (new package `@commonair/ui`), including its Storybook config.

## Contracts (read-only)

- `packages/contracts/src/shapes.ts` `ACCENTS` (channel accent token names), `api/entities.ts` (StreamCard, BroadcastSummary, UserPublic shapes for primitive props), AGENTS.md "Design rules" and the "House primitives: use X, not Y" table (binding — every primitive named there must exist with that name).

## Build

1. **shadcn/ui on Base UI**: use the shadcn CLI (`bunx shadcn@4.22.1 init` / `add`) so components stay upgradeable, configured with style `base-lyra`, base color `zinc`, CSS variables, icon library Hugeicons (`@hugeicons/react` + `@hugeicons/core-free-icons`, MIT). Verify with the shadcn docs how to select the Base UI primitive layer (`@base-ui/react` 1.9.0, not Radix) and the `base-lyra` style; record what you did in `packages/ui/README.md`. `components.json` lives in `packages/ui` and points aliases inside the package (`@commonair/ui/components/...`). Add at least: button, input, textarea, label, select, checkbox, switch, radio-group, slider, tabs, dialog, alert-dialog, sheet, popover, dropdown-menu, context-menu, tooltip, toggle, toggle-group, badge, avatar, card, separator, skeleton, scroll-area, table, form helpers (field/label/description/error compatible with TanStack Form), command (palette), sonner, progress, accordion, collapsible, breadcrumb, pagination, kbd, empty. No Radix packages may appear in the dependency tree (add a unit test that reads package.json/lock and fails on `@radix-ui/*`).
2. **Tailwind v4 theme** in `packages/ui/src/styles/globals.css` (exported as `@commonair/ui/globals.css`): all colors as CSS variables (`--background`, `--foreground`, `--primary`, `--muted`, `--accent`, `--destructive`, `--border`, `--ring`, chart colors, `--live` for live badges, chat name colors `--chat-1`…`--chat-12`), **dark first** (`:root` is dark) with a full light theme (`.light` / `[data-theme=light]` and `prefers-color-scheme: light` when the user chose "system"). **Rubik only**: `@fontsource-variable/rubik` imported in the CSS; `--font-sans` and `--font-display` both `"Rubik Variable", ui-sans-serif, system-ui, sans-serif`. Channel accents: `[data-accent="<name>"]` overrides `--channel-accent` / `--channel-accent-foreground` for each of `ACCENTS`, each pair WCAG AA (≥ 4.5:1) in both themes — write a unit test computing contrast from the oklch/hex values you choose. Reduced motion: disable animations under `prefers-reduced-motion`. Visible focus ring on every interactive element.
3. **House primitives** (`src/primitives/*`, each with props typed from contracts DTOs where relevant, all strings via props — no hard-coded English — and locale-aware formatting via `Intl` with a `locale` prop or a `LocaleProvider` context you create):
   - `StreamCard` (thumbnail 16:9 with `LiveBadge` and `ViewerCount` overlay, channel avatar, title, category, tags, discovery `reason` chip; accent from channel; keyboard focusable link; loading variant `StreamCardSkeleton`)
   - `ChannelAvatar` (image with initial-letter fallback colored by accent; sizes; live ring)
   - `LiveBadge`, `ViewerCount` (compact number formatting, "verified" semantics in an accessible label), `RelativeTime` (auto-updating, `<time dateTime>`, tooltip with absolute time), `MoneyAmount` + `formatMoney(cents, currency, locale)` (integer cents only), `EmptyState` (icon, title, description, action), `Skeleton*` set, `IconButton` (requires `label`; renders Tooltip with it; `aria-label`), `ConfirmDialog` (AlertDialog wrapper with destructive variant and async confirm), `toast` helper (`@commonair/ui/toast`: wraps Sonner with `success/error/info/promise`; components never import `sonner` directly), `Kbd`/`Shortcut` display, `CommandPalette` shell (built on the command component; takes groups/items/actions as props), `ThemeToggle` (dark/light/system; persists via a callback prop, no direct storage), `LocaleProvider`.
   - Never use native `title` attributes or `window.alert/confirm/prompt`: add a unit test that greps the package source for `title=` on JSX elements (allow the `title` _prop_ of your own components) and for `window.confirm|alert|prompt`.
4. **Storybook 10** (`storybook`, `@storybook/react-vite`, `@storybook/addon-a11y`; verify licenses MIT) with stories for **every** primitive and each state (loading, empty, error, long text, RTL-safe truncation, mobile width 320px, dark and light). `bun run storybook` (dev) and `bun run build-storybook` scripts. Storybook must not load any remote resources (no fonts/CDNs).
5. **Tests**: Vitest + `@testing-library/react` + `happy-dom` (verify licenses) for primitives' behavior (fallback avatar initials, money formatting incl. JPY zero-decimal and negatives, compact viewer counts, relative time updates with fake timers, ConfirmDialog keyboard flow, IconButton tooltip/aria), accent contrast, no-radix, no-title/no-native-dialog guards. Tests run under Bun like the rest of the repo (`bun --bun vp test run`); if happy-dom/testing-library have issues under Bun, document and use `vp test run` (Node) for this package only.
6. Exports map: `@commonair/ui` (primitives), `@commonair/ui/components/*` (shadcn components), `@commonair/ui/globals.css`, `@commonair/ui/toast`, `@commonair/ui/lib/utils` (`cn`).

## Dependencies you may add

react/react-dom 19.3.1 (peer + dev), tailwindcss 4.3.3, @tailwindcss/vite 4.3.3, @base-ui/react 1.9.0, @hugeicons/react 1.1.10, @hugeicons/core-free-icons (latest 4.x), @fontsource-variable/rubik 5.3.0, sonner 2.0.8, class-variance-authority, clsx, tailwind-merge, tw-animate-css, cmdk if the shadcn command component needs it, Storybook 10.6.2 packages, @testing-library/react, @testing-library/user-event, happy-dom. Pin exact versions; confirm each license (repo LICENSE at that version).

## Done means

Common rules; plus `bun run build-storybook` succeeds offline.
