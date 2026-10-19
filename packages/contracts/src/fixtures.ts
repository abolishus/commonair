// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Anchors that make demo fixture data impossible to confuse with real data. A row is a fixture
 * only if it matches every anchor: the reserved username prefix (real sign-ups are refused it),
 * the fixture email domain (`.invalid` is reserved by RFC 6761, so no real mailbox can verify it)
 * and, for cleanup, an id recorded in the seed manifest. Fixture sign-ups need
 * `DEMO_SEED_ENABLED=true` on the instance and are refused in production.
 */
export const DEMO_FIXTURES = {
  usernamePrefix: "demo_",
  emailDomain: "demo-seed.invalid",
} as const;

/** True when `username` and `email` both carry the fixture anchors. */
export function isDemoFixtureIdentity(username: string, email: string): boolean {
  return (
    username.toLowerCase().startsWith(DEMO_FIXTURES.usernamePrefix) &&
    email.toLowerCase().endsWith(`@${DEMO_FIXTURES.emailDomain}`)
  );
}
