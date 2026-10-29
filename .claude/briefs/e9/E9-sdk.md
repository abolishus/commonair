<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# E9-sdk: `@commonair/sdk`

You are implementing unit E9-sdk for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
PLAN.md and docs/architecture.md first, then `.claude/briefs/next/E9-developer-platform.md`,
`docs/decisions/0027-oauth-and-eventsub.md` (§5), `docs/decisions/0022-supply-chain.md`,
`.claude/briefs/e9/contract-step.md` (§1.2 `oauth.ts`, §1.4 `eventsub.ts`, §1.5, §6 and §6.1, §9)
and `docs/testing/e9-selectors.md` (scenario step 6 and the `e2e-social` line). Do not look outside
the repository. Work in your own git worktree on a branch named `e9/sdk`, created from `main` at
the start of batch-3 wave 3 (the orchestrator gives you the sha); run `git merge main` first if
main moved. Wave 3, beside E9-consent, E9-console and N2-consent. The endpoints you wrap merged in wave 2
(read `services/api/src/oauth/**`, `routes/developer/**`, `eventsub/**` and those units' final
messages, which the orchestrator passes on); unit-test against fakes, the harness step proves the
real thing.

> **SDK LICENSE: Apache-2.0** (decided 2026-10-29, `docs/decisions/0035-sdk-license.md`; read it).
> Only `packages/sdk/**` is Apache-2.0; everything else in the repository stays
> AGPL-3.0-or-later, and contributions to the SDK are still signed off under the DCO. Every
> place below marked **[LICENSE]** uses `Apache-2.0`. The contract step already set
> `"license": "Apache-2.0"` and `"private": true` in `packages/sdk/package.json` (the
> workspace package is never published; only `dist/`, whose `package.json` has no `private`),
> added `LICENSES/Apache-2.0.txt`, the `REUSE.toml` annotation (`precedence = "closest"`) for
> `packages/sdk/**` and the `check-licenses` own-licence check; keep them. Nobody publishes until the maintainer creates
> the `@commonair` npm organisation and the trusted publisher.

## Why

Bots and apps should not hand-roll PKCE, device polling, refresh rotation, EventSub reconnects and
signature checks. `harness/src/bots/sdk-bot.ts` was written against a stand-in interface (`BotSdk`)
waiting for this package; `e2e-social` should exercise the real SDK.

## You own (write only these)

- `packages/sdk/**` (the contract step created `package.json`, `tsconfig.json`, `src/index.ts`)
- `harness/src/bots/sdk-bot.ts` (keep `BotSdk`, `createContractSdk`, `SdkBot` and their
  signatures: `harness/src/platform.ts:276-279` calls them and is read-only for you)
- `harness/src/e9/sdk.ts` (step 6), `harness/tests/e9/sdk*.test.ts`, `harness/tests/bots.test.ts`
  (only the parts about `sdk-bot.ts`)
- `.github/workflows/sdk-publish.yml` (new)
- `docs/developers/sdk.md` (new; the rest of `docs/developers/` is E9-console's, in parallel: do
  not link into it, the orchestrator adds the README link)

Read-only: everything else, including `packages/contracts/**`, `REUSE.toml`,
`scripts/check-licenses.ts`, `harness/package.json` (the contract step added the dependency),
`bun.lock`. Anything else is a **contract request** with the exact diff.

## Contracts you must honor (read-only for you)

- `@commonair/contracts`: `Contract` (the oRPC contract type), `OAUTH_PATHS`, `TokenResponse`,
  `OAuthErrorResponse`, `DeviceAuthorizationResponse`, `DEVICE_CODE_GRANT`, `pkceChallenge`,
  `PKCE_VERIFIER`, `parseScope`; `@commonair/contracts/eventsub`: `EVENTSUB_WS_PATH`,
  `EVENTSUB_WS_KEEPALIVE`, `EVENTSUB_WS_CLOSE`, `ENVELOPE_STATUS`; `@commonair/contracts/events`:
  `WsMessage`, `WEBHOOK_HEADERS`, `verifyWebhook`/`signWebhook`, `EVENTS`/`EventPayload` types;
  `@commonair/contracts/chat`: the chat wire protocol (what `harness/src/chat-client.ts` speaks).
