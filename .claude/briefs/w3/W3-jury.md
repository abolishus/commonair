<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W3-jury: advisory member audit jury

You are implementing unit W3-jury for CommonAir (repo: /Users/joshe/Repos/bcon). Read these first:

- AGENTS.md, PLAN.md and docs/architecture.md.
- `.claude/briefs/batch7/README.md`. Decisions (h), (s), (u), (ac), the path ownership and the
  shared rules are binding.
- `.claude/briefs/w3/contract-step.md`:
  - §2.1 `JURY_*`
  - §2.2 the `jury.*` governance settings
  - §2.4 `jury.*`
  - §3.1–3.2 the jury tables and their protections
  - §4.1 `packages/draw`
  - §6 the `coop.jury` route and the transparency slot
- `docs/product/feature-wins.md` §4.7 (Wave 3 jury) and the debate log, item 2.
- ADR 0038 (written by the contract step).
- ADR 0019 (statements of reasons and `rule_ref`).
- ADR 0004 (governance enforcement).
- `docs/testing/b7-selectors.md` and `.claude/briefs/_done-means.md`.

Do not look outside the repository. This is **wave 1**: work in your own git worktree on branch
`w3/jury`, cut from the contract step's sha.

## Why

Members should be able to see whether platform moderation matches the rules they voted for,
without becoming moderators. Each month a small, randomly drawn panel of opted-in adult members
reviews a sample of closed cases. Its agreement rate per clause is published. A case most jurors
disagree with goes back to staff for a second look. The jury is advisory: DSA and OSA duties
cannot be delegated, so it never changes an outcome.

## You own (write only these)

- `services/api/src/jury/**`, `services/api/src/routes/jury.ts`
- `services/worker/src/jury/**`, `services/worker/src/jobs/jury-*.ts`
- `apps/web/src/routes/_app/coop.jury.tsx` (content), `apps/web/src/components/jury/**`,
  `apps/web/src/components/transparency/jury*` (fill `jury-results.tsx`)
- `apps/web/src/i18n/locales/{en,es}/w3-jury.json`, `keys/w3-jury.gen.ts`
- `harness/src/w3/jury.ts`, `harness/tests/w3/jury*`

**Read-only:**

- `packages/draw/**`
- `packages/db/src/schema/{coop,moderation,safety}.ts`
- `services/api/src/transparency/**`, for the k-suppression helper (reuse it; do not copy it)
- `apps/web/src/components/safety/**`, for the blur pattern
- `packages/{contracts,db,config}/**`

Anything else is a **contract request**.

## Contracts you must honor

- **Procedures:** `jury.{optIn, optOut, status, panel, cases, vote, results}` and `jury.flags.list` (admin).
- **Settings:** `jury.enabled` (seeded false), `jury.panelSize` (7), `jury.casesPerPanel` (20).
- **Rules:** `JURY_RULES`, `JURY_VOTES`, `JURY_REASON_CODES`.
- **Tables:** `jury_optins`, `jury_panels`, `jury_seats`, `jury_cases`, `jury_votes`, `jury_flags`.
  Their protections:
  - a seat needs an active membership, no staff role and a live opt-in;
  - only seats vote;
  - no T0, NCII, legal-hold or `watch_room` cases;
  - the commitment and reveal rules hold;
  - votes are append-only.
- **Jobs and events:** `JURY_JOBS.{draw, close}`; `jury.panel.drawn` (internal).
- **`packages/draw`:** `commit`, `verifyReveal`, `draw`, `pseudonym`.
- **Moderation statuses:** `moderation_cases.status` closed set `cleared | actioned | dismissed | confirmed`
  (`labelled` counts as open, per the unique index at `moderation.ts:79`). `reports.status` is
  `actioned | dismissed`.

## Build

1. **Opt-in.** Any active adult member can opt in from `/coop/jury`. The opt-in text explains what
   jurors see, that media is blurred until revealed, and how to opt out. Opting out takes effect
   from the next panel. While `jury.enabled` is false, the page explains that the co-op has not
   turned the jury on.
