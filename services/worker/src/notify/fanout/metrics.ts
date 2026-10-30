// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Go-live fan-out instruments (no-ops until the OTLP SDK is registered by initTelemetry). */
import { meter } from "@commonair/observability";

const m = meter("commonair.worker");

export const fanoutMetrics = {
  goLiveRows: m.createCounter("worker.notify.go_live_rows", {
    description: "Go-live deliveries written per medium (in_app rows, email queue rows, push jobs)",
  }),
  cooledDown: m.createCounter("worker.notify.go_live_cooled_down", {
    description: "Followers a go-live skipped because the channel notified them within the cooldown",
  }),
};
