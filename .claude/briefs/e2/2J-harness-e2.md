<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing **the E2 harness scenario** for CommonAir (repo: /Users/joshe/Repos/bcon).
Read AGENTS.md, PLAN.md ("Milestones"), docs/architecture.md, `docs/testing/e1-selectors.md` and
**`docs/testing/e2-selectors.md` (your contract; it describes the scenario step by step)** first.
Do not look outside the repository. You work in your own git worktree: run `git merge main
--no-edit` first.

## You own (write only these)

- `harness/**` except `harness/scenarios/integrity-basic.ts`

## Contracts you must honor (read-only for you)

- `docs/testing/e1-selectors.md`, `docs/testing/e2-selectors.md`, `packages/contracts` (incl.
  `@commonair/contracts/auth`, `channels.get.viewer`, `chat.bans.*`, chat protocol),
  `services/irc` behavior (read `services/irc/src/translate.ts` for CLEARCHAT/NOTICE tags). The web
  slice and the API are being built in parallel against the same contract.

## Build

1. `harness/src/web/selectors.ts`: add the E2 test ids and routes; extend the existing unit test
   that parses `e1-selectors.md` so it also parses `e2-selectors.md` (both documents' tables must
   match the module exactly).
2. `harness/src/bots/tmi-bot.ts`: record what the bot observes — chat messages (with tags) and
   moderation events (`timeout`, `ban`, `clearchat`, `messagedeleted` from tmi.js), with helpers to
   wait for them. Keep it unmodified tmi.js 1.8.5 and never let it call Twitch.
3. New scenario `harness/scenarios/e2e-social.ts` (registered like the others, individually
   runnable: `bun harness/src/cli.ts run e2e-social`) implementing the five steps of
   `e2-selectors.md`: streamer via API sign-up + RTMP publish (reuse `_ingest.ts`/streamer
   helpers), viewer `F` and troll `T` as signed-in Playwright sessions (Chromium is enough), the
   streamer's own signed-in web session for the moderation click, the tmi.js bot via
   `platform.createBot` + `platform.tmiBot`. Waits are bounded (directory ≤ 60 s, chat ≤ 10 s) with
   clear failure messages and failure screenshots like `e2e-basic` (no secrets in screenshots or
   logs). Record timings in the report (follow round trip, bot reply latency, moderation
   propagation to web and IRC).
4. Make sure `smoke` and `e2e-basic` still pass their unit-level checks; do not change their
   behavior.

## Tests you must add

- Unit: selectors parse test for both docs; tmi-bot event recording (feed a fake tmi client or
  test the pure parts); scenario registration.
- You cannot pass `e2e-social` end to end until the web slice lands: run what you can against the
  running stack (`HARNESS_WEB_URL=http://localhost:3100`; API steps, bot connect, timeout via
  `chat.bans.ban` and CLEARCHAT on IRC) and report which steps passed and which wait on the web.

## Done means

- Do NOT run `bun run verify` (the user runs the gate). Run `cd harness && bun --bun vp test run`,
  `bunx tsc -p harness`, and `vp lint`/`vp fmt` on changed files. Do not run `podman compose`.
- No files outside your ownership list changed (`git status`).
- Commit in your worktree with `git commit -s` (`feat(harness): …`), ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Final message: what you built, test counts, which scenario steps passed live, branch + commit
  sha, contract requests, anything left undone. Note that the gate was not run.
