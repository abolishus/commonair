// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { meter } from "@commonair/observability";

const m = meter("commonair.worker");

/** Money job instruments (no-ops until telemetry is initialised). */
export const moneyMetrics = {
  runs: m.createCounter("worker.money.runs", {
    description: "Money job runs by job and outcome (ran; skipped: another run held the lock)",
  }),
  expired: m.createCounter("worker.money.expired", {
    description: "Pending payments expired as failed, by payment kind",
  }),
  renewed: m.createCounter("worker.money.renewed", {
    description: "Manual subscriptions given a pending renewal payment (now past_due)",
  }),
  ended: m.createCounter("worker.money.subscriptions_ended", {
    description: "Subscriptions ended by a money job, by reason (canceled, gift, no_tiers, renewal_unpaid)",
  }),
  released: m.createCounter("worker.money.released_cents", {
    unit: "cents",
    description: "Creator shares moved from the hold to available, in cents of the instance currency",
  }),
};
