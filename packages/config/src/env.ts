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
  /** `production` turns on the production checks (instance contacts, IRC TLS certificate files). */
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** Minimum level the services log. */
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  /** Public base URL of the web app; links in mail, auth origins and the default noreply domain derive from it. */
  PUBLIC_URL: z.url().default("http://localhost:3000"),
  /** Public base of the API as browsers, bots and relays reach it (no trailing slash). */
  API_PUBLIC_URL: z.url().default("http://localhost:3001"),
  /** Public chat WebSocket URL. */
  CHAT_PUBLIC_URL: z.string().default("ws://localhost:3002/ws"),
  /** Public IRC gateway host and ports shown in developer docs. */
  IRC_PUBLIC_HOST: z.string().default("localhost"),
  /** Name of this instance, shown in the UI, mail, legal documents and the IRC MOTD. */
  INSTANCE_NAME: z.string().min(1).default(SITE.name),
  /** Whether this is the co-op's flagship instance; in production, only the flagship may use the built-in contacts. */
  INSTANCE_IS_FLAGSHIP: bool.default(false),
  /** General contact address; required in production on instances other than the flagship. */
  CONTACT_EMAIL: z.email().optional(),
  /** Where security reports go; required in production on instances other than the flagship. */
  SECURITY_EMAIL: z.email().optional(),
  /** Where abuse reports go; required in production on instances other than the flagship. */
  ABUSE_EMAIL: z.email().optional(),
  /** Where copyright (DMCA) notices go; required in production on instances other than the flagship. */
  DMCA_EMAIL: z.email().optional(),
  /** Where privacy requests go; required in production on instances other than the flagship. */
  PRIVACY_EMAIL: z.email().optional(),
  /** Sender for automated mail; defaults to the flagship noreply on the flagship, else noreply@<public host>. */
  NOREPLY_EMAIL: z.email().optional(),
  /** Repository URL of the running source code, linked from the UI, legal documents and the IRC MOTD (AGPL). */
  SOURCE_URL: z.url().default(SITE.repository.url),
  /** Commit of the running build, appended to the source link; set by the container image build. */
  SOURCE_COMMIT: z.string().default("unknown"),
  /** OTLP/HTTP collector for traces and metrics; unset turns telemetry off. */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  /** Service name in telemetry; unset uses the service's own name (api, chat, …). */
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
  /** Postgres connection URL: the least-privilege app role for services, the owner role for migrations. */
  DATABASE_URL: z.url(),
  /** Most Postgres connections each service process holds. */
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
  /**
   * Valkey (Redis protocol) URL for presence, caches, rate limits and job queues. With a password
   * (VALKEY_PASSWORD), `redis://:<password>@host:6379`: init-env writes it that way.
   */
  VALKEY_URL: z.url(),
});

export const internalEnv = z.object({
  /** Shared secret for service-to-service calls (chat → api, media → api, worker → api). */
  INTERNAL_API_SECRET: secret,
  /** API base URL other services and MediaMTX's hooks call on the internal network. */
  API_INTERNAL_URL: z.url().default("http://localhost:3001"),
  /** Chat WebSocket URL the IRC gateway connects to; the API health check also probes it. */
  CHAT_INTERNAL_URL: z.string().default("ws://localhost:3002/ws"),
  /** Origin base URL on the internal network; the API health check probes its `/readyz`. */
  ORIGIN_INTERNAL_URL: z.url().default("http://localhost:3003"),
});

