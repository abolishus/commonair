// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The open enforcement report (W2-enforcement-report, ADR 0019, batch 6 decision (d)): per-rule
 * counts over `rule_ref`, the automated share and the overturn rate, with cells below k = 10
 * suppressed. Contract-step stub (HTTP 501) until that unit implements it.
 */
import type { EnforcementReport } from "@commonair/contracts/dto";
import type { Deps } from "../deps.ts";
import { notImplemented } from "../lib/errors.ts";

/** `30d` (rolling) or a calendar month `YYYY-MM` (UTC), as `transparency.enforcement` validates it. */
export type EnforcementWindow = string;

export async function enforcementReport(_deps: Deps, _window: EnforcementWindow): Promise<EnforcementReport> {
  notImplemented();
}
