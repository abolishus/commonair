<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# seed-safety: reports, cases, appeals, enforcement, DMCA, legal, integrity, incidents and data requests

You are implementing unit seed-safety for CommonAir (repo: /Users/joshe/Repos/bcon).

Read these first:

- AGENTS.md, PLAN.md and docs/architecture.md.
- `.claude/briefs/seed-full/README.md` and `.claude/briefs/seed-full/common.md`. common.md has the
  shared rules, the read-only contract and the tests every unit adds, and all of it applies here.

Do not look outside the repository.

- Branch: `seed/safety`, from `main` after seed-social merges.
- Wave 1. At run time you depend on `social` and `media`, because clips and VODs are the subjects
  of reports, labels and DMCA items.

## You own (write only these)

- `harness/src/seed/safety.ts`, `harness/src/seed/safety/**`
- `harness/tests/seed/safety*.test.ts`

## Contracts you must honor (read-only for you)

- `harness/src/safety*.ts`: `ModerationHooks`, `FixturePublisher`, `readFixture`, `newStreamer`,
  `waitClip`, and the staff helpers.
- The synthetic hash fixtures the trust-and-safety scenario already uses. Use only those: no other
  imagery, ever.
- `MODERATION_TEST_HOOKS`, the scripted classifier and `OPS_TEST_HOOKS`.
- The safety, legal, DMCA, appeals, integrity, incidents and data-request procedures in
  `@commonair/contracts`.
- `store.extra.media`: the VOD and clip ids by channel. Send seed-media a cross-unit request for the
  exact key and shape if its brief doesn't already publish what you need.

## Build

Almost everything here is protected. Drive it through the API as the right role: `mod`, `admin`,
`legal`, viewer2, `banned`, or the anonymous public forms.

1. **Reports to cases.**
   - Reports from many bulk viewers against chat lines, channels and clips.
   - Cases in each state: open, in review, actioned and dismissed.
   - `moderation_flags` from the scripted classifier. `mod_actions` and `content_labels` come from
     the moderators' decisions.
   - viewer2 files one report.
2. **Hash path.**
   - A case created by a synthetic hash match (`hash_match_results`, `local_hash_list`,
     `evidence_objects`, `evidence_audit_runs`), using the scenario's fixtures and hooks exactly.
   - A draft `ncmec_reports` row for `legal` to review. No submission ever leaves the stack: the
     adapter default is the FOSS no-op, so confirm it and refuse to run if a real reporter is
     configured.
3. **NCII.** `ncii_requests` and items through the public takedown form, in pending and resolved
   states.
4. **Enforcement.**
   - `banned` is suspended through `account_actions`, with an `enforcement_statements` row and its
     deliveries.
   - viewer2 has a lesser action.
   - Both appeal: `banned`'s appeal is pending, and one of viewer2's is decided.
   - `mod` has more pending appeals from bulk users.
5. **DMCA.**
   - Notices through `/dmca`'s API, against seeded clips and VODs: items in each state.
   - viewer2 receives a notice and files a counter-notice.
6. **Integrity.** `integrity_flags` from the path the integrity scenario uses (fake viewers and
   view-botting). If that path can only run during a live stream, take the flags from a run during
   seed-media's recording window (a cross-unit request), or leave the table pending with a request
   for an `OPS_TEST_HOOKS` entry.
7. **Legal and incidents.**
   - `legal` places a legal hold on a case.
   - `admin` opens incidents: one resolved, one ongoing.
8. **Data requests.**
   - viewer1 requests a data export, which completes through the worker.
   - A bulk viewer (never a fixed login) requests account deletion and stays pending, because the
     grace period has not passed. Note which account it is.

## Tests you must add

- The tests in common.md.
- Every case, appeal, DMCA item and NCII state appears at `small`.
- The run refuses a non-default NCMEC adapter.
- Nothing personal reaches the append-only columns: case notes and statement text use fixed
  template text, not user free text. Assert this in the int test, if any direct writes remain.

## Routes you fill

- `/admin/moderation`, `/admin/appeals`, `/admin/integrity`, `/admin/dmca`, `/admin/incidents`
- `/admin/legal`, visited as `legal`
- `/settings/appeals` and `/settings/copyright`, visited as viewer2
- `/transparency`: the enforcement counts
- `/dmca` and `/takedown`: no data, but no errors either

## Done means

The "Done means" section of common.md, plus every test hook the run needs.
