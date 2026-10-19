// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { SITE, type InstanceSite } from "./site.ts";

/**
 * Environment schemas, composed per service. Every service validates its
 * environment at startup with `loadEnv()` and refuses to boot on bad config.
 * `.env.example` documents every variable defined here; a test keeps them in sync.
 */

const bool = z.enum(["true", "false", "1", "0", ""]).transform((v) => v === "true" || v === "1");
const csv = z.string().transform((v) =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const port = z.coerce.number().int().min(1024).max(65535);
const secret = z.string().min(32, "secrets must be at least 32 characters");

const coreShape = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  PUBLIC_URL: z.url().default("http://localhost:3000"),
  /** Public base of the API as browsers, bots and relays reach it (no trailing slash). */
  API_PUBLIC_URL: z.url().default("http://localhost:3001"),
  /** Public chat WebSocket URL. */
  CHAT_PUBLIC_URL: z.string().default("ws://localhost:3002/ws"),
  /** Public IRC gateway host and ports shown in developer docs. */
  IRC_PUBLIC_HOST: z.string().default("localhost"),
  INSTANCE_NAME: z.string().min(1).default(SITE.name),
  INSTANCE_IS_FLAGSHIP: bool.default(false),
  CONTACT_EMAIL: z.email().optional(),
  SECURITY_EMAIL: z.email().optional(),
  ABUSE_EMAIL: z.email().optional(),
  DMCA_EMAIL: z.email().optional(),
  PRIVACY_EMAIL: z.email().optional(),
  /** Sender for automated mail; defaults to the flagship noreply on the flagship, else noreply@<public host>. */
  NOREPLY_EMAIL: z.email().optional(),
  SOURCE_URL: z.url().default(SITE.repository.url),
  SOURCE_COMMIT: z.string().default("unknown"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  OTEL_SERVICE_NAME: z.string().optional(),
  /** Proxies whose X-Forwarded-For is trusted (comma-separated CIDRs), e.g. Caddy's network. */
  TRUSTED_PROXY_CIDRS: csv.default([]),
});

/**
 * A production instance other than the co-op's flagship must publish its own contacts:
 * otherwise security, abuse, DMCA and privacy reports would be routed to the flagship.
 */
export const coreEnv = coreShape.superRefine((env, ctx) => {
  if (env.NODE_ENV !== "production" || env.INSTANCE_IS_FLAGSHIP) return;
  for (const key of ["CONTACT_EMAIL", "SECURITY_EMAIL", "ABUSE_EMAIL", "DMCA_EMAIL", "PRIVACY_EMAIL"] as const) {
    if (!env[key])
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: "required for production instances other than the flagship",
      });
  }
});

export const databaseEnv = z.object({
  DATABASE_URL: z.url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  /** Password of the least-privilege application role (compose creates `commonair_app`). */
  POSTGRES_APP_PASSWORD: z.string().optional(),
  /**
   * First-run governance values (JSON: { "<setting key>": { field: value } }), applied only when a
   * setting does not exist yet. Lets a test instance use short review periods. Ignored afterwards.
   */
  GOVERNANCE_BOOTSTRAP_JSON: z.string().optional(),
});

export const valkeyEnv = z.object({
  VALKEY_URL: z.url(),
});

export const internalEnv = z.object({
  /** Shared secret for service-to-service calls (chat → api, media → api, worker → api). */
  INTERNAL_API_SECRET: secret,
  API_INTERNAL_URL: z.url().default("http://localhost:3001"),
  CHAT_INTERNAL_URL: z.string().default("ws://localhost:3002/ws"),
  ORIGIN_INTERNAL_URL: z.url().default("http://localhost:3003"),
});

export const storageEnv = z.object({
  S3_ENDPOINT: z.url(),
  S3_PUBLIC_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().default("garage"),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: bool.default(true),
  S3_BUCKET_MEDIA: z.string().default("commonair-media"),
  S3_BUCKET_EXPORTS: z.string().default("commonair-exports"),
  S3_BUCKET_BACKUPS: z.string().default("commonair-backups"),
});

