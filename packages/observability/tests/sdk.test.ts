// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Runs the real SDK under Bun against an in-process OTLP/HTTP receiver, so the
 * exporters, batch processors, context manager and propagators are all exercised.
 */
import { metrics, SpanStatusCode } from "@opentelemetry/api";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { createLogger, initTelemetry } from "../src/index.ts";
import {
  createTracedFetch,
  extractContext,
  injectContext,
  scrubErrorText,
  otelLogSink,
  startSdk,
  teeToOtel,
  traceHandler,
  tracedFetch,
  withSpan,
  type SdkOptions,
} from "../src/sdk.ts";
import type { TelemetryHandle } from "../src/telemetry.ts";

type Json = Record<string, unknown>;
interface KeyValue {
  key: string;
  value: { stringValue?: string; intValue?: number | string; boolValue?: boolean; doubleValue?: number };
}
interface OtlpSpan {
  links?: { traceId: string; spanId: string }[];
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  attributes: KeyValue[];
  status?: { code?: number; message?: string };
  events?: { name: string }[];
}
interface OtlpLog {
  severityNumber: number;
  severityText: string;
  body: { stringValue?: string };
  attributes: KeyValue[];
  traceId?: string;
  spanId?: string;
}

class Receiver {
  readonly bodies: Record<"traces" | "metrics" | "logs", Json[]> = { traces: [], metrics: [], logs: [] };
  private server: ReturnType<typeof Bun.serve>;

  constructor() {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const signal = new URL(req.url).pathname.replace("/v1/", "");
        if (signal !== "traces" && signal !== "metrics" && signal !== "logs")
          return new Response(null, { status: 404 });
        let raw = new Uint8Array(await req.arrayBuffer());
        if (req.headers.get("content-encoding") === "gzip") raw = Bun.gunzipSync(raw);
        this.bodies[signal].push(JSON.parse(new TextDecoder().decode(raw)) as Json);
        return Response.json({});
      },
    });
  }

  get endpoint(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  spans(): OtlpSpan[] {
    return this.bodies.traces.flatMap((b) =>
      (b.resourceSpans as { scopeSpans: { spans: OtlpSpan[] }[] }[]).flatMap((r) =>
        r.scopeSpans.flatMap((s) => s.spans),
      ),
    );
  }

  logs(): OtlpLog[] {
    return this.bodies.logs.flatMap((b) =>
      (b.resourceLogs as { scopeLogs: { logRecords: OtlpLog[] }[] }[]).flatMap((r) =>
        r.scopeLogs.flatMap((s) => s.logRecords),
      ),
    );
  }

  metricNames(): string[] {
    return this.bodies.metrics.flatMap((b) =>
      (b.resourceMetrics as { scopeMetrics: { metrics: { name: string }[] }[] }[]).flatMap((r) =>
        r.scopeMetrics.flatMap((s) => s.metrics.map((m) => m.name)),
      ),
    );
  }

  resourceAttributes(signal: "traces" | "metrics" | "logs"): Record<string, unknown> {
    const key = { traces: "resourceSpans", metrics: "resourceMetrics", logs: "resourceLogs" }[signal];
    const first = (this.bodies[signal][0]?.[key] as { resource: { attributes: KeyValue[] } }[] | undefined)?.[0];
    return attrs(first?.resource.attributes ?? []);
  }

  stop(): Promise<void> {
    return this.server.stop(true);
  }
}

function attrs(list: KeyValue[]): Record<string, unknown> {
  return Object.fromEntries(
    list.map((kv) => [
      kv.key,
      kv.value.stringValue ?? kv.value.boolValue ?? kv.value.doubleValue ?? Number(kv.value.intValue),
    ]),
  );
}

let receiver: Receiver;
let handle: TelemetryHandle | undefined;

const start = async (extra: Partial<SdkOptions> = {}) => {
  handle = await startSdk({
    serviceName: "sdk-test",
    serviceVersion: "1.2.3",
    environment: "test",
    endpoint: receiver.endpoint,
    batchDelayMillis: 50,
    ...extra,
  });
  return handle;
};

beforeEach(() => {
  receiver = new Receiver();
});

afterEach(async () => {
  await handle?.shutdown();
  handle = undefined;
  await receiver.stop();
});

