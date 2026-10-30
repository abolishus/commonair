<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Batch 4 handoff prompt

Paste this into a new session started in the repository.

---

You are the orchestrator for CommonAir batch 4 (W1 + N1). Repo: this checkout, branch `main`,
at `bd96d60` or later. Batch 3 (E8, E9, N2-core, N2-consent) is done and CI is green.

**Read first:** AGENTS.md, PROGRESS.md ("In flight", the batch 4 paragraph at the top),
`.claude/briefs/batch4/README.md` (waves, decisions table, namespaces, path conflicts, shared
rules), `.claude/briefs/_done-means.md`, then `.claude/briefs/w1/contract-step.md` and
`.claude/briefs/n1/contract-step.md`. ADRs: 0012 part 2, 0015, 0018, 0028, and 0036 (payment
fraud floor, accepted 2026-10-30).

**State:** planning only. Briefs, both contract-step docs and ADR 0036 are committed
(`e8fc926`). No code for W1 or N1 has landed. The decisions table in the batch4 README is
final; do not reopen it. A stopped earlier attempt at the W1 step was discarded, so start it
clean.

**Do, in order:**

1. **W1 contract step** on `main`: implement `.claude/briefs/w1/contract-step.md` exactly
   (migrations `0037` and `0038`). Then an independent review against the brief and AGENTS.md,
   then a fix pass. Commit `feat(w1): contract step`, then `fix(w1): contract step review`.
2. **N1 contract step** on top of it, the same way (migrations `0039` and `0040`; VAPID keys in
   config, `.env.example` and `selfhost.sh`). Then push `main` and tell the user to run
   `bun scripts/init-env.ts --merge` before any local harness stack.
3. **Wave 1:** W1-breakdown, W1-calm-chat, W1-spine, W1-player, W1-watch-gate, W1-fraud-floor.
4. **Wave 2:** W1-data-mode, N1-fanout, N1-email, N1-push, N1-inbox, N1-pwa.
5. **Wave 3:** N1-discord.
6. **Milestone wiring:**
   - New scenarios `timeline-sync`, `surge-guard` and `notifications` get `inFull: true` and
     join `FULL_REQUIRED`.
   - Add a `features` shard (rename of the planned `w1` shard) in `harness/src/shards.ts` and
     the CI matrix. `notifications` joins it unless that pushes the shard past ~12 min.
   - Add selector checks for the w1 and n1 docs in `apps/web/tests/selectors.test.ts`.
   - Add the doc links and data-export rows the briefs list.
7. **Update PROGRESS.md** as you go: waves, decisions, CI fixes, open items.

**How (this user's working rules):**

- **Orchestrate with the Workflow tool.**
  - One workflow per wave: a pipeline per unit of implement in its own worktree
    (`isolation: 'worktree'`, branch `w1/<unit>` or `n1/<unit>`, `git commit -s`), then an
    independent review, then a fix pass in the same worktree.
  - Tell implementers to copy `.env` into their worktree root first.
  - Contract steps can run as a sequential workflow (implement → review → fix) on `main`.
- **Merge waves yourself.** Use `git merge --no-ff --signoff` with the
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer.
- **Apply contract requests yourself.** Units only file them. Lift harness steps off the
  pending lists when the implementing unit merges.
- **CI on `main` is the gate.**
  - Never run `bun run verify` or `verify:full` locally, and don't run harness scenarios or
    image rebuilds. The one exception: a targeted local run to debug a specific CI failure.
  - Units run targeted checks only: package tests and `test:int` (the data services are up),
    `tsc`, `vp lint --deny-warnings`, `vp fmt`, `vp build` for `apps/web`, and `reuse lint`.
  - Push after each merged wave. Watch CI with Monitor: poll each run's jobs every ~60 s and
    react to the first failed job (`gh api …/jobs/<id>/logs`; artifacts hold container logs and
    harness screenshots). Fix it and push.
- **CI selection is on** (`scripts/ci-changes.ts`). It diffs against the last green run.
  Docs and tests run the gate only. Harness-only changes run the scenarios that import them.
  Release dry run and self-host e2e run only for deploy paths. Nightly and dispatch run
  everything.
- **Lessons from batch 3:**
  - Units missed `reuse lint` on SPDX strings inside code and `buttonVariants` in `apps/web`
    (source policy).
  - Harness steps that share a run's streamer collide; give a step its own actors when it
    creates named things.
  - The token endpoint shares the `auth` rate-limit bucket. Send machine calls through the
    forwarding proxy (`machineFetch` in `harness/src/e9/run.ts`).
  - Wait for the browser to land before the next `goto`.
- **Ask the user only real policy questions.** Use AskUserQuestion, recommendation first.
  Technical defaults are yours; record them in PROGRESS.

**Open for the user, outside this batch (don't block on them):**

- Dual-licensing the ten contract files the SDK copies in (`AGPL-3.0-or-later OR Apache-2.0`,
  ADR 0035) before the first SDK publish.
- The `@commonair` npm organisation and its trusted publisher.
- Counsel review of the terms, privacy and cookie drafts.
- `bun scripts/infra.ts reset` for their stuck local stack. It wipes the local volumes, so it's
  the user's call.
- R0's timed restore on a second droplet before tagging `v0.1.0`.

**Then:** the rest of N2 (Spanish catalog, N2-ui, N2-email, switcher, Weblate) follows after
N1-email merges.
