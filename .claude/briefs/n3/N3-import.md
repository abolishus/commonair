<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# N3-import: import a channel from Twitch (adapter, connect, preview, job, page, mock)

You are implementing unit N3-import for CommonAir (repo: /Users/joshe/Repos/bcon). Read these first:

- AGENTS.md, PLAN.md and docs/architecture.md.
- `.claude/briefs/batch7/README.md`. Decisions (b), (h), (j), (o), (p), (ac), (ad), the path
  ownership and the shared rules are binding.
- `.claude/briefs/w3/contract-step.md`:
  - §2.3 `PortabilityBundle`
  - §2.4 `twitchImport.*`
  - §2.6 `TWITCH_JOBS`
  - §5.3 the OAuth callback stub and the internal upload route
  - §5.5 the Twitch env vars
  - §7 `harness/compose.n3.yaml`
- `.claude/briefs/next/N3-twitch-import.md`.
- `docs/decisions/0031-twitch-import.md`, accepted by the contract step with decision (b):
  decisions 1–7 are your spec, and panels come in by paste.
- ADR 0037 (portability, from the contract step).
- `services/worker/src/portability/import/**`: the `applyBundle` entry point W3-portability merged
  in wave 1. Read its header comment.
- `docs/testing/b7-selectors.md`.
- `.claude/briefs/_done-means.md`.

Do not look outside the repository. **Do not call the real Twitch API** from tests or the harness.
This is **wave 2**: work in your own git worktree, branch `n3/import`, cut from `main` after wave 1
merged.

## Why

A streamer moving from Twitch should not have to retype their channel. They connect Twitch once.
The authorization proves they control the account, and the token is discarded after one use.
They preview the public channel data, choose what to bring, and it lands through the same import
path and moderation gates as any portability bundle. Twitch stays an optional adapter: with no
credentials, or with `TWITCH_IMPORT_ENABLED` false (the default), the page explains that the
import is unavailable.

## You own (write only these)

- `packages/twitch/**` (new; AGPL, no runtime dependency beyond `zod` and `@commonair/contracts`;
  package skeleton and workspace entry from the contract step, or ask)
- `services/api/src/twitch-import/**` (including `callback.ts`), `services/api/src/routes/twitch-import.ts`
- `services/worker/src/twitch-import/**`, `services/worker/src/jobs/import-twitch.ts`
- `apps/web/src/routes/_studio/import.tsx` (content), `apps/web/src/components/twitch-import/**`
- `apps/web/src/i18n/locales/{en,es}/n3-import.json`, `keys/n3-import.gen.ts`
- `harness/src/mocks/twitch/**`, `harness/scenarios/twitch-import.ts`, `harness/src/n3/**`,
  `harness/compose.n3.yaml` (fill it in), `harness/tests/n3/**`

**Read-only:**

- `services/worker/src/portability/**` (`applyBundle`)
- `services/worker/src/webhooks/{ssrf,http}.ts`
- `services/api/src/auth/index.ts` (the Twitch provider `:85-92`)
- `services/api/src/routes/channels.ts` (`setPanels` `:112-137`)
- `harness/src/e9/receiver.ts`, as the pattern for an in-process server the containers can reach
- `packages/{contracts,db,config,tokens}/**`

Anything else is a **contract request**.

## Contracts you must honor

- **Procedures.** `twitchImport.{status, connect, preview, start}`. `status.available` requires
  `OAUTH_TWITCH_CLIENT_ID`, `OAUTH_TWITCH_CLIENT_SECRET` and `TWITCH_IMPORT_ENABLED`.
- **Twitch endpoints.** Reach them only through `TWITCH_API_BASE_URL`, `TWITCH_AUTH_BASE_URL` and
  `TWITCH_IMAGE_HOSTS`, never hard-coded.
- **Bundle.** Build a `PortabilityBundle` v1 with `source: "twitch"` and `standing: null`.
- **Import path.** Use `portability_imports` (status `previewed`, the emote-art assertion columns),
  then `TWITCH_JOBS.import` and `applyBundle`.
- **Uploads.** Write the image to `incoming/`, then call `INTERNAL_ROUTES.uploadCommit` (inside
  `applyBundle`).
- **Panels.** Write them through the existing `channels.setPanels` (owner) from the paste-in
  helper.

## Build

1. **`packages/twitch` (Helix client and mapping, pure where possible).** Use typed Zod parsers for
   only the fields ADR 0031 decision 2 names:
   - `GET /users`: description;
   - `GET /channels`: title, game name, tags, language, content classification labels;
   - `GET /chat/emotes?broadcaster_id`: id, name, tier, format, images;
   - `GET /schedule`: segments.

   Pagination and rate-limit headers are handled. `toBundle(helixData) → PortabilityBundle` maps:

   - **Tags and language:** tags go through the studio's tag rules; language through its codes.
   - **Mature:** any content classification label sets `mature: true` (a suggestion; never
     clears).
   - **Category:** `categoryName` is set for the importer's name match.
   - **Emote tiers:** subscriber tiers 1000/2000/3000 → 1–3; follower emotes → 0. Bits and other
     types are skipped and listed as skipped.
   - **Schedule:** carried as segments (not applied).

   Also: `panelPaste(text) → panel[]`, which turns pasted panel text into the panel markdown
   subset. It strips all HTML, keeps http(s) links, splits panels on blank-line-separated
   headings, and enforces the panel caps. It is pure and browser-safe, exported for the web.