test("exports spans, metrics and logs over OTLP/HTTP with resource attributes", async () => {
  const h = await start();
  const lines: string[] = [];
  const log = createLogger({ service: "sdk-test", write: teeToOtel((l) => lines.push(l)) });

  await withSpan("unit-of-work", (span) => {
    span.setAttribute("work.items", 3);
    log.info("inside span", { userId: "u1", password: "hunter2", nested: { a: 1 } });
  });
  metrics.getMeter("t").createCounter("jobs.processed").add(2, { queue: "q" });
  await h.shutdown();

  const span = receiver.spans().find((s) => s.name === "unit-of-work");
  expect(span).toBeDefined();
  expect(attrs(span!.attributes)).toMatchObject({ "work.items": 3 });
  expect(receiver.metricNames()).toContain("jobs.processed");

  for (const signal of ["traces", "metrics", "logs"] as const) {
    expect(receiver.resourceAttributes(signal)).toMatchObject({
      "service.name": "sdk-test",
      "service.version": "1.2.3",
      "deployment.environment": "test",
      "deployment.environment.name": "test",
    });
  }

  // stdout still gets the line, and the OTel record carries the span's trace context.
  expect(lines).toHaveLength(1);
  const record = receiver.logs().find((l) => l.body.stringValue === "inside span");
  expect(record).toBeDefined();
  expect(record!.severityText).toBe("INFO");
  expect(record!.severityNumber).toBe(9);
  expect(record!.traceId).toBe(span!.traceId);
  expect(record!.spanId).toBe(span!.spanId);
  const recordAttrs = attrs(record!.attributes);
  expect(recordAttrs).toMatchObject({ userId: "u1", password: "[redacted]", nested: '{"a":1}' });
  expect(recordAttrs).not.toHaveProperty("msg");
  expect(recordAttrs).not.toHaveProperty("trace_id");
});

test("traceparent propagates from an internal traced fetch into a trusting traceHandler", async () => {
  const h = await start();
  let seen: string | null = null;
  let innerTraceId: string | undefined;
  const app = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: traceHandler(
      async (req) => {
        seen = req.headers.get("traceparent");
        await withSpan("db.query", (span) => {
          innerTraceId = span.spanContext().traceId;
        });
        return new Response("ok");
      },
      {
        route: (req) => (new URL(req.url).pathname.startsWith("/items/") ? "/items/:id" : undefined),
        trustIncomingContext: true,
        recordPath: true,
      },
    ),
  });
  const internalFetch = createTracedFetch({ propagateTo: [`127.0.0.1:${app.port}`] });
  try {
    await withSpan("caller", async () => {
      const res = await internalFetch(`http://127.0.0.1:${app.port}/items/42?token=secret`);
      expect(await res.text()).toBe("ok");
    });
  } finally {
    await app.stop(true);
  }
  await h.shutdown();

  const spans = receiver.spans();
  const caller = spans.find((s) => s.name === "caller")!;
  const client = spans.find((s) => s.kind === 3)!;
  const server = spans.find((s) => s.kind === 2)!;
  const inner = spans.find((s) => s.name === "db.query")!;
  expect(caller && client && server && inner).toBeTruthy();

  expect(seen).toBe(`00-${client.traceId}-${client.spanId}-01`);
  expect(client.parentSpanId).toBe(caller.spanId);
  expect(server.parentSpanId).toBe(client.spanId);
  expect(inner.parentSpanId).toBe(server.spanId);
  expect(new Set([caller.traceId, client.traceId, server.traceId, inner.traceId, innerTraceId]).size).toBe(1);

  expect(server.name).toBe("GET /items/:id");
  expect(attrs(server.attributes)).toMatchObject({
    "http.request.method": "GET",
    "http.route": "/items/:id",
    "url.path": "/items/42",
    "http.response.status_code": 200,
  });
  const clientAttrs = attrs(client.attributes);
  expect(clientAttrs["http.response.status_code"]).toBe(200);
  // Query strings may carry tokens; they never reach telemetry.
  expect(String(clientAttrs["url.full"])).not.toContain("secret");
  expect(receiver.metricNames()).toContain("http.server.request.duration");
});

