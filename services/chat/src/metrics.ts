// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Chat metrics (no-ops until an OpenTelemetry SDK is registered). */
import { meter } from "@commonair/observability";

export type DropReason =
  | "slow_consumer"
  | "send_failed"
  | "rejected"
  | "persist_failed"
  | "persist_overflow"
  | "bad_frame"
  | "idle"
  | "credentials";

export function createMetrics() {
  const m = meter("chat");
  const connections = m.createUpDownCounter("chat.connections", { description: "Open chat WebSocket connections" });
  const messagesIn = m.createCounter("chat.messages.in", { description: "Chat messages received from clients" });
  const messagesOut = m.createCounter("chat.messages.out", { description: "Frames delivered to local sockets" });
  const dropped = m.createCounter("chat.dropped", { description: "Messages, frames or sockets dropped, by reason" });
  const filterHeld = m.createCounter("chat.filter.held", {
    description: "Messages held without a filter verdict (timeout, crash, queue, quarantine), by reason",
  });
  const filterQuarantined = m.createCounter("chat.filter.quarantined", {
    description: "Filter sets quarantined after a hard timeout",
  });
  const filterZombies = m.createUpDownCounter("chat.filter.zombies", {
    description: "Terminated filter workers still finishing their last regex call",
  });
  const filterSkipped = m.createCounter("chat.filter.skipped", {
    description: "Stored word filters skipped on load because the validator refuses them, by reason",
  });
  const fanout = m.createHistogram("chat.fanout.latency", {
    description: "Time from publish on one instance to local delivery on another",
    unit: "ms",
  });
  const upgradeTimeouts = m.createCounter("chat.upgrade.timeouts", {
    description: "WebSocket upgrades answered 503 because a dependency did not answer in time, by stage",
  });
  return {
    upgradeTimedOut: (stage: string) => upgradeTimeouts.add(1, { stage }),
    connectionOpened: (via: string) => connections.add(1, { via }),
    connectionClosed: (via: string) => connections.add(-1, { via }),
    messageIn: () => messagesIn.add(1),
    framesOut: (n: number) => messagesOut.add(n),
    dropped: (reason: DropReason, extra: Record<string, string> = {}) => dropped.add(1, { reason, ...extra }),
    filterHeld: (reason: string) => filterHeld.add(1, { reason }),
    filterQuarantined: () => filterQuarantined.add(1),
    filterZombies: (delta: number) => filterZombies.add(delta),
    /** Reasons are fixed validator messages (low cardinality); the first clause is enough. */
    filterSkipped: (reason: string) => filterSkipped.add(1, { reason: reason.split(":")[0] ?? reason }),
    fanoutLatency: (ms: number) => fanout.record(Math.max(0, ms)),
  };
}
export type Metrics = ReturnType<typeof createMetrics>;
