// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The external Postgres and Valkey of a self-hosted instance (selfhost.sh --database-url and
 * --valkey-url; ADR 0032 §3), checked from the release's tools image, the only place on the host
 * with a Postgres client. Read only: it writes nothing anywhere.
 *
 *   bun infra/selfhost/state-check.ts preflight   before install or upgrade changes anything:
 *       TLS verifies against the CA (the certificate's subject named when it does not), the owner
 *       has CREATEROLE and is not a superuser (a superuser is only a warning), the server is
 *       PostgreSQL 17 or 18, max_connections covers the services' pools, and Valkey answers PING
 *       over TLS with its password and has maxmemory-policy noeviction (read with INFO, never
 *       CONFIG, which managed providers restrict). Exit 1 on any failure, each with a `fix:` line.
 *   bun infra/selfhost/state-check.ts status      one line per service for `selfhost.sh status`:
 *       reachable, TLS verified, the version, connections used, PING, and how long each took.
 *
 * Inputs come from the environment only (a command line is world-readable in ps):
 *   STATE_PG_URL      the owner's URL, password included (or DATABASE_URL, as the migrate unit's
 *                     secret names it)
 *   STATE_PG_CA       PEM file of the server's CA (optional; else the system store)
 *   STATE_VALKEY_URL  rediss://[user]:password@host:port[/db] (or VALKEY_URL)
 *   STATE_VALKEY_CA   PEM file of Valkey's CA (optional)
 *   STATE_POOL_MAX    DATABASE_POOL_MAX (default 10)
 *   STATE_ALLOW_INSECURE_DATABASE, STATE_ALLOW_INSECURE_VALKEY  `true`: the operator's
 *                     --allow-insecure-* (a weaker sslmode, or redis://, on a private network)
 * Nothing here prints a URL or a password: errors name the host, the user and the server's
 * certificate, never the credentials.
 */
import { readFileSync } from "node:fs";
import net from "node:net";
import tls from "node:tls";
import postgres from "postgres";
import { postgresTls } from "../../packages/db/src/client.ts";

type Env = Record<string, string | undefined>;

/**
 * The services that open a pool of DATABASE_POOL_MAX connections each (createDb in their main
 * files; a test checks the list against the code).
 */
export const POOL_SERVICES = ["api", "chat", "media", "origin", "worker"] as const;
/** migrate (one connection, then apply-app-role's one) and headroom for an operator's psql. */
export const MIGRATE_CONNECTIONS = 1;
export const SPARE_CONNECTIONS = 3;
/** ADR 0032 §3: the majors the stack is tested on. */
export const SUPPORTED_PG_MAJORS = [17, 18] as const;

export interface Finding {
  level: "ok" | "warning" | "error";
  message: string;
  fix?: string;
}

// --- pure rules -----------------------------------------------------------------------------

export interface Budget {
  needed: number;
  available: number;
  ok: boolean;
  /** The largest DATABASE_POOL_MAX that fits (0: none does). */
  fittingPoolMax: number;
}

/**
 * Connections the instance needs against what the server lets a non-superuser open:
 * max_connections minus the slots reserved for superusers and for pg_use_reserved_connections.
 */
export function connectionBudget(opts: {
  poolMax: number;
  maxConnections: number;
  superuserReserved: number;
  reserved: number;
  superuser: boolean;
}): Budget {
  const services = POOL_SERVICES.length;
  const needed = opts.poolMax * services + MIGRATE_CONNECTIONS + SPARE_CONNECTIONS;
  const available = opts.superuser
    ? opts.maxConnections
    : Math.max(0, opts.maxConnections - opts.superuserReserved - opts.reserved);
  const fittingPoolMax = Math.max(0, Math.floor((available - MIGRATE_CONNECTIONS - SPARE_CONNECTIONS) / services));
  return { needed, available, ok: needed <= available, fittingPoolMax };
}

export function budgetFinding(b: Budget, poolMax: number): Finding {
  const what = `${b.needed} connections needed (DATABASE_POOL_MAX ${poolMax} × ${POOL_SERVICES.length} services + migrate + ${SPARE_CONNECTIONS} spare), the server allows ${b.available}`;
  if (b.ok) return { level: "ok", message: `postgres: ${what}` };
  return {
    level: "error",
    message: `postgres: max_connections is too small: ${what}`,
    fix:
      b.fittingPoolMax > 0
        ? `a bigger node (more max_connections), or a smaller pool: run install with DATABASE_POOL_MAX=${b.fittingPoolMax} in its environment (requirements.md, "Connection budget")`
        : "a bigger node: this one leaves too few connections for even one per service (requirements.md, 'Connection budget')",
  };
}

export function versionFinding(versionNum: number, version: string): Finding {
  const major = Math.floor(versionNum / 10000);
  if ((SUPPORTED_PG_MAJORS as readonly number[]).includes(major))
    return { level: "ok", message: `postgres: PostgreSQL ${version}` };
  return {
    level: "error",
    message: `postgres: the server is PostgreSQL ${version}; CommonAir needs ${SUPPORTED_PG_MAJORS.join(" or ")}`,
    fix: `create the cluster with PostgreSQL ${SUPPORTED_PG_MAJORS.at(-1)} (ADR 0032 §3)`,
  };
}

export function roleFindings(role: {
  name: string;
  superuser: boolean;
  createRole: boolean;
  createInDatabase: boolean;
  createInPublic: boolean;
  database: string;
}): Finding[] {
  const out: Finding[] = [];
  const quoted = `"${role.name.replaceAll('"', '""')}"`;
  if (role.superuser) {
    out.push({
      level: "warning",
      message: `postgres: ${role.name} is a superuser; CommonAir needs only CREATEROLE (ADR 0032 §3), so a role with less is safer`,
    });
  } else if (!role.createRole) {
    out.push({
      level: "error",
      message: `postgres: ${role.name} lacks CREATEROLE, which migrate needs to create the app and monitor roles`,
      fix: `ask your provider (or a superuser) for: ALTER ROLE ${quoted} CREATEROLE;`,
    });
  } else {
    out.push({ level: "ok", message: `postgres: ${role.name} has CREATEROLE and is not a superuser` });
  }
  if (!role.superuser && !role.createInDatabase) {
    out.push({
      level: "error",
      message: `postgres: ${role.name} cannot create schemas in ${role.database}`,
      fix: `GRANT CREATE ON DATABASE "${role.database.replaceAll('"', '""')}" TO ${quoted}; or make ${role.name} its owner`,
    });
  }
  if (!role.superuser && !role.createInPublic) {
    out.push({
      level: "error",
      message: `postgres: ${role.name} cannot create tables in the public schema of ${role.database}`,
      fix: `ALTER SCHEMA public OWNER TO ${quoted}; (run by the database's owner)`,
    });
  }
  return out;
}

/** A field of an INFO reply (`key:value` lines). */
export function infoField(info: string, key: string): string | undefined {
  for (const line of info.split(/\r?\n/)) if (line.startsWith(`${key}:`)) return line.slice(key.length + 1).trim();
  return undefined;
}

export function evictionFinding(policy: string | undefined): Finding {
  if (policy === "noeviction") return { level: "ok", message: "valkey: maxmemory-policy noeviction" };
  return {
    level: "error",
    message: `valkey: maxmemory-policy is ${policy ?? "unknown"}; BullMQ's queues need noeviction, or Valkey drops jobs when memory runs out`,
    fix: "set the eviction policy to noeviction (DigitalOcean: the cluster's Settings, 'Eviction policy')",
  };
}

export interface PeerCert {
  subject: string;
  issuer: string;
  validTo: string;
  altNames: string;
}

/** `CN=x, O=y` from a getPeerCertificate() subject or issuer. */
export function dn(fields: Record<string, unknown> | undefined): string {
  if (!fields) return "(none)";
  const parts = Object.entries(fields)
    .filter(([, v]) => typeof v === "string" || Array.isArray(v))
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("+") : String(v)}`);
  return parts.length ? parts.join(", ") : "(empty)";
}

/** Why a server's certificate failed, in the operator's words, naming the certificate. */
export function tlsFinding(
  service: "postgres" | "valkey",
  host: string,
  code: string | undefined,
  cert: PeerCert | undefined,
  hasCa: boolean,
): Finding {
  const named = cert ? `the server's certificate (subject ${cert.subject}; issuer ${cert.issuer})` : "the server";
  const caFlag = service === "postgres" ? "--database-ca" : "--valkey-ca";
  switch (code) {
    case undefined:
      return { level: "ok", message: `${service}: TLS verified (${cert?.subject ?? host})` };
    case "CERT_HAS_EXPIRED":
      return {
        level: "error",
        message: `${service}: ${named} expired on ${cert?.validTo ?? "an earlier date"}`,
        fix: "renew the server's certificate (a managed provider rotates its own; ask its support)",
      };
    case "CERT_NOT_YET_VALID":
      return {
        level: "error",
        message: `${service}: ${named} is not valid yet; is this host's clock right? (timedatectl)`,
        fix: "synchronize the clock (systemd-timesyncd or chrony), then re-run",
      };
    case "HOSTNAME_MISMATCH":
      return {
        level: "error",
        message: `${service}: ${named} is for ${cert?.altNames || cert?.subject || "another name"}, not ${host}`,
        fix: "use the host name the certificate names in the URL (the provider's connection details)",
      };
    case "NO_TLS":
      return {
        level: "error",
        message: `${service}: ${host} does not offer TLS`,
        fix: "turn TLS on at the server, or for a server on a private network only, pass the --allow-insecure flag",
      };
    default:
      return {
        level: "error",
        message: `${service}: ${named} does not verify against ${hasCa ? `the CA given with ${caFlag}` : "the system's trusted CAs"} (${code})`,
        fix: hasCa
          ? `pass the CA that signed it with ${caFlag} <file> (DigitalOcean: the cluster's "Download CA certificate")`
          : `pass the server's CA with ${caFlag} <file> (DigitalOcean: the cluster's "Download CA certificate")`,
      };
  }
}

