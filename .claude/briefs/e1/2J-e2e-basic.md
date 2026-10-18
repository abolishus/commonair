<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing **the `e2e-basic` harness scenario** for CommonAir (repo: /Users/joshe/Repos/bcon).
Read AGENTS.md, HANDOFF.md (Milestone E1), harness/README.md and docs/testing/e1-selectors.md
first. Do not look outside the repository.

## You own (write only these)

- `harness/**`

## Contracts you must honor (read-only for you)

- `docs/testing/e1-selectors.md` — the web app (`apps/web`, being built in parallel by another
  agent) exposes exactly these routes and `data-testid`s. Select only by test id / role, never by
  visible text.
- `packages/contracts` (oRPC contract, chat frames), the existing harness drivers (`src/platform.ts`,
  `src/streamer.ts`, `src/browser-viewer.ts`, `player/probe.ts`, `src/mailpit.ts`,
  `src/chat-client.ts`, `src/wait.ts`).

## Build

`harness/scenarios/e2e-basic.ts` (needs: api, web, mail, rtmp, origin, chat — add a `web` need
to `src/scenario.ts` NEEDS if missing, probing `HARNESS_WEB_URL/healthz`):

1. Streamer signs up **through the web UI** in Chromium (Playwright): fill `/signup`, wait for
   `signup-altcha[data-state=verified]`, submit, see `signup-check-email`. Read the verification
   email from Mailpit, open its link in the same browser context, end up signed in (or sign in via
   `/signin` if the link lands there). Assert `nav-user[data-username]`.
2. On `/dashboard`: read `stream-server-url`, click `stream-key-rotate` (confirm if
   `confirm-dialog-confirm` appears), read `stream-key`. Publish an ffmpeg RTMP test pattern to
   `<server>/<key>` using the existing streamer driver (add a way to give it a full publish URL if
   it only takes slug+secret).
3. A second user (signed up via `platform.signUp`, API path is fine) opens `/<streamer>` in
   **Chromium** with the probe; an **anonymous** viewer opens `/<streamer>` in **WebKit**. Both:
   `live-badge` visible, `player[data-state=playing]`, first frame via the probe. Record TTFF and
   glass-to-glass latency per browser as metrics (`ctx.metric`), with soft checks against
   generous thresholds (TTFF < 15 s, latency < 20 s; tune later).
4. The second user sends a chat message via `chat-input` + `chat-send`; assert it appears as a
   `chat-message` with `data-author=<second user>` on the streamer's page (open the streamer's own
   channel page in their context) and in the anonymous WebKit viewer.
5. Check `footer-source-link` has a non-empty `href`.
6. Stop the stream; assert `offline-state` appears on viewers within a deadline and
   `channels.get` reports offline.

- Use `ctx.defer` for every browser/streamer cleanup; unique users per run; deadlines everywhere
  (poll, never tight wall-clock assertions). Screenshot each browser page on failure into the
  report directory.
- Make `--player web` open `/embed/<channel>` as documented (check it does).
- Add `e2e-basic` to `bun run verify:full`? No — `scripts/` is not yours. Instead mark it part of
  `full` and report it so the orchestrator wires it.

## Tests you must add

- Unit tests for any new pure helpers (e.g. publish-URL building, Mailpit link extraction from the
  web-proxied verification URL, selector constants module `src/web/selectors.ts` whose values are
  checked against docs/testing/e1-selectors.md by a test that parses the markdown table).
- `bun harness/src/cli.ts list` shows the scenario; `run e2e-basic --skip-unavailable` skips
  cleanly when the web need is unmet.

## Done means

- `bun run verify --quick` passes with your tests; `bun run --filter @commonair/harness test:int`
  still passes (Podman available).
- No files outside `harness/**` changed (`git status`).
- Commit in your worktree (Conventional Commits, `git commit -s`, trailer
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).
- Final message: what you built, test counts, the exact command to run it, assumptions about the
  web app you could not verify (the orchestrator runs it once the web app lands), contract requests.
