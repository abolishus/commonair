// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Consent for the weekly "What you missed" email (overhaul wave 4, D7.3; account-admin.md P5).
 * Kept the way the platform keeps consent today: an append-only `consent_records` row per choice,
 * under its own policy version, so the member's export lists it and account deletion removes it
 * with the cookie records. No PII: the member is referenced by id only.
 */
import { schema, type Executor } from "@commonair/db";

/** `consent_records.policy_version` of a digest choice (never a cookie-policy version). */
export const DIGEST_CONSENT_POLICY = "email-digest-weekly-v1";
/** The key a digest consent record's `choices` carries for the choice itself. */
export const DIGEST_CONSENT_KEY = "digestWeekly";

/** Where the choice was made: the settings grid, or a one-click unsubscribe link. */
export type DigestConsentSource = "settings" | "unsubscribe";

export async function recordDigestConsent(
  tx: Executor,
  userId: string,
  granted: boolean,
  source: DigestConsentSource,
  now: Date,
): Promise<void> {
  await tx.insert(schema.consentRecords).values({
    userId,
    anonymousId: null,
    choices: { [DIGEST_CONSENT_KEY]: granted, [`via_${source}`]: true },
    policyVersion: DIGEST_CONSENT_POLICY,
    createdAt: now,
  });
}