// --- TLS probe ------------------------------------------------------------------------------

/** Brackets off an IPv6 literal (`[::1]` → `::1`). */
export const bareHost = (host: string) => host.replace(/^\[(.*)\]$/, "$1");

interface Probe {
  code: string | undefined;
  cert: PeerCert | undefined;
}

function certOf(socket: tls.TLSSocket): PeerCert | undefined {
  const c = socket.getPeerCertificate();
  if (!c || Object.keys(c).length === 0) return undefined;
  return {
    subject: dn(c.subject as unknown as Record<string, unknown>),
    issuer: dn(c.issuer as unknown as Record<string, unknown>),
    validTo: c.valid_to ?? "",
    altNames: c.subjectaltname ?? "",
  };
}

/**
 * The server's certificate and whether it verifies, without trusting it first: a handshake that
 * does not reject, then the chain result and the host name checked here. So a failure can name
 * the certificate's subject, which a rejected handshake hides.
 */
function tlsProbe(socket: net.Socket | undefined, host: string, port: number, ca: string | undefined): Promise<Probe> {
  const name = bareHost(host);
  return new Promise((resolve, reject) => {
    const opts: tls.ConnectionOptions = {
      ...(socket ? { socket } : { host: name, port }),
      ...(net.isIP(name) ? {} : { servername: name }),
      ...(ca ? { ca } : {}),
      rejectUnauthorized: false,
    };
    const s = tls.connect(opts, () => {
      const cert = certOf(s);
      let code: string | undefined = s.authorized ? undefined : String(s.authorizationError ?? "UNVERIFIED");
      if (!code) {
        const raw = s.getPeerCertificate();
        if (tls.checkServerIdentity(name, raw) !== undefined) code = "HOSTNAME_MISMATCH";
      }
      s.end();
      s.destroy();
      resolve({ code, cert });
    });
    s.setTimeout(15_000, () => {
      s.destroy();
      reject(new Error(`no TLS handshake with ${host}:${port} within 15 s`));
    });
    s.once("error", reject);
  });
}

