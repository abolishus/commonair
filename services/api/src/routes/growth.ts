// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * First-party growth counters (overhaul wave 2, D2.8): `metrics.ui` (public, ignores the session),
 * `admin.growth` (admins) and `transparency.numbers` (public). See `../growth/`.
 */
import { recordUiMetric } from "../growth/ingest.ts";
import { growthNumbers, growthReport } from "../growth/report.ts";
import { os } from "../lib/orpc.ts";

export const metrics = {
  // Counted or not (rate limited, capped), the answer is the same.
  ui: os.metrics.ui.handler(async ({ context, input }) => {
    await recordUiMetric(context.deps, context.req.ip, input);
    return { ok: true as const };
  }),
};
export const adminGrowth = {
  growth: os.admin.growth.handler(async ({ context, input }) =>
    growthReport(context.deps.db, context.deps.now(), input.days),
  ),
};
export const transparencyNumbers = {
  numbers: os.transparency.numbers.handler(async ({ context }) => growthNumbers(context.deps.db, context.deps.now())),
};
