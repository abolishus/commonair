// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * First-party growth counters (overhaul wave 2, D2.8): `metrics.ui`, `admin.growth` and
 * `transparency.numbers`. Contract step stubs: d2-metrics implements them.
 */
import { ORPCError } from "@orpc/server";
import { os } from "../lib/orpc.ts";

const notYet = () => {
  throw new ORPCError("NOT_IMPLEMENTED", { status: 501, message: "Not available yet" });
};

export const metrics = { ui: os.metrics.ui.handler(notYet) };
export const adminGrowth = { growth: os.admin.growth.handler(notYet) };
export const transparencyNumbers = { numbers: os.transparency.numbers.handler(notYet) };