function tcpConnect(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: bareHost(host), port });
    s.setTimeout(15_000, () => {
      s.destroy();
      reject(new Error(`no answer from ${host}:${port} within 15 s`));
    });
    s.once("connect", () => {
      s.setTimeout(0);
      resolve(s);
    });
    s.once("error", (e: NodeJS.ErrnoException) =>
      reject(new Error(`cannot reach ${host}:${port} (${e.code ?? e.message})`)),
    );
  });
}

/** Postgres speaks TLS after an SSLRequest (8 bytes) that the server answers with `S` or `N`. */
async function pgTlsProbe(host: string, port: number, ca: string | undefined): Promise<Probe> {
  const socket = await tcpConnect(host, port);
  const answer = await new Promise<string>((resolve, reject) => {
    socket.once("data", (d: Buffer) => resolve(String.fromCharCode(d[0] ?? 0)));
    socket.once("error", reject);
    const req = Buffer.alloc(8);
    req.writeInt32BE(8, 0);
    req.writeInt32BE(80877103, 4);
    socket.write(req);
  });
  if (answer !== "S") {
    socket.destroy();
    return { code: "NO_TLS", cert: undefined };
  }
  return tlsProbe(socket, host, port, ca);
}

// --- Valkey (RESP, enough for AUTH, PING, SELECT and INFO) ----------------------------------

