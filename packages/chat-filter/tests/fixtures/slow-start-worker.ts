// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The filter worker on a slow host: a new filter set takes `SLOW_LOAD_MS` to reach it and
 * compile, as a message's first run does on a loaded CI runner; known sets run at once. Same
 * protocol as src/filter-worker.ts.
 */
import { applyFilters, type CompiledFilter } from "../../src/filter.ts";
import type { RunRequest, WorkerReply } from "../../src/filter-protocol.ts";

declare const self: Worker;

export const SLOW_LOAD_MS = 300;
const sets = new Map<string, CompiledFilter[]>();
const reply = (msg: WorkerReply) => self.postMessage(msg);

self.addEventListener("message", (event: MessageEvent<RunRequest>) => {
  const req = event.data;
  if (req.filters) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SLOW_LOAD_MS);
    sets.set(
      req.key,
      req.filters.map((f) => ({ def: f.def, re: new RegExp(f.source, f.flags) })),
    );
  }
  const filters = sets.get(req.key);
  if (!filters) return reply({ type: "missing", id: req.id });
  reply({ type: "started", id: req.id });
  reply({ type: "result", id: req.id, outcome: applyFilters(req.body, filters, req.budgetMs) });
});

reply({ type: "ready" });
