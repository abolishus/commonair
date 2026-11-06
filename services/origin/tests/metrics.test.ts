// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The origin's OpenTelemetry instruments: names, units and attributes, which the Grafana
 * dashboards and alert rules query (e.g. the cache hit ratio). A recording MeterProvider stands in
 * for the SDK.
 */
import { metrics, type Attributes, type Meter, type MeterProvider } from "@opentelemetry/api";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { createMetrics, noopMetrics } from "../src/metrics.ts";

interface Recorded {
  meter: string;
  instrument: string;
  type: "counter" | "histogram";
  value: number;
  attributes?: Attributes;
}
const recorded: Recorded[] = [];
const created: { meter: string; instrument: string; type: string; unit?: string; description?: string }[] = [];

const provider: MeterProvider = {
  getMeter(meterName: string): Meter {
    const instrument =
      (type: "counter" | "histogram") => (name: string, opts?: { unit?: string; description?: string }) => {
        created.push({ meter: meterName, instrument: name, type, unit: opts?.unit, description: opts?.description });
        const record = (value: number, attributes?: Attributes) =>
          void recorded.push({ meter: meterName, instrument: name, type, value, attributes });
        return type === "counter" ? { add: record } : { record };
      };
    return { createCounter: instrument("counter"), createHistogram: instrument("histogram") } as unknown as Meter;
  },
};

let registered = false;
beforeAll(() => {
  metrics.disable();
  registered = metrics.setGlobalMeterProvider(provider);
});
afterAll(() => metrics.disable());

test("one meter, five instruments, with the units the dashboards expect", () => {
  expect(registered).toBe(true);
  createMetrics();
  expect(created.map((c) => [c.meter, c.instrument, c.type, c.unit])).toEqual([
    ["commonair.origin", "origin.requests", "counter", undefined],
    ["commonair.origin", "origin.cache.lookups", "counter", undefined],
    ["commonair.origin", "origin.upstream.duration", "histogram", "ms"],
    ["commonair.origin", "origin.egress.bytes", "counter", "By"],
    ["commonair.origin", "origin.accounting.dropped", "counter", undefined],
  ]);
  expect(created.every((c) => (c.description ?? "").length > 0)).toBe(true);
});

test("each call records its value under the attributes queries group by", () => {
  recorded.length = 0;
  const m = createMetrics();
  m.request("hls", "segment", "origin", 200);
  m.cache("hit", "playlist");
  m.cache("coalesced", "segment");
  m.upstream("part", 504, 12.5);
  m.egress("relay", 4096);
  m.accountingDropped("dvr_pulls", 3);
  expect(recorded.map(({ instrument, value, attributes }) => [instrument, value, attributes])).toEqual([
    ["origin.requests", 1, { route: "hls", kind: "segment", source: "origin", status: 200 }],
    ["origin.cache.lookups", 1, { result: "hit", kind: "playlist" }],
    ["origin.cache.lookups", 1, { result: "coalesced", kind: "segment" }],
    ["origin.upstream.duration", 12.5, { kind: "part", status: 504 }],
    ["origin.egress.bytes", 4096, { source: "relay" }],
    ["origin.accounting.dropped", 3, { what: "dvr_pulls" }],
  ]);
});

test("the no-op metrics accept every call and record nothing", () => {
  recorded.length = 0;
  noopMetrics.request("hls", "segment", "origin", 200);
  noopMetrics.cache("miss", "segment");
  noopMetrics.upstream("segment", 200, 1);
  noopMetrics.egress("origin", 1);
  noopMetrics.accountingDropped("production", 1);
  expect(recorded).toEqual([]);
});
