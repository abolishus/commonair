<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# @commonair/ui

The CommonAir design system: shadcn/ui components on **Base UI** (style `base-lyra`, base color
zinc, CSS variables, Hugeicons), Tailwind v4 tokens, the Rubik typeface, and the house primitives
that AGENTS.md requires ("use X, not Y").

| Import                         | What                                                                    |
| ------------------------------ | ----------------------------------------------------------------------- |
| `@commonair/ui`                | House primitives, `LocaleProvider`, formatting helpers                  |
| `@commonair/ui/components/<x>` | shadcn components (`button`, `dialog`, `command`, `field`, …)           |
| `@commonair/ui/globals.css`    | Tailwind v4 entry: tokens, themes, accents, Rubik, reduced motion       |
| `@commonair/ui/toast`          | `toast.success/error/info/warning/message/promise/dismiss`, `<Toaster>` |
| `@commonair/ui/lib/utils`      | `cn()` (clsx + tailwind-merge)                                          |
| `@commonair/ui/lib/locale`     | `LocaleProvider`, `useLocale`, `useUiMessages`                          |
| `@commonair/ui/lib/messages`   | `UiMessages` type and the English fallback catalog `enMessages`         |

## App setup

```css
/* app.css */
@import "@commonair/ui/globals.css";
```

```tsx
<html data-theme={theme /* "dark" | "light" | "system" */}>
  <LocaleProvider locale={locale} messages={t.ui /* translated UiMessages */}>
    <TooltipProvider>
      <App />
      <Toaster theme={useResolvedTheme(theme)} />
    </TooltipProvider>
  </LocaleProvider>
</html>
```

- **Themes.** Dark is the default (`:root`). `data-theme="light"` (or the `.light` class) selects
  the light theme; `data-theme="system"` follows `prefers-color-scheme`. `applyTheme(theme)` sets
  both; `<ThemeToggle>` never stores anything itself, it calls `onValueChange` so the app persists
  the choice (account setting or cookie).
- **Accents.** `data-accent="<name>"` (one of `ACCENTS` from contracts) sets
  `--channel-accent` / `--channel-accent-foreground` for the subtree; use `bg-channel-accent`,
  `text-channel-accent-foreground`. Each pair is WCAG AA in both themes (`tests/tokens.test.ts`
  computes the ratios from the CSS).
- **Other tokens.** `--live` / `--live-foreground` (live badges), `--chat-1`…`--chat-12` (chat
  name colors, AA on background and card), `--overlay` (text over video), `--success` /
  `--warning` / `--info` (status tones, AA as text on background, card and their own 10–15 % tint),
  `--chart-1`…`--chart-8` (3:1 graphics on background and card; all text-safe except light
  `--chart-7`), `--sidebar*` (the `sidebar` component), `--color-channel-accent-hover` (accent
  hover surface), `--text-2xs` (the one size below `text-xs`), `--font-mono` (Rubik: use
  `tabular-nums` for codes and timestamps). `.dark` re-applies the dark tokens to a subtree; the
  preset's inverted menus (dropdown, context menu, select, combobox) use it.
- **Radius.** base-lyra is square: `--radius` stays because CLI files reference the scale, but house
  code uses only `rounded-none`, and `rounded-full` for avatars and dots (`tests/guards.test.ts`).
