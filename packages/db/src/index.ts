// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

export * from "./client.ts";
export * from "./ids.ts";
export * from "./hold-lock.ts";
export * from "./account-actions.ts";
export * from "./points.ts";
export * from "./eventsub.ts";
export * as schema from "./schema/index.ts";
export { runMigrations, MIGRATIONS_DIR } from "./migrate.ts";
/** Demo-data anchors (both required), so jobs can skip demo users and channels as `demo:clear` selects them. */
export { anchoredUser } from "./demo/anchors.ts";
export { schemaTableNames } from "./table-names.ts";
export { DEFAULT_GOVERNANCE_SETTINGS, seedGovernanceSettings, seedLegalDocuments } from "./seed.ts";
export {
  CONSENT_CATEGORIES,
  COOKIES_SEED_VERSION,
  ENFORCEMENT_NOTICE_SEED_VERSION,
  LEGAL_PLACEHOLDERS,
  LEGAL_SEED_VERSION,
  PLACEHOLDER_PATTERN,
  PRIVACY_SEED_VERSION,
  TERMS_SEED_VERSION,
  legalSeedDocuments,
  legalSeedVersion,
} from "./legal/index.ts";
