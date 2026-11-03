<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Batch 8 web ↔ harness contract (M1, B8)

The batch 8 units with web surfaces (M1-gifts-refunds, M1-connect, M1-coop-money, B8-server,
B8-web) and the harness extension steps of every batch 8 unit agree on these routes, the
`data-testid` values and the scenario steps (`.claude/briefs/batch8/README.md`, decisions U1–U6
and (a)–(r); contract step §4.3–§4.4). Changing one is a contract change: update this file, the web
app and the scenarios together. `apps/web/tests/selectors.test.ts` checks every id below: an id is
rendered somewhere in web or ui source, or it waits in `PENDING_B8_IDS` until its unit merges (a
pending id already set as a `data-testid` fails, so the list only shrinks).

## Rules

- The batch 7 rules hold (`docs/testing/b7-selectors.md`, "Rules"): tests select by `data-testid`,
  never visible text; numbers on elements are plain integers in `data-*` (cents, seconds,
  counts); every list item carries its entity id (`data-request-id`, `data-transfer-id`,
  `data-user-id`, …).
- Money shown is `<MoneyAmount>`, times are `<RelativeTime>`, and empty lists are `<EmptyState>`
  (AGENTS.md "House primitives"). A destructive or irreversible treasurer action goes through
  `<ConfirmDialog>`, whose confirm button is `confirm-dialog-confirm`.
- Status attributes carry the contract enum value, never a translated label: `data-status` is one
  of `PAYOUT_TRANSFER_STATUSES` or `PATRONAGE_PAYOUT_STATUSES`, `data-state` of a refund request
  is `outstanding`, `unknown` or `resolved`.
- No page shows a Stripe error message, an email or a username where the brief says pseudonym:
  a transfer's failure is its opaque `failure_code`.
- Harness-only hooks (an adapter fault, aging an import or its `finished_at`) live behind
  `INTERNAL_API_SECRET` and the test-hook flags, as in batch 7. A unit that needs one sends it as
  a contract request against `INTERNAL_ROUTES` and `harness/src/platform.ts`.

## Routes

No new route. These pages gain batch 8 surfaces, so `harness/src/seed/routes.ts` is unchanged
(decision (p)).

| Route                                   | What                                                                              | Unit             |
| --------------------------------------- | --------------------------------------------------------------------------------- | ---------------- |
| `/$channel`                             | gains the banner above the header and the channel panels                          | B8-web           |
| `/$channel` (the chat panel)            | the prediction card shows the grace window after `locked`                         | B8-web           |
| `/$channel/giveaways/$giveawayId`       | marks the signed-in caller's own pseudonym on any giveaway (`verify.me`)          | B8-web           |
| `/admin/moderation?tab=<tab>&case=<id>` | reads its tab and selection from the search params; the jury flag list links here | B8-web           |
| the chat replay panel (`chat/replay/`)  | a deep seek keeps the first span                                                  | B8-web           |
| `/treasury`                             | gains the refund requests tab                                                     | M1-gifts-refunds |
| `/treasury`                             | gains the payout transfers tab                                                    | M1-connect       |
| `/coop/membership`                      | "Pay by card" when the instance and `shares.cardPayments` allow it                | M1-coop-money    |
| `/coop/patronage/$periodId`             | a treasurer payout section, and the member's own payout status                    | M1-coop-money    |
| `/import`                               | the Twitch preview gains a checkbox per channel field                             | B8-server        |

`/admin/moderation`'s search params are `tab` (the mod queue's tab values) and `case` (a
moderation case id, or a report id on the report tab), validated with TanStack Router's
`validateSearch`; a selection updates the URL with `replace`. The treasury tabs are
`components/treasury/refund-requests.tsx` and `components/treasury/payout-transfers.tsx`, mounted by
`components/coop/treasury-tabs.tsx` at the contract step (each renders `<EmptyState>` until its
unit fills it).

## Test ids

### Channel page, interact, jury, giveaways and replay (B8-web)

