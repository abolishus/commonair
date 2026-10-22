// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One-time (idempotent) setup of a Railway environment after `railway config apply` has created
 * the services from .railway/railway.ts. Does what IaC must not hold in source:
 *
 *  1. secrets: generated once, then reused (a value already set on any service wins), and set on
 *     every service that needs them, through stdin so they never appear in process arguments;
 *  2. object storage: copies the Railway bucket's S3 credentials onto the app services;
 *  2b. evidence (ADR 0006 Q4): the X25519 evidence keypair (public half to api/media/worker,
 *     private half to api only) and the evidence bucket's own credentials (worker only);
 *  3. public domains: generates Railway service domains for the HTTP-facing services.
 *
 *   railway link --project <project> --environment staging
 *   bun scripts/railway-bootstrap.ts --environment staging [--dry-run]
 *
 * Requires the Railway CLI (logged in). Nothing secret is printed except the generated Mailpit
 * UI login, which only the operator running this sees.
 */
import { generateSigningKey, randomSecret } from "../packages/tokens/src/index.ts";

const APP_SERVICES = ["web", "api", "chat", "origin", "irc", "media", "worker"] as const;
const GENERATED = [
  "POSTGRES_APP_PASSWORD",
  "INTERNAL_API_SECRET",
  "AUTH_SECRET",
  "ALTCHA_HMAC_KEY",
  "MEDIA_INTERNAL_PASSWORD",
  "PLAYBACK_SIGNING_KEY",
] as const;
/** Extra services that need a subset of the secrets. */
const SUBSETS: Record<string, readonly string[]> = {
  migrate: ["POSTGRES_APP_PASSWORD"],
  mediamtx: ["INTERNAL_API_SECRET"],
};
/** Service → container port its generated public domain targets. */
const DOMAINS: Record<string, number> = {
  web: 3000,
  api: 3001,
  chat: 3002,
  origin: 3003,
  irc: 6680,
  mailpit: 8025,
  // WHIP signaling (WebRTC HTTP); the media itself goes through the webrtc-tcp TCP proxy.
  mediamtx: 8889,
};
const BUCKET = "media";
const EVIDENCE_BUCKET = "evidence";
/** Evidence secrets are scoped, never set on every app service (ADR 0006 Q4). */
const EVIDENCE_SCOPES: Record<string, readonly string[]> = {
  api: ["EVIDENCE_PUBLIC_KEY", "EVIDENCE_PRIVATE_KEY"],
  media: ["EVIDENCE_PUBLIC_KEY"],
  worker: ["EVIDENCE_PUBLIC_KEY", "S3_EVIDENCE_ACCESS_KEY_ID", "S3_EVIDENCE_SECRET_ACCESS_KEY", "S3_BUCKET_EVIDENCE"],
};

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const environment = flag("--environment") ?? "staging";
const dryRun = args.includes("--dry-run");