test("traceHandler marks 5xx responses and thrown errors as failed", async () => {
  const h = await start();
  const failing = traceHandler(async (req) => {
    if (new URL(req.url).pathname === "/throw") throw new Error("kaboom");
    return new Response("nope", { status: 503 });
  });
  expect((await failing(new Request("http://svc.test/503"))).status).toBe(503);
  await expect(failing(new Request("http://svc.test/throw"))).rejects.toThrow("kaboom");
  await h.shutdown();

  const [unavailable, thrown] = receiver.spans().filter((s) => s.kind === 2);
  expect(attrs(unavailable!.attributes)["http.response.status_code"]).toBe(503);
  expect(unavailable!.status?.code).toBe(SpanStatusCode.ERROR);
  expect(thrown!.status).toMatchObject({ code: SpanStatusCode.ERROR, message: "kaboom" });
  expect(thrown!.events?.map((e) => e.name)).toContain("exception");
  expect(attrs(thrown!.attributes)["http.response.status_code"]).toBe(500);
  // Raw paths are not recorded unless opted in.
  expect(attrs(thrown!.attributes)).not.toHaveProperty("url.path");
});

test("public traceHandler starts a new root and links the untrusted remote context", async () => {
  const h = await start();
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const parentId = "00f067aa0ba902b7";
  const handler = traceHandler(() => new Response(null, { status: 204 }), { route: () => "/a" });
  await handler(
    new Request("http://svc.test/a/secret-id", { headers: { traceparent: `00-${traceId}-${parentId}-01` } }),
  );
  await handler(new Request("http://svc.test/a", { headers: { traceparent: "garbage" } }));
  await h.shutdown();

  const [linked, plain] = receiver.spans();
  expect(linked!.traceId).not.toBe(traceId);
  expect(linked!.parentSpanId ?? "").toBe("");
  expect(linked!.links).toEqual([expect.objectContaining({ traceId, spanId: parentId })]);
  expect(JSON.stringify(linked)).not.toContain("secret-id");
  expect(plain!.links ?? []).toEqual([]);
  expect(plain!.parentSpanId ?? "").toBe("");
});

test("traced fetch sends trace headers only to allowlisted internal hosts, never baggage", async () => {
  const h = await start();
  const seen: Record<string, Record<string, string | null>> = {};
  const app = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      seen[new URL(req.url).pathname] = {
        traceparent: req.headers.get("traceparent"),
        baggage: req.headers.get("baggage"),
      };
      return new Response("ok");
    },
  });
  try {
    const internal = createTracedFetch({ propagateTo: ["127.0.0.1"] });
    const external = createTracedFetch({ propagateTo: ["api.internal.test"] });
    await withSpan("caller", async () => {
      await internal(`http://127.0.0.1:${app.port}/internal`, { headers: {} });
      await external(`http://127.0.0.1:${app.port}/external`);
      await tracedFetch(`http://127.0.0.1:${app.port}/default`);
    });
    const injected = injectContext(new Headers());
    expect(injected.has("baggage")).toBe(false);
  } finally {
    await app.stop(true);
  }
  await h.shutdown();
  expect(seen["/internal"]!.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  expect(seen["/external"]).toEqual({ traceparent: null, baggage: null });
  expect(seen["/default"]).toEqual({ traceparent: null, baggage: null });
  expect(seen["/internal"]!.baggage).toBeNull();
  // Spans are still recorded for every call.
  expect(receiver.spans().filter((s) => s.kind === 3)).toHaveLength(3);
});

test("span errors are scrubbed of PII and secrets", async () => {
  const h = await start();
  const err = new Error(
    "duplicate key: Key (email)=(ada@air.example.test) already exists; token=abc123 from 203.0.113.9",
  );
  await expect(
    withSpan("insert", () => {
      throw err;
    }),
  ).rejects.toBe(err);
  await h.shutdown();
  const span = receiver.spans().find((s) => s.name === "insert")!;
  const exported = JSON.stringify(span);
  for (const leak of ["ada@air.example.test", "abc123", "203.0.113.9"]) expect(exported).not.toContain(leak);
  expect(span.status?.message).toBe(
    "duplicate key: Key (email)=([redacted]) already exists; token=[redacted] from [ip]",
  );
  expect(scrubErrorText("mail bob@example.test, Bearer eyJhbGciOiJIUzI1NiJ9.x.y")).toBe(
    "mail [email], Bearer [redacted]",
  );
  expect(scrubErrorText(`key ${"A".repeat(40)} id 0190a8c2-7b1e-7f00-8a00-000000000000`)).toBe(
    "key [redacted] id 0190a8c2-7b1e-7f00-8a00-000000000000",
  );
});

