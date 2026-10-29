<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# E9-consent: the consent, device activation and connections pages (web)

You are implementing unit E9-consent for CommonAir (repo: /Users/joshe/Repos/bcon). Read
AGENTS.md (Design rules, house primitives), PLAN.md and docs/architecture.md first, then
`.claude/briefs/next/E9-developer-platform.md`, `docs/decisions/0027-oauth-and-eventsub.md` (§1
"Consent screen in plain words", §2), `docs/decisions/0029-i18n.md`,
`.claude/briefs/e9/contract-step.md` (§1.7-1.8 the `developer.oauth.*`/`grants.*` procedures, §7,
§9), `docs/testing/e9-selectors.md` (Consent, Device activation, Connections; scenario step 3), and
the i18n format N2-core landed in wave 1 (`apps/web/src/i18n/**` and `packages/i18n`; read its
README or module docs). Do not look outside the repository. Work in your own git worktree on a
branch named `e9/consent`, created from `main` after wave 2 merged (the orchestrator gives you the
sha). Wave 3, beside E9-sdk, E9-console and N2-consent.

## Why

A third-party app sends the browser to `/oauth2/authorize`; today that is a placeholder. The user
must see who is asking, for what, in plain words (an i18n key per scope; the English text in
`packages/contracts/src/scopes.ts` is API reference, not UI copy), approve or deny, and later see
and revoke every app they authorized. Headless bots show a user code that the user enters on
`/activate`.

## You own (write only these)

- `apps/web/src/routes/_app/oauth2.authorize.tsx`, `apps/web/src/routes/_app/activate.tsx`,
  `apps/web/src/routes/_app/settings.connections.tsx` (placeholders from the contract step; fill
  them, never add, rename or remove route files)
- `apps/web/src/components/oauth/**` (new: consent card, scope list, scope message map, connection
  row)
- Your i18n namespace **`e9-consent`**, which N2-core created empty in wave 1:
  `apps/web/src/i18n/locales/en/e9-consent.json` and the regenerated
  `apps/web/src/i18n/keys/e9-consent.gen.ts` (`cd apps/web && bun run i18n:gen`), following "How
  to add a namespace" in `.claude/briefs/n2/N2-core.md` — **only this namespace**; never `en.ts`,
  `index.ts`, `keys/index.gen.ts`, another namespace, or N2-core's files and tests. If the
  namespace does not exist, stop and send a contract request
- `apps/web/tests/e9-consent*.test.ts(x)`
- Harness: `harness/src/e9/consent.ts` (step 3), `harness/tests/e9/consent*.test.ts`

Read-only: `packages/**`, `apps/web/src/routeTree.gen.ts`, `lib/{nav,guard}.ts`,
`routes/_app/signin.tsx`, `routes/_app/signup.tsx` (both keep `returnTo`, contract step §7.2),
`components/site-chrome.tsx`, every other route and component, other
namespaces, `harness/src/e9/{run,selectors,receiver,ws-client}.ts`. Anything else is a **contract
request** with the exact diff.

## Contracts you must honor (read-only for you)

- `developer.oauth.request` (loose input mirroring the query: `client_id` → `clientId`,
  `redirect_uri`, `response_type`, `scope`, `state`, `code_challenge`, `code_challenge_method`,
  `force_verify`): `NOT_FOUND` (unknown client), `PRECONDITION_FAILED` with `data.requirement`
  `app_suspended` or `invalid_redirect_uri` (show `oauth-consent-error`, never redirect), or
  `{ kind: "redirect", redirectTo }` (go there at once) or `{ kind: "consent", app, scopes, alreadyGranted }`.
- `developer.oauth.decide({ …, approve })` → `{ redirectTo }`: navigate with
  `window.location.assign(redirectTo)` (a full navigation to the app's registered URI, which the
  API built; never to anything else).
- `developer.oauth.activation({ userCode })` (a POST: the code travels in the body, never in a
  URL the page requests; decided 2026-10-29) → `OAuthDeviceConsent`; `NOT_FOUND` →
  `device-error data-error="not_found"`, `PRECONDITION_FAILED` `expired` → `expired`;
  `developer.oauth.activate({ userCode, approve })`.
- `developer.grants.list` → `OAuthGrant[]`; `developer.grants.revoke({ appId })`.
- `SCOPE_NAMES` (`@commonair/contracts/scopes`), `normalizeUserCode`, `OAUTH_PATHS`.
- The guard (already in the placeholders; keep it): `beforeLoad: ({ location }) =>
  requireSession(() => getSessionUser(), { returnTo: location.href })` sends signed-out users to
  `/signin?returnTo=<this page with its query>` and sign-in comes back (contract step §7.2).
- Selectors: every id in `docs/testing/e9-selectors.md` "Consent", "Device activation",
  "Connections" (and `account-connections-link`, which the contract step already renders).
- Design rules: shadcn/ui on Base UI, Hugeicons, tokens only, `<ConfirmDialog>` for revoke,
  `<EmptyState>`, `<Skeleton*>`, `<RelativeTime>`, `<ChannelAvatar>` for the owner, `toast.*`,
  keyboard and screen-reader complete, 320 px wide with a 16 px gutter, dark first.

## Build

