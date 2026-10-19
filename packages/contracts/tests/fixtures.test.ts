// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from "vite-plus/test";
import { DEMO_FIXTURES, isDemoFixtureIdentity } from "../src/fixtures.ts";

test("fixture domain is under the reserved .invalid TLD", () => {
  expect(DEMO_FIXTURES.emailDomain.endsWith(".invalid")).toBe(true);
});

test("both anchors are required, case-insensitively", () => {
  expect(isDemoFixtureIdentity("demo_alice", "alice@demo-seed.invalid")).toBe(true);
  expect(isDemoFixtureIdentity("DEMO_alice", "Alice@Demo-Seed.Invalid")).toBe(true);
  expect(isDemoFixtureIdentity("alice", "alice@demo-seed.invalid")).toBe(false);
  expect(isDemoFixtureIdentity("demo_alice", "alice@example.org")).toBe(false);
  expect(isDemoFixtureIdentity("demo_alice", "alice@demo-seed.invalid.example.org")).toBe(false);
  expect(isDemoFixtureIdentity("demo_alice", "alice@xdemo-seed.invalid")).toBe(false);
});
