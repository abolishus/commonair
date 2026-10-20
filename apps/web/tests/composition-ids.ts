// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Selector-contract ids and attributes that reach the DOM only through a `@commonair/ui`
 * composition prop (`rowProps`, `cardProps`, `inputProps`, `sourceLink`, `liveBadgeProps`,
 * `data-copy-testid`), so the source spells them as a prop, not as `data-testid="…"` on an element.
 * tests/selectors-render.test.tsx renders every one of them and checks the DOM; only these may use
 * the prop form in tests/selectors.test.ts.
 */
export const COMPOSITION_TEST_IDS = [
  "stream-card",
  "relay-row",
  "chat-input",
  "chat-send",
  "signin-password",
  "signup-password",
  "footer-source-link",
  "live-badge",
  "stream-key-copy",
  // E4b web-money
  "revenue-month",
  "revenue-source",
  "revenue-tier-row",
  "revenue-ledger-row",
  "revenue-tier-price-1",
  "revenue-tier-price-2",
  "revenue-tier-price-3",
  "treasury-search",
  "treasury-payment-row",
  "treasury-dispute-amount",
  "treasury-payout-row",
  "treasury-account-enabled",
  "treasury-cost-amount",
  "transparency-month-row",
] as const;

/** `data-x={expr}` attributes written as `"data-x": expr` in a composition's prop callback. */
export const COMPOSITION_ATTRS = [
  "data-channel={card.channel.slug}",
  "data-relay-id={relay.id}",
  "data-status={relay.status}",
  // E4b web-money
  "data-source={source}",
  "data-cents={summary.bySource[source]}",
  "data-tier={row.tier}",
  "data-active={row.active}",
  "data-cents={row.monthlyShare.cents}",
  "data-transaction-id={line.id}",
  "data-type={line.type}",
  'data-tier={line.tier ?? ""}',
  "data-quantity={line.quantity}",
  "data-gross={signed(line.gross?.cents)}",
  "data-deductions={signed(line.deductions?.cents)}",
  "data-net={line.net.cents}",
  "data-payment-id={p.paymentId}",
  "data-reference={p.reference}",
  "data-status={p.status}",
  "data-kind={p.kind}",
  "data-cents={p.amount.cents}",
  "data-refunded={p.refunded.cents}",
  "data-payout-id={p.id}",
  "data-username={p.user.username}",
  'data-hold-reason={p.holdReason ?? ""}',
  "data-month={m.month}",
  "data-revenue={m.revenue.cents}",
  "data-payouts={m.streamerPayouts.cents}",
  "data-costs={monthCosts(m)}",
  "data-surplus={m.surplus.cents}",
  "data-patronage={m.patronageDistributed.cents}",
] as const;
