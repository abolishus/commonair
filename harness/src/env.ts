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

export const harnessEnvSchema = z.object({
  HARNESS_API_URL: z.url().default("http://localhost:3001"),
  HARNESS_WEB_URL: z.url().default("http://localhost:3000"),
  HARNESS_ORIGIN_URL: z.url().default("http://localhost:3003"),
  /** Mailpit HTTP API (verification emails). */
  HARNESS_MAILPIT_URL: z.url().default("http://localhost:8025"),
  /** Mailpit basic auth as `user:password` (its `MP_UI_AUTH`), e.g. for Railway staging. */
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
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
});

export type HarnessEnv = z.output<typeof harnessEnvSchema>;

export function loadHarnessEnv(source: Record<string, string | undefined> = process.env): HarnessEnv {
  return loadEnv(harnessEnvSchema, source);
}
