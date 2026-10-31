<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Batch 5 wave 1 handoff prompt

Paste this into a new session started in the repository.

---

You are the orchestrator for CommonAir batch 5 (the rest of N2, internationalization), starting
**wave 1**. Repo: this checkout, branch `main`, at `a2462d7` or later. The batch 5 contract step
is on `main` (`5ca553a`, plus `73577a2` and `a2462d7`), and CI is green on `a2462d7` with every
job, including all harness shards.

**Read first:** AGENTS.md; `.claude/briefs/batch5/README.md` (decisions (a)–(m) are final, path
ownership, the Spanish style and glossary, shared rules, milestone checks);
`.claude/briefs/n2/batch5-contract-step.md` (what landed); the six wave-1 briefs
`.claude/briefs/n2/{N2-ui,N2-email,N2-switcher,N2-es}.md` (N2-es covers three units: es-a, es-b
and es-c); `.claude/briefs/_done-means.md`; PROGRESS.md "In flight" (the batch 5 paragraph).

**Wave 1:** six units in parallel, each implement → independent review → fix in its own worktree,
using the Workflow tool:

| Unit        | Brief                  | Branch        |
| ----------- | ---------------------- | ------------- |
| N2-ui       | `n2/N2-ui.md`          | `n2/ui`       |
| N2-email    | `n2/N2-email.md`       | `n2/email`    |
| N2-switcher | `n2/N2-switcher.md`    | `n2/switcher` |
| N2-es-a     | `n2/N2-es.md` (unit a) | `n2/es-a`     |
| N2-es-b     | `n2/N2-es.md` (unit b) | `n2/es-b`     |
| N2-es-c     | `n2/N2-es.md` (unit c) | `n2/es-c`     |

- Reuse the batch 4 script:
  `~/.claude/projects/-Users-joshe-Repos-bcon/555274cf-5518-4b7f-94d9-e487a614ddc4/workflows/scripts/batch4-wave2-wf_8302f353-c4e.js`.
  It defines the implement schema (worktree, branch, commits, report) and a fix agent that `cd`s
  into the worktree. Adapt it as follows:
  - `UNITS`: the table above.
  - Prompts: point to the batch 5 README and briefs, not batch 4's. Tell the es units which
    letter they are.
  - Base sha: `a2462d7` or later.
  - Lessons line: add the batch 5 rules below.
  - es reviewers: the reviewer must read Spanish fluently. It samples at least 150 strings per
    unit against the glossary and checks every ICU message and every placeholder (README "Shared
    rules").
- Implementers copy `.env` into their worktree root. If it has no VAPID keys, they run
  `bun scripts/init-env.ts --merge` there. They run `bun install` if `node_modules` is missing.
- Batch 5 rules for every unit:
  - No new third-party dependency.
  - Never create a namespace, edit `keys/index.gen.ts`, or edit an English catalog the unit does
    not own. A unit that adds English keys writes their `es` translation in the same change
    (decision (m)).
  - `cd apps/web && bun run i18n:check && bun --bun vp test run tests/i18n.test.ts` for any web
    catalog change. The parity check now rejects:
    - changed arguments;
    - a missing select case;
    - a dropped `=0`/`=1`;
    - a changed `offset`;
    - `{n}` written in place of `#`.
  - Logical CSS only. N2-ui must not touch class names in its seven block files; N2-rtl converts
    those in wave 2.
  - Spanish: neutral Latin American, address the reader as tú, write `one`/`other` plurals and
    never `many`, follow the glossary. The DMCA sworn statements in `e7-dmca` stay in English
    verbatim (es-a lists their keys).

**Merge the wave yourself:**

1. Check that no two branches touch the same file. Shared risk points: `apps/web/src/i18n/index.ts`
   and `catalogs.ts` (N2-ui only), `packages/ui/src/index.ts` (N2-ui only).
2. Merge each branch with `git merge --no-ff --signoff` and the
   `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer.
3. Apply contract requests yourself, or decline them with a reason in PROGRESS.
4. After N2-switcher merges, empty `PENDING_N2_SWITCHER_IDS` in `apps/web/tests/selectors.test.ts`.
5. Merge the glossary terms the units report into the README table before wave 2.
   If N2-email adds optional count props, apply its caller contract requests (api and worker
   senders).
6. Push `main`. Watch CI with Monitor, reporting only failed jobs and the final result.

**CI on `main` is the gate:**

- Never run `bun run verify`, `verify:full`, harness scenarios or image rebuilds locally, except
  a targeted check to debug a specific CI failure.
- Read a failed job with
  `gh api --allow-escape-sequences repos/abolishus/commonair/actions/jobs/<id>/logs`.
- Use `gh run rerun <run> --failed` for infrastructure flakes once the run has completed.
- Hand a failure that looks like a product bug to an agent with a precise brief: the failing
  check, its data, the code paths, and "reproduce in a unit test first".

**Known while landing the contract step:**

- **Parallel seed work:** another session is building the full-coverage seed
  (`.claude/briefs/seed-full/`, `harness/src/seed/**`). Its `SEED_ROUTES` must list every web
  route. A new route needs a row there; batch 5 adds none in wave 1.
  When an env var is added to a service, regenerate the self-host key lists with
  `bun scripts/selfhost/unit-env.ts`.
- **Advisory exceptions:** `glob` and `minimatch` have dated exceptions in `supply-chain.json`
  and `osv-scanner.toml`, expiring 2026-11-17. After 2026-11-03, try the upgrade (`glob` 14.0.2,
  `minimatch` 11.0.1) if Storybook still builds.
- **Flake:** `apps/web/tests/e8-studio.test.tsx` "counts down a started raid" failed once under
  full-suite load locally and passes alone.

**After wave 1 is merged and green:** start wave 2 (N2-rtl, N2-weblate, N2-pseudo; briefs in
`n2/`) the same way. Then the milestone:

- `REQUIRED_LOCALES = ["es"]`;
- register `e2e-basic --set locale=en-XA` in `harness/src/shards.ts`;
- `docs/README.md` rows;
- PROGRESS.

After that, plan W2 as batch 6 (`.claude/briefs/next/W2-feature-wave.md`); start no W2 unit
before batch 5 is merged and green.

**Open for the user (don't block on them):** the Hosted Weblate libre-plan application and the
GitHub integration (after N2-weblate lands), visual checks under `es` and `en-XA`, a fluent
speaker's read of the Spanish, and the counsel items in the README.