export const authEnv = z.object({
  AUTH_SECRET: secret,
  AUTH_TRUSTED_ORIGINS: csv.default([]),
  AUTH_MIN_AGE: z.coerce.number().int().min(13).default(13),
  ALTCHA_HMAC_KEY: secret,
  /**
   * Allow demo fixture accounts (`DEMO_FIXTURES` in contracts: reserved `demo_` usernames on the
   * `.invalid` fixture domain) to sign up. Local and staging only; refused in production.
   */
  DEMO_SEED_ENABLED: bool.default(false),
  OAUTH_DISCORD_CLIENT_ID: z.string().optional(),
  OAUTH_DISCORD_CLIENT_SECRET: z.string().optional(),
  OAUTH_TWITCH_CLIENT_ID: z.string().optional(),
  OAUTH_TWITCH_CLIENT_SECRET: z.string().optional(),
  OAUTH_GITHUB_CLIENT_ID: z.string().optional(),
  OAUTH_GITHUB_CLIENT_SECRET: z.string().optional(),
});

export const mailEnv = z.object({
  SMTP_HOST: z.string().default("localhost"),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_SECURE: bool.default(false),
  /** Refuse to send credentials or mail without TLS (STARTTLS). Leave false only for a local catcher like Mailpit. */
  SMTP_REQUIRE_TLS: bool.default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().optional(),
});

export const paymentsEnv = z.object({
  /** `manual` (default, no vendor) or `stripe` (test mode only in this build). */
  PAYMENTS_PROVIDER: z.enum(["manual", "stripe"]).default("manual"),
  STRIPE_SECRET_KEY: z
    .string()
    .refine((k) => !k.startsWith("sk_live_") && !k.startsWith("rk_live_"), "live Stripe keys are refused")
    .optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  /** Override the Stripe API base, e.g. a local stripe-mock in the harness. */
  STRIPE_API_BASE: z.url().optional(),
  PAYOUT_MINIMUM_CENTS: z.coerce.number().int().nonnegative().default(2500),
  CURRENCY: z.string().length(3).default("usd"),
});

export const mediaEnv = z.object({
  /**
   * Password for the MediaMTX-internal user (origin and media read RTSP/HLS and publish renditions).
   * Separate from INTERNAL_API_SECRET because it appears in ffmpeg process arguments.
   */
  MEDIA_INTERNAL_PASSWORD: secret,
  MEDIAMTX_API_URL: z.url().default("http://localhost:9997"),
  MEDIAMTX_HLS_URL: z.url().default("http://localhost:8888"),
  MEDIAMTX_RTSP_URL: z.string().default("rtsp://localhost:8554"),
  MEDIAMTX_RTMP_URL: z.string().default("rtmp://localhost:1935"),
  /** Public ingest endpoints shown to streamers. */
  INGEST_RTMP_PUBLIC_URL: z.string().default("rtmp://localhost:1935/live"),
  INGEST_WHIP_PUBLIC_URL: z.url().default("http://localhost:8889/live"),
  TRANSCODE_VIEWER_THRESHOLD: z.coerce.number().int().nonnegative().default(50),
  TRANSCODE_HWACCEL: z.enum(["auto", "nvenc", "none"]).default("auto"),
  /** CSAM hash-match hook: `none` (default) or `stub` (matches SHA-256s listed in HASH_MATCH_LIST_FILE; harness only). */
  HASH_MATCH_PROVIDER: z.enum(["none", "stub"]).default("none"),
  HASH_MATCH_LIST_FILE: z.string().optional(),
  /** Scratch space for recordings, clip cuts and thumbnails (defaults to <tmpdir>/commonair-media). */
  MEDIA_WORK_DIR: z.string().optional(),
  /** Most bytes the work dir may hold before new recordings and clips are refused (default 20 GiB). */
  MEDIA_WORK_DIR_MAX_BYTES: z.coerce.number().int().positive().default(21_474_836_480),
  /** Free space the work dir's filesystem must keep (default 2 GiB). */
  MEDIA_WORK_DIR_MIN_FREE_BYTES: z.coerce.number().int().nonnegative().default(2_147_483_648),
  /** Concurrent adaptive ladders per host; unset picks 2 with NVENC or one per 4 CPU cores. */
  TRANSCODE_MAX_LADDERS: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().positive().optional()),
});

