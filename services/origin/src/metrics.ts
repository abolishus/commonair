// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Origin metrics (OpenTelemetry; no-ops until an SDK is registered). The cache hit
 * ratio is `origin.cache.lookups{result="hit"} / origin.cache.lookups`.
 */
import { meter } from "@commonair/observability";

export interface OriginMetrics {
  request(route: string, kind: string, source: string, status: number): void;
  cache(result: "hit" | "miss" | "coalesced", kind: string): void;
  upstream(kind: string, status: number, ms: number): void;
  egress(source: string, bytes: number): void;
  accountingDropped(what: "segment_fetch" | "egress", n: number): void;
}

export function createMetrics(): OriginMetrics {
  const m = meter("commonair.origin");
  const requests = m.createCounter("origin.requests", { description: "HLS requests served" });
  const lookups = m.createCounter("origin.cache.lookups", { description: "Content cache lookups by result" });
  const latency = m.createHistogram("origin.upstream.duration", {
    description: "MediaMTX request latency",
    unit: "ms",
  });
  const egress = m.createCounter("origin.egress.bytes", { description: "Bytes served by delivery source", unit: "By" });
  const dropped = m.createCounter("origin.accounting.dropped", {
    description: "Accounting records dropped under backpressure",
  });
  return {
    request: (route, kind, source, status) => requests.add(1, { route, kind, source, status }),
    cache: (result, kind) => lookups.add(1, { result, kind }),
    upstream: (kind, status, ms) => latency.record(ms, { kind, status }),
    egress: (source, bytes) => egress.add(bytes, { source }),
    accountingDropped: (what, n) => dropped.add(n, { what }),
  };
}

export const noopMetrics: OriginMetrics = {
  request: () => {},
  cache: () => {},
  upstream: () => {},
  egress: () => {},
  accountingDropped: () => {},
};
