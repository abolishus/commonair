<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# @commonair/web

The web app: TanStack Start (React 19) on Bun, built with the repo's `vp` (vite-plus), styled
with `@commonair/ui`. Milestone E1 scope: sign up, verify email, sign in, a streamer dashboard
(ingest URL + stream key), a channel page (player + chat) and a chrome-free embed.

Routes and `data-testid`s follow [docs/testing/e1-selectors.md](../../docs/testing/e1-selectors.md)
(the harness `e2e-basic` scenario selects by them).

## Run it

```sh
# Infra + API + chat (+ origin/media for playback), e.g. the compose stack:
bun scripts/infra.ts test
bun services/api/src/main.ts &        # or: podman compose up -d api chat origin media mediamtx
bun services/chat/src/main.ts &

cd apps/web
bun run dev                            # Vite dev server on WEB_PORT (3000), reads the repo-root .env
bun run build && bun run start         # production build, served by server.ts on WEB_PORT
```

Sign up at `/signup`, open the verification link from Mailpit (<http://localhost:8025>), and you
land signed in on `/dashboard`. Publish to `<server URL>/<stream key>` and open `/<username>`.

| Script      | What                                                                     |
| ----------- | ------------------------------------------------------------------------ |
| `dev`       | Vite dev server (TanStack Start), `/api` + `/rpc` proxied to the API     |
| `build`     | `vp build` → `dist/client` (static assets) + `dist/server/server.js`     |
| `start`     | `bun server.ts`: `/healthz`, API proxy, static assets, SSR (production)  |
| `test`      | Unit tests (proxy headers, heartbeat deltas, chat protocol, i18n keys …) |
| `test:int`  | Builds, starts `bun run start` on a random port, checks it end to end    |
| `typecheck` | `tsc -p .`                                                               |

## How it fits together

- **Same-origin API.** The browser only talks to the web origin. `server.ts` (production) and
  Vite's dev proxy forward `/api/*` and `/rpc/*` to `API_INTERNAL_URL`, streaming bodies, keeping
  every `set-cookie`, passing redirects through (`redirect: manual`), dropping hop-by-hop headers
  and appending the socket address to `x-forwarded-for` (`src/server/proxy.ts`). better-auth
  cookies are therefore first-party, and the verification link (`PUBLIC_URL/api/auth/verify-email…`)
  works as-is.
- **Instance config from the env, at request time.** The root route's loader is a server
  function (`src/lib/bootstrap.ts`) that returns the public URLs (`PublicConfig`: chat, ingest,
  playback), `instance.info` (name + AGPL source link) and the visitor's session (`me.get` with
  the request's cookie). Nothing instance-specific is baked into the client bundle.
- **Player** (`src/player/`, framework-free except `player.tsx`): `playback.start`, hls.js over
  MSE, native HLS on WebKit/Safari or where MSE is missing, heartbeats with per-heartbeat deltas
  (`HeartbeatAccountant`; a failed heartbeat rolls into the next one), token refresh for every
  hls.js request, `switchTo`, `playback.end` on stop/pagehide (keepalive fetch). Retries a failed
  start every 5 s while the channel is live. Kept separate so it can move to `packages/player`.
- **Chat** (`src/chat/`): a fresh `chat.connectToken` per (re)connect (anonymous viewers get a
  read-only token), `join` after `welcome`, pings at half the server heartbeat, frames validated
  with the contract's `ServerFrame`, exponential backoff with jitter on unexpected closes.
- **Channel state** comes from `channels.get` (SSR snapshot, then polled every 5 s).
- **i18n:** every visible string is `t("key")` from `src/i18n/en.ts`; `tests/i18n.test.ts` fails on
  a missing or dynamically built key.

## TanStack Start with vite-plus: notes

- Works unchanged with `vp build` / `vp dev` (vite-plus core is Vite with Rolldown). The Start
  Vite plugin is `@tanstack/react-start/plugin/vite`; it includes the router plugin and generates
  `src/routeTree.gen.ts` (committed so `tsc` works before the first build).
- **NODE_ENV pitfall:** `vite.config.ts` reads the repo-root `.env` for dev defaults. Vite's
  `loadEnv` records any `NODE_ENV` it finds (the root `.env` sets `development`) as
  `VITE_USER_NODE_ENV`, which silently turns `vp build` into a development build (React's dev JSX
  runtime in the bundle). `rootEnv()` removes that side effect.
- Start's build output has no server of its own: `dist/server/server.js` exports `{ fetch }`, and
  `server.ts` wraps it in `Bun.serve` with the health check, proxy and static files. The
  container (`infra/containers/service.Containerfile`, `SERVICE=web`) runs `bun run start`.
- The ALTCHA widget's React JSX typings conflict between its entry points, so the element is
  created with `React.createElement("altcha-widget", …)`.

## Third-party code in the bundle

All bundled and self-hosted; nothing loads from another origin. `hls.js` (Apache-2.0), `altcha`
(MIT; footer and logo hidden, so no link to its site), TanStack Router/Start (MIT), React (MIT),
oRPC (MIT), Zod (MIT), plus `@commonair/ui`'s dependencies.