export function encodeCommand(args: readonly string[]): Buffer {
  const parts = [`*${args.length}\r\n`];
  for (const a of args) parts.push(`$${Buffer.byteLength(a)}\r\n${a}\r\n`);
  return Buffer.from(parts.join(""));
}

export type Reply = { kind: "ok"; value: string } | { kind: "error"; value: string };

/** One RESP2 reply at the start of `buf`, or undefined while incomplete. */
export function parseReply(buf: Buffer): { reply: Reply; rest: Buffer } | undefined {
  const eol = buf.indexOf("\r\n");
  if (eol === -1) return undefined;
  const head = buf.subarray(1, eol).toString();
  const type = String.fromCharCode(buf[0] ?? 0);
  const after = buf.subarray(eol + 2);
  if (type === "+" || type === ":") return { reply: { kind: "ok", value: head }, rest: after };
  if (type === "-") return { reply: { kind: "error", value: head }, rest: after };
  if (type === "$") {
    const n = Number(head);
    if (n < 0) return { reply: { kind: "ok", value: "" }, rest: after };
    if (after.length < n + 2) return undefined;
    return { reply: { kind: "ok", value: after.subarray(0, n).toString() }, rest: after.subarray(n + 2) };
  }
  if (type === "%" || type === "=" || type === "*") {
    throw new Error(`unexpected RESP reply type ${type}`);
  }
  throw new Error("not a Valkey server (unexpected reply)");
}

class Resp {
  private buf: Buffer = Buffer.alloc(0);
  private waiting: ((r: Reply) => void) | undefined;
  private failed: ((e: Error) => void) | undefined;
  constructor(private readonly socket: net.Socket) {
    socket.on("data", (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.drain();
    });
    socket.on("error", (e) => this.failed?.(e));
    socket.on("close", () => this.failed?.(new Error("Valkey closed the connection")));
  }
  private drain() {
    if (!this.waiting) return;
    try {
      const parsed = parseReply(this.buf);
      if (!parsed) return;
      this.buf = parsed.rest;
      const w = this.waiting;
      this.waiting = undefined;
      w(parsed.reply);
    } catch (e) {
      this.failed?.(e as Error);
    }
  }
  send(args: readonly string[]): Promise<Reply> {
    return new Promise((resolve, reject) => {
      this.waiting = resolve;
      this.failed = reject;
      this.socket.write(encodeCommand(args));
      this.drain();
    });
  }
  close() {
    this.socket.destroy();
  }
}

function tlsSocket(host: string, port: number, ca: string | undefined): Promise<tls.TLSSocket> {
  const name = bareHost(host);
  return new Promise((resolve, reject) => {
    const s = tls.connect(
      { host: name, port, ...(net.isIP(name) ? {} : { servername: name }), ...(ca ? { ca } : {}) },
      () => resolve(s),
    );
    s.once("error", reject);
  });
}

// --- the checks -----------------------------------------------------------------------------

export interface PgTarget {
  url: string;
  host: string;
  port: number;
  user: string;
  database: string;
  sslmode: string;
}

/** Host, port, user, database and sslmode of a Postgres URL (never its password). */
export function pgTarget(url: string): PgTarget {
  const u = new URL(url);
  return {
    url,
    host: u.hostname,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    database: decodeURIComponent(u.pathname.slice(1)) || "postgres",
    sslmode: u.searchParams.get("sslmode") ?? "prefer",
  };
}

export interface ValkeyTarget {
  host: string;
  port: number;
  user: string;
  password: string;
  db: number;
  tls: boolean;
}

