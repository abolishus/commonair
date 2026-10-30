<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# N1-pwa: installable PWA, the service worker (shell and push) and the browser push client

You are implementing unit N1-pwa for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
PLAN.md and docs/architecture.md first, then `.claude/briefs/next/N1-notifications-pwa.md`,
`docs/decisions/0028-notifications.md` (decisions 1, 6, 7), `.claude/briefs/n1/contract-step.md`
(§0 rows on the manifest, `sw.ts` and the harness push approach, §1.3 `PushPayload`, §1.5
`notifications.push`, §7.2, §7.3, §7.4, §7.5, §8 PWA and push-toggle ids and steps 6-7, §10.2,
§12), `docs/testing/n1-selectors.md`, `packages/db/src/legal/cookies.md` (what may be stored),
`apps/web/src/i18n/README.md` ("How to add a namespace") and `.claude/briefs/_done-means.md`. Do
not look outside the repository. Work in your own git worktree on a branch named `n1/pwa`,
created from `main` after batch-4 wave 1 (the six W1 units) merged; the orchestrator gives you the sha, which contains the W1 and N1 contract steps; run `git merge main` first if main moved. Batch 4, wave 2, beside N1-fanout, N1-email,
N1-push, N1-inbox and W1-data-mode. N1-push implements the push procedures and fills
`harness/src/n1/ece.ts` in the same wave: code against the contract (§1.5) and the stub's
signatures with fakes; steps 6 and 7 run on the stack once you and N1-push have merged.

## Why

Web push needs a service worker, and a service worker plus a manifest makes the web app
installable. ADR 0028 decision 7 limits the worker to the app shell and icons: never media, API
responses or anything that depends on who is signed in, no offline playback, an update prompt
instead of reloading under the viewer. You also own the browser half of push (permission,
subscription, the toggle) so one unit owns everything that touches `navigator.serviceWorker`.

## You own (write only these)

- `apps/web/public/**` (new): `icons/icon.svg`, `icons/icon-192.png`, `icons/icon-512.png`,
  `icons/maskable-512.png`, `icons/apple-touch-icon.png` (180), each PNG with a `.license`
  sidecar (the usual copyright line and license tag, licensed CC-BY-SA-4.0, as the repo's other
  `.license` sidecars are written) so `reuse lint` passes without touching `REUSE.toml`
- `apps/web/src/sw/**` (the `sw.ts` stub and new logic modules; its own `tsconfig.json` from the
  contract step: you may add files, not change its options without a contract request)
- `apps/web/src/pwa/**` (`theme.ts` values only, plus new registration and update logic; the
  two colours are allowlisted in `apps/web/tests/source-policy.test.ts` by value, so a changed
  value needs the matching allowlist edit as a contract request, and no other file may hold a
  colour literal),
  `apps/web/src/components/pwa/**` (stubs `pwa-root.tsx`, `push-client.ts`, `push-toggle.tsx`
  and anything new)
- `apps/web/src/server/pwa.ts` (stub `manifestResponse`), `apps/web/scripts/vite-pwa.ts` (stub
  plugin), `harness/src/tools/render-pwa-icons.ts` (new; it lives in the harness because only the
  harness depends on Playwright: under Bun's isolated linker `apps/web` cannot resolve
  `playwright`, and adding it there would be a new dependency)
- i18n: `apps/web/src/i18n/locales/en/n1-pwa.json` (keys `pwa.*`, `push.*`) and `keys/n1-pwa.gen.ts`
- Tests: `apps/web/tests/pwa*.test.ts(x)`, `apps/web/tests/sw*.test.ts`, `apps/web/tests/push-client*.test.ts`
- Harness: `harness/src/n1/pwa.ts` (step 6), `harness/src/n1/push-web.ts` (step 7) and their tests

Read-only, in particular: `packages/contracts/**`, `apps/web/src/routes/__root.tsx` (head links
and `<PwaRoot />` from the contract step), `apps/web/src/components/site-chrome.tsx` (calls
`forgetPushSubscription` on sign-out), `apps/web/src/server/{http,env}.ts`, `apps/web/server.ts`,
`apps/web/vite.config.ts`, `apps/web/tsconfig.json`, `apps/web/package.json`, `apps/web/src/i18n/**`
except your namespace, `harness/src/n1/{run,push-receiver,selectors,ece}.ts` (`ece.ts` is
N1-push's, filled in the same wave from the contract step's stub). Anything else is a **contract request** with the exact diff. No new
dependency: no Workbox, no PWA plugin, nothing from a CDN (AGENTS.md rules 4 and 7).

## Contracts you must honor (read-only for you)

