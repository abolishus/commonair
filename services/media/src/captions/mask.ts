// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Masking for live cues (ADR 0011 decision 4) through `@commonair/chat-filter`: the creator's list
 * as `replace` filters, compiled once per settings load (each pattern re-checked by safe-regex)
 * and applied within `FILTER_BUDGET_MS`. Patterns are linear-time by that check, so they run
 * inline rather than in the worker pool. A run past the budget masks the whole cue: the unmasked
 * text is never stored, served or logged.
 */
import { maskedText, maskFilterDefs } from "@commonair/captions";
import { applyFilters, compileFilters, FILTER_BUDGET_MS, type CompiledFilter } from "@commonair/chat-filter";

export interface Masker {
  mask(text: string): string;
  /** Patterns refused by the safe-regex check (counted, never logged: they are the creator's text). */
  readonly refused: number;
}

export function createMasker(
  words: readonly string[],
  budgetMs = FILTER_BUDGET_MS,
  clock: () => number = () => performance.now(),
): Masker {
  let refused = 0;
  const filters: CompiledFilter[] = compileFilters(maskFilterDefs(words), () => void refused++);
  return {
    mask: (text) => (filters.length === 0 ? text : maskedText(applyFilters(text, filters, budgetMs, clock))),
    get refused() {
      return refused;
    },
  };
}