export function valkeyTarget(url: string): ValkeyTarget {
  const u = new URL(url);
  const scheme = u.protocol.replace(/:$/, "");
  if (!["redis", "rediss", "valkey", "valkeys"].includes(scheme)) throw new Error("not a redis:// or rediss:// URL");
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    db: Number(u.pathname.slice(1) || 0),
    tls: scheme === "rediss" || scheme === "valkeys",
  };
}

const ms = (start: number) => Math.round(performance.now() - start);
const where = (host: string, port: number) => `${host}:${port}`;

interface PgFacts {
  versionNum: number;
  version: string;
  maxConnections: number;
  superuserReserved: number;
  reserved: number;
  superuser: boolean;
  createRole: boolean;
  createInDatabase: boolean;
  createInPublic: boolean;
  used: number;
  role: string;
}

async function pgFacts(t: PgTarget, ca: string | undefined): Promise<PgFacts> {
  // postgresTls requires verify-full whenever a CA is given; the insecure path has no CA.
  const conn = postgresTls(t.url, ca);
  const sql = postgres(conn.url, {
    max: 1,
    connect_timeout: 15,
    onnotice: () => {},
    connection: { application_name: "commonair-state-check" },
    ...(conn.ssl ? { ssl: conn.ssl } : {}),
  });
  try {
    const [row] = await sql<
      {
        version_num: number;
        version: string;
        max_conn: number;
        su_reserved: number;
        reserved: number;
        rolsuper: boolean;
        rolcreaterole: boolean;
        create_db: boolean;
        create_public: boolean;
        used: number;
        role: string;
      }[]
    >`
      select current_setting('server_version_num')::int as version_num,
             current_setting('server_version') as version,
             current_setting('max_connections')::int as max_conn,
             current_setting('superuser_reserved_connections')::int as su_reserved,
             coalesce(nullif(current_setting('reserved_connections', true), ''), '0')::int as reserved,
             r.rolsuper, r.rolcreaterole,
             has_database_privilege(current_database(), 'CREATE') as create_db,
             coalesce(has_schema_privilege('public', 'CREATE'), false) as create_public,
             (select count(*) from pg_stat_activity where backend_type = 'client backend')::int as used,
             current_user::text as role
      from pg_roles r where r.rolname = current_user`;
    if (!row) throw new Error("the server returned no row for the current role");
    return {
      versionNum: row.version_num,
      // `17.6 (Debian 17.6-1.pgdg13+1)` on Debian's builds: the number is enough.
      version: row.version.split(" ")[0] ?? row.version,
      maxConnections: row.max_conn,
      superuserReserved: row.su_reserved,
      reserved: row.reserved,
      superuser: row.rolsuper,
      createRole: row.rolcreaterole,
      createInDatabase: row.create_db,
      createInPublic: row.create_public,
      used: row.used,
      role: row.role,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** The database's own reason, without anything from the URL. */
function pgError(e: unknown, t: PgTarget): Finding {
  const err = e as Error & { code?: string };
  const msg = err.message.replaceAll(t.url, "<url>");
  const fix =
    err.code === "28P01" || /password authentication failed/i.test(msg)
      ? "check DATABASE_PASSWORD for this user (install reads it from the environment or asks for it)"
      : err.code === "3D000"
        ? `create the database ${t.database} first (DigitalOcean: the cluster's Users & Databases tab)`
        : "check the host, port and that this host may connect (DigitalOcean: the cluster's trusted sources)";
  return { level: "error", message: `postgres: ${t.user}@${where(t.host, t.port)}/${t.database}: ${msg}`, fix };
}

export interface CheckInput {
  pgUrl?: string;
  pgCa?: string;
  valkeyUrl?: string;
  valkeyCa?: string;
  poolMax: number;
  allowInsecureDatabase: boolean;
  allowInsecureValkey: boolean;
}

export function inputFromEnv(env: Env): CheckInput {
  const pool = Number(env.STATE_POOL_MAX || 10);
  if (!Number.isInteger(pool) || pool < 1) throw new Error("STATE_POOL_MAX must be a positive integer");
  return {
    pgUrl: env.STATE_PG_URL || env.DATABASE_URL || undefined,
    pgCa: env.STATE_PG_CA || undefined,
    valkeyUrl: env.STATE_VALKEY_URL || env.VALKEY_URL || undefined,
    valkeyCa: env.STATE_VALKEY_CA || undefined,
    poolMax: pool,
    allowInsecureDatabase: env.STATE_ALLOW_INSECURE_DATABASE === "true",
    allowInsecureValkey: env.STATE_ALLOW_INSECURE_VALKEY === "true",
  };
}

const readCa = (path: string | undefined) => (path ? readFileSync(path, "utf8") : undefined);

export async function checkPostgres(input: CheckInput): Promise<{ findings: Finding[]; status: string }> {
  if (!input.pgUrl) return { findings: [], status: "" };
  const t = pgTarget(input.pgUrl);
  const ca = readCa(input.pgCa);
  const findings: Finding[] = [];
  const start = performance.now();
  const at = `${t.user}@${where(t.host, t.port)}/${t.database}`;
  let tlsText = "TLS off (--allow-insecure-database)";
  if (t.sslmode === "verify-full") {
    try {
      const p = await pgTlsProbe(t.host, t.port, ca);
      const f = tlsFinding("postgres", t.host, p.code, p.cert, Boolean(ca));
      findings.push(f);
      if (f.level === "error")
        return { findings, status: `unreachable over TLS: ${f.message.replace(/^postgres: /, "")}` };
      tlsText = "TLS verified";
    } catch (e) {
      const f: Finding = {
        level: "error",
        message: `postgres: ${(e as Error).message}`,
        fix: "check the host and port, and that this host may connect (DigitalOcean: the cluster's trusted sources)",
      };
      return { findings: [f], status: `unreachable: ${(e as Error).message}` };
    }
  } else if (!input.allowInsecureDatabase) {
    return {
      findings: [
        {
          level: "error",
          message: `postgres: the URL says sslmode=${t.sslmode}, which does not verify the server`,
          fix: "use sslmode=verify-full (with --database-ca for a private CA), or --allow-insecure-database on a private network only",
        },
      ],
      status: "refused: no verified TLS",
    };
  } else {
    tlsText = `TLS not verified (sslmode=${t.sslmode}, --allow-insecure-database)`;
    findings.push({ level: "warning", message: `postgres: ${tlsText}` });
  }
  let facts: PgFacts;
  try {
    facts = await pgFacts(t, t.sslmode === "verify-full" ? input.pgCa : undefined);
  } catch (e) {
    const f = pgError(e, t);
    return { findings: [...findings, f], status: `unreachable: ${f.message.replace(/^postgres: [^:]+: /, "")}` };
  }
  findings.push(versionFinding(facts.versionNum, facts.version));
  findings.push(
    ...roleFindings({
      name: facts.role,
      superuser: facts.superuser,
      createRole: facts.createRole,
      createInDatabase: facts.createInDatabase,
      createInPublic: facts.createInPublic,
      database: t.database,
    }),
  );
  const budget = connectionBudget({
    poolMax: input.poolMax,
    maxConnections: facts.maxConnections,
    superuserReserved: facts.superuserReserved,
    reserved: facts.reserved,
    superuser: facts.superuser,
  });
  findings.push(budgetFinding(budget, input.poolMax));
  const status = `reachable, ${tlsText}, PostgreSQL ${facts.version}, ${facts.used}/${budget.available} connections in use (${at}, ${ms(start)} ms)`;
  return { findings, status };
}

export async function checkValkey(input: CheckInput): Promise<{ findings: Finding[]; status: string }> {
  if (!input.valkeyUrl) return { findings: [], status: "" };
  const t = valkeyTarget(input.valkeyUrl);
  const ca = readCa(input.valkeyCa);
  const findings: Finding[] = [];
  const start = performance.now();
  const at = `${t.user ? `${t.user}@` : ""}${where(t.host, t.port)}`;
  let tlsText: string;
  if (t.tls) {
    try {
      const p = await tlsProbe(undefined, t.host, t.port, ca);
      const f = tlsFinding("valkey", t.host, p.code, p.cert, Boolean(ca));
      findings.push(f);
      if (f.level === "error")
        return { findings, status: `unreachable over TLS: ${f.message.replace(/^valkey: /, "")}` };
      tlsText = "TLS verified";
    } catch (e) {
      return {
        findings: [
          {
            level: "error",
            message: `valkey: ${(e as Error).message}`,
            fix: "check the host and port, and that this host may connect (DigitalOcean: the cluster's trusted sources)",
          },
        ],
        status: `unreachable: ${(e as Error).message}`,
      };
    }
  } else if (!input.allowInsecureValkey) {
    return {
      findings: [
        {
          level: "error",
          message: "valkey: the URL is redis://, without TLS",
          fix: "use rediss:// (with --valkey-ca for a private CA), or --allow-insecure-valkey on a private network only",
        },
      ],
      status: "refused: no TLS",
    };
  } else {
    tlsText = "TLS off (--allow-insecure-valkey)";
    findings.push({ level: "warning", message: `valkey: ${tlsText}` });
  }
  let r: Resp | undefined;
  try {
    const socket = t.tls ? await tlsSocket(t.host, t.port, ca) : await tcpConnect(t.host, t.port);
    socket.setTimeout(15_000, () => socket.destroy(new Error(`no answer from ${where(t.host, t.port)} within 15 s`)));
    r = new Resp(socket);
    if (t.password) {
      const auth = await r.send(t.user ? ["AUTH", t.user, t.password] : ["AUTH", t.password]);
      if (auth.kind === "error") {
        return {
          findings: [
            ...findings,
            {
              level: "error",
              message: `valkey: ${at} refused the password (${auth.value.split(" ")[0]})`,
              fix: "check VALKEY_PASSWORD (install reads it from the environment or asks for it) and the user in --valkey-url",
            },
          ],
          status: "refused the password",
        };
      }
    }
    if (t.db) {
      const sel = await r.send(["SELECT", String(t.db)]);
      if (sel.kind === "error") throw new Error(`SELECT ${t.db}: ${sel.value}`);
    }
    const pong = await r.send(["PING"]);
    if (pong.kind === "error" || pong.value !== "PONG") {
      return {
        findings: [
          ...findings,
          {
            level: "error",
            message: `valkey: PING answered ${pong.value}`,
            fix: pong.value.startsWith("NOAUTH")
              ? "this Valkey needs a password: set VALKEY_PASSWORD"
              : "check the URL points at a Valkey or Redis server",
          },
        ],
        status: `PING answered ${pong.value}`,
      };
    }
    findings.push({ level: "ok", message: `valkey: PING over ${tlsText}` });
    const info = await r.send(["INFO", "memory"]);
    if (info.kind === "error") {
      findings.push({
        level: "error",
        message: `valkey: INFO is refused (${info.value.split(" ")[0]}); BullMQ runs INFO on every connection`,
        fix: "allow +info for this user (requirements.md, 'Valkey'); CONFIG and ACL are never needed",
      });
      return { findings, status: `PING ok, INFO refused (${at}, ${ms(start)} ms)` };
    }
    findings.push(evictionFinding(infoField(info.value, "maxmemory_policy")));
    return { findings, status: `reachable, ${tlsText}, PING ok (${at}, ${ms(start)} ms)` };
  } catch (e) {
    const msg = (e as Error).message;
    return {
      findings: [
        ...findings,
        {
          level: "error",
          message: `valkey: ${msg}`,
          fix: "check the host and port, and that this host may connect (DigitalOcean: the cluster's trusted sources)",
        },
      ],
      status: `unreachable: ${msg}`,
    };
  } finally {
    r?.close();
  }
}

/** Preflight output: one line per finding, `fix:` under each error. */
export function formatFindings(findings: readonly Finding[]): string {
  return findings
    .map((f) => `${f.level === "ok" ? "ok" : f.level}: ${f.message}${f.fix ? `\n  fix: ${f.fix}` : ""}`)
    .join("\n");
}

const out = (text: string) => process.stdout.write(`${text}\n`);

async function main(argv: string[]): Promise<number> {
  const mode = argv[0];
  if (mode !== "preflight" && mode !== "status") {
    console.error("usage: bun infra/selfhost/state-check.ts preflight|status");
    return 2;
  }
  const input = inputFromEnv(process.env);
  const [pg, vk] = await Promise.all([checkPostgres(input), checkValkey(input)]);
  if (mode === "status") {
    if (input.pgUrl) out(`postgres  ${pg.status}`);
    if (input.valkeyUrl) out(`valkey    ${vk.status}`);
    return 0;
  }
  const findings = [...pg.findings, ...vk.findings];
  out(formatFindings(findings));
  return findings.some((f) => f.level === "error") ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (e) {
    // Never the URL: only the message, which the checks above keep free of it.
    console.error(`state-check: ${(e as Error).message}`);
    process.exit(1);
  }
}
