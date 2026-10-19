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
  and appending the socket address to `x-forwarded-for` (`src/server/proxy.ts`). Client-sent
  `forwarded`, `x-real-ip` and `x-forwarded-host/port/proto/prefix` are dropped; host and proto
  come from `PUBLIC_URL`. Request bodies are capped at 1 MB. better-auth cookies are therefore
  first-party, and the verification link (`PUBLIC_URL/api/auth/verify-email…`) works as-is.
- **Page headers** (`src/server/security.ts`, production and dev): `frame-ancestors 'self'`
  everywhere except `/embed/*` (`frame-ancestors *`), `nosniff`,
  `strict-origin-when-cross-origin`. Rendered pages and server-function results are
  `private, no-store` (they carry the session).
- **Guards:** `/dashboard` checks the session in `beforeLoad` (server-side during SSR, redirect to
  `/signin`); the component keeps a client-side fallback.
- **Instance config from the env, at request time.** The root route's loader is a server
  function (`src/lib/bootstrap.ts`) that returns the public URLs (`PublicConfig`: chat, ingest,
  playback), `instance.info` (name + AGPL source link) and the visitor's session (`me.get` with
  the request's cookie). Nothing instance-specific is baked into the client bundle.
- **Player** (`src/player/`, framework-free except `player.tsx`): `playback.start`, hls.js over
  MSE, native HLS on WebKit/Safari or where MSE is missing, heartbeats with per-heartbeat deltas
  (`HeartbeatAccountant`; a failed heartbeat rolls into the next one, played time above the 120 s
  cap carries over), token refresh for every hls.js request, `switchTo`, `playback.end` on stop
  or a real unload (keepalive fetch). A page kept in the back/forward cache keeps its session and
  starts a fresh one when restored. Retries a failed
  start every 5 s while the channel is live. Kept separate so it can move to `packages/player`.
- **Chat** (`src/chat/`): a fresh `chat.connectToken` per (re)connect (anonymous viewers get a
  read-only token), `join` after `welcome`, pings at half the server heartbeat, frames validated
  with the contract's `ServerFrame`, exponential backoff with jitter on unexpected closes. Notices
  and errors are shown from the catalog by code (`src/chat/messages.ts`), never the server's text.
- **Channel state** comes from `channels.get` (SSR snapshot, then polled every 5 s).
- **i18n:** every visible string is `t("key")` from `src/i18n/en.ts`; `tests/i18n.test.ts` fails on
  a missing or dynamically built key.

## Design system (E4a)

Pages only compose `@commonair/ui`: shells from `@commonair/ui/layouts`, blocks from
`@commonair/ui/blocks/<group>`, shadcn components and house primitives. Layout utilities (`flex`,
`grid`, `gap-*`, `py-*`) are the only classes a page adds.

| Route                | Layout (route file)                  | Compositions                                                                                                                               |
| -------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `/`                  | `AppShell` (`routes/_app.tsx`)       | `PageContainer`, `PageHeader` (calls to action), `Section` + `StreamGrid` (`cardProps` → `stream-card`), `EmptyState`                      |
| `/$channel`          | `AppShell`                           | `SplitLayout`, `PlayerChrome` (`liveBadgeProps` → `live-badge`), `ChannelHeader`, `AccentButton`, `ChatPanel`/`ChatMessage`/`ChatComposer` |
| `/signin`, `/signup` | `AppShell`                           | `PageContainer width="form"`, `PageHeader`, `Field*`, `PasswordField`, `Checkbox`, ALTCHA, `Alert` (`form-error`)                          |
| `/dashboard`         | `StudioShell` (`routes/_studio.tsx`) | `PageHeader`, `Card`, `CodeBlock` (server URL, new key), `KeyValueList` + `StatusBadge` (health), `ConfirmDialog`                          |
| `/relays`            | `StudioShell`                        | `PageHeader`, `ListPanel`, `FormSection`, `CodeBlock`, `DataTable` (`rowProps` → `relay-row`), `StatusBadge`, `ConfirmDialog`              |
| `/embed/$channel`    | none (chromeless)                    | `PlayerChrome` only                                                                                                                        |

The header (`SiteHeader` + `UserMenu` + `ThemeToggle`) and footer (`SiteFooter` with the AGPL
source link) live in `src/components/site-chrome.tsx`; what they link to is data in
`src/lib/nav.ts` (only pages that exist). Links styled as buttons are `Button` with
`render={<Link …/>}`. `tests/source-policy.test.ts` scans `src/**` (`.ts`, `.tsx`, `.css`; not
`src/server/**` or the generated route tree) and fails, with file and line, on raw interactive
HTML, `role=` on div/span, arbitrary Tailwind syntax (values, properties, variants, `x-(--var)`),
color literals, `sonner`/`@base-ui/react` imports or shadcn modules that have a house replacement,
`buttonVariants` class strings, native `title=`, `style=`, `alert/confirm/prompt`, inline number
formatting, and raw media or custom elements. Exceptions are allowlist entries keyed by a snippet
with an exact count and a reason (today: the player's `<video>`, the ALTCHA web component and
`formatBytes`'s `Intl.NumberFormat`). Where a composition cannot yet express something, an
`E4a gap:` comment names what it needs.

Selector contracts: `tests/selectors.test.ts` finds every e1–e3 test id in the source as
`data-testid="…"`. The few that reach the DOM only through a composition prop (listed in
`tests/composition-ids.ts`) are server-rendered from the app's components with fixture data in
`tests/selectors-render.test.tsx`, which checks the DOM attributes and the text content of
`stream-server-url`, `stream-key`, `relay-token` and `relay-run-command`.

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
