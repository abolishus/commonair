<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0038: The advisory member jury

- Status: proposed (maintainer to accept; see [Decisions at acceptance](#decisions-at-acceptance))
- Date: 2026-11-01 (code checked at `3bb7af9b`)
- Gates: W3-jury ([batch 7 contract step](../../.claude/briefs/w3/contract-step.md) §2.1, §2.2,
  §2.4, §3.1, §3.2, §4.1; [brief](../../.claude/briefs/w3/W3-jury.md))

**No counsel retained; listed for post-launch review.** Exposing members to moderated content, and
whether an advisory jury needs anything more under the DSA and the OSA, were decided by the
maintainer with the conservative defaults below (decision (h)) and are listed under "Post-launch
review" in the batch 7 README. This is not legal advice.

## Context

Feature-wins §4.7 plans, for wave 3, "an advisory member audit jury that samples closed T1/T2 and
report cases (never T0), blurred by default", drawn with a seed committed to `audit_log`. Debate
log item 2 settled binding versus advisory: finance wanted binding outcomes; T&S argued that the
platform's DSA and OSA duties cannot be delegated to members. The jury is advisory; binding
outcomes are parked.

What exists at `3bb7af9b`:

- **Membership and the electorate** (E5): the electorate query in
  `packages/db/drizzle/0002_protections_hardening.sql:340-348` defines an active member.
- **Closed cases.** `moderation_cases` closes as `cleared`, `actioned`, `dismissed` or `confirmed`
  (`labelled` is still open, per the unique index at `packages/db/src/schema/moderation.ts:79`).
  Reports resolve as `actioned` or `dismissed`. Statements of reasons carry a `rule_ref`
  (ADR 0019), which maps a case to a clause of the published rules.
- **Transparency** already publishes enforcement counts with k-suppression and complementary
  suppression (`services/api/src/transparency/enforcement.ts`).
- **Governance settings** distinguish ordinary from protected settings (ADR 0004); members vote
  ordinary settings on through the existing proposal path.
- No jury code or tables exist.

## Decisions

### 1. Advisory only: the jury never changes an outcome

The jury reviews; staff decide. No code path that the jury drives updates `moderation_cases`,
`reports`, account actions or statements of reasons. A case that a majority of its jurors disagree
with gets a `jury_flags` row and an `audit_log` row, and appears in the admin `jury.flags.list` for
staff re-review through the existing paths. W3-jury carries a test that a flag leaves every
outcome table unchanged.

**Why.** The platform's DSA and OSA duties (statements of reasons, appeals, timeliness) belong to
the platform and cannot be handed to a randomly drawn group. An advisory jury still tells members,
in public, whether moderation matches the rules they voted for.

### 2. Off until the co-op turns it on

The governance setting `jury.enabled` is ordinary and seeded `false`; members vote it on. While it
is false the monthly draw does nothing and `/coop/jury` explains that the co-op has not turned the
jury on. `jury.panelSize` (7) and `jury.casesPerPanel` (20) are ordinary settings too; their
defaults are `JURY_RULES` in `packages/contracts/src/enums.ts`.

### 3. Who can sit

A juror is a user who, at draw time:

- has a live opt-in (`jury_optins`, opted in and not opted out; opting out takes effect from the
  next panel);
- has an active membership (the electorate's definition);
- is an adult (18 or over by `users.birth_date` on the draw date; unknown age is not eligible);
- holds no staff role (any platform role other than `user`: `moderator`, `admin`, `treasurer`,
  `legal`);
- is not banned, suspended or deleted.

A trigger on `jury_seats` refuses a non-member, a staff account and a user without a live opt-in,
so a bug in the draw cannot seat them (AGENTS.md rule 9).

**Per-case conflicts.** A juror who moderates the channel of a sampled case, or who is a party to
it (the subject, the reporter, or the actor), is not shown that case. They keep their seat; the
case simply has one fewer juror.

### 4. Drawing the panel and the sample

Once a month the `jury-draw` job draws one panel with the fair draw of
[ADR 0039](0039-fair-draws-predictions-raids.md) decision 1:

1. Generate a 32-byte seed; write `seed_commitment = SHA-256(seed)` to `jury_panels` and an
   `audit_log` row **before** anything is selected.
2. Seats: `draw(seed, pool, panelSize)` over the eligible pool sorted by user id, with the domain
   separator for seats.
3. Cases: `draw(seed, candidates, casesPerPanel)` over the candidate list sorted by
   `(subject kind, subject id)`, with the domain separator for cases.
4. Write `jury.panel.drawn` (internal; audit only) and the seats and cases.

The panel closes after 14 days (`jury-close`), which reveals the seed: the trigger accepts it only
if its SHA-256 equals the stored commitment, and the reveal writes another `audit_log` row. Anyone
can then re-run the draw from the published seed. Audit rows reference ids only.

**What can be sampled** (closed in the last `JURY_RULES.sampleDays`, 30):

- T1 and T2 moderation cases closed as `cleared`, `actioned`, `dismissed` or `confirmed`;
- reports resolved as `actioned` or `dismissed`.

**What is never sampled:** T0 cases; NCII cases; any case whose subject is under an active legal
hold; `watch_room` reports (ADR 0017: room content stays with platform moderation); anything
whose subject or reporter is a minor by `birth_date`. A trigger on `jury_cases` refuses T0, NCII,
legal-hold and `watch_room` rows; the minor rule is applied by the sampler.

### 5. What a juror sees

- **The clause** (title and version from the case's `rule_ref`), the action taken, and whether it
  was automated or human.
- **The kept evidence**: text excerpts, and media **blurred by default**, revealed per item behind
  a content warning. The blur respects `prefers-reduced-transparency` and `prefers-reduced-motion`.
- **Pseudonyms, never usernames.** Each panel has a `pseudonym_map` (server-side only) so a juror
  sees stable names within the panel and different ones across panels.
- **Never the reporter.**

### 6. Votes

A seat votes once per case: `agree`, `disagree` or `unsure` (`JURY_VOTES`), with one reason code
from the fixed `JURY_REASON_CODES`. There is **no free text**: votes are append-only (a trigger),
and free text would be personal data in an append-only table (ADR 0004). A trigger refuses a vote
from anyone who does not hold a seat on that case's panel.

### 7. Publication and re-review

At close, agreement is computed per clause and tier and published through the public
`jury.results({period})` and on `/transparency`, with the period, the panel size and the revealed
seed. Any cell with fewer than `JURY_RULES.k` (10) votes is suppressed, using the transparency
suppression helper (not a copy), complementary suppression included.

A case is flagged for re-review when its `disagree` votes are **more than half** of the votes cast
on it (`unsure` counts as cast; a tie is not a majority).

## Consequences

- Members get a recurring, public, reproducible check of moderation against the rules, without
  becoming moderators and without any power to overturn a decision.
- With k = 10 and seven jurors, a single panel publishes few cells; most figures appear only once
  several panels' votes for a clause add up. That is the price of not exposing individual votes.
- Jurors see moderated content, blurred by default. The opt-in text says so, and the content
  classes most likely to harm (T0, NCII) are never sampled.
- The trust guarantee is the commit-reveal draw: the platform cannot choose who sits or which
  cases are sampled after the commitment is written, but it does hold the seed until close (see
  ADR 0039 decision 1).

## Alternatives considered

- **A binding jury.** Rejected (debate log item 2): DSA and OSA duties cannot be delegated.
- **Volunteers choose their cases.** Rejected: self-selection skews the sample and invites
  brigading.
- **Free-text reasons.** Rejected: append-only personal data; reason codes are enough to aggregate.
- **Include T0 and NCII with stronger blurring.** Rejected: no blur makes exposing members to that
  material acceptable, and their outcomes are not a matter for member review.

## Decisions at acceptance

For the maintainer. Each item is the recommended default; accepting this ADR accepts them.

1. **Advisory (u):** the jury never changes an outcome; a majority disagree only flags the case for
   staff re-review, with an audit row.
2. **Off by default:** `jury.enabled` seeded false, an ordinary setting the co-op votes on.
3. **Seats:** 7 a month from opted-in, active, adult members; never staff; conflicts skip the case,
   not the juror.
4. **Sample:** 20 cases from the last 30 days; never T0, NCII, legal hold, `watch_room`, or minors.
5. **Exposure:** media blurred by default, reporters never shown, subjects pseudonymized per panel.
   Post-launch review of jurors' exposure to moderated content.
6. **Votes:** agree, disagree or unsure, with a reason code; no free text; append-only.
7. **Publication:** per clause, k = 10 with complementary suppression; a flag when disagree votes
   are more than half of the votes cast.
8. **Panel length:** 14 days from draw to close and reveal.
