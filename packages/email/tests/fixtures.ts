// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { coreEnv, instanceSite, loadEnv, type InstanceSite } from "@commonair/config";

/** A self-hosted instance with its own identity, so nothing here depends on the flagship's. */
export function testSite(overrides: Record<string, string> = {}): InstanceSite {
  return instanceSite(
    loadEnv(coreEnv, {
      PUBLIC_URL: "https://air.example.test",
      INSTANCE_NAME: "Example Air",
      CONTACT_EMAIL: "hello@air.example.test",
      SECURITY_EMAIL: "security@air.example.test",
      ABUSE_EMAIL: "abuse@air.example.test",
      DMCA_EMAIL: "dmca@air.example.test",
      PRIVACY_EMAIL: "privacy@air.example.test",
      SOURCE_URL: "https://forge.example.test/air/commonair",
      SOURCE_COMMIT: "0123abcd",
      ...overrides,
    }),
  );
}
