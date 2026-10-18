// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * OpenTelemetry SDK wiring (OTLP/HTTP traces, metrics and logs) plus manual
 * instrumentation helpers that work under Bun.
 *
 * Bun does not run Node's `require` hooks, so auto-instrumentations are not
 * used. Instead services wrap their `Bun.serve` fetch handler with
 * `traceHandler`, make outbound calls with `tracedFetch`, and wrap units of
 * work in `withSpan`. The heavy SDK packages are imported lazily inside
 * `startSdk`, so importing this module (and the package index) stays cheap.
 */
import {
  context,
  metrics,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Link,
  type Span,
  type SpanOptions,
  type TextMapGetter,
  type TextMapSetter,
} from "@opentelemetry/api";
import { logs, SeverityNumber, type AnyValue } from "@opentelemetry/api-logs";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { registerSdk, type TelemetryHandle, type TelemetryOptions } from "./telemetry.ts";

const SCOPE = "@commonair/observability";

export interface SdkOptions extends TelemetryOptions {
  /** OTLP/HTTP base endpoint, e.g. `http://otel-collector:4318`; signal paths are appended. */
  endpoint: string;
  /** `deployment.environment`; defaults to NODE_ENV, then "development". */
  environment?: string;
  /** Metric export interval (default 15 s). */
  metricIntervalMillis?: number;
  /** Batch span/log processor delay (default 1 s for logs, 5 s for spans: the SDK defaults). */
  batchDelayMillis?: number;
  /** Per-request export timeout (default 10 s). */
  exportTimeoutMillis?: number;
  /** Extra resource attributes. */
  resourceAttributes?: Attributes;
}

let active: TelemetryHandle | undefined;

function signalUrl(endpoint: string, signal: "traces" | "metrics" | "logs"): string {
  return `${endpoint.replace(/\/+$/, "")}/v1/${signal}`;
}

/**
 * W3C trace context only. Baggage is deliberately not propagated: it is free-form key/value
 * data that crosses service boundaries (and could carry PII or be injected by clients).
 */
export function w3cPropagator(): W3CTraceContextPropagator {
  return new W3CTraceContextPropagator();
}

// Starts are serialised so concurrent callers never race two SDKs onto the globals.
let starting: Promise<unknown> = Promise.resolve();

/**
 * Start the SDK and register it globally. Calling it again replaces the
 * previous SDK (after shutting it down), which keeps tests independent.
 * Concurrent calls run one after another; the last one wins.
 */
export function startSdk(opts: SdkOptions): Promise<TelemetryHandle> {
  const next = starting.then(
    () => doStart(opts),
    () => doStart(opts),
  );
  starting = next.catch(() => {});
  return next;
}