2. **Draw** (the monthly `jury-draw` job; also a harness hook).
   - **Seed commitment.** Generate a seed and write its commitment to `jury_panels` and to an
     `audit_log` row before anything is selected.
   - **Eligible pool.** Opted-in users with an active membership (the electorate query in
     `0002_protections_hardening.sql:340-348` is the model). Exclude staff, banned users,
     suspended users and deleted users.
   - **Seats.** Draw `panelSize` seats with `draw` over the pool, sorted by user id.
   - **Case sample.** From the last 30 days, take closed T1/T2 cases and resolved reports. Exclude:
     - T0 cases;
     - NCII cases;
     - anything with an active legal hold on the subject;
     - `watch_room` reports;
     - any case whose subject or reporter is a minor, from `birth_date`.

     Draw `casesPerPanel` cases with the same seed and a domain separator.

   - **Conflicts.** For a juror who moderates a sampled case's channel, or who is a party to the
     case, skip that case for that juror. Do not reseat them.
   - **Pseudonyms.** Store a per-panel `pseudonym_map` so jurors see stable pseudonyms, never
     usernames. Reporters are never shown.
   - **Reveal.** Reveal the seed when the panel closes (the `jury-close` job, 14 days later). That
     writes an audit row too. All audit rows reference ids only.
3. **Juror view.**
   - **Case card.** Each case shows the clause title and version (`rule_ref` → the API's clause
     title), the action taken, and whether it was automated or human. It shows the evidence the
     case kept: text excerpts, and media blurred by default with a per-item reveal and a content
     warning.
   - **Vote.** Agree, disagree or unsure, plus a reason code from `JURY_REASON_CODES`. There is no
     free text, because votes are append-only and free text is personal data.
   - **Access.** Keyboard navigable, reduced motion respected, and the blur works with
     `prefers-reduced-transparency`.
4. **Results and flags.**
   - **Results.** At close, compute agreement per clause and tier. Cells under k = 10 votes are
     suppressed (reuse the transparency suppression helper). `jury.results` is public, and
     `jury-results.tsx` renders it on `/transparency`, with the period, panel size and the
     revealed seed.
   - **Flags.** A case where a majority of its votes disagree gets a `jury_flags` row and an audit
     row. `jury.flags.list` shows it to staff with a link to the case.
   - **No outcome change.** No code path reverses or edits an outcome. Add a test that asserts it.

## Tests you must add

- **Unit:**
  - sampling filters (each exclusion, the minor rule, the 30-day window edges);
  - conflict skips;
  - k-suppression at 9, 10 and 11;
  - majority-disagree at a tie and at an even split;
  - pseudonym stability within a panel and difference across panels.
- **Integration:**
  - **Draw determinism.** The same seed and the same pool give the same seats and cases.
  - **Commitment.** It is written before selection, and a wrong reveal is refused by the trigger.
  - **Refusals.** A non-member, staff or non-opted-in seat is refused by the trigger. A vote from a
    non-seat is refused. A T0, NCII or legal-hold case is refused as a `jury_cases` row.
  - **`jury.enabled` false.** No panel is drawn.
  - **Outcomes.** A flag never changes `moderation_cases` or `reports`.
- **Web unit:**
  - the opt-in states;
  - the case card blur and reveal;
  - vote submission;
  - the results table's suppressed cells.
- **Harness `e5-coop` extension step `jury`:**
  1. Set `jury.enabled` true (governance setting through the existing path).
  2. Opt in 12 members.
  3. Seed closed T1/T2 cases and reports, plus one T0 case and one NCII case.
  4. Run the draw hook.
  5. Jurors vote.
  6. Close.
  7. Assert: the results are published with suppression; a majority-disagree case is flagged; no
     T0 or NCII case was sampled; the seed matches the commitment.

## Done means

Follow `.claude/briefs/_done-means.md`:

- `bun run test` and `test:int` in `services/api` and `services/worker` (one at a time).
- `bunx tsc -p` for each.
- `bun --bun vp test run` in `apps/web` and `harness`.
- `vp build` in `apps/web`.
- `vp lint --deny-warnings` and `vp fmt` on your files.
- The i18n check.
- `reuse lint`.
- `git status` shows only your paths. Commit with `git commit -s`.

Send the privacy text for jurors as a contract request (a draft, not reviewed by counsel).

Then tell the user to run `bun harness/src/cli.ts run e5-coop --set w3=jury`, and to check
`/coop/jury` and the transparency results by hand under `en`, `es` and `en-XA`, at 320 px, dark
and light, keyboard only.
