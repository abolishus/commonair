// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Which keys of the operator's commonair.env each Quadlet unit receives. Each unit with an env
 * file runs render-env.sh as `ExecStartPre=`, which copies only the keys of its list
 * (infra/selfhost/env/commonair-<unit>.keys) into `~/.config/commonair/unit-env/`, and the
 * container reads that file instead of the whole commonair.env. So Caddy, MediaMTX, Grafana and
 * Garage never see the database passwords, the session secrets or the S3 keys.
 *
 *   bun scripts/selfhost/unit-env.ts           write the key lists
 *   bun scripts/selfhost/unit-env.ts --check   exit 1 if a committed list is out of date
 *
 * The lists of our own services are derived from the Zod schemas they validate at start, minus
 * what the unit sets itself (`Environment=`, `Secret=`), so a variable added to a schema reaches
 * the unit once the lists are regenerated (a test fails until then). Third-party images and the
 * tools-image jobs read what their configuration and scripts reference; tests check those
 * lists against those files.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ALL_ENV_SCHEMAS, loadEnv } from "../../packages/config/src/env.ts";
import { webEnvSchema } from "../../apps/web/src/server/env.ts";
import { loadApiEnv } from "../../services/api/src/env.ts";
import { mediaServiceEnv } from "../../services/media/src/env.ts";
import { workerEnv } from "../../services/worker/src/env.ts";
import { QUADLET_DIR, readUnitDir, unitValues } from "./units.ts";

export const REPO_ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
/** Repository (and release) directory of the key lists. */
export const KEYS_DIR = "infra/selfhost/env";
/** Repository (and release) path of the renderer. */
export const RENDER_SCRIPT = "scripts/selfhost/render-env.sh";
/** The operator's file, the one source of truth. */
export const SOURCE_ENV = "%h/.config/commonair/commonair.env";
/** Where the per-unit files are rendered (0700 directory, 0600 files). */
export const UNIT_ENV_DIR = "%h/.config/commonair/unit-env";

export type SchemaName = keyof typeof ALL_ENV_SCHEMAS;
/** A whole schema, or only some of its keys (`schema.pick(...)`). */
export type SchemaPart = SchemaName | [SchemaName, string[]];

type Source = Record<string, string | undefined>;

/** Our own services and what they validate (or read) at start. */
export const APP_UNITS = ["api", "chat", "irc", "media", "origin", "tracker", "web", "worker"] as const;
export type AppUnit = (typeof APP_UNITS)[number];

/**
 * chat, origin, irc and tracker compose their schemas in `main.ts`, which cannot be imported
 * without starting the service; these mirror those `loadEnv(...)` calls, and a test parses each
 * main.ts and fails when they differ.
 */
export const MAIN_TS_SCHEMAS: Record<"chat" | "irc" | "origin" | "tracker", SchemaPart[]> = {
  chat: ["coreEnv", "databaseEnv", "valkeyEnv", "internalEnv", "servicePorts", "chatEnv"],
  irc: ["coreEnv", ["internalEnv", ["CHAT_INTERNAL_URL"]], "servicePorts", "ircEnv"],
  origin: [
    "coreEnv",
    "databaseEnv",
    "valkeyEnv",
    "internalEnv",
    "mediaEnv",
    "playbackEnv",
    "storageEnv",
    "servicePorts",
  ],
  tracker: [
    "coreEnv",
    "valkeyEnv",
    ["internalEnv", ["INTERNAL_API_SECRET"]],
    ["playbackEnv", ["PLAYBACK_SIGNING_KEY"]],
    ["servicePorts", ["TRACKER_PORT"]],
    "trackerEnv",
  ],
};

/**
 * Schemas a service reads outside its main env schema: the API and the worker build the network
 * classifier from `process.env` (`classifierFromEnv`, `INTEGRITY_DATACENTER_CIDRS_FILE`).
 */
export const EXTRA_SCHEMAS: Partial<Record<AppUnit, SchemaName[]>> = {
  api: ["integrityEnv"],
  worker: ["integrityEnv"],
};

