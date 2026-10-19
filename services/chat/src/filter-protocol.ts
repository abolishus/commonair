// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Messages between the filter runner and its worker threads. */
import type { FilterOutcome } from "./content.ts";
import type { WordFilterDef } from "./types.ts";

/** A compiled filter as it crosses the thread boundary (RegExp objects are rebuilt there). */
export interface WireFilter {
  def: WordFilterDef;
  source: string;
  flags: string;
}

export interface RunRequest {
  type: "run";
  id: number;
  /** Identifies one compiled filter set; the worker caches it. */
  key: string;
  body: string;
  budgetMs: number;
  /** Sent the first time a worker sees a key, or again after it reported the key missing. */
  filters?: WireFilter[];
}

export type WorkerReply =
  | { type: "ready" }
  | { type: "result"; id: number; outcome: FilterOutcome }
  | { type: "missing"; id: number };
