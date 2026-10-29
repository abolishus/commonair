// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Harness configuration. The harness is a client of the stack, not a service, so its variables
 * live here rather than in `@commonair/config`; defaults match `compose.yaml` and `.env.example`.
 */
import { loadEnv } from "@commonair/config";
import { z } from "zod";

const csv = z.string().transform((v) =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

/** Optional string; empty or whitespace = unset. */
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v?.trim() ? v.trim() : undefined));

export const harnessEnvSchema = z.object({
  HARNESS_API_URL: z.url().default("http://localhost:3001"),
  HARNESS_WEB_URL: z.url().default("http://localhost:3000"),
  HARNESS_ORIGIN_URL: z.url().default("http://localhost:3003"),
  /** Mailpit HTTP API (verification emails). */
  HARNESS_MAILPIT_URL: z.url().default("http://localhost:8025"),
  /** Mailpit basic auth as `user:password` (its `MP_UI_AUTH`), e.g. for a remote staging instance. */
  HARNESS_MAILPIT_AUTH: z.string().optional(),
  /** The instance's STRIPE_WEBHOOK_SECRET, for signing Stripe events in `e4b-money --set provider=stripe`. */
  HARNESS_STRIPE_WEBHOOK_SECRET: z.string().optional(),
  /** MediaMTX RTMP ingest base (the harness appends `/live/<stream key>`). */
  HARNESS_RTMP_URL: z.string().default("rtmp://localhost:1935"),
  /** MediaMTX WebRTC base (the harness appends `/live/<slug>/whip`). */
  HARNESS_WHIP_URL: z.url().default("http://localhost:8889"),
  /** IRC gateway WebSocket listener (tmi.js). */
  HARNESS_IRC_WS_URL: z.string().default("ws://localhost:6680"),
  /** Health endpoints used to decide whether a scenario's needs are met. */
  HARNESS_CHAT_HEALTH_URL: z.url().default("http://localhost:3002/healthz"),
  HARNESS_IRC_HEALTH_URL: z.url().default("http://localhost:6681/healthz"),
  HARNESS_WORKER_HEALTH_URL: z.url().default("http://localhost:3005/healthz"),
  /** stripe-mock (only probed for scenarios that need Stripe). */
  HARNESS_STRIPE_MOCK_URL: z.url().default("http://localhost:12111"),
  /** The tracker's WebSocket URL (P2P viewers reach it through the harness tracker proxy). */
  HARNESS_TRACKER_URL: z.string().default("ws://localhost:8000"),
  /**
   * Fixed loopback port of the harness tracker proxy; harness/compose.p2p.yaml points the API's
   * P2P_TRACKER_URL at it.
   */
  HARNESS_TRACKER_PROXY_PORT: z.coerce.number().int().min(1024).max(65535).default(8010),
  /**
   * `developer-platform` (E9): the host name the stack's containers use to reach the harness
   * webhook receiver on this machine (Podman resolves `host.containers.internal`).
   */
  HARNESS_WEBHOOK_HOST: z.string().default("host.containers.internal"),
  /** `harness` = the harness player page; `web` = the web app's `/embed/<channel>` route. */
  HARNESS_PLAYER: z.enum(["harness", "web"]).default("harness"),
  /** Prometheus HTTP API for load-test metrics; unset = skip Prometheus queries. */
  HARNESS_PROMETHEUS_URL: z.url().optional(),
  /** Container name prefix for `podman stats` CPU sampling. */
  HARNESS_CONTAINER_PREFIX: z.string().default("commonair"),
  HARNESS_REPORT_DIR: z.string().optional(),
  /** Datacenter CIDR list for viewbots (defaults to the bundled sample). */
  HARNESS_DATACENTER_CIDRS_FILE: z.string().optional(),
  /** Address pool for well-behaved simulated users (defaults to the bundled sample). */
  HARNESS_RESIDENTIAL_CIDRS_FILE: z.string().optional(),
  /** Domain for simulated users' email addresses (delivered to Mailpit, never the internet). */
  HARNESS_EMAIL_DOMAIN: z.string().default("harness.test"),
  /** Comma-separated Playwright engines for browser viewers. */
  HARNESS_BROWSERS: csv.default(["chromium", "webkit"]),
  HARNESS_HEADFUL: z
    .enum(["true", "false", "1", "0", ""])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  /**
   * Postgres of the stack under test (Bun loads it from the repo `.env`). Optional: only the
   * scenario steps that use the operator role CLI or read the ledger need it; empty = unset.
   */
  DATABASE_URL: z
    .string()
    .optional()
    .transform((v) => (v?.trim() ? v.trim() : undefined)),
  /**
   * `trust-safety`: the instance's INTERNAL_API_SECRET for the test-hook routes. Unset = the
   * `INTERNAL_API_SECRET` Bun loaded from the repo `.env`.
   */
  HARNESS_INTERNAL_API_SECRET: optionalString,
  /** `trust-safety`: the media bucket (read-only listing that nothing was published), from the repo `.env`. */
  S3_ENDPOINT: optionalString,
  S3_REGION: optionalString,
  S3_ACCESS_KEY_ID: optionalString,
  S3_SECRET_ACCESS_KEY: optionalString,
  S3_BUCKET_MEDIA: optionalString,
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
});

export type HarnessEnv = z.output<typeof harnessEnvSchema>;

/**
 * Local defaults follow the host ports compose publishes (`WEB_PORT` etc., from the repo `.env`),
 * so a stack moved off a busy port is still found. An explicit `HARNESS_*` value always wins.
 */
export function localDefaults(source: Record<string, string | undefined>): Record<string, string> {
  const port = (name: string, fallback: number) => source[name]?.trim() || String(fallback);
  return {
    HARNESS_API_URL: `http://localhost:${port("API_PORT", 3001)}`,
    HARNESS_WEB_URL: `http://localhost:${port("WEB_PORT", 3000)}`,
    HARNESS_ORIGIN_URL: `http://localhost:${port("ORIGIN_PORT", 3003)}`,
    HARNESS_MAILPIT_URL: `http://localhost:${port("MAILPIT_HTTP_PORT", 8025)}`,
    HARNESS_RTMP_URL: `rtmp://localhost:${port("MEDIAMTX_RTMP_PORT", 1935)}`,
    HARNESS_WHIP_URL: `http://localhost:${port("MEDIAMTX_WEBRTC_PORT", 8889)}`,
    HARNESS_IRC_WS_URL: `ws://localhost:${port("IRC_WS_PORT", 6680)}`,
    HARNESS_CHAT_HEALTH_URL: `http://localhost:${port("CHAT_PORT", 3002)}/healthz`,
    HARNESS_IRC_HEALTH_URL: `http://localhost:${port("IRC_HEALTH_PORT", 6681)}/healthz`,
    HARNESS_WORKER_HEALTH_URL: `http://localhost:${port("WORKER_PORT", 3005)}/healthz`,
    HARNESS_STRIPE_MOCK_URL: `http://localhost:${port("STRIPE_MOCK_PORT", 12111)}`,
    HARNESS_TRACKER_URL: `ws://localhost:${port("TRACKER_PORT", 8000)}`,
  };
}

export function loadHarnessEnv(source: Record<string, string | undefined> = process.env): HarnessEnv {
  const merged = { ...source };
  for (const [key, value] of Object.entries(localDefaults(source))) if (!merged[key]?.trim()) merged[key] = value;
  return loadEnv(harnessEnvSchema, merged);
}