/** Keys of schema parts. */
export function partKeys(parts: readonly SchemaPart[]): string[] {
  return parts.flatMap((p) => {
    const [name, pick] = typeof p === "string" ? [p, undefined] : p;
    const keys = Object.keys(ALL_ENV_SCHEMAS[name].shape);
    if (!pick) return keys;
    const missing = pick.filter((k) => !keys.includes(k));
    if (missing.length) throw new Error(`${name} has no ${missing.join(", ")}`);
    return pick;
  });
}

// A value every field of every schema accepts at least one of (tried in order).
const X25519_PUBLIC = Buffer.alloc(32).toString("base64");
const X25519_PRIVATE = Buffer.concat([
  Buffer.from("302e020100300506032b656e04220420", "hex"),
  Buffer.alloc(32),
]).toString("base64");
/** An uncompressed P-256 point's shape (0x04 then 64 bytes), base64url: the VAPID public key. */
const VAPID_PUBLIC = Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString("base64url");
const CANDIDATES = [
  "true",
  "10",
  "3000",
  "development",
  "info",
  "manual",
  "auto",
  "onnx",
  "none",
  "acme",
  "usd",
  "http://localhost:1",
  "ws://localhost:1",
  "ops@instance.test",
  "0".repeat(64),
  X25519_PUBLIC,
  X25519_PRIVATE,
  VAPID_PUBLIC,
  "off",
  "stun:localhost:1",
  "turn:localhost:1",
  "127.0.0.1",
];

/** A valid value for every variable of every schema, so a loader's output lists every key it reads. */
export function sampleEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const schema of Object.values(ALL_ENV_SCHEMAS))
    for (const [key, field] of Object.entries(schema.shape)) {
      const value = CANDIDATES.find((c) => (field as z.ZodType).safeParse(c).success);
      if (value === undefined) throw new Error(`no sample value for ${key}: add one to CANDIDATES`);
      out[key] = value;
    }
  return out;
}

/** Keys a loader returns from a source that sets every known variable. */
export function keysRead(load: (source: Source) => object): string[] {
  return Object.keys(load(sampleEnv()));
}

/** Every key each of our services reads from its environment. */
export function appSchemaKeys(unit: AppUnit): string[] {
  const keys = new Set<string>(partKeys(EXTRA_SCHEMAS[unit] ?? []));
  const add = (ks: Iterable<string>) => {
    for (const k of ks) keys.add(k);
  };
  switch (unit) {
    case "api":
      add(keysRead(loadApiEnv));
      break;
    case "media":
      add(Object.keys(mediaServiceEnv.shape));
      add(keysRead((s) => loadEnv(mediaServiceEnv, s)));
      break;
    case "web":
      add(Object.keys(webEnvSchema.shape));
      add(keysRead((s) => loadEnv(webEnvSchema, s)));
      break;
    case "worker":
      add(Object.keys(workerEnv.shape));
      add(keysRead((s) => loadEnv(workerEnv, s)));
      break;
    default:
      add(partKeys(MAIN_TS_SCHEMAS[unit]));
  }
  return [...keys].sort();
}

/** Keys a unit sets itself: `Environment=K=…` (also empty) and `Secret=…,target=K`. */
export function unitSetKeys(unit: string): Set<string> {
  const keys = new Set<string>();
  for (const e of unitValues(unit, "Environment")) keys.add(e.slice(0, e.indexOf("=")));
  for (const s of unitValues(unit, "Secret")) {
    const target = /(?:^|,)target=([A-Za-z_][A-Za-z0-9_]*)/.exec(s)?.[1];
    if (target) keys.add(target);
  }
  return keys;
}

interface StaticList {
  why: string;
  keys: string[];
}

/**
 * Units that do not run our services: what each image or tools-image script reads. A `PREFIX_*`
 * entry passes every key with that prefix (operator settings of that image).
 */