export const playbackEnv = z.object({
  /** Ed25519 private key (PKCS#8 DER, base64) used to sign playback/segment tokens. */
  PLAYBACK_SIGNING_KEY: z.string().min(1),
  /** Public origin of the HLS edge (origin service), no trailing slash. */
  PLAYBACK_PUBLIC_URL: z.url().default("http://localhost:3003"),
  P2P_ENABLED: bool.default(true),
  P2P_TRACKER_URL: z.string().default("ws://localhost:8000"),
  /** Optional burst CDN (origin-pull). Disabled by default. */
  CDN_PROVIDER: z.enum(["none", "origin-pull"]).default("none"),
  CDN_BASE_URL: z.url().optional(),
  CDN_BURST_VIEWER_THRESHOLD: z.coerce.number().int().positive().default(5000),
  ORIGIN_CACHE_MB: z.coerce.number().int().positive().default(512),
  /** Compute relay issuance on this origin; replicas elect one leader per tick through Valkey. */
  ORIGIN_ISSUANCE_ENABLED: bool.default(true),
});

export const integrityEnv = z.object({
  /** Operator-supplied hosting-provider CIDR list (one per line) for datacenter detection. */
  INTEGRITY_DATACENTER_CIDRS_FILE: z.string().optional(),
});

export const developerEnv = z.object({
  /** Allow http:// and private-network EventSub webhook callbacks. Development and harness only. */
  EVENTSUB_ALLOW_INSECURE_CALLBACKS: bool.default(false),
  /**
   * Allow relay URLs and simulcast targets on private, loopback and other non-public networks
   * (and plain http relays). Development and harness only: the local stack runs on such addresses.
   */
  OUTBOUND_ALLOW_PRIVATE_NETWORKS: bool.default(false),
});

export const workerEnv = z.object({
  /** Per-queue concurrency, e.g. "webhooks=32,retention=1". Unlisted queues use defaults. */
  WORKER_CONCURRENCY: z.string().default(""),
  /** BullMQ key prefix in Valkey. */
  WORKER_BULL_PREFIX: z.string().min(1).default("bull"),
});

/**
 * Variables read only by compose/Quadlet and infrastructure containers (not by Bun services).
 * Kept here so `.env.example` stays the single documented list.
 */
export const infraEnv = z.object({
  POSTGRES_PASSWORD: z.string().min(1).optional(),
  /** Garage requires exactly 64 hex characters. */
  GARAGE_RPC_SECRET: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  GARAGE_ADMIN_TOKEN: z.string().min(32).optional(),
  GRAFANA_ADMIN_PASSWORD: z.string().min(16).optional(),
  /** Host interface for published ports (default 127.0.0.1). */
  BIND_ADDRESS: z.string().optional(),
  /** Public hostname Caddy serves with TLS (profile `tls`). */
  PUBLIC_HOSTNAME: z.string().optional(),
  IMAGE_REGISTRY: z.string().optional(),
  IMAGE_TAG: z.string().optional(),
  WALG_RETAIN_FULL: z.coerce.number().int().positive().optional(),
  /** Compose network subnet (default 10.89.42.0/24); a second stack on one host needs its own. */
  COMPOSE_SUBNET: z.string().optional(),
  COMMONAIR_ENV_FILE: z.string().optional(),
});

