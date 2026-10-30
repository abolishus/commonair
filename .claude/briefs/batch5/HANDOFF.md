<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Batch 5 handoff prompt

Paste this into a new session started in the repository.

---

You are the orchestrator for CommonAir batch 5: the rest of N2 (internationalization), then W2
planning. Repo: this checkout, branch `main`, at `316915b` or later. Batch 4 (W1 + N1) is done
and CI is green on `8065ce3` with every job, including all seven harness shards.

**Read first:** AGENTS.md; PROGRESS.md ("In flight": the batch 4 paragraph at the top, and the
batch 3 paragraph for N2-core and N2-consent); `.claude/briefs/next/README.md` (batch order and
the decisions the user owns); `.claude/briefs/next/N2-i18n-weblate.md` (units, done means);
ADR 0029 (`docs/decisions/0029-i18n.md`); `.claude/briefs/n2/{contract-step,N2-core,N2-consent}.md`
and `apps/web/src/i18n/README.md` to see what already landed; `.claude/briefs/_done-means.md`;
`.claude/briefs/batch4/README.md` as the model for a batch README.

**State:**

- Already on `main` from batch 3: the N2 contract step (nullable `users.locale`,
  `INSTANCE_DEFAULT_LOCALE`, `instanceSite().defaultLocale`), N2-core (formatter and plurals over
  `Intl.PluralRules`, JSON catalogs under `apps/web/src/i18n/locales/<lang>/<namespace>.json` with
  generated typed keys, negotiation, lazy load, `en-XA`) and N2-consent (cookie settings).
- Not started: the Spanish (`es`) catalog, N2-ui (`UiMessages` per locale, locale-aware house
  primitives), N2-email (`packages/email/src/messages/**` in the same JSON format; N1-email has
  merged, so the email catalog is free), N2-switcher (settings and footer switcher, `me.update`
  locale), N2-weblate (`docs/maintainers/translations.md`; the maintainer applies for the Hosted
  Weblate libre plan and installs the GitHub integration).
- No batch 5 briefs exist yet. Batch 4 added ~26 namespaces' worth of strings (w1-_, n1-_, core
  keys) that the `es` catalog must cover.

**Do, in order:**

1. **Plan batch 5** (the N2 rest). Check the code first: what N2-core already built, whether any
   unit needs a contract step (a new env var, a contract field, a migration; probably none or a
   small one), and the path conflicts between the five units (`packages/ui` primitives,
   `packages/email`, settings and footer components, `apps/web/src/i18n/locales/es/**`).
   Write `.claude/briefs/batch5/README.md` (waves, decisions table, path ownership, shared rules)
   and one brief per unit with the `brief-subagent` skill. Ask the user only real policy questions
   (for example: machine-assisted first draft of `es` with human review in Weblate, or human only;
   whether `ar` RTL is in this batch); technical defaults are yours, recorded in the README.
2. **Contract step**, if any, on `main`: implement → independent review → fix, commit, push, CI
   green.
3. **Waves** with the Workflow tool, at most six units at a time.
4. **Milestone:** N2's done means (`e2e-basic` passes under `en-XA` so a missed literal shows;
   plural and RTL unit tests; `es` at 100 %); the selectors and i18n checks; PROGRESS.
5. **Then plan W2** (`.claude/briefs/next/W2-feature-wave.md`, which also holds the deferred chat
   replay UI) the same way, as batch 6. Do not start W2 units in this session unless batch 5 is
   merged and green.

