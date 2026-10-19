// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Anchors that make demo fixture data impossible to confuse with real data. The demo seed
 * (`packages/db` `demo:seed`) gives every account both anchors and `demo:clear` deletes only rows
 * matching both: the `demo_` username prefix is reserved (real sign-ups are refused it) and the
 * email domain is under `.invalid`, which RFC 6761 reserves, so no real mailbox can verify it.
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