- The API speaks oRPC RPC at `/rpc` (what the web app and `harness/src/api/client.ts` use) and
  OpenAPI REST at `/api`; the OAuth endpoints are form-encoded raw handlers (`OAUTH_PATHS`).
- `@commonair/contracts` is `private: true`: the published package must not depend on it.
  Everything the SDK needs from it is inlined at build time (ADR 0027 §5).
- Runtime dependencies only from the repository's allowlist and already in the root `catalog`
  (`@orpc/client`, `@orpc/contract`, `zod`). Adding anything else needs `bun scripts/vet-package.ts`
  and a contract request; you cannot run `bun add`.
- AGENTS.md rule 7 and ADR 0022: Actions pinned to commit SHAs, no long-lived npm token, provenance.

## Build

1. **Client** (`src/client.ts`): `createClient({ baseUrl, token?, getToken?, fetch?, timeoutMs? })`
   → `ContractRouterClient<Contract>` over `RPCLink` at `${baseUrl}/rpc`, sending
   `Authorization: Bearer` from `token` or the async `getToken()` (so a refreshing auth helper can
   plug in). Errors surface as oRPC's typed errors (`RATE_LIMITED` carries `retryAfterSeconds`).
2. **Auth helpers** (`src/auth.ts`):
   - `createPkcePair()` (verifier from `crypto.getRandomValues`, 64 chars of the unreserved set,
     challenge via `pkceChallenge`), `authorizeUrl({ baseUrl, clientId, redirectUri, scopes, state, codeChallenge, forceVerify? })`
     → `${baseUrl}${OAUTH_PATHS.authorizePage}?client_id=…&redirect_uri=…&response_type=code&scope=…&state=…&code_challenge=…&code_challenge_method=S256`.
   - `exchangeCode`, `refresh`, `clientCredentials`, `revoke`: form-encoded POSTs to
     `OAUTH_PATHS.token`/`revoke`, `client_secret_post` when a secret is given; parse
     `TokenResponse` or throw an `OAuthError` with the RFC `error` code.
   - `deviceFlow({ baseUrl, clientId, scopes, clientSecret?, onCode, signal? })`: POST
     `OAUTH_PATHS.device`, hand `user_code`/`verification_uri_complete` to `onCode`, poll at
     `interval`, add 5 s on `slow_down`, stop on `access_denied`/`expired_token`/abort.
   - `TokenStore` + `refreshingToken({ … })`: returns a `getToken()` that refreshes ahead of
     expiry, at most one refresh in flight, persists the rotated pair through a caller-supplied
     `save()`, and on `invalid_grant` surfaces "re-authorize" (a replayed refresh token kills the
     family server-side; never retry with the old token). A refresh does not end a bound EventSub
     session (the server ignores `token_rotated` for sessions bound to the grant and accepts the
     new token on later `subscribe` calls), so the EventSub client never reconnects because of a
     refresh; a 4008 close means the grant is gone and surfaces as "re-authorize", not a reconnect.
3. **EventSub WebSocket client** (`src/eventsub.ts`): `connectEventSub({ baseUrl | url, keepaliveSeconds?, WebSocket? })`
   → `{ sessionId, on(type, handler), onNotification(handler), onRevocation(handler), closed, close() }`.
   Uses the global `WebSocket` (Bun, Node ≥ 22, browsers) or an injected constructor. Watchdog:
   no message for `keepalive_timeout_seconds` + 2 s → reconnect from scratch (new session; the
   caller resubscribes through a `onNewSession(sessionId)` callback). On `session_reconnect`: open
   `reconnect_url`, wait for its `session_welcome` (same session id), then close the old socket;
   deliver no message twice (dedupe by `message_id` over a bounded window). Expose close codes by
   name (`EVENTSUB_WS_CLOSE`). Validate every message with `WsMessage`.
   `subscribe(client, { type, condition, sessionId })` helper over `developer.events.subscribe`.
4. **Webhook verification** (`src/webhooks.ts`): `verifyEventSubRequest({ secret, headers, rawBody, now? })`
   → `{ ok: true; messageType; messageId; subscription; event?; challenge? } | { ok: false; reason }`:
   header names from `WEBHOOK_HEADERS`, HMAC via `verifyWebhook` (10-minute window, constant time),
   and a `createDedupe(maxEntries)` helper for message ids. Works on Web `Request` and on raw
   strings (no Node-only APIs).
