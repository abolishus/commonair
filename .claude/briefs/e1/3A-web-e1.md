<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing **3A-e1: the minimal real web app** for CommonAir (repo: /Users/joshe/Repos/bcon).
Read AGENTS.md, HANDOFF.md (Milestone E1), PLAN.md, docs/architecture.md and
docs/testing/e1-selectors.md first. Do not look outside the repository.

## You own (write only these)

- `apps/web/**` (new workspace `@commonair/web`)
- `bun.lock` only as a side effect of `bun install` for your new dependencies (the orchestrator reconciles)

## Contracts you must honor (read-only for you)

- `docs/testing/e1-selectors.md` — routes and `data-testid`s, verbatim. The harness scenario is
  written against it in parallel; do not deviate. If something in it is impossible, say so in
  your final message (contract request) and implement the closest thing.
- `packages/contracts` (oRPC contract `src/api/router.ts`, entities, `src/chat.ts` chat frames),
  `packages/config` (`instanceSite()`, env schema: `WEB_PORT`, `PUBLIC_URL`, `API_INTERNAL_URL`,
  `API_PUBLIC_URL`, `CHAT_PUBLIC_URL`, `PLAYBACK_PUBLIC_URL`, `INGEST_RTMP_PUBLIC_URL`),
  `packages/ui` (shadcn base-lyra components, house primitives, `globals.css`, toast, `lib/locale`,
  `lib/messages`).
- The API surface as implemented in `services/api` (read it): better-auth under `/api/auth`
  (ALTCHA challenge `GET /api/auth/altcha-challenge`, sign-up with birth date + legal document ids,
  email verification link), oRPC at `/rpc`. Reference client implementations that already work
  against it: `harness/src/platform.ts`, `harness/src/users.ts`, `harness/src/altcha.ts`,
  `harness/player/player.ts` (playback.start + heartbeat contract + token refresh/switchTo),
  `harness/src/chat-client.ts` (chat frames over WebSocket with a `chat.connectToken` token).
- `infra/containers/service.Containerfile` builds the image with `cd apps/web && vp build`, then
  runs `bun run start` (see `infra/containers/entrypoint.sh`) with `WEB_PORT` and a healthcheck
  on `/healthz` (`infra/containers/healthcheck.ts`). Make that work unchanged.

## Build

- TanStack Start (React 19) on Bun, Vite via the repo's `vp` (vite-plus). Tailwind v4 with
  `@commonair/ui/globals.css`. Pick current stable versions at least two weeks old, pin exactly,
  verify each new dependency's license from its repository at that version (OSI only), and make
  `bun scripts/check-licenses.ts` pass. If TanStack Start fights vite-plus, document the
  workaround in `apps/web/README.md`; do not swap frameworks without saying why.
- `package.json` scripts: `dev`, `build` (`vp build`), `start` (serve the production build on
  `WEB_PORT`, default 3000), `test`, `test:int` (`--passWithNoTests` ok), `typecheck`.
- Server: `GET /healthz` → 200 `{ "status": "ok" }`. Reverse-proxy `/api/*` and `/rpc/*` to
  `API_INTERNAL_URL` (stream bodies, keep `set-cookie`, pass `x-forwarded-for` with the client
  socket address appended, drop hop-by-hop headers). Browser-visible public URLs (chat WS,
  ingest) are read from the env on the server and handed to the client (loader/serialized
  config), never hardcoded; no domain literals (`check-domains`).
- Pages (routes per the contract): home; `/signup` (email, username, password, birth date,
  legal acceptance with links to the current legal docs if the API exposes them, ALTCHA widget —
  bundle the FOSS `altcha` widget package, no remote assets; submit disabled until solved);
  confirmation; `/signin`; header with `nav-user` + sign out; `/dashboard` (auth-guarded:
  `stream.ingest` server URL + key prefix, rotate → `ConfirmDialog` → full key shown once with
  copy, link to own channel); `/$channel` (player + chat side by side, stacked on mobile; live/
  offline state from `channels.get`, refreshed by polling ~5 s or by events if available);
  `/embed/$channel` (player only).
- Player: `hls.js` (already used by the harness, Apache-2.0) over MSE; on browsers without MSE
  (WebKit/Safari) use native HLS in the `<video>`. Call `playback.start`, play the returned
  playlist, heartbeat per the contract (copy the logic of `harness/player/player.ts`: deltas,
  buffer, stalls, latency, visibility), honour token refresh and `switchTo`, `playback.end` on
  unmount/pagehide. Autoplay muted with an unmute control. `data-state` transitions per contract.
  Keep it in `apps/web/src/player/` so it can move to `packages/player` later.
- Chat: connect to `CHAT_PUBLIC_URL` with a token from `chat.connectToken` (anonymous viewers get
  a read-only token if the API allows; otherwise show history-less read-only state and
  `chat-signin-prompt`). Render messages with `data-author`, send via `chat-send` / Enter, show
  server notices/errors via toast. Reconnect with backoff.
- Footer: `footer-source-link` from `instance.info` (AGPL source link), plus instance name.
- i18n: every user-facing string through `t("key")` from a catalog in `apps/web/src/i18n/`
  (English only for now; check whether `@commonair/ui/lib/messages`/`lib/locale` already
  provide the mechanism and reuse it).
- Design rules from AGENTS.md: house primitives (`ChannelAvatar`, `LiveBadge`, `ViewerCount`,
  `RelativeTime`, `EmptyState`, `Skeleton*`, `IconButton tooltip`, `ConfirmDialog`, toast), CSS
  variable tokens only, dark first + light theme, keyboard accessible, visible focus, responsive to
  320 px with no horizontal scroll. No polish beyond that — this is a thin real slice.
- No third-party client-side code, no CDN, fonts self-hosted via `@commonair/ui`.

## Tests you must add

- Unit tests (`*.test.ts[x]`): proxy header handling (hop-by-hop dropped, x-forwarded-for,
  set-cookie passthrough), heartbeat delta accounting, chat frame handling/reconnect backoff,
  i18n catalog has every key used (a test that greps `t("…")` keys against the catalog).
- A build smoke test or script check: `vp build` succeeds and `bun run start` answers `/healthz`
  (integration test `*.int.test.ts` is fine; it may start the server on a random port).
- Manually run it against the real API: `bun scripts/infra.ts test` has Postgres/Valkey/Garage/
  Mailpit up; start the API (`bun services/api/src/main.ts` with `.env`), chat
  (`services/chat`), then your dev server, and sign up through the UI end to end, reading the
  verification email from Mailpit (http://localhost:8025). Report what you saw.

## Done means

- `bun run verify --quick` passes plus `bun run --filter @commonair/web test:int`, with your tests.
- `podman build -f infra/containers/service.Containerfile --build-arg SERVICE=web .` succeeds.
- No files outside your ownership list changed (`git status`).
- Commit in your worktree (Conventional Commits, `git commit -s`, trailer
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).
- Final message: what you built, test counts, how to run it, every deviation from
  docs/testing/e1-selectors.md, contract requests (exact changes needed in files you do not own,
  e.g. API CORS/anonymous chat tokens), and anything left undone.