export const storageEnv = z.object({
  /** S3 endpoint the services use on the internal network (Garage by default). */
  S3_ENDPOINT: z.url(),
  /**
   * S3 endpoint browsers reach for presigned uploads and export downloads (not for public
   * media); unset means S3_ENDPOINT. Self-hosted: `https://<host>`, routed by Caddy (ADR 0024).
   */
  S3_PUBLIC_ENDPOINT: z.url().optional(),
  /**
   * Base URL of public media objects (`<base>/<key>`). The origin's `/media` route by default,
   * which serves only the public key prefixes (ADR 0009); a CDN or public bucket may replace it.
   */
  MEDIA_PUBLIC_URL: z.url().default("http://localhost:3003/media"),
  /** S3 region used to sign requests (`garage` for Garage). */
  S3_REGION: z.string().default("garage"),
  /** S3 access key for the media, exports and backups buckets (not the evidence bucket). */
  S3_ACCESS_KEY_ID: z.string().min(1),
  /** Secret of S3_ACCESS_KEY_ID. */
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  /** Use path-style S3 URLs (`<endpoint>/<bucket>/<key>`), as Garage needs. */
  S3_FORCE_PATH_STYLE: bool.default(true),
  /** Bucket for public media (avatars, thumbnails, clips, VODs) and moderation frames. */
  S3_BUCKET_MEDIA: z.string().default("commonair-media"),
  /** Bucket for personal data export archives, which users download through presigned URLs. */
  S3_BUCKET_EXPORTS: z.string().default("commonair-exports"),
  /** Bucket for WAL-G Postgres backups (prefix `wal/` unless WALG_S3_PREFIX is set). */
  S3_BUCKET_BACKUPS: z.string().default("commonair-backups"),
  /**
   * Sealed T0 evidence too large for Postgres (VOD and clip objects). Only the worker holds a
   * key for it (`evidenceStorageEnv`); the main key has no access at all (ADR 0006 Q4).
   */
  S3_BUCKET_EVIDENCE: z.string().default("commonair-evidence"),
});

export const authEnv = z.object({
  /** Secret that signs sessions and keys the HMACs of stored IP, device and mailbox hashes. */
  AUTH_SECRET: secret,
  /** Origins besides PUBLIC_URL that auth and CORS accept (comma-separated). */
  AUTH_TRUSTED_ORIGINS: csv.default([]),
  /** Minimum age to sign up, checked against the birth date; also filled into the legal documents. */
  AUTH_MIN_AGE: z.coerce.number().int().min(13).default(13),
  /** HMAC key for the ALTCHA proof-of-work challenges on sign-up and NCII reports. */
  ALTCHA_HMAC_KEY: secret,
  /** Discord OAuth client ID; sign-in with Discord is on when it and its secret are set. */
  OAUTH_DISCORD_CLIENT_ID: z.string().optional(),
  /** Discord OAuth client secret. */
  OAUTH_DISCORD_CLIENT_SECRET: z.string().optional(),
  /** Twitch OAuth client ID; sign-in with Twitch is on when it and its secret are set. */
  OAUTH_TWITCH_CLIENT_ID: z.string().optional(),
  /** Twitch OAuth client secret. */
  OAUTH_TWITCH_CLIENT_SECRET: z.string().optional(),
  /** GitHub OAuth client ID; sign-in with GitHub is on when it and its secret are set. */
  OAUTH_GITHUB_CLIENT_ID: z.string().optional(),
  /** GitHub OAuth client secret. */
  OAUTH_GITHUB_CLIENT_SECRET: z.string().optional(),
});

export const mailEnv = z.object({
  /** SMTP relay host for outgoing mail. */
  SMTP_HOST: z.string().default("localhost"),
  /** SMTP relay port. */
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  /** Connect with implicit TLS (usually port 465) instead of STARTTLS. */
  SMTP_SECURE: bool.default(false),
  /** Refuse to send credentials or mail without TLS (STARTTLS). Leave false only for a local catcher like Mailpit. */
  SMTP_REQUIRE_TLS: bool.default(false),
  /** SMTP username; when set, STARTTLS is required unless SMTP_SECURE is on. */
  SMTP_USER: z.string().optional(),
  /** SMTP password for SMTP_USER. */
  SMTP_PASSWORD: z.string().optional(),
  /** From header of outgoing mail; unset uses `"<instance name>" <NOREPLY_EMAIL>`. */
  MAIL_FROM: z.string().optional(),
});

