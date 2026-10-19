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
] as const;

/** `data-x={expr}` attributes written as `"data-x": expr` in a composition's prop callback. */
export const COMPOSITION_ATTRS = [
  "data-channel={card.channel.slug}",
  "data-relay-id={relay.id}",
  "data-status={relay.status}",
] as const;
