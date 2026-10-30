<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# M1: money follow-ups

**Goal.** Close the money decisions already taken but not built, and make payouts actually
move money through Stripe Connect, all proven against stripe-mock.

**Hard gate.** ROADMAP.md's non-goals say payment adapters run in test mode only, and the
co-op is not incorporated. Building and testing on stripe-mock can happen any time; live keys
need a legal entity and counsel (payee status, tax, money transmission). This plan never
configures live keys.

## Scope

| Item                                                               | Source                            | Build                                                                                                                                                                       |
| ------------------------------------------------------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One open unpaid gift per gifter per channel, 24 h window           | ADR 0007 decision 1 (lines 22-29) | constraint + expiry job                                                                                                                                                     |
| Auto-refund money collected for an ended subscription              | ADR 0007 decision 2 (lines 30-36) | detect on webhook, refund through the adapter, ledger reversal                                                                                                              |
| "Outcome unknown" state for Stripe refund calls                    | ADR 0007 decision 3 (lines 37-41) | state, reconciliation job, treasurer view                                                                                                                                   |
| Stripe Connect transfers on payout runs                            | ADR 0007:52-54; PLAN.md:78        | transfers to Express accounts at payout; ledger postings; failure and reversal handling                                                                                     |
| Stripe for co-op shares (`buyShare` today answers `manual_shares`) | ADR 0020; HANDOFF.md:40           | Checkout for shares, ledger postings, refunds per bylaws                                                                                                                    |
| Paying patronage payables out                                      | ADR 0020                          | payable → payout path (manual adapter first, Connect second)                                                                                                                |
| Payment receipt email with the breakdown                           | batch 4 decision (2026-10-30)     | deferred from W1-breakdown: a receipt email showing `PaymentBreakdown` lines, sent after posting (`confirmPaymentTx`, `stripe-events.ts`); M1-gifts-refunds or its own unit |

The manual adapter stays the FOSS default for every item (AGENTS.md rule 3).

## Units

Money code concentrates in `packages/ledger`, `packages/payments` and
`services/worker/src/money`; to stay file-disjoint, run as three units: **M1-gifts-refunds**
(decisions 1–3), **M1-connect** (transfers, after W2-splits if splits have merged so transfers
are per recipient), **M1-coop-money** (shares and patronage payout). Any change to ledger
rules or triggers goes through the contract step and a database security review (as
`0002_protections_hardening.sql` did).

## Done means

`e4b-money` gains: a second gift inside the window is refused; an ended subscription's late
charge refunds; a refund that times out shows "outcome unknown" and reconciles; a payout run
creates Connect transfers on stripe-mock. `e5-coop` gains a Stripe share purchase and a
patronage payout. Ledger still balances in every step (triggers).
