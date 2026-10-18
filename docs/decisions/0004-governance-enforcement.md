<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0004: Database-enforced governance and ledger integrity

- Status: accepted
- Date: 2026-10-18

## Context

The co-op's rules say the platform cut, patronage formula, payout rules, membership classes and
the protections themselves change only by a protected decision: a member-wide supermajority AND
a majority within the streamer class, after creator-council review. "The system enforces these
rules; they cannot be bypassed by an admin." The ledger must be append-only double-entry.

An application-level check alone cannot meet that bar: any admin endpoint, script or bug with
write access could skip it. A review of the first draft proved several bypasses (temp-table
`search_path` shadowing, moving a passed proposal back to draft and re-targeting it, replaying
an old decision, TRUNCATE, amending committed ledger transactions).

## Decision

Enforce in Postgres triggers (`packages/db/drizzle/0001_protections.sql`), designed against an
attacker who holds ordinary DML (and TEMP) on every table but does not own the tables:

1. **Pinned `search_path`** (`pg_catalog, public, pg_temp`) and schema-qualified tables in every
   function, so temporary tables cannot shadow real ones.
2. **Proposal state machine**: `draft → discussion → (council_review →) voting → passed|rejected`,
   `passed → applied`, withdrawal only before voting. Proposals are inserted only as drafts.
   Content (title, body, author, changes, kind) freezes when review or voting begins; timeline
   fields are set only by the trigger using `clock_timestamp()`. Discussion, council review and
   minimum voting durations come from governance settings. Creator-affecting proposals (every
   protected one) must complete council review before voting.
3. **Electorate built by the database** from active memberships when voting opens; nobody can
   insert electorate rows directly.
4. **Votes** only from the electorate, only inside the wall-clock window (`clock_timestamp()`, so a
   transaction opened before the deadline cannot vote after it), never deleted, every cast or
   change copied to `vote_history`.
5. **Settings change only by applying a passed proposal, exactly once**: the settings trigger
   re-tallies the proposal from raw votes and the frozen electorate under its frozen rules,
   checks the change matches the proposal, and records `(proposal, key)` in
   `governance_applications` (primary key ⇒ once). A proposal becomes `applied` only after all
   its changes were applied. Protected keys need a protected proposal; the protected flag is
   derived from `governance.protections.protectedKeys`, never chosen, and
   `governance.protections` is shape- and range-checked so it cannot lock out future votes.
6. **Ledger**: append-only (row and TRUNCATE triggers); entries only in the database transaction
   that created their ledger transaction (txid check); non-zero amounts; balanced per currency
   at commit; account owners may be cleared (pseudonymization) but never reassigned.
7. **History tables** (`governance_settings_history`, `vote_history`, `membership_history`,
   `governance_applications`, `proposal_electorate`) are written only by `SECURITY DEFINER`
   trigger functions owned by the migration owner (not executable by PUBLIC); their guards
   check table ownership, not trigger depth (a caller can raise `pg_trigger_depth()` with its
   own temp-table trigger). The app role holds no write privilege on them at all.
8. **Fail closed**: rule snapshots must be well-formed (typed numbers and booleans) and the
   tally treats anything missing as failing. `governance.protections` and `governance.ordinary`
   are type- and range-checked (periods ≤ 90 days, quorums ≤ 0.5) so no decision can lock out
   future decisions.
9. **Applying is all-or-nothing**: every change and the `applied` status in one transaction
   (deferred check), refused if the key changed after the proposal's vote opened.
10. **Votes take a share lock** on the proposal, so the outcome waits for in-flight votes.
11. The ledger balance is checked at commit per transaction and per entry, so
    `SET CONSTRAINTS ALL IMMEDIATE` cannot fire it early.

Deployment requirement: the application connects as a role that does not own the tables;
migrations run as the owner, which then calls `commonair_configure_app_role('<role>')` to grant
DML on ordinary tables and nothing on history tables (compose and the self-hosting guide do
this). Integration tests run the protections as such a role (`createTestDatabase().app`).
Hardening landed in `0002_protections_hardening.sql` after a second review.

## Residual risk

A role with unrestricted DML can still fabricate the _facts_ the rules are computed from:
create memberships before a vote opens, or overwrite a voter's choice while voting is open.
Both leave append-only history rows (`membership_history`, `vote_history`) that the transparency
page and auditors can examine. Superusers and table owners can disable triggers; operators must
not run the application as either. Signed ballots and per-voter receipts are possible future
hardening.

## Consequences

- Test instances use `GOVERNANCE_BOOTSTRAP_JSON` (first-run only) for short periods.
- Personal data must never be written into append-only columns (ledger descriptions, memos,
  metadata, audit details): reference users by id so deletion can pseudonymize without rewriting
  history.
