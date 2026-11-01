// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Re-masking a creator's correction (ADR 0011 decision 4) the way the live worker masks
 * (`services/media/src/captions/mask.ts`): the channel's mask list as chat-filter `replace` filters,
 * fail closed past the budget. A correction can never put a masked word back.
 */
import { maskedText, maskFilterDefs } from "@commonair/captions";
import { applyFilters, compileFilters } from "@commonair/chat-filter";

export function maskWith(words: readonly string[]): (text: string) => string {
  const filters = compileFilters(maskFilterDefs(words));
  return (text) => (filters.length === 0 ? text : maskedText(applyFilters(text, filters)));
}
