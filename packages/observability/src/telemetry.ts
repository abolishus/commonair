// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Telemetry entry points. Services call `initTelemetry()` first thing and use
 * `meter()` / `tracer()` from here (backed by @opentelemetry/api, so they are
 * no-ops until an SDK is registered). The OTLP SDK wiring is registered by
 * `initTelemetry` when OTEL_EXPORTER_OTLP_ENDPOINT is set.
 */
import { metrics, trace, type Meter, type Tracer } from "@opentelemetry/api";

export interface TelemetryHandle {
  shutdown(): Promise<void>;
}

export interface TelemetryOptions {
  serviceName: string;
  serviceVersion?: string;
  endpoint?: string;
}

type SdkInit = (opts: Required<Pick<TelemetryOptions, "serviceName">> & TelemetryOptions) => Promise<TelemetryHandle>;
let sdkInit: SdkInit | undefined;

/** Registered by the SDK module (see ./sdk.ts) so the core stays dependency-light. */
export function registerSdk(init: SdkInit): void {
  sdkInit = init;
}

export async function initTelemetry(opts: TelemetryOptions): Promise<TelemetryHandle> {
  const endpoint = opts.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint || !sdkInit) return { shutdown: async () => {} };
  return sdkInit({ ...opts, endpoint });
}

export const meter = (name: string): Meter => metrics.getMeter(name);
export const tracer = (name: string): Tracer => trace.getTracer(name);