5. **Chat client** (`src/chat.ts`): the minimal bot surface `harness/src/bots/sdk-bot.ts` needs:
   `connectChat({ url | client, token })` → `join`, `say`, `onMessage`, `close`, speaking the
   protocol in `@commonair/contracts/chat` (port the parts of `harness/src/chat-client.ts` a bot
   needs; the harness keeps its own client).
6. **Package build** (`packages/sdk/scripts/build.ts`, `bun run build`): bundle `src/index.ts` with
   `vp pack` (tsdown, part of `vite-plus`, already a dependency) into `dist/` as ESM with bundled
   `.d.ts`, inlining `@commonair/contracts` (code and types) and keeping `@orpc/*` and `zod`
   external; then write `dist/package.json` from `package.json`: `name`, the release `version`,
   **[LICENSE]** `license` (`Apache-2.0`), `type`, `exports` → `./index.js`/`./index.d.ts`, `dependencies` with
   the exact versions the root `catalog` resolves (no `catalog:`/`workspace:` protocols), `files`,
   `repository` (from `@commonair/config/site` `SITE`, never a literal), `publishConfig: { access:
   "public", provenance: true }`, no `private`. Copy `README.md` and **[LICENSE]** `LICENSES/Apache-2.0.txt` (as
   `LICENSE`) into `dist/`. If `vp pack` cannot inline workspace types, say so and propose the smallest
   vetted alternative as a contract request instead of hand-writing declaration files.
7. **Workspace use**: `package.json` `exports` keeps pointing at `./src/index.ts` so the harness
   and tests use the source; only `dist/` is published.
8. **Licence wiring [LICENSE]**: every file you add under `packages/sdk/**` (`src/`, `scripts/`,
   `tests/`, `examples/`, `README.md`) carries `SPDX-FileCopyrightText: 2026 CommonAir
   contributors` and an `SPDX-License-Identifier` of `Apache-2.0` (the README as an HTML comment, so the
   npm tarball is one licence); `dist/package.json` has `"license": "Apache-2.0"`; copy
   `LICENSES/Apache-2.0.txt` into `dist/LICENSE`. The bundle inlines parts of
   `@commonair/contracts`, which are AGPL-3.0-or-later: send a contract request to dual-license
   exactly the contract files the bundle pulls in (`packages/contracts/src/{oauth,eventsub,events,chat,scopes,enums,…}.ts`,
   the exact list from the build's metafile) as SPDX `AGPL-3.0-or-later OR Apache-2.0` (ADR 0035:
   the maintainer confirms it before the first publish; the orchestrator applies it). Add
   `packages/sdk/tests/license.test.ts` asserting: `package.json` says `Apache-2.0`; every file
   under `packages/sdk/` other than JSON has an `Apache-2.0` SPDX header; every runtime
   dependency's licence (read from `node_modules/<dep>/package.json`) is in the
   `scripts/licenses.ts` allowlist and compatible with Apache-2.0 (no copyleft); every inlined
   contract file's header allows Apache-2.0 (until the dual-licence request is applied, mark that
   assertion `test.todo` and say so in your final message). `check-licenses` now checks the SDK's
   own declared licence (contract step); this test checks what it cannot.
9. **Publish workflow** (`.github/workflows/sdk-publish.yml`; nobody runs it until the maintainer
   creates the `@commonair` npm organisation and the trusted-publisher link):
   - Triggers: `push` of tags `sdk-v*`, and `workflow_dispatch` with `dry_run` (default `true`).
   - `permissions: {}` at the top; the job gets `contents: read`, `id-token: write` only.
   - Steps: `actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0` with
     `persist-credentials: false`; `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0`;
     `uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0` with
     `node-version: 24` (npm ≥ 11.5 for trusted publishing) and no cache (v7.1.0 is the newest
     release older than 7 days on 2026-10-29; the tag is lightweight and points at that commit); `bun install --frozen-lockfile`; `bun run
     --filter @commonair/sdk test`; check the tag's version equals `packages/sdk/package.json`'s;
     `bun run --filter @commonair/sdk build`; `npm publish packages/sdk/dist --provenance --access
     public` (`--dry-run` when `dry_run`). No `NPM_TOKEN`, no caches, no `pull_request_target`.
   - It must pass the repository's workflow lint (actionlint and zizmor as CI runs them in the
     `lint-workflows` job of `.github/workflows/ci.yml`); install them the way CI does
     (`bun scripts/release/tools.ts install --dir <scratch dir> actionlint zizmor`, ci.yml:48) and
     run both on your file; if that fails offline, say so.