2. **Connect and callback (API).**
   - `connect` returns the authorize URL with **no scopes**, a `state` bound to the session
     (HMAC, 10 min) and the import redirect URI.
   - The raw callback does the following:
     - validates `state` and exchanges the code;
     - reads the user (`/users` with the user token proves the login matches the account being
       imported);
     - makes the read calls of decision 2;
     - stores the preview (public data only) in `portability_imports` with status `previewed`,
       and an expiry of 1 h;
     - **revokes the token** with Twitch.
   - The token never reaches the worker, a queue, the database or a log. Add tests that grep the
     log output and the stored rows for it.
   - The tokens Sign in with Twitch keeps are never read.
   - Every Twitch call is a fixed-host fetch with a timeout and no redirects.
3. **Start (API → worker).**
   - `start` takes the per-item choices and, if emotes are chosen, the art-ownership assertion
     (wording version from `n3-import`). It records `asserted_at` and `assertion_version`, then
     queues `import-twitch`.
   - The job does the following:
     - fetches each chosen emote image only from `TWITCH_IMAGE_HOSTS`, through `resolveCallback`
       (SSRF guard), with a size cap;
     - builds the bundle with `toBundle`;
     - calls `applyBundle`, which does the moderation, hashing, re-hosting, clash and skip
       reporting, and the result.

   Nothing hotlinks Twitch.

4. **Web (`_studio/import.tsx`, `components/twitch-import/**`).**
   - **Unavailable state:** a plain explanation, with no Twitch branding beyond the name in text.
   - **Connect button.**
   - **Preview:** fields with checkboxes; emotes with tier and skip reasons; the schedule shown as
     "carried, not applied"; the mature suggestion.
   - **Assertion checkbox** for emotes.
   - **Start, progress and result:** imported, skipped and rejected per item, with opaque reasons.
   - **Panels:** a "paste your panels" helper (textarea → live preview through `panelPaste` →
     save with `setPanels`).
   - Strings go in `n3-import`, `en` and `es`. The page is hidden under `--no-proprietary`.
5. **Mock (`harness/src/mocks/twitch/**`).** An in-process `Bun.serve` with:
   - `/oauth2/authorize`, which redirects back with a code;
   - `/oauth2/token`, `/oauth2/revoke` (records the revocation) and `/oauth2/validate`;
   - Helix `/users`, `/channels`, `/chat/emotes` and `/schedule`, from fixtures (`fixtures/*.json`
     with `.license` sidecars, CC0, our own made-up channel);
   - an image CDN host that serves fixture PNGs, including the T0 fixture image (from the
     trust-safety fixtures) as one emote.

   Reachability from the containers works as in the e9 receiver. `harness/compose.n3.yaml` sets
   fake `OAUTH_TWITCH_*` values, `TWITCH_IMPORT_ENABLED=true` and the base URLs.

## Tests you must add

- **Unit (`packages/twitch`):**
  - Parsers: fixture and malformed responses, pagination.
  - `toBundle`:
    - every mapping;
    - the tier table;
    - skipped types;
    - mature suggestion;
    - schedule carried.
  - `panelPaste` (exhaustive):
    - HTML removal, including `<script>`, attributes and entities;
    - links;
    - caps;
    - empty input;
    - unicode.
- **API integration (with the mock):**
  - No scopes are requested.
  - State replay or forgery is refused.
  - Account mismatch: the CommonAir user tries to import a Twitch account whose login differs from
    the authorized one, and is refused.
  - Token handling:
    - the token is revoked after the read;
    - no token appears in the DB rows or the logs;
    - the preview expires.
  - The import is unavailable without credentials, and unavailable with the flag false.
- **Worker integration:**
  - Image fetches are refused for a host outside `TWITCH_IMAGE_HOSTS`.
  - Emotes:
    - the T0 fixture emote is refused and enqueues T0;
    - a clash is skipped;
    - accepted emotes are stored under our storage.
  - The job is idempotent on retry.
- **Web unit:**
  - the unavailable state;
  - the preview choices;
  - the assertion required for emotes;
  - the paste helper's preview and save.
- **Harness `twitch-import`** (fill the pending steps; it needs `oauth`, so it is skipped under
  `--profile no-proprietary`):
  1. Connect through the mock.
  2. Preview shows the fixture channel.
  3. Import title, tags, category, description and emotes, with the assertion.
  4. The channel page shows the title.
  5. Accepted emotes work in chat. The T0 emote is rejected, and the T0 job ran.
  6. The schedule is shown as carried, not applied.
  7. Paste panels and see them on the channel page.
  8. The mock recorded the revocation.
     (Not a step: with `TWITCH_IMPORT_ENABLED` false the page shows the unavailable state, covered by
     the API integration and web unit tests, because the `w3` stack forces the flag on everywhere.)

## Done means

Follow `.claude/briefs/_done-means.md`:

- `bun run test` in `packages/twitch`.
- `bun run test` / `test:int` in `services/api` and `services/worker` (one `test:int` at a time).
- `bunx tsc -p` for each.
- `bun --bun vp test run` in `apps/web` and `harness`.
- `vp build` in `apps/web`.
- `vp lint --deny-warnings` and `vp fmt`.
- The i18n check.
- `reuse lint`.
- `git status` shows only your paths. Commit with `git commit -s`.

Then tell the user to run `bun harness/src/cli.ts run twitch-import` against `stack --harness`, and
to check the import page by hand under `en`, `es` and `en-XA`, at 320 px, dark and light, keyboard
only.

A real-Helix smoke test is the maintainer's, before anyone turns the flag on. List its steps in
your final message.