- Manifest at `/manifest.webmanifest` from `manifestResponse(publicConfig(env))` (production:
  `server/http.ts`; dev: your Vite plugin): `name` and `short_name` from the instance
  (`PublicConfig.instanceName`; never a literal name, AGENTS.md rule 5), `start_url: "/"`,
  `scope: "/"`, `display: "standalone"`, `background_color`/`theme_color` from `PWA_THEME_COLORS`,
  `icons` (192, 512, maskable 512 with `purpose: "maskable"`, the SVG `sizes: "any"`), `id: "/"`,
  content type `application/manifest+json`.
- Service worker at `/sw.js`, scope `/`, built from `apps/web/src/sw/sw.ts` by your Vite plugin
  in the client build (a classic script: `iife`, no module worker), served by the static branch
  of `server/http.ts` (`cache-control: public, max-age=0, must-revalidate`, so updates are seen).
- `PushPayload` `{ v: 1, type: "go_live", slug, title }` (validate by hand in the worker; do not
  bundle zod there). `notifications.push.status` / `subscribe({ endpoint, keys })` /
  `unsubscribe({ endpoint })`; `notifications.preferences.set` (to turn the go-live push default on).
- Selectors: `pwa-update-prompt`, `pwa-update-reload`, `push-toggle` (`data-state`
  `unsupported|unavailable|denied|off|on|busy`), `push-unsupported`, `push-denied-help`.
- Storage rules (`cookies.md` after the contract step's §10.2 draft): Cache Storage holds only the
  app's own static files; the worker uses no IndexedDB, no cookies, no `localStorage`; nothing
  personal is cached.

## What is there today (verified at `a43aa6b`; recheck against your base)

- No `apps/web/public/`, no service worker, no manifest, no favicon. The header's brand mark is
  Hugeicons `LiveStreaming02Icon` (`apps/web/src/components/site-chrome.tsx`); brand artwork in
  `docs/assets/brand/*.svg`. Use a generic mark (the instance's own name is the identity; nothing
  in the icon may name the flagship).
- The client build is TanStack Start on vite-plus (`apps/web/vite.config.ts`); hashed assets
  under `/assets/` are served `immutable` (`apps/web/src/server/http.ts:62-74`); documents are
  SSR with the visitor's session and `private, no-store` (`:76-77`).
- i18n: the app's `t()` loads every catalog through `import.meta.glob`; the service worker must
  not (Build 3).
- Playwright is a harness dependency (`harness/package.json`), so the icon renderer lives in `harness/src/tools/`.

## Build

1. **Icons**: one SVG (a simple broadcast mark on the zinc background, legible at 16 px and as a
   maskable icon with its safe zone); `harness/src/tools/render-pwa-icons.ts` renders the PNGs
   from it into `apps/web/public/icons/` with the harness's Playwright Chromium (run once with
   `bun harness/src/tools/render-pwa-icons.ts`, commit the PNGs; the script documents how to
   rerun). No scenario imports it.
2. **Vite plugin** (`scripts/vite-pwa.ts`): in the client environment's build, after the bundle is
   generated, collect the emitted `/assets/*.js|css` files that the shell needs (entry and its
   static imports; not every lazy chunk) plus the icons, build `src/sw/sw.ts` as an IIFE (a nested
   `build()` of vite-plus with `write: false`, or rolldown through vite-plus; no new package) with
   `__PRECACHE__` (the list) and `__VERSION__` (a hash of the list) defined, and emit it as
   `sw.js`. In dev (`serve`), serve the manifest from `manifestResponse` and no service worker
   (registration is production-only).
