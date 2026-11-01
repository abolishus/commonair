<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W3-portability: move links, "tell me if they move" grants, and the portability bundle

You are implementing unit W3-portability for CommonAir (repo: /Users/joshe/Repos/bcon). Read these
first:

- AGENTS.md, PLAN.md and docs/architecture.md.
- `.claude/briefs/batch7/README.md`. Decisions (j)–(p), (aa), (ac), path ownership and shared
  rules are binding.
- `.claude/briefs/w3/contract-step.md`:
  - §2.3 `PortabilityBundle`;
  - §2.4 `portability.*`;
  - §3.1 tables;
  - §4.3 the standing statement;
  - §5.1 `attribution.ts` and the export stubs;
  - §5.2 `channel.moved`;
  - §5.3 the internal upload route and `/.well-known/commonair-portability`.
- `docs/product/feature-wins.md` §4.14.
- ADR 0037 (written by the contract step).
- `docs/testing/b7-selectors.md` and `.claude/briefs/_done-means.md`.

Do not look outside the repository. This is **wave 1**: work in your own git worktree on branch
`w3/portability`, cut from the contract step's sha. **N3-import builds on your importer in wave 2**,
so `applyBundle` must be a clean, documented, exported entry point.

## Why

Twitch followers cannot be exported or contacted. On CommonAir, a creator can pin a "follow me here"
link and count conversions, and a viewer can opt in to one email if the creator moves. A channel can
also leave with its setup in a bundle another instance can import, carrying a signed statement of
its moderation standing so that leaving is not ban evasion.

## You own (write only these)

- `services/api/src/portability/**` (including `attribution.ts`), `services/api/src/routes/portability.ts`
- `services/worker/src/portability/**`, `services/worker/src/jobs/portability-*.ts`,
  `services/worker/src/exports/bundle*.ts`
- `packages/email/src/templates/portability.tsx` and the `channelMoved` keys in the email catalogs
  (`en`, `es`). The template id is registered by the contract step; ask if it is not.
- `apps/web/src/routes/_app/m.$channel.$nonce.tsx` and `apps/web/src/routes/_studio/move.tsx`
  (content), `apps/web/src/components/portability/**` (including `grants.tsx` and `moved-notice.tsx`)
- `apps/web/src/i18n/locales/{en,es}/w3-portability.json`, `keys/w3-portability.gen.ts`
- `harness/scenarios/portability.ts`, `harness/src/w3/portability/**`, `harness/tests/w3/portability*`

**Read-only:**

- `services/worker/src/exports/{collectors,build,archive}.ts`
- `services/api/src/moderation/{uploads,internal-commit}.ts`
- `services/worker/src/webhooks/{ssrf,http}.ts`
- `services/api/src/routes/channels.ts` (`setPanels` `:112-137`, the follow handler), `routes/chat.ts`
  (emote create `:485-540`)
- `packages/{contracts,db,config,tokens,email/src/registry.ts}/**`

Anything else is a **contract request**.

## Contracts you must honor

- **Procedures:** `portability.links.*`, `.grants.*`, `.move.*`, `.bundle.create`, `.imports.*`;
  `channel.follow` `moveLink`.
- **Columns and tables:** `follows.source` / `move_link_id`; `channels.moved_to` / `moved_at`;
  `move_links`, `follow_portability_grants`, `portability_imports`, `portability_signing_keys`;
  the `MOVE_LINK_RULES` trigger; the follower-count trigger (do not update `follower_count` yourself).
- **Bundle and signing:** `PortabilityBundle` v1 (`@commonair/contracts/portability`);
  `StandingStatement` `sign`/`verify` (`packages/tokens/src/standing.ts`);
  `PORTABILITY_SIGNING_KEY` (worker only).
- **Upload route:** `INTERNAL_ROUTES.uploadCommit` → `commitUpload`.
- **Events, jobs and lists:** the `channel.moved` event → `PORTABILITY_JOBS.moved`;
  `PORTABILITY_JOBS.{build,import}`; the `bundle` export kind; `UNSUBSCRIBE_LISTS` `moved`.

## Build

1. **Move links.** `links.create` mints a 128-bit nonce, stores its SHA-256 and returns
   `/m/<slug>/<nonce>` once.
   - Limits: 10 active per channel (the trigger) and 20 per day (rate limit).
   - Links can be revoked, and can have an optional expiry.
   - `links.resolve` answers the landing page: the channel card, and a follow button that passes
     `moveLink` to the follow call.
   - `attributeFollow` sets `follows.source = 'move_link'` and `move_link_id` only on a new follow
     through a live link.
   - `links.list` shows conversions per link: non-excluded follows only.
2. **Grants and the move.**
   - `grants.set` lets a viewer opt in or out per followed channel. The UI is a section on
     `/settings/privacy` plus a toggle on the follow menu (`grants.tsx`; the follow-menu mount is
     a contract request if it is not there).
   - `move.set` takes an https URL (validated, no credentials, length cap), sets `moved_to` /
     `moved_at` and writes `channel.moved` in the same transaction. `move.clear` undoes it; no
     email is sent for a clear.
   - The `portability-moved` job sends one `channelMoved` email per grant holder (with the List-
     Unsubscribe header and the `moved` list), then deletes those grants. The streamer never
     sees the list or the addresses.
   - `moved-notice.tsx` shows "moved to …" on the channel page, with an external-link note.
   - Subscriptions are untouched (decision (m)). The studio page says so.