test("concurrent startSdk calls are serialised and the last one wins", async () => {
  const other = new Receiver();
  try {
    const [first, second] = await Promise.all([
      startSdk({ serviceName: "first", endpoint: receiver.endpoint, batchDelayMillis: 50 }),
      startSdk({ serviceName: "second", endpoint: other.endpoint, batchDelayMillis: 50 }),
    ]);
    handle = second;
    await withSpan("after-race", () => {});
    await second.shutdown();
    await first.shutdown(); // already shut down by the second start; still resolves
    expect(other.spans().map((s) => s.name)).toContain("after-race");
    expect(receiver.spans().map((s) => s.name)).not.toContain("after-race");
  } finally {
    await other.stop();
  }
});

test("trusting traceHandler continues an incoming W3C trace and starts a new root without one", async () => {
  const h = await start();
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const parentId = "00f067aa0ba902b7";
  const handler = traceHandler(() => new Response(null, { status: 204 }), { trustIncomingContext: true });
  await handler(new Request("http://svc.test/a", { headers: { traceparent: `00-${traceId}-${parentId}-01` } }));
  await handler(new Request("http://svc.test/b"));
  await h.shutdown();

  const [continued, root] = receiver.spans();
  expect(continued).toMatchObject({ traceId, parentSpanId: parentId, name: "GET" });
  expect(root!.traceId).not.toBe(traceId);
  expect(root!.parentSpanId ?? "").toBe("");
});

test("withSpan records failures and rethrows", async () => {
  const h = await start();
  await expect(
    withSpan("explodes", () => {
      throw new Error("bad input");
    }),
  ).rejects.toThrow("bad input");
  await expect(withSpan("returns", async () => 7)).resolves.toBe(7);
  await h.shutdown();

  const failed = receiver.spans().find((s) => s.name === "explodes")!;
  expect(failed.status).toMatchObject({ code: SpanStatusCode.ERROR, message: "bad input" });
  expect(receiver.spans().find((s) => s.name === "returns")!.status?.code ?? 0).toBe(SpanStatusCode.UNSET);
});

test("tracedFetch records transport errors on the client span", async () => {
  const h = await start();
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = closed.port;
  await closed.stop(true);
  await expect(tracedFetch(`http://127.0.0.1:${port}/`)).rejects.toBeInstanceOf(Error);
  await h.shutdown();
  const client = receiver.spans().find((s) => s.kind === 3)!;
  expect(client.status?.code).toBe(SpanStatusCode.ERROR);
});

test("otelLogSink maps levels and tolerates non-JSON lines", async () => {
  const h = await start();
  const sink = otelLogSink();
  sink(JSON.stringify({ time: "2026-01-01T00:00:00.000Z", level: "error", msg: "failed", code: 42 }));
  sink(JSON.stringify({ level: "fatal", msg: "down" }));
  sink("not json at all");
  await h.shutdown();

  const records = receiver.logs();
  expect(records.map((r) => [r.body.stringValue, r.severityNumber])).toEqual([
    ["failed", 17],
    ["down", 21],
    ["not json at all", 9],
  ]);
  expect(attrs(records[0]!.attributes)).toEqual({ code: 42 });
});

test("initTelemetry uses the registered SDK only when an endpoint is configured", async () => {
  const noop = await initTelemetry({ serviceName: "sdk-test", endpoint: "" });
  await noop.shutdown();
  expect(receiver.bodies.traces).toHaveLength(0);

  handle = await initTelemetry({ serviceName: "via-init", endpoint: receiver.endpoint });
  await withSpan("registered", () => {});
  await handle.shutdown();
  await handle.shutdown(); // idempotent
  expect(receiver.spans().map((s) => s.name)).toContain("registered");
  expect(receiver.resourceAttributes("traces")["service.name"]).toBe("via-init");
});

test("extractContext without a registered SDK yields no remote parent", () => {
  const ctx = extractContext(new Headers({ traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" }));
  // Propagation is a no-op until the SDK starts, so nothing leaks into an unconfigured service.
  expect(ctx.getValue(Symbol.for("OpenTelemetry Context Key SPAN"))).toBeUndefined();
});
