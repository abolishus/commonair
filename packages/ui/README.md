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
  name colors, AA on background and card), `--chart-1`…`--chart-5`, `--overlay` (text over video).
- **Strings.** Components never inline English. Visible text comes from props; the few strings
  the design system itself needs (screen-reader labels, Cancel/Confirm defaults, discovery-reason
  chips) come from `UiMessages` via `LocaleProvider`. `enMessages` is only the fallback; the app
  passes its translated catalog.
- **Formatting.** Every number, date and amount goes through `Intl` with the provider's locale
  (or a `locale` prop): `formatMoney(cents, currency, locale)` (integer minor units, JPY has none),
  `formatCompactNumber`, `formatRelativeTime`, `getInitial`.

## House primitives

`StreamCard` (+ `StreamCardSkeleton`), `ChannelAvatar`, `LiveBadge`, `ViewerCount`, `RelativeTime`,
`MoneyAmount` / `formatMoney`, `EmptyState`, `Skeleton`, `SkeletonGroup`, `SkeletonText`,
`SkeletonAvatar`, `SkeletonThumbnail`, `SkeletonButton`, `IconButton` (required `label`, Tooltip,
`aria-label`), `ConfirmDialog` (AlertDialog, destructive variant, async confirm), `toast`,
`Kbd` / `Shortcut`, `CommandPalette`, `ThemeToggle`, `LocaleProvider`.

## How the shadcn layer was set up

1. Checked the CLI (`bunx shadcn@4.22.1 init --help`): `-b base` picks the Base UI primitive layer
   (`@base-ui/react`, not Radix) and `-p lyra` the Lyra preset, which writes `"style": "base-lyra"`.
   A throwaway `init -t vite -b base -p lyra` project confirmed the generated `components.json`.
2. Wrote `components.json` here with `style: base-lyra`, `baseColor: zinc`, `cssVariables: true`,
   `iconLibrary: hugeicons` and every alias pointing inside the package (`@commonair/ui/...`,
   resolved by the `paths` entry in `tsconfig.json` and by the package `exports`).
3. Added components with `bunx shadcn@4.22.1 add …`, then applied `scripts/shadcn-add.ts`'s
   post-processing (below).

To add or upgrade components, always use the wrapper:

```sh
bun scripts/shadcn-add.ts accordion            # add
bun scripts/shadcn-add.ts dialog --overwrite   # upgrade; review the diff and re-apply local patches
```

It runs the pinned CLI and then: rewrites `import { cn } from "cn"` to our `@commonair/ui/lib/utils`,
adds SPDX headers (shadcn code is MIT; the notice is kept, see below), removes registry
dependencies we replace (`cn`, `next-themes`, `cmdk`, `shadcn`) and fails on any unpinned new
dependency.

### Deliberate deviations (re-apply after `--overwrite`)

- **`command.tsx` is not the registry version.** The registry `command` uses `cmdk`, which depends
  on `@radix-ui/react-dialog`, `-id`, `-primitive` and `-compose-refs`. This package has no Radix
  in its tree (enforced by `tests/guards.test.ts`), so `command.tsx` keeps the shadcn API and
  base-lyra classes but is built on Base UI's inline `Autocomplete` (the pattern Base UI documents
  for command palettes). `CommandDialog` requires `title`/`description` instead of English defaults.
- **`shadcn/tailwind.css` is vendored** as `src/styles/shadcn.css` (what `shadcn eject` inlines), so
  the CLI is not a runtime dependency. Re-copy it when bumping the CLI version.
- **Strings.** `dialog`, `sheet`, `pagination`, `breadcrumb` and `sonner` read their screen-reader
  labels from `useUiMessages()` instead of hard-coded English.
- **`sonner.tsx`** takes the theme as a prop instead of `next-themes`.
- **`field.tsx`** `FieldError` also accepts plain-string errors (TanStack Form validators can return
  either) and uses `===`.
- Lint exceptions (file-level `oxlint-disable` with a reason): `field`, `input-group`,
  `breadcrumb`, `label`.

## Storybook

`bun run storybook` (dev, port 6006) and `bun run build-storybook` (static, `storybook-static/`).
Every primitive has stories for its states (loading, empty, error, long text, RTL, 320 px, dark,
light); the toolbar switches theme, direction and locale. Storybook loads nothing remote:
telemetry and "what's new" are off, fonts are bundled from `@fontsource-variable/rubik`, and story
images are inline SVG data URIs.

## Tests

`bun run test` (Vitest under Bun, happy-dom, Testing Library): formatting (money incl. JPY/KWD and
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