3. **Bundle build (`exports/bundle.ts`).** The `bundle` export kind writes a ZIP with
   `bundle.json` (`PortabilityBundle` v1, `source: "commonair"`), `files/` (panel images and
   emote images from storage) and the manifest with SHA-256 per file.
   - The standing statement: compute it from `channels.suspended_at`, active `legal_holds`,
     upheld platform actions in the last 12 months by tier (`enforcement_statements` /
     `mod_actions` with `rule_ref`), and DMCA strikes (`account_actions`).
   - Sign it with `PORTABILITY_SIGNING_KEY`, publishing the key to `portability_signing_keys` on
     worker start (the attestation-key pattern). It is valid for 30 days.
   - Reuse the export pipeline (cooldown, TTL, email); do not duplicate it.
4. **Import and the `applyBundle` entry point** (`services/worker/src/portability/import/**`).
   - **Upload:** `imports.upload` presigns an upload to `incoming/`. `imports.preview` parses the
     bundle (refusing unknown `v`, bad hashes and over-cap files), verifies the statement and
     stores a preview with the per-item choices.
   - **Statement check:**
     - the issuer's key is fetched from `https://<issuer>/.well-known/commonair-portability`
       through `resolveCallback` (SSRF guard) in the worker, never the API;
     - a verified statement that says `activeSuspension` or `legalHold` refuses the import;
     - an invalid, expired or missing statement imports, marked "standing not verified" in the
       preview and on the import record.
   - **Start:** `imports.start` queues `portability-import`. The job calls
     `applyBundle(ctx, {importId, bundle, files, choices})`, which:
     - refuses an importer under an active local legal hold or a suspended channel;
     - applies the channel fields through the same validation as a studio edit, never clearing an
       existing mature label (a `mature: true` in the bundle sets it);
     - maps the category by slug, then by exact name, and otherwise leaves it unset;
     - for each image: writes it to `incoming/`, calls `uploadCommit` (`purpose` `emote` or
       `panel`), and on refusal skips it with the same opaque reason a user upload gets;
     - writes panels through the `setPanels` rules, and emotes through the create rules (code
       regex, a clash is skipped and reported, `MAX_EMOTES`);
     - ignores the schedule (records "carried, not applied");
     - writes the per-item result, `finished_at`, and `portability.import.finished`.
   - **Idempotent:** a retried job does not double-insert. Document `applyBundle`'s contract in
     its header for N3.
5. **Studio `move.tsx`:** the links table (create, copy, revoke, conversions), set or clear "moved
   to", export bundle, import bundle (upload, preview with choices and the standing badge, start,
   result). `<ConfirmDialog>` for move and revoke. Strings go in `w3-portability`, `en` and `es`.
6. **Landing `m.$channel.$nonce.tsx`:** the channel card, a follow button, and a revoked or
   expired state (`<EmptyState>`).

## Tests you must add

- **Unit:**
  - bundle parse (versions, caps, hash mismatch, path traversal in file names);
  - the standing statement against the vectors, and tamper cases;
  - category mapping;
  - the mature rule.
- **API integration:**
  - link limits and revoke;
  - attribution only on a new follow through a live link;
  - conversions exclude excluded follows (set `excluded_at` and check the trigger-maintained
    count too);
  - grants;
  - URL validation for the move.
- **Worker integration:**
  - **Moved email:** one email per grant into Mailpit (or the test mailer), the grants deleted,
    no email for the streamer.
  - **Bundle build:** a round trip, `build` then `applyBundle` into a second channel. Every field
    lands, an emote clash is skipped, a T0 fixture emote is refused and enqueues T0 (through the
    real `uploadCommit`).
  - **Statement gates:** a statement with `activeSuspension` refuses the import; a legal hold on
    the importer refuses it; an expired statement imports as unverified; the job is idempotent on
    retry.
- **Web unit:** the move page (create, copy, revoke confirm), the import preview choices, the
  landing states.
- **Harness `portability`:**
  1. A link converts: a follow with `source = move_link`, and the count rises.
  2. A grant, then a move: Mailpit receives exactly one moved notice, and the channel page shows
     the notice.
  3. A bundle round-trips into a second channel.
  4. A T0 fixture emote in the bundle is refused.
  5. A suspended channel's bundle is refused at import.

## Done means

Follow `.claude/briefs/_done-means.md`:

- `bun run test` and `test:int` in `services/api` and `services/worker` (one at a time);
  `bunx tsc -p` each.
- `bun --bun vp test run` in `apps/web` and `harness`; `vp build` in `apps/web`.
- `vp lint --deny-warnings` and `vp fmt`; the i18n check plus the email catalog check;
  `reuse lint`.
- `git status` shows only your paths. Commit with `git commit -s`.

Then tell the user to run `bun harness/src/cli.ts run portability` against
`stack --harness`, then check by hand under `en`, `es` and `en-XA`, at 320 px, dark and light,
keyboard only:

- create and copy a link;
- follow through it in a private window;
- set "moved to" and read the email in Mailpit;
- export and import a bundle.