| Test id                | Element and attributes                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `channel-banner`       | The channel banner image above the header (`alt=""`, fixed aspect ratio); absent with no `bannerUrl`      |
| `channel-panels`       | The panels section; absent with no panels                                                                 |
| `channel-panel`        | One panel; `data-panel-index` (0-based, in the channel's order)                                           |
| `prediction-grace`     | The prediction card's grace bet form and countdown; `data-prediction-id`, `data-grace-ends-at` (ISO)      |
| `jury-flag-case-link`  | A jury flag's link to `/admin/moderation?tab=…&case=…`; `data-case-id`                                    |
| `giveaway-verify-mine` | The verify page's mark on the caller's own entry; `data-pseudonym` (the caller's pseudonym, never a name) |
| `replay-span-kept`     | Marker in the replay panel's root once a deep seek kept the first span; `data-spans` (spans held)         |

### Refund requests (M1-gifts-refunds)

| Test id                  | Element and attributes                                                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `treasury-tab-refunds`   | The treasury's "Refund requests" tab (the contract step mounts it)                                                                                              |
| `refund-requests`        | The treasury tab's request list (`<EmptyState>` when empty); each row `data-request-id`, `data-state`. The contract step's stub renders it as an `<EmptyState>` |
| `refund-request-unknown` | A request whose Stripe outcome is unknown; `data-request-id`, `data-payment-id`                                                                                 |
| `refund-request-resolve` | Resolves an unknown request (`refunded` or `failed`); opens a `ConfirmDialog`; `data-request-id`                                                                |

### Payout transfers (M1-connect)

| Test id                  | Element and attributes                                                                                                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `treasury-tab-transfers` | The treasury's "Payout transfers" tab (the contract step mounts it)                                                                                                                                      |
| `payout-transfers`       | The treasury tab's transfer list by payout run (`<EmptyState>` when empty); each row `data-transfer-id`. The contract step's stub renders it as an `<EmptyState>`                                        |
| `payout-transfer-status` | A transfer's status; `data-status` (`PAYOUT_TRANSFER_STATUSES`), `data-reversed-cents`, `data-failure-code` (the opaque code, empty when none; `sending` while a request is in flight or awaiting retry) |

### Co-op money (M1-coop-money)

| Test id             | Element and attributes                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `share-buy-stripe`  | "Pay by card" for a share on `/coop/membership`; shown only when the instance and the setting allow it                             |
| `patronage-payouts` | The period page's treasurer payout list; each row `data-user-id`, `data-status` (`PATRONAGE_PAYOUT_STATUSES`), `data-amount-cents` |
| `patronage-pay`     | Pays the period out (second approver as for write-offs); opens a `ConfirmDialog`; `data-period-id`                                 |

### Twitch import (B8-server)

| Test id               | Element and attributes                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `twitch-import-field` | A channel field's checkbox in the preview; `data-field` (`title`, `description`, `tags`, `language`, `mature`, `category`) |

## Scenarios

Every batch 8 step is an extension of an existing scenario, selected with `--set b8=` and pending
until the unit that implements it merges (`harness/src/b8/steps.ts`: `B8_EXTENSIONS`,
`PENDING_B8_EXTENSIONS`, `B8_EXTENSION_UNITS`). A pending extension runs only when named. An
extension that needs some of the scenario's own steps adds them (`B8_SCENARIO_STEP_PREREQUISITES`).
The contexts each scenario hands its extensions are in `harness/src/b8/kit.ts`.

- **`e4b-money`** (after the W1 and W2 extensions, on the `MoneyExtension`):
  - M1-gifts-refunds (`src/b8/money-refunds.ts`): `gift-window` (a second unpaid gift inside
    `GIFT_PAYMENT_HOURS` is refused with `CONFLICT`); `auto-refund` (a signed local `invoice.paid`
    for an ended subscription produces a refund request, then `charge.refunded` posts it);
    `refund-unknown` (the harness fault hook makes the adapter time out; `refund-request-unknown`
    shows on `refund-requests`, and a signed `charge.refunded` reconciles it); `receipt-email`
    (the receipt lands in Mailpit with its breakdown lines).
  - M1-connect (`src/b8/money-connect.ts`): `connect-transfer` (a payout run pays the seeded
    Express creator, the transfer exists on stripe-mock, and `payout-transfer-status` reads
    `created`); `transfer-reversed` (adds `connect-transfer`; a signed local `transfer.reversed`
    returns the amount to the payable).
  - The ledger balances after each.
- **`e5-coop`** (after the W3 `jury`, on the `CoopW3Extension`; M1-coop-money,
  `src/b8/coop-money.ts`): `share-stripe` (the step turns `shares.cardPayments` on, then a share
  is bought by card on stripe-mock through `share-buy-stripe` and membership is activated);
  `patronage-payout` (an approved period is paid out with `patronage-pay`, manually for one member
  and through Connect for the seeded Express member, and `patronage-payouts` shows both `paid`).
- **`interact`** (after the W3 extensions, on the E8 run): `grace-bet-web` (B8-web: a viewer bets
  within `prediction-grace` and the server accepts it), `giveaway-verify-mine` (B8-web: the
  verify page shows `giveaway-verify-mine` for an entrant and nothing for a non-entrant) and
  `raid-restart-keeps-raid` (B8-server: a raid surge restarted inside its window keeps `raid`).
- **`watch-room`** (B8-player, `src/b8/player.ts`): `edge-sync`: two members on different sources
  sync within today's targets (Chromium under 500 ms, WebKit under 1 s).
- **`twitch-import`**: `field-choices` (B8-server: only the `twitch-import-field` boxes left ticked
  apply), `channel-panels-banner` (B8-web; adds steps 3 and 7: the channel page shows
  `channel-panels` and `channel-banner`) and `import-expiry` (B8-server; adds step 3: a test hook
  ages `finished_at` past 30 days, the Twitch data is cleared, the status and audit row kept).
- **`federation`** (B8-server; adds step 3): `actor-disabled-event`: the peer receives the actor
  `Delete` after a suspension, and the API queued no deliver job itself.
- **`portability`** (B8-server): `incoming-cleanup`: a test hook ages an abandoned import, and
  `portability-incoming-cleanup` deletes its archive.
- **`data-export`** (B8-server, after step 6, on the E6 kit): `giveaway-section`:
  `interact-giveaways.json` holds the caller's own entries and wins, no other pseudonym and no salt.
- **`trust-safety`** (B8-server, around the steps after the W3 `sor-resolve`):
  `sor-staff-action` (a staff action with no moderation case has a `staff_action` statement, and
  its email cites no case) and `lapsed-ban-signin` (a lapsed ban cleared at sign-in writes one
  `channel.suspension {suspended:false}`, never two with the `ban-expiry` sweep).
- **`relay-dvr`** (B8-player, `relay-dvr-switch`): the relay stops mid-DVR session and the player
  keeps DVR from the origin with no 403. `relay-dvr` is the scenario B8-harness splits out of
  `e2e-relay` in wave 2 (`UNWIRED_B8_SCENARIOS`); the orchestrator wires the step when B8-harness
  merges.

The jury rerun cleanup and the localized rate-limit message are B8-harness's, in existing files:
they are not extensions and add no id. The jury flag link (`jury-flag-case-link`) is covered by
web unit tests, since the jury steps run in `e5-coop` with `jury.enabled` turned on by the step.