1. **`/oauth2/authorize`**: `validateSearch` with zod over the OAuth query names (all strings,
   optional, bounded; unknown params ignored). On load call `oauth.request`. Render:
   - `redirect` → `window.location.replace(redirectTo)` and a minimal "returning to the app" state.
   - error → `oauth-consent-error` with `data-error` (`invalid_client` for `NOT_FOUND`, or the
     requirement), a plain explanation, a link home. Never echo `redirect_uri` or `state` into the
     page as HTML (text only, and preferably not at all).
   - `consent` → `oauth-consent` card: app name and description, `oauth-consent-owner` (the
     registering member, with a link to their profile), "will be able to:" the scope list
     (`oauth-consent-scope data-scope`) in plain words, "will not be able to see your password or
     email unless listed", the signed-in account with a "not you?" sign-out-and-return link,
     `oauth-consent-approve` (primary) and `oauth-consent-deny`. Buttons call `oauth.decide`; while
     pending both are disabled; errors (e.g. the app got suspended meanwhile) show inline.
   - `alreadyGranted` and no `force_verify` → approve without showing the card (still through
     `oauth.decide`), with the card's skeleton visible for that moment.
     The page must not leak the request: no third-party resources, no referrer of the query (`<meta name="referrer" content="no-referrer">`
     via the route `head`, since the query carries `state` and the challenge). Framing is already
     refused by Caddy for non-embed paths.
2. **Scope copy**: `apps/web/src/components/oauth/scope-messages.ts` exports a static
   `Record<Scope, MessageKey>` (no runtime-built keys: the i18n test forbids them) into
   `e9-consent` keys like `oauth.scope.chat.read`, `oauth.scope.moderator.manage.chat`, … (ADR
   0027 §1 names them `oauth.scope.<name>`; every key of your namespace starts with `oauth.`, the
   unit prefix N2-core's recipe asks for, which no other catalog uses) with a short title
   and one sentence each, written for viewers and streamers ("Send chat messages as you"). A test
   asserts every `SCOPE_NAMES` entry has a key and every key exists in the catalog. Sensitive
   scopes (`user:read:email`, `channel:manage`, `moderator:manage:chat`,
   `channel:manage:points`) get a visible "sensitive" marker.
3. **`/activate`**: `device-form` with `device-code` (accepts `XXXX-XXXX`, lowercase, no dash;
   prefilled from `?code=`; `inputMode="text"`, `autoCapitalize="characters"`, `autoComplete="off"`),
   `device-submit` → `oauth.activation` → `device-consent` (same scope list component, same owner
   line), `device-approve` / `device-deny` → `oauth.activate` → `device-done data-result`.
   "Return to your device" text after approval. Never put the code in a URL the page navigates to
   (only the incoming `?code=` the device showed).
4. **`/settings/connections`**: `connections` list from `grants.list`: app name, owner, scopes in
   plain words, authorized and last-used times (`<RelativeTime>`), `connection-revoke` with
   `<ConfirmDialog>` (it disconnects the app's chat bots and event subscriptions at once; say so),
   then remove the row and toast. `connections-empty` `<EmptyState>`. Loading skeletons; a failed
   load shows a retry (same pattern as the co-op pages).
5. **i18n**: every string through `t()` in your `e9-consent` namespace in N2-core's format,
   including plurals (ICU) for counts ("{count, plural, one {# app} other {# apps}}"); dates and
   numbers only through the house primitives.
6. **Harness step 3** (`harness/src/e9/consent.ts`, flip `ready: true`; `webOnly`): scenario step 3
   of `docs/testing/e9-selectors.md` in Chromium with the streamer's browser context: open the
   authorize URL signed out, sign in through `/signin` (the existing harness sign-in helper), land
   back on the consent, check one `oauth-consent-scope` per requested scope, approve, read `code`
   and `state` from the receiver's recorded `/cb` request (the browser follows the redirect to
   `127.0.0.1:<port>/cb`), exchange the code over HTTP; then deny on a second request →
   `error=access_denied`; then `/activate` with a user code from `OAUTH_PATHS.device` for the
   public app and poll the token to success; then `/settings/connections` lists the confidential
   app with its scopes.

## Tests you must add

- `apps/web/tests/e9-consent.test.tsx` (component tests with a mocked API client): each
  `oauth.request` outcome (consent, redirect, the three errors), approve and deny call `decide`
  with the right input and navigate to `redirectTo`, `alreadyGranted` auto-approves only without
  `force_verify`; activation flow (normalization, not found vs expired, approve/deny); connections
  list, revoke with confirm, empty and failed states; every selector id in the three sections is
  rendered; scope map completeness.
- Accessibility: buttons have accessible names, the scope list is a list, focus lands on the card
  heading; reduced motion respected.
- Harness: pure helpers of step 3.

## Done means

Follow `.claude/briefs/_done-means.md` (targeted checks only): `bun --bun vp test run` in
`apps/web` (the N2-core i18n tests included) and `harness`; `bunx tsc -p apps/web --noEmit` and
`harness`; `vp lint --deny-warnings` and `vp fmt` on your paths; `vp build` in `apps/web` and
confirm `git diff apps/web/src/routeTree.gen.ts` is empty. Never run `bun run verify`, a dev
server, a browser, a harness scenario, `podman compose` or `scripts/infra.ts`. `git status` shows
only your paths. Commit in your worktree (`git commit -s`, Conventional Commits, ending with
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). Final message: what you built, test
counts, branch and sha, contract requests (exact diffs), anything left undone, and the live
commands: `bun harness/src/cli.ts run developer-platform --set steps=1-3` and a manual check list
for the user (the three pages at 320 px, dark and light, keyboard only).
