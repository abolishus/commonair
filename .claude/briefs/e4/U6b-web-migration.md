<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing **E4a U6b — apps/web migration onto the shells and compositions, plus the
apps/web source policy test** for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md
("Design rules (web)", "House primitives"), PLAN.md (E4a row), `apps/web/README.md`,
`packages/ui/README.md`, `packages/ui/DEVIATIONS.md`, `docs/testing/e1-selectors.md`,
`e2-selectors.md`, `e3-selectors.md`, then `.claude/briefs/e4/_common.md` and
`.claude/briefs/e4/_compositions.md` (both are part of this brief). Read the U1–U5 compositions and
their stories (`packages/ui/src/{layouts,blocks,primitives}`, `packages/ui/stories/**`). Do not look
outside the repository. You work in your own git worktree: run `git merge main --no-edit` first,
then `bun install` if `node_modules` is missing. Another unit (U6a) writes `packages/ui/stories/
pages/**` and `packages/ui/tests/source-policy.test.ts` in parallel; do not touch packages/ui.

Canvas: <https://claude.ai/artifact/Ve5J5XjRZV42eRE2cdReVd>. The boards that match today's routes:
**Main** (`/`), **SignIn** (`/signin`, `/signup`), **Channel** + **ChannelAbout** + **Mobile**
(`/$channel` live and offline), **StreamManager** + **StreamSetup** (`/dashboard`: stream key,
health), **TrustSafety**/StudioShell patterns for `/relays` (it is a creator tool: put it in the
StudioShell). Condensed copies: `.claude/briefs/e4/boards/<Board>.html`.

## You own (write only these)

- `apps/web/src/**` except `apps/web/src/server/**` and `apps/web/src/player/{controller,heartbeat,lifecycle,
  source,stats}.ts` (behavior you must not change; you may change `player.tsx` presentation)
- `apps/web/tests/**` (new `source-policy.test.ts`; existing tests may be updated only where markup
  moved, never to weaken an assertion), `apps/web/README.md`

## Contracts you must honor (read-only for you)

- **Every `data-testid` and data attribute in e1/e2/e3-selectors.md survives** with the same
  semantics (`apps/web/tests/selectors.test.ts` must keep passing unchanged). Behavior does not
  change: same routes, same API calls, same loaders, same forms and validation, same toasts, same
  keyboard flows. No API, contracts, config, DB or harness changes.
- `packages/ui/**` is read-only. If a page needs something the compositions cannot express, do
  not style it locally: report a contract request (composition, props, why) and, until the head
  agent adds it, keep the existing markup for that piece with a `// E4a gap: <request>` comment.

## Build

1. **Shells.** `routes/_app.tsx` → `AppShell` with `SiteHeader` (brand, nav with `nav-directory`,
   `HeaderSearch` only if it has a working target — otherwise omit it, do not add dead UI),
   `ThemeToggle`, `UserMenu` carrying `nav-user` + `data-username` (dashboard, relays, sign out),
   signed-out sign-in/sign-up links) and `SiteFooter` (`footer-source-link`). Creator routes
   (`/dashboard`, `/relays`) render inside `StudioShell` with nav items only for pages that exist
   (Stream manager → /dashboard, Relays → /relays). `embed.$channel` stays chromeless and uses
   `PlayerChrome` only.
2. **Pages compose only** (`PageContainer`, `PageHeader`, `Section`, `SplitLayout`,
   `ResponsiveGrid`, blocks): `/` (directory sections via `StreamGrid` keeping `directory`,
   `directory-section` + `data-section`, `directory-empty`, the signed-out/signed-in calls to action
   as a `PageHeader` with actions), `/$channel` (`ChannelHeader` with follow button +
   `follower-count`, `PlayerChrome` around the existing `<video>`, `ChatPanel`/`ChatMessage`/
   `ChatComposer` keeping every chat id, the moderation menu as the message `actions` slot,
   offline state as the player `stage`), `/signin` and `/signup` (`FormSection`/Field blocks:
   `PasswordField`, `DateOfBirthField`, ALTCHA row, legal checkbox, `form-error`), `/dashboard`
   (`CopyField` for server URL + stream key with the e1 ids, rotate through `ConfirmDialog`,
   stream health via `KeyValueList` + `StatusBadge` keeping `stream-health` / `-warning` +
   `data-code`), `/relays` (`DataTable` with `rowProps` for `relay-row` and its data attributes,
   create form, token `CopyField`/`CodeBlock` for the run command, `relays-empty`).
3. **Strings** through `t()`; new keys in `src/i18n/en.ts` (and the test that checks the catalog).
4. **`tests/source-policy.test.ts`** scans `apps/web/src/**` (except `routeTree.gen.ts` and
   `src/server/**`) and fails, with file and line, on: raw `<button`, `<input`, `<select`,
   `<textarea`, `<table`, `<dialog`; `role=` on `<div`/`<span`; arbitrary-value classes and
   arbitrary properties; color literals (`#hex`, `rgb(`, `hsl(`, `oklch(`, `oklab(`, `color-mix(`);
   imports of `@base-ui/react`, `sonner` or `@commonair/ui/components/*` primitives that have a
   house replacement listed in AGENTS.md ("use X, not Y") used the wrong way — at minimum, ban
   `sonner`; native `title=` on lower-case JSX elements; `style=`; `alert(`/`confirm(`/`prompt(`.
   One-off exceptions need an allowlist entry `{ file, rule, reason }` with a short reason; the
   `<video>` element and the ALTCHA custom element are expected entries. Include detector
   self-tests. The video element is not interactive HTML in this sense; `<a>` via router `Link`
   is fine.
5. Keep 320 px with a 16 px gutter and no horizontal scroll, keyboard and visible focus,
   `prefers-reduced-motion`, both themes.

## Tests you must add

- `tests/source-policy.test.ts`; the existing web tests keep passing (update only selectors that
  moved inside compositions, never weaken). Add tests for any new presentational logic (e.g. nav
  items for signed-in vs signed-out, studio nav current item).

## Done means

Per `_common.md` "Done means" (`vp build` in `apps/web` must pass; `bun run test` in `apps/web`).
Final message also lists every route → compositions used, every allowlist entry, every E4a gap
left in place, and what the user should click through on staging (routes, signed-in and signed-out).