export const STATIC_UNITS: Record<string, StaticList> = {
  caddy: {
    why: "the {$VAR} placeholders of infra/caddy/Caddyfile",
    keys: [
      "ACME_CA",
      "ACME_EMAIL",
      "PUBLIC_HOSTNAME",
      "S3_BUCKET_EXPORTS",
      "S3_BUCKET_MEDIA",
      "S3_CONNECT_SRC",
      "S3_MODE",
      "TLS_MODE",
    ],
  },
  coturn: {
    why: "the variables infra/coturn/start.sh renders turnserver.conf from (TURN_PORT is fixed in the unit)",
    keys: [
      "P2P_TURN_URLS",
      "PUBLIC_HOSTNAME",
      "TURN_EXTERNAL_IP",
      "TURN_RELAY_PORT_MAX",
      "TURN_RELAY_PORT_MIN",
      "TURN_SHARED_SECRET",
    ],
  },
  garage: {
    why: "Garage's own settings (garage.toml leaves its secrets to the environment)",
    keys: ["GARAGE_ADMIN_TOKEN", "GARAGE_RPC_SECRET"],
  },
  "storage-init": {
    why: "optionsFromEnv in infra/garage/bootstrap.ts (it creates both S3 keys) and storeFromEnv in infra/garage/storage-init.ts",
    keys: [
      "AWS_ENDPOINT",
      "GARAGE_ADMIN_TOKEN",
      "GARAGE_CAPACITY_BYTES",
      "GARAGE_EVIDENCE_KEY_NAME",
      "GARAGE_INIT_TIMEOUT_MS",
      "GARAGE_KEY_NAME",
      "GARAGE_ZONE",
      "S3_ACCESS_KEY_ID",
      "S3_BUCKET_BACKUPS",
      "S3_BUCKET_EVIDENCE",
      "S3_BUCKET_EXPORTS",
      "S3_BUCKET_MEDIA",
      "S3_ENDPOINT",
      "S3_EVIDENCE_ACCESS_KEY_ID",
      "S3_EVIDENCE_SECRET_ACCESS_KEY",
      "S3_FORCE_PATH_STYLE",
      "S3_MODE",
      "S3_REGION",
      "S3_SECRET_ACCESS_KEY",
      "WALG_S3_PREFIX",
    ],
  },
  grafana: {
    why: "Grafana's GF_* settings (the admin password is a Podman secret)",
    keys: ["GF_*"],
  },
  "irc-cert": {
    why: "infra/irc/sync-cert.ts",
    keys: ["IRC_PUBLIC_HOST"],
  },
  mediamtx: {
    why: "the hook commands of infra/mediamtx/mediamtx.yml and MediaMTX's MTX_* settings",
    keys: ["INTERNAL_API_SECRET", "MTX_*"],
  },
  migrate: {
    why: "packages/db/src/migrate.ts and infra/postgres/apply-app-role.ts (DATABASE_URL is a Podman secret)",
    keys: ["GOVERNANCE_BOOTSTRAP_JSON", "POSTGRES_APP_PASSWORD"],
  },
  valkey: {
    why: "the server's password, which its Exec= hands to valkey-server on stdin (VALKEY_URL is a Podman secret)",
    keys: ["VALKEY_PASSWORD"],
  },
  postgres: {
    why: "the Postgres entrypoint and WAL-G (infra/postgres/*.sh), with the operator's AWS_* and WALG_* backup settings",
    keys: [
      "AWS_*",
      "POSTGRES_MAX_CONNECTIONS",
      "POSTGRES_PASSWORD",
      "S3_ACCESS_KEY_ID",
      "S3_BUCKET_BACKUPS",
      "S3_ENDPOINT",
      "S3_FORCE_PATH_STYLE",
      "S3_REGION",
      "S3_SECRET_ACCESS_KEY",
      "WALG_*",
    ],
  },
};

/** Units without any env file: their images read nothing from the operator's file. */
export const NO_ENV_UNITS = ["loki", "otel-collector", "prometheus", "tempo"] as const;

export const unitName = (unit: string) => `commonair-${unit}`;
export const keysPath = (unit: string) => `${KEYS_DIR}/${unitName(unit)}.keys`;
export const renderedPath = (unit: string) => `${UNIT_ENV_DIR}/${unitName(unit)}.env`;

