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
  const fanout = m.createHistogram("chat.fanout.latency", {
    description: "Time from publish on one instance to local delivery on another",
    unit: "ms",
  });
  return {
    connectionOpened: (via: string) => connections.add(1, { via }),
    connectionClosed: (via: string) => connections.add(-1, { via }),
    messageIn: () => messagesIn.add(1),
    framesOut: (n: number) => messagesOut.add(n),
    dropped: (reason: DropReason, extra: Record<string, string> = {}) => dropped.add(1, { reason, ...extra }),
    fanoutLatency: (ms: number) => fanout.record(Math.max(0, ms)),
  };
}
export type Metrics = ReturnType<typeof createMetrics>;
