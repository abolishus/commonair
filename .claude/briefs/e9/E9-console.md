<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# E9-console: the developer console, the admin apps page and the developer docs

You are implementing unit E9-console for CommonAir (repo: /Users/joshe/Repos/bcon). Read
AGENTS.md (Design rules, house primitives), PLAN.md and docs/architecture.md first, then
`.claude/briefs/next/E9-developer-platform.md`, `docs/decisions/0027-oauth-and-eventsub.md`,
`docs/decisions/0029-i18n.md`, `.claude/briefs/e9/contract-step.md` (§1.7-1.8, §7, §8, §9),
`docs/testing/e9-selectors.md` (Developer console, Bots and tokens, Apps; scenario step 7), the
final messages of the wave-2 E9 units (the orchestrator passes them on: limits, error codes,
protocol facts for the docs), `.claude/briefs/e9/E9-sdk.md` (the SDK is being written beside you:
its package name and example file names are fixed there), and the i18n format N2-core landed in
wave 1 (`.claude/briefs/n2/N2-core.md`, "How to add a namespace"). Do not look outside the repository. Work in your own git worktree
on a branch named `e9/console`, created from `main` after wave 2 merged (the orchestrator gives you
the sha). Wave 3, beside E9-sdk, E9-consent and N2-consent.

## Why

Developers need a place to register apps, see their credentials once, manage redirect URIs, rotate
secrets, watch their subscriptions and webhook deliveries, send test events and redeliver; bot
authors porting from Twitch need bot accounts and tokens; admins need to find and suspend an
abusive app; and everyone needs documentation with examples that actually run.

## You own (write only these)

- `apps/web/src/routes/_studio/developer.index.tsx`, `developer.apps.$appId.tsx`,
  `developer.bots.tsx`, `apps/web/src/routes/_admin/admin.apps.tsx` (placeholders from the contract
  step; fill them, never add, rename or remove route files; keep each studio page's own
  `beforeLoad: () => requireSession(() => getSessionUser())`: the studio layout guards nothing,
  the admin layout does)
- `apps/web/src/components/developer/**` (new)
- Your i18n namespace **`e9-console`** (created empty by N2-core):
  `apps/web/src/i18n/locales/en/e9-console.json` and the regenerated
  `apps/web/src/i18n/keys/e9-console.gen.ts` — **only this namespace**; never `en.ts`, `index.ts`,
  `keys/index.gen.ts` or another namespace
- `apps/web/tests/e9-console*.test.ts(x)`
- `docs/developers/**` (new; CC-BY-SA-4.0 headers), except `docs/developers/sdk.md` (E9-sdk's, in
  parallel; do not create or link it, the orchestrator adds the link)
- Harness: `harness/src/e9/console.ts` (step 7), `harness/tests/e9/console*.test.ts`

Read-only: `packages/**`, every other web
file, other namespaces, `routeTree.gen.ts`, nav/access/sidebars (the contract step added the
studio and admin entries), `harness/src/e9/{run,selectors,receiver,ws-client}.ts`. Anything else
is a **contract request** with the exact diff.

## Contracts you must honor (read-only for you)

- `developer.apps.list/create/update/rotateSecret/remove` (`OAuthApp`, `OAuthAppSecret` shown
  once, `suspended`), `developer.events.catalog` (types, condition fields, scopes, `transports`),
  `developer.events.list({ appId })`, `subscribe({ appId, type, condition, transport: webhook })`,
  `unsubscribe`, `deliveries`, `sendTest`, `redeliver`; `me.bots.create/list/createToken`
  (token shown once), `developer.tokens.list/revoke` (`AccessToken` with `appId`, `kind`);
  `developer.admin.list/suspend/unsuspend` (`AdminOAuthApp`, `APP_SUSPENSION_REASONS`).
  Error requirements from the wave-2 briefs (`app_limit`, `app_suspended`, `public_client`,
  `subscription_limit`, `websocket_only`, `condition_keys`, `webhook_only`, `not_enabled`) map to
  inline messages, and so do `me.bots.create`'s `bot_limit` and `me.bots.createToken`'s
  `channel_bot` (E8's step: the per-channel bot that `/bot` creates is listed by `me.bots.list`
  with the owner's other bots, but no token can be minted for it; say so inline in
  `devbot-token-form`).
- Selectors: every id in `docs/testing/e9-selectors.md` "Developer console", "Bots and tokens",
  "Apps".
- Design rules and house primitives (AGENTS.md): `<ConfirmDialog>` for delete, rotate, revoke and
  suspend; `<EmptyState>`; `<Skeleton*>`; `<RelativeTime>`; `<IconButton tooltip>` for copy
  buttons; `toast.*`; tokens only; 320 px; dark first; keyboard complete.

## Build

1. **`/developer`** (studio): `devapps` list (`devapp-row`, suspended badge), `devapp-new` →
   `devapp-form` (name, description, redirect URIs one per line validated client-side with
   `redirectUriProblem` from `@commonair/contracts/oauth` and server-side errors inline,
   confidential switch with a one-line explanation of public clients and PKCE), on success the
   `devapp-secret` dialog for confidential apps: the secret once, copy button, a warning that it
   cannot be shown again, `devapp-secret-done` closes and forgets it (never stored in state beyond
   the dialog, never in `localStorage`, never logged).
