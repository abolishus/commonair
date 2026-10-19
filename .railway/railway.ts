// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * CommonAir on Railway (staging), as Railway Infrastructure as Code.
 *
 *   railway link --project <project> --environment staging
 *   railway config plan            # review
 *   railway config apply           # only after review
 *   bun scripts/railway-bootstrap.ts --environment staging   # secrets, bucket creds, domains
 *
 * Railway is an optional host (AGENTS.md rule 3): the platform's FOSS default stays
 * `podman compose` / Quadlet. Differences from compose, all documented in docs/deploy/railway.md:
 * managed Postgres (no WAL-G; Railway backups), a Railway bucket instead of Garage, no
 * observability stack, RTMP ingest only (Railway has no UDP, so no WebRTC/WHIP), no media
 * work-dir volume, and no P2P tracker.
 *
 * Never put secrets, Railway UUIDs or generated *.up.railway.app domains in this file.
 * Secrets are `preserve()`d here and set by scripts/railway-bootstrap.ts.
 */
import { bucket, defineRailway, github, group, image, postgres, preserve, project, service } from "railway/iac";

const REPO = "abolishus/commonair";
const SERVICE_DOCKERFILE = "infra/containers/service.Containerfile";

/** Values Railway resolves at runtime: `${{service.VAR}}`, or `${{VAR}}` for this service. */
const ref = (variable: string, from?: string) => (from ? `\${{${from}.${variable}}}` : `\${{${variable}}}`);
const privateUrl = (scheme: string, svc: string, port: number) =>
  `${scheme}://${ref("RAILWAY_PRIVATE_DOMAIN", svc)}:${port}`;
const publicUrl = (scheme: string, svc: string) => `${scheme}://${ref("RAILWAY_PUBLIC_DOMAIN", svc)}`;

/** Container-side ports (fixed, as in compose's x-app-env). */
const PORTS = {
  web: 3000,
  api: 3001,
  chat: 3002,
  origin: 3003,
  media: 3004,
  worker: 3005,
  irc: 6667,
  ircTls: 6697,
  ircWs: 6680,
  ircHealth: 6681,
  rtmp: 1935,
  mtxRtsp: 8554,
  mtxHls: 8888,
  mtxApi: 9997,
  smtp: 1025,
  mailpitUi: 8025,
  valkey: 6379,
} as const;

/**
 * Set by scripts/railway-bootstrap.ts on every app service, never in source. The S3 values come
 * from the Railway bucket's credentials.
 */
const SECRETS = [
  "POSTGRES_APP_PASSWORD",
  "INTERNAL_API_SECRET",
  "AUTH_SECRET",
  "ALTCHA_HMAC_KEY",
  "MEDIA_INTERNAL_PASSWORD",
  "PLAYBACK_SIGNING_KEY",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_FORCE_PATH_STYLE",
  "S3_BUCKET_MEDIA",
  "S3_BUCKET_EXPORTS",
  "S3_BUCKET_BACKUPS",
] as const;

