<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing **E4c unit F, harness `trust-safety`** for CommonAir (repo: /Users/joshe/Repos/bcon).
Read AGENTS.md, PLAN.md, docs/architecture.md and `.claude/briefs/e4c/_common.md` first (all of
it, especially the SAFETY RULES), then `docs/testing/e4c-selectors.md` in full (especially
"Scenario `trust-safety`" and the test hooks), the harness README and the E4b scenario as the
pattern (`harness/scenarios/e4b-money.ts`, `harness/src/money*.ts`, `harness/src/web/selectors.ts`,
`harness/tests/web.test.ts`). Do not look outside the repository.

**SAFETY RULES (repeated; absolute):** never obtain, generate, download, describe or handle real
CSAM, NCII or other illegal material, and never search for it. The scenario streams and uploads
**only the synthetic fixtures** in `packages/moderation/fixtures/` (`t0-pattern.png`,
`t0-ncii-pattern.png`, benign patterns) and generated clips, and drives T1/T2 only through the
**scripted classifier** (`PUT /internal/moderation/script`). Never download or embed industry hash
lists. The scenario's reports must not contain image bytes or account emails.

## You own (write only these)

- `harness/scenarios/trust-safety.ts` (new), `harness/src/safety*.ts` (new),
  `harness/src/web/selectors.ts` (add the e4c ids), `harness/src/env.ts` (only optional variables
  the scenario needs, e.g. `DATABASE_URL` for the DB-refusal checks and the role CLI),
  `harness/tests/safety*.test.ts`, `harness/tests/web.test.ts` (parse
  `docs/testing/e4c-selectors.md` like the other docs), `harness/README.md` (the scenario's section,
  including the env it needs: fixture lists mounted, `MODERATION_CLASSIFIER=scripted`,
  `MODERATION_SAMPLE_SECONDS=2`, `MODERATION_TEST_HOOKS=true`, and the compose override the user
  applies — write the override as `harness/compose.trust-safety.yaml` and own it).

## Contracts you must honor (read-only for you)

- The spec's seven steps, routes and test ids; `moderation.*`, `ncii.*`, `appeals.*`,
  `channels.uploadUrl`/`commitUpload`, `admin.expediteDeletion`, `me.deletion.get`,
  `playback.start` (`MATURE_GATE`), `UPLOAD_REJECTED`; `INTERNAL_ROUTES.moderationScript` and
  `nciiTick` with `INTERNAL_SECRET_HEADER`; the role CLI (`bun packages/db/src/roles/cli.ts
  <username> <role>` with `DATABASE_URL`) for `legal` ×2, `moderator`, `admin`.
- The services are being built in parallel (units B–E). Code against the spec and contract types;
  unit tests cover the pure parts. The user runs the scenario live.

## Build

1. The scenario with steps individually selectable (`--set steps=1,2,5`) and `--set via=api`
   (no browser) vs the default (web flows too), fresh accounts per run.
2. Step 1 T0 live (ffmpeg loops `t0-pattern.png` to the ingest; the off-air deadline is
   `2 × MODERATION_SAMPLE_SECONDS + 5 s`; then a republish with the same key is refused); step 2
   evidence survives deletion (including the app-role DB refusal checks: deleting the evidence row,
   the hold or the draft fails); step 3 two-reviewer dismissal; step 4 T2 label and appeal; step 5
   T1 blur, queue, clear (history shows the system and moderator rows); step 6 upload rejected and
   nothing under `channels/<E>/avatar/`; step 7 the NCII clock via `nciiTick` and the re-upload of a
   removed clip's first frame as a panel rejected.
3. Log hygiene after every step: grep the services' captured logs (the harness's existing log
   capture or `podman logs` per the README's conventions) for the fixtures' bytes in base64 and the
   test accounts' emails; any hit fails the step.
4. Report rows like the other scenarios (ids, timings, statuses; no emails).

## Tests you must add

- Unit: step selection parsing, deadline arithmetic (±5 s windows), the log-hygiene matcher (finds
  base64 of a fixture and an email, ignores ids), selector doc parsing for e4c.

## Done means

See `_common.md` "Done means". Your package: `harness` (`bun run test`, `tsc`), lint/fmt on
changed paths. Final message: the exact commands for the user to run the scenario.