export const paymentsEnv = z.object({
  /** `manual` (default, no vendor) or `stripe` (test mode only in this build). */
  PAYMENTS_PROVIDER: z.enum(["manual", "stripe"]).default("manual"),
  /** Stripe test-mode secret key (`sk_test_`/`rk_test_`), used when PAYMENTS_PROVIDER=stripe; live keys are refused. */
  STRIPE_SECRET_KEY: z
    .string()
    .refine((k) => !k.startsWith("sk_live_") && !k.startsWith("rk_live_"), "live Stripe keys are refused")
    .optional(),
  /** Signing secret of the Stripe webhook endpoint for platform-account events. */
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  /** Signing secret of the Connect webhook endpoint (connected accounts' `account.updated`). */
  STRIPE_CONNECT_WEBHOOK_SECRET: z.string().optional(),
  /** Override the Stripe API base, e.g. a local stripe-mock in the harness. */
  STRIPE_API_BASE: z.url().optional(),
  /**
   * Instance currency for prices and tips. Must equal the `payout.rules` governance setting's
   * currency (the payout minimum, schedule and hold period live there, not in env).
   */
  CURRENCY: z
    .string()
    .regex(/^[a-z]{3}$/)
    .default("usd"),
  /**
   * Manual adapter: what the payer is told after checkout. `{reference}` and `{amount}` are filled
   * in. Operator text, shown as is (not translated).
   */
  MANUAL_PAYMENT_INSTRUCTIONS: z
    .string()
    .min(1)
    .default(
      "Send {amount} to the co-op treasurer and quote the reference {reference}. It starts when the treasurer confirms the payment.",
    ),
  /** Manual adapter: shown on the creator's payout settings until the treasurer enables payouts. */
  MANUAL_PAYOUT_INSTRUCTIONS: z
    .string()
    .min(1)
    .default("Contact the co-op treasurer to set up how you are paid. Payouts start once they confirm it."),
  /** Days a pending (unconfirmed) payment stays open before it expires as failed. */
  PAYMENT_PENDING_DAYS: z.coerce.number().int().min(1).max(60).default(7),
});

export const mediaEnv = z.object({
  /**
   * Password for the MediaMTX-internal user (origin and media read RTSP/HLS and publish renditions).
   * Separate from INTERNAL_API_SECRET because it appears in ffmpeg process arguments.
   */
  MEDIA_INTERNAL_PASSWORD: secret,
  /** MediaMTX control API, used by media and by the API's health and live-moderation checks. */
  MEDIAMTX_API_URL: z.url().default("http://localhost:9997"),
  /** MediaMTX HLS server the origin pulls playlists and segments from. */
  MEDIAMTX_HLS_URL: z.url().default("http://localhost:8888"),
  /** MediaMTX RTSP server media reads streams from and publishes renditions to. */
  MEDIAMTX_RTSP_URL: z.string().default("rtsp://localhost:8554"),
  /** Public RTMP ingest URL shown to streamers (the server URL in OBS). */
  INGEST_RTMP_PUBLIC_URL: z.string().default("rtmp://localhost:1935/live"),
  /** Public WHIP ingest base shown to streamers; `/<channel>/whip` is appended. */
  INGEST_WHIP_PUBLIC_URL: z.url().default("http://localhost:8889/live"),
  /** Viewers above which a stream gets an adaptive ladder (after 30 s; it stops below 80% for 2 min). */
  TRANSCODE_VIEWER_THRESHOLD: z.coerce.number().int().nonnegative().default(50),
  /** `auto` uses NVENC when a test encode works, else the CPU; `nvenc` refuses to start without it; `none` always uses the CPU. */
  TRANSCODE_HWACCEL: z.enum(["auto", "nvenc", "none"]).default("auto"),
  /** Scratch space for recordings, clip cuts and thumbnails (defaults to <tmpdir>/commonair-media). */
  MEDIA_WORK_DIR: z.string().optional(),
  /** Most bytes the work dir may hold before new recordings and clips are refused (default 20 GiB). */
  MEDIA_WORK_DIR_MAX_BYTES: z.coerce.number().int().positive().default(21_474_836_480),
  /** Free space the work dir's filesystem must keep (default 2 GiB). */
  MEDIA_WORK_DIR_MIN_FREE_BYTES: z.coerce.number().int().nonnegative().default(2_147_483_648),
  /** Concurrent adaptive ladders per host; unset picks 2 with NVENC or one per 4 CPU cores. */
  TRANSCODE_MAX_LADDERS: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().positive().optional()),
});

