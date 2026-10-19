// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

export * from "./client.ts";
export * from "./ids.ts";
export * as schema from "./schema/index.ts";
export { runMigrations, MIGRATIONS_DIR } from "./migrate.ts";
export { DEFAULT_GOVERNANCE_SETTINGS, seedGovernanceSettings, seedLegalDocuments } from "./seed.ts";
export {
  CONSENT_CATEGORIES,
  LEGAL_PLACEHOLDERS,
  LEGAL_SEED_VERSION,
  PLACEHOLDER_PATTERN,
  legalSeedDocuments,
} from "./legal/index.ts";
