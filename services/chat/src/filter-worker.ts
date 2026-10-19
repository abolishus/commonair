// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Word-filter worker thread: runs `applyFilters` off the main thread so the runner can terminate
 * it if a single regex runs past its hard timeout. Compiled filter sets are cached by key.
 */
import { applyFilters, type CompiledFilter } from "./content.ts";
import type { RunRequest, WorkerReply } from "./filter-protocol.ts";

declare const self: Worker;

const MAX_SETS = 256;
const sets = new Map<string, CompiledFilter[]>();

const reply = (msg: WorkerReply) => self.postMessage(msg);

self.addEventListener("message", (event: MessageEvent<RunRequest>) => {
  const req = event.data;
  let filters = sets.get(req.key);
  if (req.filters) {
    filters = req.filters.map((f) => ({ def: f.def, re: new RegExp(f.source, f.flags) }));
    if (sets.size >= MAX_SETS) {
      const oldest = sets.keys().next().value;
      if (oldest !== undefined) sets.delete(oldest);
    }
  } else if (filters) sets.delete(req.key); // re-inserted below: most recently used last
  if (!filters) return reply({ type: "missing", id: req.id });
  sets.set(req.key, filters);
  reply({ type: "result", id: req.id, outcome: applyFilters(req.body, filters, req.budgetMs) });
});

reply({ type: "ready" });