10. **Examples** (type-checked by the package's `tsconfig`), with exactly these names:
    `packages/sdk/examples/device-flow-chat-bot.ts`, `webhook-receiver.ts` (Bun.serve +
    `verifyEventSubRequest`), `eventsub-websocket.ts`, `app-token-webhook.ts` (client credentials
    subscribing a webhook). `docs/developers/sdk.md` walks through them (install, the four helpers,
    token storage and rotation, reconnects) and links them by relative path.
11. **README** (`packages/sdk/README.md`, Apache-2.0 SPDX header as an HTML comment: it ships in
    the tarball; `docs/developers/sdk.md` stays CC-BY-SA-4.0 like every doc): install, quick start, the four helpers, the porting notes
    (Twitch scope map via `TWITCH_SCOPE_MAP`, IRC gateway for tmi.js bots).
12. **Harness**: rewrite `createContractSdk` in `harness/src/bots/sdk-bot.ts` on top of
    `@commonair/sdk` (`createClient` + `connectChat`), same exported names and behaviour, so
    `e2e-social` runs on the SDK with `platform.ts` untouched. Step 6 (`harness/src/e9/sdk.ts`, flip
    `ready: true`): scenario step 6: PKCE via `createPkcePair`/`authorizeUrl` (the streamer's
    session approves through `developer.oauth.decide`, as step 2 does), `exchangeCode`,
    `refreshingToken` across one forced refresh, `deviceFlow` with the public app, the EventSub
    client receiving a follow `notification`, `verifyEventSubRequest` accepting a real delivery
    captured by the shared receiver and rejecting it with one byte changed.

## Tests you must add

- `packages/sdk/tests/*.test.ts` (unit, no network): PKCE pair (RFC 7636 vector through
  `pkceChallenge`), authorize URL encoding, token/device/refresh/revoke against a fake `fetch`
  (pending → slow_down → success; `access_denied`; `expired_token`; abort), single-flight refresh,
  `invalid_grant` surfaces re-authorize; EventSub client against an in-process Bun WebSocket
  server: welcome, keepalive watchdog reconnect, `session_reconnect` hand-over with no duplicate,
  revocation and 4008, inbound validation; webhook verification (valid, tampered body, stale
  timestamp, wrong secret, challenge message); chat client against a fake chat server frame
  sequence.
- `packages/sdk/tests/build.test.ts`: runs the build into a temp dir; `dist/index.js` imports no
  `@commonair/*`; `dist/index.d.ts` references no `@commonair/*`; `dist/package.json` has no
  `catalog:`/`workspace:`/`private`, its `license` is `Apache-2.0`, and `dist/LICENSE` exists.
- `packages/sdk/tests/license.test.ts` (see Build 8).
- `harness/tests/bots.test.ts`: the SDK-backed `createContractSdk` still satisfies `BotSdk`.

## Done means

Follow `.claude/briefs/_done-means.md` (targeted checks only): `bun --bun vp test run` in
`packages/sdk` and `harness`; `bunx tsc -p packages/sdk --noEmit` and `harness`; `bun run
--filter @commonair/sdk build`; `vp lint --deny-warnings` and `vp fmt` on your paths. Never run
`bun run verify`, a harness scenario, `podman compose`, `scripts/infra.ts`, `npm publish` or the
workflow. `git status` shows only your paths. Commit in your worktree (`git commit -s`,
Conventional Commits, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).
Final message: what you built, test counts, branch and sha, contract requests (exact diffs: the
contract-file SPDX changes to `AGPL-3.0-or-later OR Apache-2.0`), the bundle's inlined file list, `vet-package` output for anything new, the maintainer's
one-time setup steps (create the `@commonair` npm organisation, add `sdk-publish.yml` as the
trusted publisher for `@commonair/sdk`, first publish by tag `sdk-v0.1.0`), and the live commands
after the wave: `bun harness/src/cli.ts run e2e-social` and
`bun harness/src/cli.ts run developer-platform --set steps=1-2,4-6 --set via=api`.