export default defineRailway((ctx) => {
  const db = postgres("postgres");
  // Bucket regions cannot change after creation.
  const media = bucket("media", { region: "iad" });

  // Valkey holds ephemeral state only (architecture.md): no volume, no persistence.
  const valkey = service("valkey", {
    source: image("docker.io/valkey/valkey:9.1.2-trixie"),
    start: 'valkey-server --appendonly no --save ""',
  });

  // Staging email sink. Its UI shows verification links, so it sits behind basic auth
  // (MP_UI_AUTH="user:password", set by the bootstrap script).
  const mailpit = service("mailpit", {
    source: image("docker.io/axllent/mailpit:v1.31.6"),
    env: {
      MP_UI_AUTH: preserve(),
      MP_MAX_MESSAGES: "5000",
    },
  });

  const secrets = Object.fromEntries(SECRETS.map((k) => [k, preserve()]));

  /** What compose's env_file + x-app-env give every app service, with Railway hostnames. */
  const appEnv = {
    ...secrets,
    NODE_ENV: "production",
    LOG_LEVEL: "info",
    // Staging accepts demo fixture accounts (demo_* on the .invalid fixture domain) for the seed.
    DEMO_SEED_ENABLED: "true",
    INSTANCE_NAME: `CommonAir (${ctx.environmentName ?? "staging"})`,
    // Production mode requires instance contacts. Staging placeholders on the web domain (all
    // mail goes to Mailpit here); replace them with real mailboxes for a public instance.
    ...Object.fromEntries(
      ["CONTACT", "SECURITY", "ABUSE", "DMCA", "PRIVACY"].map((k) => [
        `${k}_EMAIL`,
        `${k.toLowerCase()}@${ref("RAILWAY_PUBLIC_DOMAIN", "web")}`,
      ]),
    ),
    PUBLIC_URL: publicUrl("https", "web"),
    API_PUBLIC_URL: publicUrl("https", "api"),
    CHAT_PUBLIC_URL: `${publicUrl("wss", "chat")}/ws`,
    PLAYBACK_PUBLIC_URL: publicUrl("https", "origin"),
    AUTH_TRUSTED_ORIGINS: publicUrl("https", "web"),
    IRC_PUBLIC_HOST: ref("RAILWAY_TCP_PROXY_DOMAIN", "irc"),
    INGEST_RTMP_PUBLIC_URL: `rtmp://${ref("RAILWAY_TCP_PROXY_DOMAIN", "mediamtx")}:${ref("RAILWAY_TCP_PROXY_PORT", "mediamtx")}/live`,
    // No public WHIP: WebRTC needs UDP, which Railway does not offer.
    INGEST_WHIP_PUBLIC_URL: `${publicUrl("https", "web")}/whip-unavailable`,
    // The services connect as the least-privilege role (ADR 0004); the owner URL stays on `migrate`.
    DATABASE_URL: `postgres://commonair_app:${ref("POSTGRES_APP_PASSWORD")}@${ref("PGHOST", "postgres")}:${ref("PGPORT", "postgres")}/${ref("PGDATABASE", "postgres")}`,
    VALKEY_URL: privateUrl("redis", "valkey", PORTS.valkey),
    API_INTERNAL_URL: privateUrl("http", "api", PORTS.api),
    CHAT_INTERNAL_URL: `${privateUrl("ws", "chat", PORTS.chat)}/ws`,
    ORIGIN_INTERNAL_URL: privateUrl("http", "origin", PORTS.origin),
    MEDIAMTX_API_URL: privateUrl("http", "mediamtx", PORTS.mtxApi),
    MEDIAMTX_HLS_URL: privateUrl("http", "mediamtx", PORTS.mtxHls),
    MEDIAMTX_RTSP_URL: privateUrl("rtsp", "mediamtx", PORTS.mtxRtsp),
    MEDIAMTX_RTMP_URL: privateUrl("rtmp", "mediamtx", PORTS.rtmp),
    SMTP_HOST: ref("RAILWAY_PRIVATE_DOMAIN", "mailpit"),
    SMTP_PORT: String(PORTS.smtp),
    SMTP_SECURE: "false",
    // Railway's edge and the private network (IPv4 and IPv6) forward client addresses.
    TRUSTED_PROXY_CIDRS: "10.0.0.0/8,100.64.0.0/10,fd00::/8",
    // Strict SSRF rules: staging must behave like production.
    OUTBOUND_ALLOW_PRIVATE_NETWORKS: "false",
    // services/tracker is not built yet.
    P2P_ENABLED: "false",
    PAYMENTS_PROVIDER: "manual",
    WEB_PORT: String(PORTS.web),
    API_PORT: String(PORTS.api),
    CHAT_PORT: String(PORTS.chat),
    ORIGIN_PORT: String(PORTS.origin),
    MEDIA_PORT: String(PORTS.media),
    WORKER_PORT: String(PORTS.worker),
    IRC_PORT: String(PORTS.irc),
    IRC_TLS_PORT: String(PORTS.ircTls),
    IRC_WS_PORT: String(PORTS.ircWs),
    IRC_HEALTH_PORT: String(PORTS.ircHealth),
  };

  /**
   * One Bun service from service.Containerfile. `SERVICE` doubles as the Docker build arg
   * (Railway passes service variables to matching ARGs). `PORT` points Railway's healthcheck
   * at the service's own health port.
   */
  const app = (
    name: string,
    svc: string,
    port: number,
    opts: { tcp?: number[] } = {},
    extra: Record<string, string> = {},
  ) =>
    service(name, {
      ...opts,
      source: github(REPO, { branch: "main" }),
      build: { builder: "DOCKERFILE", dockerfilePath: SERVICE_DOCKERFILE },
      healthcheck: "/healthz",
      healthcheckTimeout: 120,
      env: { ...appEnv, SERVICE: svc, PORT: String(port), OTEL_SERVICE_NAME: svc, ...extra },
    });

  // Migrations as the database owner, then the least-privilege app role; exits when done.
  const migrate = service("migrate", {
    source: github(REPO, { branch: "main" }),
    build: { builder: "DOCKERFILE", dockerfilePath: SERVICE_DOCKERFILE },
    start: "sh -c 'bun packages/db/src/migrate.ts && bun infra/postgres/apply-app-role.ts'",
    env: {
      SERVICE: "tools",
      DATABASE_URL: db.env.DATABASE_URL,
      POSTGRES_APP_PASSWORD: preserve(),
    },
  });

  const mediamtx = service("mediamtx", {
    source: github(REPO, { branch: "main" }),
    build: { builder: "DOCKERFILE", dockerfilePath: "infra/mediamtx/Containerfile" },
    tcp: [PORTS.rtmp],
    // Railway keeps this once set; restart MediaMTX whenever it exits.
    deploy: { restartPolicyType: "ALWAYS" },
    env: {
      INTERNAL_API_SECRET: preserve(),
      API_INTERNAL_URL: privateUrl("http", "api", PORTS.api),
      MTX_AUTHHTTPADDRESS: `${privateUrl("http", "api", PORTS.api)}/internal/media/auth`,
    },
  });

  const web = app("web", "web", PORTS.web);
  const api = app("api", "api", PORTS.api);
  const chat = app("chat", "chat", PORTS.chat);
  const origin = app("origin", "origin", PORTS.origin);
  // IRC: plain TCP through Railway's TCP proxy; TLS clients use the WebSocket listener behind an
  // HTTPS domain (the TLS listener's certificate is self-signed on this host).
  const irc = app("irc", "irc", PORTS.ircHealth, { tcp: [PORTS.irc] }, { IRC_TLS_ALLOW_SELF_SIGNED: "true" });
  // Scratch space is the container filesystem: Railway volumes mount as root and the images
  // run as `bun`, so recordings in progress do not survive a restart on this host.
  const mediaSvc = app("media", "media", PORTS.media);
  const worker = app("worker", "worker", PORTS.worker);

  return project("commonair", {
    resources: [
      group("Data", [db, valkey, media, mailpit, migrate]),
      group("Media", [mediamtx, mediaSvc, origin]),
      group("App", [web, api, chat, irc, worker]),
    ],
  });
});
