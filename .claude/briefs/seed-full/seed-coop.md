<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# seed-coop: memberships, governance, proposals, votes, elections, council and patronage

You are implementing the seed-coop unit for CommonAir (repo: /Users/joshe/Repos/bcon).

Read these first:

- AGENTS.md, PLAN.md and docs/architecture.md.
- `.claude/briefs/seed-full/README.md` and `.claude/briefs/seed-full/common.md`. common.md holds the
  shared rules, the read-only contract and the tests every unit adds. All of it applies here.

Do not look outside the repository.

- Branch: `seed/coop`, from `main` after seed-social merges.
- Wave 1. At run time you depend on `social` and `money`, so build against seed-money's published
  keys.

## You own (write only these)

- `harness/src/seed/coop.ts`, `harness/src/seed/coop/**`
- `harness/tests/seed/coop*.test.ts`

## Contracts you must honor (read-only for you)

- `harness/src/coop-actors.ts`: `ApiCoop` / `CoopDriver`, `apiMembership`, `sharesByStatus`.
- `harness/src/coop.ts`, which provides:
  - `E5_GOVERNANCE_BOOTSTRAP` and `preflightGovernance`;
  - `governancePeriods`, `councilSize` and `choosePatronagePeriod`;
  - `qualifyingTier` and `minSubscriptionCents`;
  - `expectedTally`, `leaksIn` and `rowLeaks`.
- `harness/src/coop-db.ts` and `harness/src/coop-io.ts`.
- `COOP_TEST_HOOKS` (short governance periods).
- The co-op procedures in `@commonair/contracts`.
- `store.extra.money`: `subscriptionsByUser`, `revenuePeriod`, `paidCreators`.

## Build

Every row in this unit is protected, so all of it goes through `ApiCoop` and the worker. Never use
direct inserts.

1. **Governance.**
   - Check `COOP_TEST_HOOKS` first.
   - Bootstrap the settings the way the co-op scenario does, so `governance_settings_history` gets
     a few real changes.
   - `admin` approves the `governance_applications`: some approved, one pending, one rejected.
2. **Memberships and shares.**
   - member1 holds shares in every class it qualifies for.
   - council1 and council2 are streamer-class members.
   - About 30% of the bulk viewers who qualify (from money's subscriptions) become viewer members.
   - Share purchases go through the share checkout. Some are pending and one is redeemed or
     cancelled, if the lifecycle allows it.
   - `membership_history` follows from these.
3. **Proposals.** Cover every status in `PROPOSAL_ORDER`:
   - draft: member1's, published as `draftProposalId`;
   - discussion, with `proposal_comments` from several members;
   - voting, with votes cast across classes;
   - passed and failed, both tallied;
   - a streamer-majority failure (`STREAMER_MAJORITY_NOT_MET`).

   Use the shortest periods that the test hooks allow, and run proposals in parallel so the whole
   unit stays within its 5-minute budget. Publish one fully tallied proposal as `proposalId`.
   `expectedTally` must match the tallies.

4. **Council and board.**
   - A council term with council1 and council2 among `councilSize` members.
   - `council_responses` to the open proposals.
   - An election with candidates (council1 among them), ballots cast, and one completed election.
   - `board_seats` filled.
5. **Patronage.**
   - Run one patronage period over `money.revenuePeriod` (`choosePatronagePeriod`) to close, so
     `patronage_inputs` and `patronage_allocations` exist and member1 has an allocation.
   - Publish the closed period as `patronagePeriodId`.
   - If the period rules make a closed period impossible within the budget, close it as far as the
     hooks allow and record the gap in `notes`.
6. **Privacy check.** Run `leaksIn` / `rowLeaks` over the audit and event rows you caused. Ballot
   choices, comment bodies and emails must not leak.

## Tests you must add

- The tests in common.md.
- Every proposal status, the streamer-majority failure, an election in each state, and a pending
  application each appear at `small`.
- The planned votes give the planned tallies (`expectedTally`).
- Electorate eligibility follows `qualifyingTier` / `minSubscriptionCents`.

## Routes you fill

- `/coop/`, `/coop/membership`, `/coop/council`, `/coop/settings`.
- `/coop/proposals/` and `/coop/proposals/new`.
- `/coop/proposals/$id/` (`proposalId`) and `/coop/proposals/$id/edit` (`draftProposalId`).
- `/coop/patronage/` and `/coop/patronage/$periodId` (`patronagePeriodId`).
- `/admin/coop`.
- The co-op section of `/transparency`.

## Done means

common.md "Done means", and report the wall-clock time at `small`.