async function doStart(opts: SdkOptions): Promise<TelemetryHandle> {
  if (active) await active.shutdown();

  const [sdkNode, { OTLPTraceExporter }, { OTLPMetricExporter }, { OTLPLogExporter }, sdkTrace, sdkLogs, sdkMetrics] =
    await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@opentelemetry/exporter-trace-otlp-http"),
      import("@opentelemetry/exporter-metrics-otlp-http"),
      import("@opentelemetry/exporter-logs-otlp-http"),
      import("@opentelemetry/sdk-trace"),
      import("@opentelemetry/sdk-logs"),
      import("@opentelemetry/sdk-metrics"),
    ]);
  const { resourceFromAttributes, defaultResource } = await import("@opentelemetry/resources");
  const semconv = await import("@opentelemetry/semantic-conventions");

  const timeoutMillis = opts.exportTimeoutMillis ?? 10_000;
  const environment = opts.environment ?? process.env.NODE_ENV ?? "development";
  const resource = defaultResource().merge(
    resourceFromAttributes({
      [semconv.ATTR_SERVICE_NAME]: opts.serviceName,
      ...(opts.serviceVersion ? { [semconv.ATTR_SERVICE_VERSION]: opts.serviceVersion } : {}),
      // Both the stable-track and the legacy key, so dashboards on either semconv match.
      "deployment.environment.name": environment,
      "deployment.environment": environment,
      ...opts.resourceAttributes,
    }),
  );
  const delay = opts.batchDelayMillis !== undefined ? { scheduledDelayMillis: opts.batchDelayMillis } : {};

  const sdk = new sdkNode.NodeSDK({
    resource,
    // Detectors would add host/process attributes we do not need, and some touch Node-only APIs.
    autoDetectResources: false,
    instrumentations: [],
    textMapPropagator: w3cPropagator(),
    spanProcessors: [
      new sdkTrace.BatchSpanProcessor({
        exporter: new OTLPTraceExporter({ url: signalUrl(opts.endpoint, "traces"), timeoutMillis }),
        exportTimeoutMillis: timeoutMillis,
        ...delay,
      }),
    ],
    metricReaders: [
      new sdkMetrics.PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: signalUrl(opts.endpoint, "metrics"), timeoutMillis }),
        exportIntervalMillis: opts.metricIntervalMillis ?? 15_000,
        exportTimeoutMillis: Math.min(timeoutMillis, opts.metricIntervalMillis ?? 15_000),
      }),
    ],
    logRecordProcessors: [
      new sdkLogs.BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({ url: signalUrl(opts.endpoint, "logs"), timeoutMillis }),
        exportTimeoutMillis: timeoutMillis,
        ...delay,
      }),
    ],
  });
  sdk.start();

  let stopped: Promise<void> | undefined;
  const handle: TelemetryHandle = {
    shutdown: () => {
      // Idempotent: graceful-shutdown paths may call this more than once.
      stopped ??= sdk.shutdown().finally(() => {
        // NodeSDK leaves the globals registered; clear them so a later start (or tests) can re-register.
        trace.disable();
        metrics.disable();
        logs.disable();
        propagation.disable();
        context.disable();
        if (active === handle) active = undefined;
      });
      return stopped;
    },
  };
  active = handle;
  return handle;
}

registerSdk((opts) => startSdk({ ...opts, endpoint: opts.endpoint ?? "" }));

/* ----------------------------------------------------------------------------
 * Spans
 * ------------------------------------------------------------------------- */

const SCRUB: [RegExp, string][] = [
  // Postgres constraint details: `Key (email)=(a@b.test) already exists.`
  [/(Key \([^)]*\)=\()[^)]*(\))/g, "$1[redacted]$2"],
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]"],
  [/\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi, "[ip]"],
  [/\b(bearer|basic)\s+[\w.~+/=-]+/gi, "$1 [redacted]"],
  [
    /\b(pass(?:word)?|secret|token|authorization|cookie|api_?key|stream_?key)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
    "$1$2[redacted]",
  ],
  // Long opaque strings (keys, tokens, signatures); UUIDs are kept (hyphenated, short segments).
  [/[A-Za-z0-9+_]{32,}={0,2}/g, "[redacted]"],
];

/**
 * Error text is free-form and often embeds user data (constraint values, emails, tokens in
 * URLs). Scrub it before it becomes a span status or exception event; the logger's rule is the
 * same: no PII or secrets in telemetry.
 */
export function scrubErrorText(text: string): string {
  return SCRUB.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
}

function recordFailure(span: Span, err: unknown): void {
  const name = err instanceof Error ? err.name : typeof err;
  const message = scrubErrorText(err instanceof Error ? err.message : String(err));
  const stack = err instanceof Error && err.stack ? scrubErrorText(err.stack) : undefined;
  span.recordException({ name, message, ...(stack ? { stack } : {}) });
  span.setStatus({ code: SpanStatusCode.ERROR, message });
}

/** Run `fn` inside an active span; errors are recorded on the span and rethrown. */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => T | Promise<T>,
  options: SpanOptions = {},
): Promise<T> {
  return trace.getTracer(SCOPE).startActiveSpan(name, options, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      recordFailure(span, err);
      throw err;
    } finally {
      span.end();
    }
  });
}

