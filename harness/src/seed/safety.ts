// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** seed-safety: reports, moderation cases, appeals, enforcement, DMCA, NCII, legal holds, incidents and privacy requests. Brief: `.claude/briefs/seed-full/seed-safety.md`. */
import type { SeedUnit } from "./types.ts";

const TABLES = [
  "reports",
  "mod_actions",
  "moderation_cases",
  "moderation_flags",
  "content_labels",
  "evidence_objects",
  "evidence_audit_runs",
  "hash_match_results",
  "local_hash_list",
  "ncmec_reports",
  "ncii_requests",
  "ncii_request_items",
  "appeals",
  "account_actions",
  "enforcement_statements",
  "enforcement_statement_deliveries",
  "dmca_notices",
  "dmca_notice_items",
  "dmca_counter_notices",
  "integrity_flags",
  "legal_holds",
  "incidents",
  "data_exports",
  "account_deletions",
] as const;

export const unit: SeedUnit = {
  name: "safety",
  after: ["social", "media"],
  tables: TABLES,
  pending: TABLES,
  async run() {
    return { rows: {}, notes: ["seed-safety: not implemented yet"] };
  },
};
