// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Channel word filters (extracted from services/chat in the W2 contract step): compile, apply
 * within a budget, and run regex sets in a terminable worker pool. Used by chat and by caption
 * masking in services/media.
 */
export {
  applyFilters,
  type CompiledFilter,
  compileFilters,
  FILTER_BUDGET_MS,
  type FilterOutcome,
  type WordFilterDef,
} from "./filter.ts";
export {
  type FilterRunner,
  type FilterRunnerHooks,
  type HoldReason,
  inlineFilterRunner,
  WorkerFilterRunner,
  type WorkerFilterRunnerOptions,
} from "./filter-runner.ts";