const headerGetter: TextMapGetter<Headers> = {
  keys: (carrier) => [...carrier.keys()],
  get: (carrier, key) => carrier.get(key) ?? undefined,
};

const headerSetter: TextMapSetter<Headers> = {
  set: (carrier, key, value) => carrier.set(key, value),
};

/** Extract the W3C trace context from incoming headers (ROOT_CONTEXT when absent). */
export function extractContext(headers: Headers): Context {
  return propagation.extract(ROOT_CONTEXT, headers, headerGetter);
}

/** Inject the active (or given) context into outgoing headers as `traceparent`/`tracestate`. */
export function injectContext(headers: Headers, ctx: Context = context.active()): Headers {
  propagation.inject(ctx, headers, headerSetter);
  return headers;
}

/* ----------------------------------------------------------------------------
 * HTTP server helper for Bun.serve
 * ------------------------------------------------------------------------- */

export interface TraceHandlerOptions {
  /**
   * Low-cardinality route template for span names and metrics, e.g. `/channels/:id`.
   * Never return raw paths with ids: they explode metric cardinality.
   */
  route?: (req: Request) => string | undefined;
  /**
   * Continue the caller's trace from `traceparent`. Only for internal services whose callers
   * are other CommonAir services. Public endpoints (the default) start a new root span and
   * keep the remote context as a span link, so clients cannot force sampling or join traces.
   */
  trustIncomingContext?: boolean;
  /** Record the raw `url.path` (may contain ids or tokens). Off by default; `http.route` is recorded. */
  recordPath?: boolean;
}

type FetchHandler<A extends unknown[]> = (req: Request, ...rest: A) => Response | Promise<Response>;

/**
 * Wrap a `Bun.serve` fetch handler: creates a SERVER span named `METHOD route`
 * (a new root linked to any incoming `traceparent`, or its child with
 * `trustIncomingContext`), records the response status (5xx and thrown errors
 * mark the span as failed) and a request-duration histogram.
 */
export function traceHandler<A extends unknown[]>(
  handler: FetchHandler<A>,
  opts: TraceHandlerOptions = {},
): (req: Request, ...rest: A) => Promise<Response> {
  return async (req, ...rest) => {
    const url = new URL(req.url);
    const route = opts.route?.(req);
    const remote = extractContext(req.headers);
    const remoteSpan = trace.getSpanContext(remote);
    const parent = opts.trustIncomingContext ? remote : ROOT_CONTEXT;
    const links: Link[] =
      !opts.trustIncomingContext && remoteSpan && trace.isSpanContextValid(remoteSpan) ? [{ context: remoteSpan }] : [];
    const startedAt = performance.now();
    const span = trace.getTracer(SCOPE).startSpan(
      route ? `${req.method} ${route}` : req.method,
      {
        kind: SpanKind.SERVER,
        links,
        attributes: {
          "http.request.method": req.method,
          ...(opts.recordPath ? { "url.path": url.pathname } : {}),
          "url.scheme": url.protocol.replace(/:$/, ""),
          "server.address": url.hostname,
          ...(route ? { "http.route": route } : {}),
          ...(req.headers.get("user-agent") ? { "user_agent.original": req.headers.get("user-agent") ?? "" } : {}),
        },
      },
      parent,
    );
    let status = 500;
    try {
      const res = await context.with(trace.setSpan(parent, span), () => handler(req, ...rest));
      status = res.status;
      span.setAttribute("http.response.status_code", status);
      if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      return res;
    } catch (err) {
      span.setAttribute("http.response.status_code", status);
      recordFailure(span, err);
      throw err;
    } finally {
      span.end();
      // Looked up per request: the global MeterProvider may be registered after this wrapper
      // is built, and the SDK returns the same instrument for a repeated name.
      metrics
        .getMeter(SCOPE)
        .createHistogram("http.server.request.duration", { unit: "s" })
        .record((performance.now() - startedAt) / 1000, {
          "http.request.method": req.method,
          "http.response.status_code": status,
          ...(route ? { "http.route": route } : {}),
        });
    }
  };
}

