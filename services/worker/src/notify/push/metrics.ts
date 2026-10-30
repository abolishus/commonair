// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { meter } from "@commonair/observability";

/** Web push instruments (no-ops until the OTLP SDK is registered). */
const m = meter("commonair.worker");

export const metrics = {
  pushSends: m.createCounter("worker.notify.push.sends", {
    description: "Web push sends by outcome (sent, removed, retry, failed)",
  }),
};
