<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# E7: platform debts

**Goal.** Every API procedure outside PLAN 3C/3D answers, and the follow-ups E4c and E5 left
are closed, so nothing a user can reach returns 501 except the developer platform and
interactivity (E9, E8).

## Stubs in scope (18 handlers, all `.handler(notImplemented)`)

| Procedure                                       | Where                                        | Builds on                                                                                                                                                                |
| ----------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chat.send`, `chat.deleteMessage`, `chat.clear` | `services/api/src/routes/chat.ts:224-226`    | the chat service already does all three over WS (`services/chat/src/moderation.ts`, `commands.ts`): the HTTP routes publish to it on the bus rather than duplicate rules |
| `chat.held.list`, `chat.held.resolve`           | `chat.ts:515-516`                            | held state in `chat_messages` (`packages/db/src/schema/chat.ts:28`); unblocks Mod Circles                                                                                |
| `safety.dmca.submit/counter/queue/action`       | `services/api/src/routes/safety.ts:480-483`  | `dmca_notices`, `dmca_counter_notices`, `DmcaNotice` contract, DMCA email templates                                                                                      |
| `integrity.flags`, `integrity.decide`           | `services/api/src/routes/integrity.ts:10-11` | `integrity_flags`, worker integrity jobs. `channelSummary` stays for W2-rollup-analytics                                                                                 |
| `admin.egress`                                  | `services/api/src/routes/admin.ts:19`        | `egress_samples` (`schema/media.ts:121`), `EgressReport`                                                                                                                 |
| `admin.incidents`                               | `admin.ts:77`                                | `incidents` (`schema/safety.ts:332`)                                                                                                                                     |

Plus `appeals.create` for kinds `dmca` and `account` (`services/api/src/routes/appeals.ts:20`):
`dmca` points to the counter-notice; `account` needs an `account_actions` table (contract step).

## Follow-ups in scope

- E5 (HANDOFF.md:40-46, ADR 0020): explicit viewer rejoin; the co-op pages retry instead of a
  skeleton forever on a failed load; index the membership view's streaming-hours query;
  board-election UI beyond read-only. Stripe shares and patronage payout go to M1.
- E4c/E2: overturning a moderation appeal lifts the ban (today it records the decision only);
  `ncii-hash` hashes `broadcast` items (PROGRESS.md "E4c"); `vods.broadcast_id` index.
- Legal: `LegalDocument.requiresAcceptance` so clients stop sending every id; a retention job for
  anonymous consent rows.
- Open contract requests (HANDOFF.md:443): `CidrClassifier` `size` getter, `WordFilter` DTO
  `invalid`/`invalidReason`, `appeals.create` on the `write` bucket, `ISSUANCE_KEYS` into contracts.
- `services/tracker/src/ip.ts` helpers move into `@commonair/service`.

## Contract step (orchestrator)

`account_actions` table + migration, the four contract requests, `requiresAcceptance`, the
`vods.broadcast_id` index, `dmca.*` events in the outbox catalog, selectors doc
`docs/testing/e7-selectors.md` (DMCA form and queue, held-message queue, egress and incidents
admin pages).

## Units

| Unit         | Owns                                                                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E7-chat-http | `services/api/src/routes/chat.ts` (stubbed handlers), `apps/web/src/components/mod/held-queue*`                                                          |
| E7-dmca      | `services/api/src/routes/safety.ts` (dmca section), `services/api/src/dmca/**`, `apps/web/src/routes/_app/dmca*.tsx`, `_admin` DMCA page, DMCA email use |
| E7-admin     | `routes/admin.ts`, `routes/integrity.ts` (`flags`, `decide`), `apps/web/src/routes/_admin/{egress,incidents,integrity}*`                                 |
| E7-appeals   | `routes/appeals.ts`, `services/worker/src/moderation/**` (lift on overturn, broadcast hashing)                                                           |
| E7-coop      | `apps/web/src/routes/_app/coop.*`, `services/api/src/coop/**` (rejoin, election UI, retry, index use)                                                    |
| E7-legal     | legal routes and consent retention job                                                                                                                   |

DMCA is a legal process: the notice form fields, counter-notice waiting period and restore
rules follow 17 U.S.C. § 512 and the operator template in `docs/operators/`; record that a
lawyer has not reviewed them.

## Harness

- `trust-safety`: a DMCA notice takes a clip down, a counter-notice restores it after the
  waiting period (test hook shortens it), the audit log shows each step; an overturned appeal
  lifts the ban.
- `e2e-social`: a word filter holds a message, a moderator allows it, viewers then see it.
- `e5-coop`: an exited subscription-only viewer rejoins.

## Done means

`grep -c '.handler(notImplemented)' services/api/src/routes/*.ts` shows only interact, bot,
developer and `integrity.channelSummary`; the three scenarios pass; verify green.