/* ----------------------------------------------------------------------------
 * Outbound fetch
 * ------------------------------------------------------------------------- */

export interface TracedFetchOptions {
  /**
   * Hosts that receive `traceparent`: other CommonAir services, as `host` or `host:port`
   * (e.g. `new URL(env.API_INTERNAL_URL).host`). Every other destination gets a CLIENT span
   * but no trace headers, so trace ids never leak to third parties.
   */
  propagateTo?: readonly string[];
  /** Underlying fetch; by default the global one, looked up per call so overrides apply. */
  fetch?: typeof fetch;
}

/** Build a fetch that creates CLIENT spans and injects `traceparent` for internal hosts only. */
export function createTracedFetch(opts: TracedFetchOptions = {}): typeof fetch {
  const internal = new Set((opts.propagateTo ?? []).map((h) => h.toLowerCase()));
  const base = () => opts.fetch ?? fetch;
  const traced = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    const url = new URL(request.url);
    const propagate = internal.has(url.host.toLowerCase()) || internal.has(url.hostname.toLowerCase());
    return trace.getTracer(SCOPE).startActiveSpan(
      request.method,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "http.request.method": request.method,
          "server.address": url.hostname,
          ...(url.port ? { "server.port": Number(url.port) } : {}),
          // Path only: query strings can carry tokens.
          "url.full": `${url.origin}${url.pathname}`,
        },
      },
      async (span) => {
        const headers = new Headers(request.headers);
        if (propagate) injectContext(headers);
        try {
          const res = await base()(new Request(request, { headers }));
          span.setAttribute("http.response.status_code", res.status);
          if (res.status >= 400) span.setStatus({ code: SpanStatusCode.ERROR });
          return res;
        } catch (err) {
          recordFailure(span, err);
          throw err;
        } finally {
          span.end();
        }
      },
    );
  };
  const preconnect: typeof fetch.preconnect = (...args) => base().preconnect(...args);
  return Object.assign(traced, { preconnect });
}

/** `fetch` with CLIENT spans and no trace-header propagation; use `createTracedFetch` for internal calls. */
export const tracedFetch: typeof fetch = createTracedFetch();

/* ----------------------------------------------------------------------------
 * Logger bridge
 * ------------------------------------------------------------------------- */

const SEVERITY: Record<string, SeverityNumber> = {
  trace: SeverityNumber.TRACE,
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
  fatal: SeverityNumber.FATAL,
};

// The logger already puts these in the record's own fields (or the resource).
const RESERVED = new Set(["time", "level", "msg", "trace_id", "span_id", "service"]);

function toAttribute(value: unknown): AnyValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  return JSON.stringify(value);
}

/**
 * A `write` target for `createLogger` that forwards each JSON line to the
 * global OTel LoggerProvider (a no-op until the SDK starts). The logger has
 * already redacted PII; the active span context is attached by the SDK.
 */
export function otelLogSink(): (line: string) => void {
  const logger = logs.getLogger(SCOPE);
  return (line) => {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      logger.emit({ severityNumber: SeverityNumber.INFO, body: line });
      return;
    }
    const level = typeof entry.level === "string" ? entry.level : "info";
    const attributes: Record<string, AnyValue> = {};
    for (const [k, v] of Object.entries(entry)) if (!RESERVED.has(k)) attributes[k] = toAttribute(v);
    const time = typeof entry.time === "string" ? new Date(entry.time) : new Date();
    logger.emit({
      timestamp: Number.isNaN(time.getTime()) ? new Date() : time,
      severityNumber: SEVERITY[level] ?? SeverityNumber.INFO,
      severityText: level.toUpperCase(),
      body: typeof entry.msg === "string" ? entry.msg : line,
      attributes,
    });
  };
}

/** Default stdout writer, matching the logger's own default. */
export const stdoutWrite = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/** Write each line to `write` (stdout by default) and to OTel logs. */
export function teeToOtel(write: (line: string) => void = stdoutWrite): (line: string) => void {
  const sink = otelLogSink();
  return (line) => {
    write(line);
    sink(line);
  };
}
