// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `trust-safety` W2 extension `enforcement` (docs/testing/w2-selectors.md, "Scenarios"; ADR 0019):
 * `before` reads the report and tops a run-unique cell up to k − 1; `after` (steps 4 and 5 have
 * run) asserts the counts, the automated split, the overturn rate and the suppressed cell. Stub:
 * W2-enforcement-report fills it.
 */
import type { SafetyW2Extension } from "./kit.ts";

const notMerged = (): never => {
  throw new Error("W2-enforcement-report not merged");
};

export const enforcementExtension: SafetyW2Extension = {
  async before() {
    notMerged();
  },
  async after() {
    notMerged();
  },
};