function railway(argv: string[], stdin?: string): string {
  const proc = Bun.spawnSync(["railway", ...argv, "--environment", environment], {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0)
    throw new Error(`railway ${argv.slice(0, 3).join(" ")} failed: ${proc.stderr.toString().trim()}`);
  return proc.stdout.toString();
}

function variables(service: string): Record<string, string> {
  return JSON.parse(railway(["variable", "list", "--service", service, "--json"])) as Record<string, string>;
}

function setSecret(service: string, key: string, value: string): void {
  if (dryRun) {
    console.log(`would set ${key} on ${service}`);
    return;
  }
  railway(["variable", "set", "--service", service, "--skip-deploys", "--stdin", key], value);
  console.log(`set ${key} on ${service}`);
}

/** Bucket credentials, tolerating the CLI's key spelling. */
function bucketCredentials(creds: Record<string, unknown>) {
  const flat = new Map(
    Object.entries(creds)
      .filter(([, v]) => typeof v === "string" || typeof v === "boolean")
      .map(([k, v]) => [k.toLowerCase().replace(/[^a-z]/g, ""), String(v)]),
  );
  const pick = (...names: string[]) => names.map((n) => flat.get(n)).find((v) => v !== undefined);
  const endpoint = pick("endpoint", "endpointurl", "awsendpointurl", "s3endpoint", "url");
  const accessKey = pick("accesskeyid", "accesskey", "awsaccesskeyid");
  const secretKey = pick("secretaccesskey", "secretkey", "awssecretaccesskey");
  const bucketName = pick("bucketname", "bucket", "name");
  const region = pick("region", "awsregion") ?? "auto";
  const style = pick("urlstyle", "addressingstyle", "forcepathstyle");
  if (!endpoint || !accessKey || !secretKey || !bucketName)
    throw new Error(`unrecognized bucket credentials (keys: ${Object.keys(creds).join(", ")})`);
  const pathStyle = style === undefined ? "false" : /path|true/i.test(style) ? "true" : "false";
  return { endpoint, accessKey, secretKey, bucketName, region, pathStyle };
}

/** Bucket credentials as S3_* settings. */
export function s3Settings(creds: Record<string, unknown>): Record<string, string> {
  const { endpoint, accessKey, secretKey, bucketName, region, pathStyle } = bucketCredentials(creds);
  return {
    S3_ENDPOINT: endpoint,
    S3_REGION: region,
    S3_ACCESS_KEY_ID: accessKey,
    S3_SECRET_ACCESS_KEY: secretKey,
    S3_FORCE_PATH_STYLE: pathStyle,
    // One Railway bucket holds every kind of object on staging; keys are prefixed per kind.
    S3_BUCKET_MEDIA: bucketName,
    S3_BUCKET_EXPORTS: bucketName,
    S3_BUCKET_BACKUPS: bucketName,
  };
}

/**
 * The evidence bucket's own key. The worker reaches it through the shared S3_ENDPOINT, region and
 * addressing style, so the two buckets must agree on those.
 */
export function evidenceS3Settings(
  creds: Record<string, unknown>,
  main: Record<string, string>,
): Record<string, string> {
  const { endpoint, accessKey, secretKey, bucketName, region, pathStyle } = bucketCredentials(creds);
  if (endpoint !== main.S3_ENDPOINT || region !== main.S3_REGION || pathStyle !== main.S3_FORCE_PATH_STYLE)
    throw new Error("the evidence bucket's endpoint, region or addressing style differs from the media bucket's");
  return {
    S3_EVIDENCE_ACCESS_KEY_ID: accessKey,
    S3_EVIDENCE_SECRET_ACCESS_KEY: secretKey,
    S3_BUCKET_EVIDENCE: bucketName,
  };
}

/** Reuse the evidence keypair when both halves exist; never pair a kept half with a fresh one. */
export async function evidenceKeyPair(
  publicKey: string | undefined,
  privateKey: string | undefined,
): Promise<{ EVIDENCE_PUBLIC_KEY: string; EVIDENCE_PRIVATE_KEY: string }> {
  if (publicKey && privateKey) return { EVIDENCE_PUBLIC_KEY: publicKey, EVIDENCE_PRIVATE_KEY: privateKey };
  if (publicKey || privateKey)
    throw new Error("only one half of the evidence keypair is set; restore the other half or remove both");
  const b64 = (b: ArrayBuffer) => Buffer.from(b).toString("base64");
  const pair = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  return {
    EVIDENCE_PUBLIC_KEY: b64(await crypto.subtle.exportKey("raw", pair.publicKey)),
    EVIDENCE_PRIVATE_KEY: b64(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
  };
}

async function main(): Promise<void> {
  const targets = [...APP_SERVICES, ...Object.keys(SUBSETS), "mailpit"];
  const current = Object.fromEntries(targets.map((s) => [s, variables(s)] as const));

  // 1. Secrets: reuse any value already present, otherwise generate.
  const existing = (key: string) => targets.map((s) => current[s]?.[key]).find((v) => v);
  const values: Record<string, string> = {};
  for (const key of GENERATED) {
    values[key] =
      existing(key) ?? (key === "PLAYBACK_SIGNING_KEY" ? (await generateSigningKey()).pkcs8B64 : randomSecret("", 32));
  }

  // 2. Object storage.
  const creds = JSON.parse(railway(["bucket", "credentials", "--bucket", BUCKET, "--json"])) as Record<string, unknown>;
  Object.assign(values, s3Settings(creds));

  for (const svc of APP_SERVICES)
    for (const [key, value] of Object.entries(values)) if (current[svc]?.[key] !== value) setSecret(svc, key, value);
  for (const [svc, keys] of Object.entries(SUBSETS))
    for (const key of keys) if (current[svc]?.[key] !== values[key]) setSecret(svc, key, values[key]!);

  // 2b. Evidence: the private half lives only on the API, so the API is its source of truth.
  const evidenceCreds = JSON.parse(railway(["bucket", "credentials", "--bucket", EVIDENCE_BUCKET, "--json"])) as Record<
    string,
    unknown
  >;
  const evidence: Record<string, string> = {
    ...(await evidenceKeyPair(existing("EVIDENCE_PUBLIC_KEY"), current.api?.EVIDENCE_PRIVATE_KEY)),
    ...evidenceS3Settings(evidenceCreds, values),
  };
  for (const [svc, keys] of Object.entries(EVIDENCE_SCOPES))
    for (const key of keys) if (current[svc]?.[key] !== evidence[key]) setSecret(svc, key, evidence[key]!);

  if (!current.mailpit?.MP_UI_AUTH) {
    const login = `staging:${randomSecret("", 18)}`;
    setSecret("mailpit", "MP_UI_AUTH", login);
    if (!dryRun) console.log(`Mailpit UI login (store it in your password manager): ${login}`);
  }

  // 3. Public domains (one generated domain per service; skipped when one exists).
  for (const [svc, port] of Object.entries(DOMAINS)) {
    const list = railway(["domain", "list", "--service", svc, "--json"]);
    if (list.includes("up.railway.app")) continue;
    if (dryRun) console.log(`would generate a domain for ${svc} → :${port}`);
    else {
      railway(["domain", "--service", svc, "--port", String(port), "--json"]);
      console.log(`generated a domain for ${svc} → :${port}`);
    }
  }

  console.log(
    dryRun
      ? "dry run: nothing changed"
      : "done. Redeploy the services (railway redeploy, or the dashboard) so they pick up the variables.",
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (e) {
    console.error(`railway-bootstrap: ${(e as Error).message}`);
    process.exit(1);
  }
}
