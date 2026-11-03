<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# D4: page titles, skip link, error actions, no theme flash, signup and sign-in, co-op cap

You are implementing unit D4 for CommonAir (repo: /Users/joshe/Repos/bcon). Before you start,
read:

- AGENTS.md, PLAN.md and docs/architecture.md;
- `.claude/briefs/d/README.md` (the shared rules and the ownership matrix are binding) and
  `D0-contract-step.md`;
- `.claude/briefs/_done-means.md`;
- the design review `docs/design/2026-11-design-review.md`, findings **F13, F14, F15, F16, F17
  and F19**, with screenshots 05, 15, 16, 18, 19 and 21.

Do not look outside the repository. You are in **wave 1**: work on branch `d/d4`, cut from D0's sha.
D1-seed, D1-api and D5-capture run beside you, and so does batch 8's wave 2.

## You own (write only these)

- The `head()` of every route file under `apps/web/src/routes/**`, except those in
  `PENDING_HEAD` (below). You may edit only the `head` option in those files, unless a file is
  listed here in full.
- In full:
  - `apps/web/src/routes/__root.tsx`;
  - `apps/web/src/routes/_app/signin.tsx` and `signup.tsx`;
  - `apps/web/src/components/password-fields.tsx` and `components/altcha-field.tsx`;
  - `apps/web/src/components/coop/overview.tsx`.
- The error and not-found components rendered by `__root.tsx` and by the `_app`, `_studio` and
  `_admin` layout routes. Their `errorComponent` and `notFoundComponent` only.
- `packages/ui/src/layouts/app-shell.tsx`, and `packages/ui/src/components/empty-state*` if the
  action slot needs a change.
- The `d4-polish` namespace (`en` and `es`).
- `apps/web/tests/d4-*.test.tsx`, plus the new `head` check in `apps/web/tests/source-policy.test.ts`.
- `harness/src/d/d4.ts`.

**`PENDING_HEAD`** (do not touch these; their owners add titles later):

- `routes/_app/$channel.tsx` and `routes/_admin/admin.moderation.tsx`: B8-web, then D2-channel
  and D5-studio.
- The VOD and clip routes: D3-watch.
- Any route file whose component directory B8-web or B8-server owns.

The test fails if a listed file already has a `head`, and if an unlisted file lacks one, so the
list can only shrink.

## Build

1. **F15: a title on every page.**
   - Each route gets
     `head: () => ({ meta: [{ title: pageTitle(t("pageTitle.<route>")) }] })`, where
     `pageTitle(page)` returns `"<page> · <SITE.name>"`. Write that helper in `apps/web/src/lib/`
     (new file `page-title.ts`, owned by you).
   - The root keeps the site tagline as the fallback.
   - When loader data is needed, use the loader's data the route already has. Never fetch again.
   - The titles must update on a locale switch: the root already re-runs matches (`__root.tsx:74`).
   - Add the source-policy check. It fails on a route without a `head`, and fails on a
     `PENDING_HEAD` entry that has gained one.
2. **F16: the skip link comes first.** In `app-shell.tsx`, render `skip` before `header`, as the
   sidebar branch already does (`:50` and `:61-62`). Add a test for the tab order, and a Storybook
   story for both variants.
3. **F13: every error and not-found state has an action.**
   - Each `<EmptyState>` on an error or not-found path gets a description and a primary action:
     "Browse live channels" goes to `/` until D1-web's directory lands, and the route constant
     lives in one place so D1-web can repoint it.
   - The unknown channel's state is in `$channel.tsx`, which is D2's. Make it available as a
     shared `NotFoundState` component in `apps/web/src/components/not-found.tsx` (new, yours), so
     D2-channel can adopt it.
   - The root error boundary uses the same pattern, never a stack trace.
   - Count it: every `<EmptyState>` under `routes/**` in an error or not-found branch passes
     `action` (a test greps for it).
4. **F14, the no-flash half.**
   - The server-rendered `<html>` must carry the theme class from the cookie (the
     `boot.theme` path, `__root.tsx:57-64`), so the first paint is already right.
   - Colour transitions stay disabled until hydration: a `data-hydrating` attribute that CSS
     uses to suppress `transition`, removed on mount.
   - A test renders the root server-side with each cookie value and asserts the class.
   - The switcher's move into the account menu is D1-web's (it owns `site-chrome.tsx`), not yours.
5. **F17: signup and sign-in.**
   - On `lg`, two columns: the form, and a short co-op pitch (member-owned, open books, a link to
     `/transparency`). On narrow screens, one column, form first.
   - Replace the native date input with the design system's date field, or three `Select`s for
     day, month and year with a locale-ordered layout. Keep the same validation and age rules.
   - Restyle the ALTCHA container with tokens (`altcha-field.tsx`), so it matches the inputs in
     both themes.
   - Show "Forgot password?" under the password field on sign-in, linked to the existing reset
     flow.
   - Return the visitor to where they came from: a `redirect` search param, validated as
     same-origin and path-only. An open redirect is a bug, and a test covers it.
6. **F19, the UI half.**
   - The co-op overview shows the 5 latest decisions, with a "See all decisions" link to the
     proposals list filtered to decided.
   - Use `<Skeleton*>` and `aria-busy` instead of the plain "Loading" text (`overview.tsx:191`).

## Tests you must add

- `d4-titles.test.tsx`: `pageTitle()`; a sample of routes renders the expected title in `en` and
  `es`.
- The source-policy `head` check and the `PENDING_HEAD` rules.
- `d4-shell.test.tsx`: the skip link is the first focusable element in both shell variants.
- `d4-errors.test.tsx`: every error and not-found state renders an action.
- `d4-theme.test.tsx`: the server-rendered class for each cookie value; transitions are suppressed
  until hydration.
- `d4-auth.test.tsx`: the date field validation, the `redirect` allowlist (an absolute URL, `//`,
  `javascript:` and a backslash trick are all refused), and the forgot-password link.
- `d4-coop.test.tsx`: the 5-item cap and the link.
- `harness/src/d/d4.ts`:
  - on the seeded stack, the first Tab on `/` lands on `skip-link`;
  - an unknown channel shows `empty-state-action`;
  - `document.title` differs on `/`, `/coop` and `/transparency`.

## Done means

- The `_done-means.md` checks pass, and the source-policy test is green with `PENDING_HEAD`
  listing only the files above.
- The user's visual checklist in your final message covers:
  - screenshots 15, 18, 19 and 21 retaken, light and dark, at 375 and 1440 px;
  - the theme with a throttled CPU (no flash);
  - the keyboard walk on `/`;
  - signup in `es`.
