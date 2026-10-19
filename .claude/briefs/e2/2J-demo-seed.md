<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing **the demo seed and cleanup** for CommonAir (repo: /Users/joshe/Repos/bcon).
Read AGENTS.md, PLAN.md, docs/architecture.md, ADR 0004 (`docs/decisions/0004-governance-enforcement.md`),
`harness/README.md` and `packages/contracts/src/fixtures.ts` first. Do not look outside the
repository. You work in your own git worktree: run `git merge main --no-edit` first.

## Goal

The user wants to click around a local or staging instance with realistic data: known logins,
channels, follows, chat, a moderation example and optionally live streams. And to remove all of
it again without any chance of touching real data.

## You own (write only these)

- `harness/**` (new code under `harness/src/demo/`, CLI wiring, README, tests)
- `services/api/src/auth/identity.ts`, `services/api/src/auth/index.ts` (sign-up gate only), and
  their tests under `services/api/tests/`

## Contracts you must honor (read-only for you)

- `@commonair/contracts/fixtures`: `DEMO_FIXTURES` (`usernamePrefix: "demo_"`,
  `emailDomain: "demo-seed.invalid"`) and `isDemoFixtureIdentity`.
- `packages/config` `authEnv.DEMO_SEED_ENABLED` (default false).
- `packages/db` schema and protections. Facts that matter:
  - `channels.owner_id` is `ON DELETE RESTRICT`.
  - Several channel children are `RESTRICT` (broadcasts in media.ts, playback sessions in
    delivery.ts, reports in safety.ts, money tables).
  - `audit_log` is append-only. Its rows reference ids only and must stay.
  - Ledger, governance and co-op tables are protected: the seed must never create rows there.

## Fixture anchors (non-negotiable)

1. **API sign-up gate** (`identity.ts` / the sign-up hook in `auth/index.ts`):
   - Add `DEMO_FIXTURES.usernamePrefix` to the reserved prefixes, so real users can never register
     `demo_*`.
   - Exempt a sign-up only when all of these hold:
     - `isDemoFixtureIdentity(username, email)` is true;
     - `DEMO_SEED_ENABLED` is true;
     - `NODE_ENV !== "production"`.
   - Conversely, refuse any sign-up whose email is on the fixture domain unless the username is
     also `demo_*` and seeding is enabled. Then a fixture-domain account always carries both anchors.
   - Unit and integration tests for every cell of that matrix.
2. **Seed.** Every account it creates uses a `demo_` username and an `@demo-seed.invalid` email.
   It signs up through the real API: ALTCHA, then the verification link from Mailpit (staging and
   local Mailpit accept any address). Use the existing harness `UserFactory`/`Platform` code; make
   the username prefix and email domain injectable rather than forking it.
3. **Manifest.** Seeding writes `harness/.demo-seed/<target>.json` (gitignored; file mode 0600;
   `<target>` derived from the API host). It records the run tag, target URLs, and per account:
   user id, username, email, password and role, plus channel ids and bot ids. Passwords are random
   and strong, never logged and never printed. Print usernames and the manifest path only.
4. **Cleanup.**
   - Deletes only rows whose user id is in the manifest **and** whose stored username and email
     both satisfy `isDemoFixtureIdentity`. A manifest entry that fails the anchors is reported and
     skipped, never deleted.
   - `--all-anchored` (for a lost manifest) deletes every user matching both anchors, after
     printing the count and asking for `--yes`.
   - It refuses to run without `DATABASE_URL`, and refuses when the database's instance looks like
     production (`NODE_ENV=production` in the env it was given) unless `--force-production`, which
     still requires both anchors.
   - It deletes children before parents in one transaction per user (sessions, chat, follows,
     roles, bans, playback sessions, broadcasts, stream keys, channels, bot accounts owned by the
     user, then the user).
   - Append-only and protected tables are left alone.
   - It removes Valkey keys for those ids only if trivially possible; otherwise document that they
     expire.
   - Dry-run by default: show what would be deleted; `--yes` executes.

## Build

- CLI:
  - `bun harness/src/cli.ts seed [--profile small|full] [--live <n>] [--refresh]`
  - `bun harness/src/cli.ts cleanup [--yes] [--all-anchored]`
  - Both use the harness env (`HARNESS_*`, incl. `HARNESS_MAILPIT_AUTH`) so they work against
    local and Railway staging alike.
- **Idempotent.** Re-running `seed` with an existing manifest signs the recorded accounts in and
  tops up missing pieces instead of creating duplicates. `--refresh` cleans up first, then seeds.
- **Content.** `small`:
  - 3 streamers and 4 viewers named `demo_<role><n>` (other reserved names stay reserved), with
    display names;
  - channels with titles, a category, tags and language (via `channels.update`);
  - follows between them;
  - ~30 chat messages over the channels (via the chat socket);
  - one active timeout and one ban (via `chat.bans.ban`);
  - a bot account owned by a streamer, with a token, recorded in the manifest so the user can try
    tmi.js;
  - `full`: more accounts and messages.
  - The seed creates no money, co-op or relay data.
- **`--live <n>`.** Rotates keys and starts n looping ffmpeg test streams (reuse the harness
  streamer). It keeps running until Ctrl-C, then stops the streams cleanly. Stream keys go in the
  manifest only.
- **README.** A "Demo data" section: what gets created, the anchors and why collisions are
  impossible or unlikely, the commands for local and staging (staging needs
  `DEMO_SEED_ENABLED=true` on the api service: tell the head agent, do not change
  `.railway/railway.ts`), and how cleanup decides what to delete.

## Tests you must add

- API: the identity/sign-up matrix (unit + integration through the real sign-up endpoint).
- Harness unit tests: manifest round trip and permissions; anchor filtering (a tampered manifest
  entry is skipped); target naming; plan ordering.
- Integration test (`*.int.test.ts`, `createTestDatabase()`): insert fixture users/channels/
  follows/chat/bans/broadcasts/playback sessions **and** a real-looking user with similar data,
  run cleanup; every fixture row is gone, every real row (and its audit rows) is untouched, and
  `--all-anchored` behaves the same.

## Done means

- Do NOT run `bun run verify`, `podman compose`, dev servers, browsers or a live seed against the
  stack (the user tests). Run the harness and services/api unit tests, the integration tests above
  (data services are up at the `.env.example` defaults), `bunx tsc -p harness` and
  `bunx tsc -p services/api`, and `vp lint`/`vp fmt` on changed files.
- No files outside your ownership list changed (`git status`).
- Commit in your worktree with `git commit -s` (`feat(harness): …`), ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Final message: what you built, test counts, branch + commit sha, contract/infra requests, and
  anything left undone. Note that the gate was not run.