**How (this user's working rules):**

- **Workflow tool per wave.** Per unit: implement in its own worktree (`isolation: 'worktree'`,
  branch `n2/<unit>`, `git commit -s`), then an independent review, then a fix pass in the same
  worktree. The batch 4 scripts are reusable: `~/.claude/projects/-Users-joshe-Repos-bcon/555274cf-5518-4b7f-94d9-e487a614ddc4/workflows/scripts/batch4-wave2-wf_8302f353-c4e.js` (implement schema returns worktree, branch, commits and report; the fix
  agent `cd`s into the worktree). Tell implementers to copy `.env` into their worktree root (run
  `bun scripts/init-env.ts --merge` there if VAPID keys are missing) and `bun install` if needed.
- **Merge waves yourself.** Before merging, check that no two branches touch the same file. Use
  `git merge --no-ff --signoff` with the `Co-Authored-By: Claude Opus 5.5
  <noreply@anthropic.com>` trailer. Apply contract requests yourself; decline with a reason in
  PROGRESS or an ADR amendment when one is not worth it. Lift harness steps off pending lists
  when their unit merges.
- **CI on `main` is the gate.**
  - Never run `bun run verify`, `verify:full`, harness scenarios or image rebuilds locally. The
    one exception is a targeted local check to debug a specific CI failure.
  - Units run targeted checks only: package tests and `test:int` (data services are up), `tsc`,
    `vp lint --deny-warnings`, `vp fmt`, `vp build` for `apps/web`, `reuse lint`.
  - Push after each merged wave. Watch the run with Monitor, reporting only failed jobs and the
    final result.
  - Read a failed job with `gh api --allow-escape-sequences repos/abolishus/commonair/actions/jobs/<id>/logs`.
    Harness artifacts (`gh run download <run> -n verify-logs-harness-<shard>-<attempt>`) hold
    `harness/reports/latest.json`, container logs and failure screenshots; they upload only on
    failure.
  - Use `gh run rerun <run> --failed` for infrastructure flakes (a registry blob fetch, a slow
    runner) once the run has completed.
  - Hand a product-looking failure to an agent with a precise brief: the failing check, its data,
    the code paths, and "reproduce in a unit test first". That is how batch 4 found the Calm Chat
    wave bug.
- **CI selection is on** (`scripts/ci-changes.ts`): docs and tests run the gate only;
  harness-only changes run the scenarios that import them; the CI harness matrix follows
  `FULL_SHARDS` in `harness/src/shards.ts`.

**Lessons from batch 4:**

- The raw `sql` client from `createDb` has drizzle's timestamp parsers and serializers turned
  off: raw `timestamptz` reads are strings and `Date` params throw. Use ISO text both ways (cast
  `::timestamptz`; read with `to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`), not float epochs.
- Integration tests must not depend on the host clock agreeing with Postgres's (the Podman VM
  runs ahead locally and hides it). Pin the code's clock instead.
- Harness timing assertions need slack for a loaded runner. A scenario that runs first in its
  shard sees a broadcast only seconds old.
- Web sign-ins go through `signInViaUi`, which retries the shared `auth` bucket (10 a minute per
  address, shared by a shard's scenarios). Machine token calls go through `machineFetch`.
- Every signed-in viewer gets the chat message menu (block); moderator menus carry
  `data-moderation="true"`.
- Selectors docs written as prose (like w1) are checked by `proseTestIds` in
  `apps/web/tests/selectors.test.ts`; conditional and templated ids count.
- Earlier lessons still hold: `reuse lint` on SPDX strings in code, the web source policy
  (`buttonVariants`), logical CSS only, harness steps that create named things use their own
  actors, wait for the browser to land before the next `goto`.

**Open from batch 4 (watch, don't block):**

- `simulcast` "S removes the target" hung to the 10-minute timeout on two slow runs. Its web
  path is now capped at 60 s and logs where it stuck (`simulcast.webRemoveStuckAt` in the
  report). If that key appears, find the cause.
- `integrity-basic` "count converges to 7" timed out once at 150 s (36–64 s usually).
- Follow-up, not scheduled: judge only the origin stretch of a session moved there by data mode
  (ADR 0018 Amendment 1 item 4; needs a column, an API change and an integrity change).
- Optional contract requests left out: push `status` `thisBrowser`; `settlementAccount` export
  (W2-splits owns `rules.ts`); `authSecret` on `WorkerContext`.
- Many old worktrees under `.claude/worktrees/` (batches 1–4). Offer to clean the merged ones
  (`git worktree remove`); deleting is the user's call.

**Open for the user (don't block on them):**

- Run `bun scripts/init-env.ts --merge` before any local harness stack (VAPID keys).
- Live checks CI does not cover: `notifications` under `--profile no-proprietary`, PWA install in
  a real Chromium, a real web push on an HTTPS instance with `selfhost.sh --web-push`, a Discord
  webhook, data mode on a phone or Safari, and the visual checks (dark/light, 320 px).
- Counsel: the W1 and N1 privacy and cookie drafts (`2026-10-30-notifications-draft`), the terms
  and the earlier drafts.
- Dual-licensing the ten SDK contract files (ADR 0035), the `@commonair` npm organisation and its
  trusted publisher, `bun scripts/infra.ts reset` for their stuck local stack, and R0's timed
  restore on a second droplet before tagging `v0.1.0`.
