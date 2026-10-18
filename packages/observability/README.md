<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# @commonair/observability

Structured logging and OpenTelemetry for every CommonAir service.

## Start telemetry first

```ts
import { createLogger, initTelemetry, teeToOtel } from "@commonair/observability";

const telemetry = await initTelemetry({ serviceName: "api", serviceVersion: process.env.SOURCE_COMMIT });
const log = createLogger({ service: "api", write: teeToOtel() }); // stdout + OTLP logs
// … on shutdown
await telemetry.shutdown();
```

`initTelemetry` is a no-op unless `OTEL_EXPORTER_OTLP_ENDPOINT` (or `endpoint`) is set. With it,
`startSdk` (from `src/sdk.ts`, registered on import) starts `@opentelemetry/sdk-node` with:

- OTLP/HTTP (JSON) exporters for traces, metrics and logs at `<endpoint>/v1/{traces,metrics,logs}`;
- batch span and log processors, a periodic metric reader every 15 s;
- resource attributes `service.name`, `service.version`, `deployment.environment` (and
  `deployment.environment.name`) from `NODE_ENV`;
- W3C trace-context + baggage propagation. Shutdown flushes and unregisters the globals.

## Manual instrumentation (Bun)

Bun does not run Node's require hooks, so there are **no auto-instrumentations**. Use:

```ts
import { traceHandler, tracedFetch, withSpan } from "@commonair/observability";

Bun.serve({
  // SERVER span per request, continues incoming `traceparent`, records status + duration histogram.
  fetch: traceHandler(app.fetch, { route: (req) => router.match(req)?.template }),
});

await withSpan("ledger.post", async (span) => { span.setAttribute("entries", 2); … });

const res = await tracedFetch(`${apiUrl}/internal/…`); // CLIENT span + `traceparent` header
```

`route` must return a low-cardinality template (`/channels/:id`), never a raw path. Client spans
record `url.full` without the query string so tokens never reach telemetry. `createTracedFetch(base)`
wraps another fetch implementation; `extractContext` / `injectContext` handle other carriers.

## Logs

`createLogger` writes one redacted JSON object per line. `otelLogSink()` is a `write` target that
forwards those lines to the OTel LoggerProvider (severity from `level`, body from `msg`, other
fields as attributes, trace/span ids from the active span); `teeToOtel(write?)` writes to stdout
(or `write`) **and** OTel. Before the SDK starts, the sink is a no-op.

## Tests

`bun run test` runs the real SDK under Bun against an in-process OTLP/HTTP receiver: spans,
metrics and logs arrive with resource attributes, and `traceparent` flows client → server → child.