/** X25519 PKCS#8 DER prefix: SEQUENCE, version 0, AlgorithmIdentifier 1.3.101.110, OCTET STRING(OCTET STRING(32)). */
const X25519_PKCS8_PREFIX = "302e020100300506032b656e04220420";
const base64Bytes = (v: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(v)) return null;
  try {
    return Uint8Array.from(atob(v), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
};
const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/**
 * Trust & safety (ADR 0006, docs/testing/e4c-selectors.md). Read by media, the worker and the API.
 * Nothing here can switch the pipeline off: only providers and the sample interval are chosen,
 * and an invalid value makes the service refuse to start.
 */
const moderationShape = z.object({
  /** Seconds between sampled live frames; the effective interval is the smaller of this and the governance setting. */
  MODERATION_SAMPLE_SECONDS: z.coerce.number().int().min(2).max(60).default(10),
  /** Operator CSAM hash list (one PDQ hex per line); empty = none (the database block list always loads). */
  MODERATION_HASHLIST_CSAM: z.string().default(""),
  /** Operator NCII hash list (StopNCII or similar), same format. */
  MODERATION_HASHLIST_NCII: z.string().default(""),
  /** `onnx` (the default open-weight model) or `scripted` (test hooks only). */
  MODERATION_CLASSIFIER: z.enum(["onnx", "scripted"]).default("onnx"),
  /** Path to the ONNX model; empty = the path `bun scripts/fetch-model.ts` writes. Checked by sha256 on load. */
  MODERATION_CLASSIFIER_MODEL: z.string().default(""),
  /**
   * Harness only, never on a public instance: allows the scripted classifier and the
   * `/internal/moderation/*` hooks. Services log a warning at every start while it is on.
   */
  MODERATION_TEST_HOOKS: bool.default(false),
});
/**
 * Co-op (E5, ADR 0020). Harness only, never on a public instance: serves
 * `POST /internal/coop/tick` (run a co-op job now). Services log a warning at every start while it
 * is on. Governance periods are never shortened by env; test instances bootstrap them
 * (`GOVERNANCE_BOOTSTRAP_JSON`, first migration only).
 */
export const coopEnv = z.object({
  /** Harness only: serves `POST /internal/coop/tick`. Never on a public instance. */
  COOP_TEST_HOOKS: bool.default(false),
});

/**
 * Operations (E6, ADR 0021). Harness only, never on a public instance: serves
 * `POST /internal/ops/tick` (run account deletion, export cleanup or VOD retention now).
 * Services log a warning at every start while it is on.
 */
export const opsEnv = z.object({
  /** Harness only: serves `POST /internal/ops/tick`. Never on a public instance. */
  OPS_TEST_HOOKS: bool.default(false),
});

export const moderationEnv = moderationShape.superRefine((env, ctx) => {
  if (env.MODERATION_CLASSIFIER === "scripted" && !env.MODERATION_TEST_HOOKS)
    ctx.addIssue({
      code: "custom",
      path: ["MODERATION_CLASSIFIER"],
      message: "the scripted classifier needs MODERATION_TEST_HOOKS=true (harness only)",
    });
});

/** The evidence public key, raw 32-byte X25519, base64. Media, the worker and the API seal with it; none can open. */
export const evidenceSealEnv = z.object({
  /** Evidence public key (raw 32-byte X25519, base64) that sealed evidence is encrypted to. */
  EVIDENCE_PUBLIC_KEY: z
    .string()
    .refine((v) => base64Bytes(v)?.length === 32, "must be a base64 raw 32-byte X25519 public key"),
});

/** The evidence private key (X25519 PKCS#8 DER, base64). Only the API's legal-view handlers use it. */
export const evidenceOpenEnv = z.object({
  /** Evidence private key (X25519 PKCS#8 DER, base64); keep an offline copy, sealed evidence is unreadable without it. */
  EVIDENCE_PRIVATE_KEY: z.string().refine((v) => {
    const b = base64Bytes(v);
    return b?.length === 48 && hexOf(b.subarray(0, 16)) === X25519_PKCS8_PREFIX;
  }, "must be a base64 X25519 PKCS#8 private key"),
});

/** The evidence bucket's own Garage key, read and write on that bucket only. Worker only. */
export const evidenceStorageEnv = z.object({
  /** S3 access key for the evidence bucket only. */
  S3_EVIDENCE_ACCESS_KEY_ID: z.string().min(1),
  /** Secret of S3_EVIDENCE_ACCESS_KEY_ID. */
  S3_EVIDENCE_SECRET_ACCESS_KEY: z.string().min(1),
});

export const playbackEnv = z.object({
  /** Ed25519 private key (PKCS#8 DER, base64) used to sign playback/segment tokens. */
  PLAYBACK_SIGNING_KEY: z.string().min(1),
  /** Public origin of the HLS edge (origin service), no trailing slash. */
  PLAYBACK_PUBLIC_URL: z.url().default("http://localhost:3003"),
  /** Offer peer-to-peer segment sharing to players that support it (not native HLS). */
  P2P_ENABLED: bool.default(true),
  /** Tracker base URL handed to players (the API appends `?t=<playback token>`). */
  P2P_TRACKER_URL: z.url({ protocol: /^wss?$/ }).default("ws://localhost:8000"),
  /** Optional burst CDN (origin-pull). Disabled by default. */
  CDN_PROVIDER: z.enum(["none", "origin-pull"]).default("none"),
  /** Public base URL of the origin-pull CDN; CDN_PROVIDER=origin-pull does nothing without it. */
  CDN_BASE_URL: z.url().optional(),
  /** Verified viewers above which a channel's new sessions are sent to the CDN. */
  CDN_BURST_VIEWER_THRESHOLD: z.coerce.number().int().positive().default(5000),
  /** Size of the origin's in-memory segment and playlist cache, in MB. */
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
  /** Password of the Postgres owner role `commonair` (migrations and backups). */
  POSTGRES_PASSWORD: z.string().min(1).optional(),
  /** Garage requires exactly 64 hex characters. */
  GARAGE_RPC_SECRET: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  /** Bearer token for Garage's admin API, used by garage-init to create buckets and keys. */
  GARAGE_ADMIN_TOKEN: z.string().min(32).optional(),
  /** Password of Grafana's `admin` user; Grafana refuses to start without it. */
  GRAFANA_ADMIN_PASSWORD: z.string().min(16).optional(),
  /**
   * Password Valkey requires (`requirepass`). Empty runs Valkey without one (development only; the
   * self-hosted unit refuses to start without it). It goes into VALKEY_URL unescaped, so only
   * URL-safe characters (init-env generates 64 hex characters).
   */
  VALKEY_PASSWORD: z
    .string()
    .regex(/^[A-Za-z0-9._~-]*$/)
    .optional(),
  /** Host interface for published ports (default 127.0.0.1). */
  BIND_ADDRESS: z.string().optional(),
  /** Public hostname Caddy serves with TLS (profile `tls`). */
  PUBLIC_HOSTNAME: z.string().optional(),
  /**
   * Caddy's certificate source (ADR 0023): `acme` (default) gets a publicly trusted certificate
   * for PUBLIC_HOSTNAME; `internal` uses Caddy's own CA for LAN and test hosts.
   */
  TLS_MODE: z.enum(["acme", "internal"]).optional(),
  /** Account email for ACME expiry notices (optional). */
  ACME_EMAIL: z.email().optional(),
  /** ACME directory URL override, e.g. a staging CA (default: Let's Encrypt production; no ZeroSSL fallback). */
  ACME_CA: z.url().optional(),
  /** Compose only: registry and namespace of the CommonAir images (default `localhost/commonair`). */
  IMAGE_REGISTRY: z.string().optional(),
  /** Compose only: tag of the CommonAir images (default `dev`). */
  IMAGE_TAG: z.string().optional(),
  /** Full backups `commonair-backup` keeps; older ones are pruned (unset keeps all). */
  WALG_RETAIN_FULL: z.coerce.number().int().positive().optional(),
  /** Postgres `max_connections` (compose default 400: parallel integration suites hold many pools). */
  POSTGRES_MAX_CONNECTIONS: z.coerce.number().int().positive().optional(),
  /** Compose network subnet (default 10.89.42.0/24); a second stack on one host needs its own. */
  COMPOSE_SUBNET: z.string().optional(),
  /** Compose only: path of the env file our own images read; third-party services do not (default `.env`). */
  COMMONAIR_ENV_FILE: z.string().optional(),
});

export const servicePorts = z.object({
  /** Port the web server listens on. */
  WEB_PORT: port.default(3000),
  /** Port the API listens on. */
  API_PORT: port.default(3001),
  /** Port the chat WebSocket service listens on. */
  CHAT_PORT: port.default(3002),
  /** Port the HLS origin listens on. */
  ORIGIN_PORT: port.default(3003),
  /** Plain-TCP IRC port. */
  IRC_PORT: port.default(6667),
  /** IRC over TLS port. */
  IRC_TLS_PORT: port.default(6697),
  /** IRC over WebSocket port (what tmi.js uses). */
  IRC_WS_PORT: port.default(6680),
  /** HTTP port of the IRC gateway's `/healthz`, `/readyz` and `/stats`. */
  IRC_HEALTH_PORT: port.default(6681),
  /** Port of the media service's health endpoints. */
  MEDIA_PORT: port.default(3004),
  /** Port of the worker's health endpoints. */
  WORKER_PORT: port.default(3005),
  /** Port the WebTorrent tracker listens on (WebSocket and health). */
  TRACKER_PORT: port.default(8000),
  /** PEM certificate for the IRC TLS listener; set with IRC_TLS_KEY_FILE (required in production unless self-signed is allowed). */
  IRC_TLS_CERT_FILE: z.string().optional(),
  /** PEM private key for IRC_TLS_CERT_FILE. */
  IRC_TLS_KEY_FILE: z.string().optional(),
  /**
   * Let a production instance run the IRC TLS listener on an ephemeral self-signed certificate
   * when no files are configured. For hosts that do not expose the TLS port.
   */
  IRC_TLS_ALLOW_SELF_SIGNED: z
    .enum(["true", "false", "1", "0", ""])
    .transform((v) => v === "true" || v === "1")
    .default(false),
});

/** IRC gateway admission limits (per process). */
export const ircEnv = z.object({
  /** Most IRC connections per process; more are refused. */
  IRC_MAX_CONNECTIONS: z.coerce.number().int().positive().default(20_000),
  /** Most IRC connections from one client address. */
  IRC_MAX_CONNECTIONS_PER_IP: z.coerce.number().int().positive().default(50),
  /** Token bucket for new connections per client address: the burst size. */
  IRC_CONNECT_BURST_PER_IP: z.coerce.number().int().positive().default(20),
  /** Sustained new IRC connections per second per client address, after the burst. */
  IRC_CONNECT_PER_SECOND_PER_IP: z.coerce.number().positive().default(2),
});

/** WebTorrent tracker (services/tracker) limits. */
export const trackerEnv = z.object({
  /** Most tracker sockets per process; more are refused with 503. */
  TRACKER_MAX_CONNECTIONS: z.coerce.number().int().positive().default(20_000),
  /** Most tracker sockets from one client address; more are refused with 429. */
  TRACKER_MAX_CONNECTIONS_PER_IP: z.coerce.number().int().positive().default(20),
  /** Most peers (offers) relayed per announce, whatever `numwant` asks for. */
  TRACKER_MAX_NUMWANT: z.coerce.number().int().positive().default(20),
  /**
   * Oldest playback token (by `iat`) accepted at connect. Tokens live 120 s but a tracker socket
   * outlives them; the tracker also requires the session to be heartbeating (KEYS.viewers).
   */
  TRACKER_TOKEN_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(43_200),
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
  moderationEnv: moderationShape,
  coopEnv,
  opsEnv,
  evidenceSealEnv,
  evidenceOpenEnv,
  evidenceStorageEnv,
  playbackEnv,
  integrityEnv,
  developerEnv,
  workerEnv,
  infraEnv,
  servicePorts,
  ircEnv,
  trackerEnv,
} as const;