- **Charts.** `chart` (`ChartContainer`, recharts 3.8.0): give each series `color: "var(--chart-N)"`,
  never the `theme` key (its `.dark` selector does not match CommonAir's dark-by-default `:root`).
- **Strings.** Components never inline English. Visible text comes from props; the few strings
  the design system itself needs (screen-reader labels, Cancel/Confirm defaults, discovery-reason
  chips, the sidebar toggle) come from `UiMessages` via `LocaleProvider`. `enMessages` is only the
  fallback; the app passes its translated catalog.
- **Formatting.** Every number, date and amount goes through `Intl` with the provider's locale
  (or a `locale` prop): `formatMoney(cents, currency, locale)`, `formatCompactNumber`,
  `formatRelativeTime`, `getInitial`. Money minor units come from ISO 4217
  (`minorUnits()` in `@commonair/contracts/currency`), never from `Intl` (V8 and JSC disagree for
  HUF, IDR, IQD, …), and Intl is pinned to exactly that many fraction digits.
- **SSR.** Wrap the app in `<NowProvider now={requestTime}>` (same value on server and client) so
  `<RelativeTime>` renders identical markup on the server and the first client render; it switches
  to the live clock after mount. `tests/ssr.test.tsx` server-renders and hydrates every primitive
  and every shadcn component and fails on any hydration warning.

## House primitives

`StreamCard` (+ `StreamCardSkeleton`), `ChannelAvatar`, `LiveBadge`, `ViewerCount`, `RelativeTime`,
`MoneyAmount` / `formatMoney`, `EmptyState`, `Skeleton`, `SkeletonGroup`, `SkeletonText`,
`SkeletonAvatar`, `SkeletonThumbnail`, `SkeletonButton`, `IconButton` (required `label`, Tooltip,
`aria-label`), `ConfirmDialog` (AlertDialog, destructive variant, async confirm), `toast`,
`Kbd` / `Shortcut`, `CommandPalette`, `ThemeToggle`, `LocaleProvider`, and on top of `Badge` /
`Button`:

- `StatusBadge` (`tone`: `neutral | success | warning | info | danger | accent`, optional `icon`):
  state chips (the mockups' `badge-ok/warn/info/accent`).
- `OverlayBadge` (`size`: `sm | md`, optional `icon`): text over video and thumbnails (durations,
  "Mature", `ViewerCount variant="overlay"`).
- `AccentButton` (every `Button` size, optional `accent`): Follow / Subscribe / Support in the
  channel accent; AA in every accent and theme, hover included.

## How the shadcn layer was set up

1. The CLI is pinned to `shadcn@4.21.1` (`SHADCN_VERSION` in `scripts/shadcn-add.ts`). A scratch
   project outside the repository, `bunx shadcn@4.21.1 init -t vite -b base -p b1ZhhFNpx -n probe
   --no-monorepo -y`, shows what the preset writes: `style: base-lyra` (Base UI, not Radix),
   `baseColor: zinc`, `menuColor: inverted`, `menuAccent: bold`, Lucide, Instrument Sans and a blue
   primary.
2. `components.json` here keeps the style, base color and menu settings, and uses
   `iconLibrary: hugeicons` with every alias inside the package (`@commonair/ui/...`, resolved by
   the `paths` entry in `tsconfig.json` and by the package `exports`). Fonts and colors stay
   CommonAir's.
3. Components are added with the wrapper, which runs the pinned CLI and post-processes the output.

```sh
bun scripts/shadcn-add.ts accordion            # add
bun scripts/shadcn-add.ts dialog --overwrite   # upgrade; review the diff and re-apply DEVIATIONS.md
bun scripts/shadcn-add.ts --snapshot           # regenerate upstream/ from a scratch preset project
```

The wrapper rewrites `import { cn } from "cn"` to our `@commonair/ui/lib/utils`, adds SPDX headers
to `src/components` and `src/hooks` (shadcn code is MIT; the notice is kept, see below), removes
registry dependencies we replace (`cn`, `next-themes`, `cmdk`, `shadcn`) and fails on any unpinned
new dependency.

### Deliberate deviations

[DEVIATIONS.md](DEVIATIONS.md) lists every difference from the upstream reference (file, what, why,
the guarding test). `upstream/` holds that reference (the preset project's output, normalized and
formatted, stored as `.txt`); `tests/deviations.test.ts` fails when a component file differs from
it without a row. The big ones: `command.tsx` is built on Base UI's `Autocomplete` instead of
`cmdk` (no Radix in the tree), `sonner.tsx` takes `theme` as a prop instead of `next-themes`,
focus rings are full-opacity tokens (3:1), and design-system strings come from `UiMessages`.

## Storybook

`bun run storybook` (dev, port 6006) and `bun run build-storybook` (static, `storybook-static/`).
Every primitive has stories for its states (loading, empty, error, long text, RTL, 320 px, dark,
light); the toolbar switches theme, direction and locale. Storybook loads nothing remote:
telemetry and "what's new" are off, fonts are bundled from `@fontsource-variable/rubik`, and story
images are inline SVG data URIs.

## Tests

`bun run test` (Vitest under Bun) and `bun run test:node` (the same suite under Node/V8, so engine
differences in `Intl` show up), with happy-dom and Testing Library: SSR hydration of every primitive,
formatting (money incl. JPY/KWD and
negatives, compact counts, relative time), token contrast, the no-Radix / no-`title=` /
no-native-dialog guards, and behavior of each primitive (avatar fallback, RelativeTime updates with
fake timers, ConfirmDialog keyboard and async flows, IconButton tooltip, CommandPalette filtering and
keyboard, toast).

## Third-party code

Files under `src/components/` and `src/styles/shadcn.css` derive from shadcn/ui
(<https://github.com/shadcn-ui/ui>), used under the MIT License:

> MIT License
>
> Copyright (c) 2023 shadcn
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
> associated documentation files (the "Software"), to deal in the Software without restriction,
> including without limitation the rights to use, copy, modify, merge, publish, distribute,
> sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or
> substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
> NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
> NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
> DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
> OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Rubik (`@fontsource-variable/rubik`) is under the SIL Open Font License 1.1.
