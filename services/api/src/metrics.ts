// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** API feature counters (OpenTelemetry; no-ops until initTelemetry registers the SDK). */
import { meter } from "@commonair/observability";

const m = meter("commonair.api");
/** First-party counters (feature-wins §6). No ids, addresses or user data in labels. */
export const apiMetrics = {
  /** `money.paymentBreakdown` reads that returned a breakdown, by viewer role (payer|payee). */
  breakdownViews: m.createCounter("money.payment_breakdown.views", { description: "Payment breakdowns opened" }),
  /** Surge overrides by moderators, by action (start|end). */
  surgeOverrides: m.createCounter("chat.surge.overrides", {
    description: "Surge mode started or ended by a moderator",
  }),
};