/** The two lines a unit with a key list carries. */
export function unitEnvLines(unit: string): { environmentFile: string; execStartPre: string } {
  return {
    environmentFile: `EnvironmentFile=${renderedPath(unit)}`,
    execStartPre: `ExecStartPre=/bin/sh %h/commonair/${RENDER_SCRIPT} %h/commonair/${keysPath(unit)} ${SOURCE_ENV} ${renderedPath(unit)}`,
  };
}

/** Every unit's key list, by unit name (without `commonair-`), sorted. */
export function unitKeyLists(
  units: Map<string, string> = readUnitDir(join(REPO_ROOT, QUADLET_DIR)),
): Map<string, { why: string; keys: string[] }> {
  const out = new Map<string, { why: string; keys: string[] }>();
  for (const unit of APP_UNITS) {
    const text = units.get(`${unitName(unit)}.container`);
    if (!text) throw new Error(`no unit ${unitName(unit)}.container`);
    const set = unitSetKeys(text);
    const source =
      unit in MAIN_TS_SCHEMAS
        ? `the loadEnv calls of services/${unit}/src/main.ts`
        : {
            api: "loadApiEnv (services/api/src/env.ts)",
            media: "mediaServiceEnv (services/media/src/env.ts)",
            web: "webEnvSchema (apps/web/src/server/env.ts)",
            worker: "workerEnv (services/worker/src/env.ts)",
          }[unit as "api" | "media" | "web" | "worker"];
    const extras = EXTRA_SCHEMAS[unit] ?? [];
    const extra = extras.length ? ` and ${extras.join(", ")}` : "";
    out.set(unit, {
      why: `${source}${extra}, minus what the unit sets itself`,
      keys: appSchemaKeys(unit).filter((k) => !set.has(k)),
    });
  }
  for (const [unit, list] of Object.entries(STATIC_UNITS)) out.set(unit, { ...list, keys: [...list.keys].sort() });
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
}

// REUSE-IgnoreStart
/** The license header of every key list. */
export const KEYS_HEADER = [
  "# SPDX-FileCopyrightText: 2026 CommonAir contributors",
  "# SPDX-License-Identifier: CC0-1.0",
];
// REUSE-IgnoreEnd

/** The text of one key list file. */
export function keysFile(unit: string, why: string, keys: string[]): string {
  return [
    ...KEYS_HEADER,
    "#",
    "# Generated by `bun scripts/selfhost/unit-env.ts`; do not edit.",
    `# The keys of commonair.env that ${unitName(unit)} receives (${RENDER_SCRIPT}),`,
    `# from ${why}.`,
    ...keys,
    "",
  ].join("\n");
}

/** Every key list file: repository path → text. */
export function keysFiles(units?: Map<string, string>): Map<string, string> {
  return new Map([...unitKeyLists(units)].map(([unit, { why, keys }]) => [keysPath(unit), keysFile(unit, why, keys)]));
}

/** Keys of a key list file (comments and blank lines dropped). */
export function parseKeysFile(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const files = keysFiles();
  const dir = join(REPO_ROOT, KEYS_DIR);
  if (!check) mkdirSync(dir, { recursive: true });
  const listed = existsSync(dir) ? readdirSync(dir) : [];
  const stale = new Set(listed.filter((f) => f.endsWith(".keys") && !files.has(`${KEYS_DIR}/${f}`)));
  let bad = 0;
  for (const [path, text] of files) {
    let current = "";
    try {
      current = readFileSync(join(REPO_ROOT, path), "utf8");
    } catch {
      // missing: written below, or reported with --check
    }
    if (current === text) continue;
    if (check) {
      console.error(`${path} is out of date: run bun scripts/selfhost/unit-env.ts`);
      bad++;
    } else {
      writeFileSync(join(REPO_ROOT, path), text);
      console.log(`wrote ${path}`);
    }
  }
  for (const f of stale) {
    console.error(`${KEYS_DIR}/${f} belongs to no unit: remove it`);
    bad++;
  }
  if (bad) process.exit(1);
  if (check) console.log(`${files.size} key lists are up to date`);
}