2. **`/developer/apps/$appId`**: `devapp` header with client id (copyable), confidential/public,
   suspended notice (from `suspended.reason`, in plain words), `devapp-edit`, `devapp-rotate`
   (confirm, then `devapp-secret`), `devapp-delete` (confirm: "revokes every token and deletes
   every subscription"). `devsubs`: the app's subscriptions (`events.list({ appId })`, paged),
   `devsub-new` → `devsub-form` built from `events.catalog` (only webhook-capable types; condition
   inputs per the type's fields; callback; secret with a "generate" helper using
   `crypto.getRandomValues`), `devsub` rows with status, `devsub-test` (webhook only), `devsub-delete`,
   `devsub-deliveries` → the delivery log (`devdelivery`, paged, auto-refresh while open),
   `devdelivery-redeliver` on failed notifications.
3. **`/developer/bots`**: `devbots` from `me.bots.list`, `devbot-new`, per bot `devbot-token-new` →
   `devbot-token-form` (scopes as checkboxes labelled with the scope identifiers in `<code>`, e.g.
   `chat:edit`: API names, not prose, so they are not translated; E9-consent's plain-word labels
   are in a parallel unit, and switching to them is a follow-up you list in your final message),
   days, then the token once (`devbot-token-value`) with the IRC hint
   (`oauth:<token>`, nick = bot login). Below, `devtoken` rows from `developer.tokens.list`
   (personal and app tokens on your account and your bots'), `devtoken-revoke`.
4. **`/admin/apps`** (admins): `adminapps` with search and the suspended filter, paged;
   `adminapp` rows with owner, grants and subscriptions counts; `adminapp-suspend` →
   `adminapp-suspend-form` (reason radio items, confirm stating the consequences); `adminapp-unsuspend`
   (confirm stating that tokens stay revoked).
5. **i18n**: every string through `t()` in your `e9-console` namespace in N2-core's format, with
   ICU plurals for counts; times and numbers through the house primitives. Every key starts with
   your unit prefix `developer.` (admin page: `developer.admin.*`); no other catalog uses it (the
   contract step's nav keys are `studio.developer`, `nav.connections`, `nav.adminApps`).
6. **Docs** (`docs/developers/`), plain and accurate against the code as merged, each page linked
   from `docs/developers/README.md` and from `docs/README.md` via a contract request (that file is
   the orchestrator's):
   - `getting-started.md`: register an app, choose confidential or public, redirect URI rules.
   - `oauth.md`: endpoints (`OAUTH_PATHS`), authorization code + PKCE step by step, lifetimes
     (`OAUTH_LIMITS`), refresh rotation and reuse detection, client credentials (no scopes, what
     they can call), device flow, revocation, `oauth2/validate`, error codes, scopes table (names
     from `SCOPES`), sensitive scopes.
   - `eventsub.md`: catalog, conditions, transports, the backing-user rules for app tokens, webhook
     signing and verification, retries and failure handling, the WebSocket protocol (connect URL,
     keepalive, close codes, reconnect, limits), WebSocket-only types.
   - `rate-limits.md`: per-token subjects and the per-app bucket (ADR 0027 §4).
   - `porting-from-twitch.md`: `@commonair/sdk` by name (its guide is E9-sdk's `sdk.md`),
     `TWITCH_SCOPE_MAP`, the IRC gateway for tmi.js and friends
     (`services/irc/README.md`), EventSub differences (header prefix `eventsub-`, string `scope` in
     token responses, `channel.chat.message` WebSocket only, device flow at `/activate`), what has
     no equivalent yet.
     No instance-specific hostnames: write `https://<your instance>` (`check-domains` fails on
     stray literals).
7. **Harness step 7** (`harness/src/e9/console.ts`, flip `ready: true`; `webOnly`): scenario step 7
   of `docs/testing/e9-selectors.md` in Chromium (developer and admin browser contexts), reading
   ids only through `harness/src/e9/selectors.ts`.

## Tests you must add

- `apps/web/tests/e9-console.test.tsx` (mocked API client): app create (confidential shows the
  secret once and forgets it on close; public shows none), redirect URI validation, edit, rotate,
  delete with confirm; subscription form built from a catalog fixture (condition fields per type,
  WebSocket-only types absent), test event, deliveries paging and redeliver visibility; bots and
  token minting (token shown once); token revoke; admin list, suspend with reason, unsuspend; every
  selector id in the three sections rendered; suspended app disables edit and rotate.
- `apps/web/tests/e9-console-docs.test.ts`: every relative link in `docs/developers/**` resolves;
  every `OAUTH_PATHS` value and every `EVENTSUB_WS_CLOSE` code appears in the docs (so the docs
  move with the contract).
- Harness: pure helpers of step 7.

## Done means

Follow `.claude/briefs/_done-means.md` (targeted checks only): `bun --bun vp test run` in
`apps/web` and `harness`; `bunx tsc -p apps/web --noEmit` and `harness`; `vp lint
--deny-warnings` and `vp fmt` on your paths (docs included); `vp build` in `apps/web` and confirm
`git diff apps/web/src/routeTree.gen.ts` is empty; `bun scripts/check-domains.ts` if it runs
standalone. Never run `bun run verify`, a dev server, a browser, a harness scenario, `podman
compose` or `scripts/infra.ts`. `git status` shows only your paths. Commit in your worktree (`git
commit -s`, Conventional Commits, ending with `Co-Authored-By: Claude Opus 5.5
<noreply@anthropic.com>`). Final message: what you built, test counts, branch and sha, contract
requests (exact diffs, including the `docs/README.md` link), anything left undone, and the live
commands: `bun harness/src/cli.ts run developer-platform` (all steps, web) and a manual check list
for the user (the four pages at 320 px, dark and light, keyboard only).