export const servicePorts = z.object({
  WEB_PORT: port.default(3000),
  API_PORT: port.default(3001),
  CHAT_PORT: port.default(3002),
  ORIGIN_PORT: port.default(3003),
  IRC_PORT: port.default(6667),
  IRC_TLS_PORT: port.default(6697),
  IRC_WS_PORT: port.default(6680),
  IRC_HEALTH_PORT: port.default(6681),
  MEDIA_PORT: port.default(3004),
  WORKER_PORT: port.default(3005),
  TRACKER_PORT: port.default(8000),
  IRC_TLS_CERT_FILE: z.string().optional(),
  IRC_TLS_KEY_FILE: z.string().optional(),
  /**
   * Let a production instance run the IRC TLS listener on an ephemeral self-signed certificate
   * when no files are configured. For hosts that do not expose the TLS port (e.g. Railway).
   */
  IRC_TLS_ALLOW_SELF_SIGNED: z
    .enum(["true", "false", "1", "0", ""])
    .transform((v) => v === "true" || v === "1")
    .default(false),
});

/** IRC gateway admission limits (per process). */
export const ircEnv = z.object({
  IRC_MAX_CONNECTIONS: z.coerce.number().int().positive().default(20_000),
  IRC_MAX_CONNECTIONS_PER_IP: z.coerce.number().int().positive().default(50),
  /** Token bucket for new connections per client address: burst size and refill rate. */
  IRC_CONNECT_BURST_PER_IP: z.coerce.number().int().positive().default(20),
  IRC_CONNECT_PER_SECOND_PER_IP: z.coerce.number().positive().default(2),
});

export class EnvError extends Error {
  constructor(public readonly issues: z.core.$ZodIssue[]) {
    super(`Invalid environment:\n${issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
    this.name = "EnvError";
  }
}

/** Parse `source` (default `process.env`) against `schema`; throws EnvError listing every problem. */
export function loadEnv<S extends z.ZodType>(
  schema: S,
  source: Record<string, string | undefined> = process.env,
): z.output<S> {
  // Treat empty strings as unset so `.env.example`-style blank values fall back to defaults.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ""));
  const result = schema.safeParse(cleaned);
  if (!result.success) throw new EnvError(result.error.issues);
  return result.data;
}

/** Instance-facing identity derived from core env. */
export function instanceSite(env: z.output<typeof coreShape>): InstanceSite {
  return {
    name: env.INSTANCE_NAME,
    publicUrl: env.PUBLIC_URL.replace(/\/+$/, ""),
    isFlagship: env.INSTANCE_IS_FLAGSHIP,
    sourceUrl: env.SOURCE_URL,
    sourceCommit: env.SOURCE_COMMIT,
    contacts: {
      ...SITE.contacts,
      ...(env.CONTACT_EMAIL ? { general: env.CONTACT_EMAIL } : {}),
      ...(env.SECURITY_EMAIL ? { security: env.SECURITY_EMAIL } : {}),
      ...(env.ABUSE_EMAIL ? { abuse: env.ABUSE_EMAIL } : {}),
      ...(env.DMCA_EMAIL ? { dmca: env.DMCA_EMAIL } : {}),
      ...(env.PRIVACY_EMAIL ? { privacy: env.PRIVACY_EMAIL } : {}),
      noreply:
        env.NOREPLY_EMAIL ??
        (env.INSTANCE_IS_FLAGSHIP ? SITE.contacts.noreply : `noreply@${new URL(env.PUBLIC_URL).hostname}`),
    },
  };
}

/** Every env schema, for documentation and the `.env.example` sync test. */
export const ALL_ENV_SCHEMAS = {
  coreEnv: coreShape,
  databaseEnv,
  valkeyEnv,
  internalEnv,
  storageEnv,
  authEnv,
  mailEnv,
  paymentsEnv,
  mediaEnv,
  playbackEnv,
  integrityEnv,
  developerEnv,
  workerEnv,
  infraEnv,
  servicePorts,
  ircEnv,
} as const;