3. **Service worker** (`src/sw/**`, logic in pure modules with the event wiring in `sw.ts`):
   - `install`: open `commonair-shell-<version>`, `addAll(precache)`; no `skipWaiting` unless the
     page asks (`message` `{ type: "skip-waiting" }`).
   - `activate`: delete every `commonair-shell-*` cache but the current; `clients.claim()`.
   - `fetch`: only `GET`, same origin, and the path is in the precache list → cache first, then
     network. Everything else is not intercepted (`/api`, `/rpc`, `/hls`, `/media`, `/vod`,
     `/chat`, `/overlay`, `/embed`, documents, uploads): the browser handles it as if there were
     no worker. Pure `shouldServeFromCache(url, precache)`, exhaustively tested.
   - `push`: parse `event.data.json()`; anything not a valid `PushPayload` → show nothing. Show
     a notification: title `pwa.push.live` ("{channel} is live", with the slug) and body the
     stream title (empty when the payload's title is empty), `tag: "go-live-<slug>"` (a repeat
     replaces it), `icon` and `badge` from the icons, `data: { url: "/<slug>" }`. Text from the
     bundled `n1-pwa` English catalog formatted with `formatMessage` from `@commonair/i18n` (not the app's `t()`; `negotiateLocale` for the pick):
     pick the catalog for `self.navigator.languages` among bundled ones (only `en` today; N2 adds
     more), fall back to English. Keys stay literal in the source so `i18n.test.ts` sees them used.
   - `notificationclick`: close it; focus an open window on `data.url` or open one (same origin
     paths only; anything else opens `/`).
4. **Registration and update** (`components/pwa/pwa-root.tsx`, `pwa/**`): production only, after
   hydration and idle, `navigator.serviceWorker.register("/sw.js", { scope: "/" })`; when a new
   worker is `waiting`, show `pwa-update-prompt` (a non-blocking toast or banner with
   `pwa-update-reload`); reload only after the user clicks, by posting `skip-waiting` and
   reloading on `controllerchange`. Never on overlay (`/overlay/*`) or embed (`/embed/*`) pages
   (they run inside OBS and other sites).
5. **Push client** (`components/pwa/push-client.ts`) and **toggle** (`push-toggle.tsx`): state
   machine `unsupported` (no `PushManager`/`serviceWorker`/`Notification`), `unavailable`
   (`push.status().enabled` false: render nothing), `denied` (`Notification.permission`), `off`,
   `on` (this browser has a subscription the server knows), `busy`. Turning on (from a click only,
   never on load): `Notification.requestPermission()`; `registration.pushManager.subscribe({
   userVisibleOnly: true, applicationServerKey: <vapidPublicKey decoded> })`; send
   `subscription.toJSON()`'s `endpoint` and `keys` to `push.subscribe` (use `toJSON()`: the
   harness stubs it); if the go-live push default is off, `preferences.set({ type: "go_live",
   medium: "push", channel: null, enabled: true })`. Turning off: `push.unsubscribe({ endpoint })`
   then `subscription.unsubscribe()`. `forgetPushSubscription()` (called on sign-out): the same as
   off, ignoring errors, bounded to 3 s so sign-out never hangs. Help text explains that the
   browser's maker relays the message (`push.vendorNote`) and how to undo a denial
   (`push-denied-help`).
6. **Strings** in `n1-pwa.json` only.

## Tests you must add

- `shouldServeFromCache` (precached asset, an `/api` URL, a document, another origin, `POST`,
  a query string on an asset), cache naming and cleanup, payload validation (missing fields,
  wrong `v`, long title, extra fields ignored), notification options (title from the catalog,
  empty title, tag, URL), click target (same-origin path only), language pick.
- Manifest builder (instance name, icons, colours, content type) and the Vite plugin's precache
  selection (fixture bundle: entry and static imports in, lazy chunks out).
- Push client state machine with a fake `PushManager` (unsupported, unavailable, denied, on/off,
  the preference call only when off, sign-out bounded and silent).
- Harness steps 6 and 7 per §8 of the contract step: step 6 with CDP
  (`Page.getAppManifest`, `Page.getInstallabilityErrors`, `ServiceWorker.deliverPushMessage`,
  `caches.keys()`/`cache.keys()` in the page); step 7 with `context.grantPermissions(["notifications"])`
  and an `addInitScript` that replaces `PushManager.prototype.subscribe`/`getSubscription` with a
  harness subscription (keys from `harness/src/n1/ece.ts`), then has the **fourth** streamer
  (`run.actors.streamers[3]`, `state.webPushChannel`) go live (step 4's channel is in its
  cooldown) and decrypts what the receiver gets.

## Done means

`.claude/briefs/_done-means.md`, plus: `apps/web` tests including `i18n.test.ts` and
`logical-css.test.ts`, `bun run i18n:check`, `bunx tsc -p apps/web --noEmit` and `bunx tsc -p
apps/web/src/sw --noEmit`, `vp build` (check `dist/client/sw.js` exists, is an IIFE, and lists only
`/assets/` files and icons), `reuse lint` (the PNG sidecars), harness tests; lint and format on
your paths; no new dependency. Final message: what you built, test counts, branch and sha,
contract requests, and the live commands: `bun harness/src/cli.ts run notifications --set
steps=6,7`; the user's checks: install the app from Chromium's address bar on the harness stack,
check DevTools → Application (manifest without warnings, only `commonair-shell-*` caches, no
`/api` entries), deploy twice and see the update prompt, and on an HTTPS instance with
`--web-push` turn the toggle on and receive a real go-live push on desktop and Android.
