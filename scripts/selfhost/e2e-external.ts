// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Self-host e2e checks for external Postgres and Valkey (S1-b, ADR 0032 §3), which
 * scripts/selfhost/e2e.ts runs with `--state external` (together with e2e-s3.ts's external S3
 * store, Garage outside the instance):
 *
 *   externalStateSetup(inHost, expectThat)  a Postgres 17 and a Valkey in their own rootful
 *       containers on the e2e host, outside the instance's network and user, each TLS only with a
 *       certificate from a CA made here for host.containers.internal. Postgres as a managed
 *       provider hands it out (contract step §1.1): an owner with LOGIN and CREATEROLE only, and a
 *       database it owns. Valkey with two users, both denied @admin and @dangerous (but INFO,
 *       which BullMQ runs on every connection): `commonair`, an ACL user, and the password-only
 *       default user, DigitalOcean's model, which has no ACL users. An admin user is the test's.
 *   externalStateFlags(user) / externalStateEnv(user)  what to add to `selfhost.sh install`: the
 *       URLs and the CA, and the passwords in the environment, never on the command line.
 *   checkExternalState(inHost, expectThat, label)  after such an install, upgrade or re-install:
 *       no bundled Postgres or Valkey unit, container or volume; no unit depends on one; migrate
 *       created the app and monitor roles as the owner; `status` reports both servers as external,
 *       reachable over verified TLS, and prints no password; the worker ran jobs; and Valkey's
 *       ACL log is empty, so no command the stack sent was refused (no CONFIG or ACL at runtime).
 *
 * The instance reaches both at host.containers.internal (Podman's name for the host inside a
 * container), as it reaches the external S3 store.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./bundle.ts";
import type { Expect, InHost } from "./e2e-s3.ts";

/** The upstream Postgres image the stack's own image builds on (infra/postgres/Containerfile). */
export const POSTGRES_IMAGE = /^ARG POSTGRES_IMAGE=(\S+)$/m.exec(
  readFileSync(join(REPO_ROOT, "infra/postgres/Containerfile"), "utf8"),
)![1]!;
/** The Valkey image the instance's own unit pins. */
export const VALKEY_IMAGE = /^Image=(.*)$/m.exec(
  readFileSync(join(REPO_ROOT, "infra/quadlet/commonair-valkey.container"), "utf8"),
)![1]!;

export const E2E_STATE = {
  pg: "commonair-e2e-pg",
  valkey: "commonair-e2e-valkey",
  dir: "/root/commonair-e2e-state",
  host: "host.containers.internal",
  /** DigitalOcean's ports, not the defaults, on purpose. */
  pgPort: 25060,
  valkeyPort: 25061,
  owner: "commonair_owner",
  database: "commonair",
  aclUser: "commonair",
} as const;

const hex = (n: number) => randomBytes(n).toString("hex");
/** Fresh for each run; the owner's has URL-reserved characters, as a provider's may. */
export const E2E_STATE_PASSWORDS = {
  owner: `e2e/${hex(12)}@:+`,
  valkeyDefault: hex(24),
  valkeyAcl: hex(24),
  valkeyAdmin: hex(24),
};

export type ValkeyUser = "acl" | "default";

/** The flags for `selfhost.sh install` against the servers (the CA is root's file: install stages it). */
export function externalStateFlags(user: ValkeyUser): string {
  const s = E2E_STATE;
  const vkUser = user === "acl" ? `${s.aclUser}@` : "";
  return [
    `--database-url postgres://${s.owner}@${s.host}:${s.pgPort}/${s.database}?sslmode=verify-full`,
    `--database-ca ${s.dir}/ca.crt`,
    `--valkey-url rediss://${vkUser}${s.host}:${s.valkeyPort}`,
    `--valkey-ca ${s.dir}/ca.crt`,
  ].join(" ");
}

/** The passwords, for the install's environment (`inHost(…, { env })`). */
export const externalStateEnv = (user: ValkeyUser): Record<string, string> => ({
  DATABASE_PASSWORD: E2E_STATE_PASSWORDS.owner,
  VALKEY_PASSWORD: user === "acl" ? E2E_STATE_PASSWORDS.valkeyAcl : E2E_STATE_PASSWORDS.valkeyDefault,
});

/** A CA and a server certificate for host.containers.internal, made by the Postgres image's openssl. */
export const MAKE_CERTS = [
  "set -eu",
  "cd /out",
  "openssl req -x509 -new -nodes -newkey ec -pkeyopt ec_paramgen_curve:P-256 -days 3 -keyout ca.key -out ca.crt" +
    " -subj /CN=commonair-e2e-state-ca -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign",
  `openssl req -new -nodes -newkey ec -pkeyopt ec_paramgen_curve:P-256 -keyout server.key -out server.csr -subj /CN=${E2E_STATE.host}`,
  `printf '%s\\n' 'subjectAltName=DNS:${E2E_STATE.host},DNS:localhost,IP:127.0.0.1' 'basicConstraints=critical,CA:FALSE'` +
    " 'keyUsage=critical,digitalSignature' 'extendedKeyUsage=serverAuth' > server.ext",
  "openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 3 -extfile server.ext -out server.crt",
  "rm -f ca.key server.csr ca.srl",
  "chmod 0644 ./*",
].join("\n");

/** The Postgres container's start: TLS only (hostssl lines), TLSv1.2 at least. */
export const PG_START = [
  "set -eu",
  "install -d -o postgres -g postgres -m 0700 /etc/pgtls",
  "install -o postgres -g postgres -m 0600 /certs/server.key /etc/pgtls/server.key",
  "install -o postgres -g postgres -m 0644 /certs/server.crt /etc/pgtls/",
  "printf 'local all all trust\\nhostssl all all 0.0.0.0/0 scram-sha-256\\nhostssl all all ::/0 scram-sha-256\\n' > /etc/pgtls/pg_hba.conf",
  "chown postgres:postgres /etc/pgtls/pg_hba.conf",
  "exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/etc/pgtls/server.crt -c ssl_key_file=/etc/pgtls/server.key" +
    " -c ssl_min_protocol_version=TLSv1.2 -c hba_file=/etc/pgtls/pg_hba.conf",
].join("\n");

/**
 * The Valkey container's start: TLS only, noeviction, and the users. The rules every instance user
 * gets: everything but @admin and @dangerous, plus INFO (BullMQ's version and eviction check).
 */
export const VALKEY_RULES = '"~*" "&*" +@all -@admin -@dangerous +info';
export const VALKEY_START = [
  "set -eu",
  "install -d -m 0755 /tmp/tls",
  "install -m 0644 /certs/server.crt /certs/server.key /certs/ca.crt /tmp/tls/",
  "exec docker-entrypoint.sh valkey-server --port 0 --tls-port 6380 --tls-cert-file /tmp/tls/server.crt" +
    " --tls-key-file /tmp/tls/server.key --tls-ca-cert-file /tmp/tls/ca.crt --tls-auth-clients no" +
    " --save '' --appendonly no --maxmemory-policy noeviction" +
    ` --user default on ">$VK_DEFAULT" ${VALKEY_RULES}` +
    ` --user ${E2E_STATE.aclUser} on ">$VK_ACL" ${VALKEY_RULES}` +
    ' --user e2eadmin on ">$VK_ADMIN" "~*" "&*" +@all',
].join("\n");

/** The shell script that starts both servers; runs as root on the e2e host. */
export function setupScript(): string {
  const s = E2E_STATE;
  const psql = `podman exec -i -u postgres ${s.pg} psql -XqAt -v ON_ERROR_STOP=1`;
  return [
    "set -eu",
    "command -v podman >/dev/null || { echo 'podman is not installed on the host yet' >&2; exit 1; }",
    // As e2e-s3.ts: the outer Podman's host.containers.internal would never reach this host.
    "grep -v 'host\\.containers\\.internal' /etc/hosts > /tmp/hosts.e2e || true",
    "cat /tmp/hosts.e2e > /etc/hosts && rm -f /tmp/hosts.e2e",
    `podman rm -f ${s.pg} ${s.valkey} >/dev/null 2>&1 || true`,
    `rm -rf ${s.dir} && mkdir -p ${s.dir} && chmod 755 ${s.dir}`,
    `cat > ${s.dir}/make-certs.sh <<'EOF'\n${MAKE_CERTS}\nEOF`,
    `cat > ${s.dir}/pg-start.sh <<'EOF'\n${PG_START}\nEOF`,
    `cat > ${s.dir}/valkey-start.sh <<'EOF'\n${VALKEY_START}\nEOF`,
    `podman run --rm --network none -v ${s.dir}:/out:Z --entrypoint sh ${POSTGRES_IMAGE} /out/make-certs.sh`,
    // Rootful, on Podman's default network: outside the instance user's containers and network.
    `podman run -d --name ${s.pg} -p ${s.pgPort}:5432 -e POSTGRES_PASSWORD="$E2E_PG_SUPER" ` +
      `-v ${s.dir}:/certs:ro,Z --entrypoint sh ${POSTGRES_IMAGE} /certs/pg-start.sh >/dev/null`,
    `podman run -d --name ${s.valkey} -p ${s.valkeyPort}:6380 -e VK_DEFAULT -e VK_ACL -e VK_ADMIN ` +
      `-v ${s.dir}:/certs:ro,Z --entrypoint sh ${VALKEY_IMAGE} /certs/valkey-start.sh >/dev/null`,
    // The entrypoint's init server listens on the socket only; wait for the TCP one.
    `i=0; until podman exec ${s.pg} pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; do i=$((i + 1)); [ $i -lt 120 ] || exit 1; sleep 1; done`,
    // The provider's side: an owner with LOGIN and CREATEROLE only, and a database it owns.
    `${psql} -v pw="$E2E_PG_OWNER" <<'EOF'\ncreate role ${s.owner} login createrole password :'pw';\ncreate database ${s.database} owner ${s.owner};\nEOF`,
    `i=0; until ${valkeyCli("ping")} 2>/dev/null | grep -qx PONG; do i=$((i + 1)); [ $i -lt 60 ] || exit 1; sleep 1; done`,
    "echo state-ready",
  ].join("\n");
}

/** valkey-cli as the test's admin, in the Valkey container, over TLS. */
function valkeyCli(args: string): string {
  return (
    `podman exec -e REDISCLI_AUTH="$VK_ADMIN" ${E2E_STATE.valkey} valkey-cli --tls --cacert /tmp/tls/ca.crt -p 6380 ` +
    `--user e2eadmin --no-auth-warning ${args}`
  );
}

const ADMIN_ENV = () => ({ VK_ADMIN: E2E_STATE_PASSWORDS.valkeyAdmin });

/** Starts both servers as a provider would hand them out. */
export function externalStateSetup(inHost: InHost, expectThat: Expect): void {
  const p = E2E_STATE_PASSWORDS;
  const out = inHost(setupScript(), {
    env: {
      E2E_PG_SUPER: hex(16),
      E2E_PG_OWNER: p.owner,
      VK_DEFAULT: p.valkeyDefault,
      VK_ACL: p.valkeyAcl,
      VK_ADMIN: p.valkeyAdmin,
    },
  });
  expectThat(out.trim().endsWith("state-ready"), "the external Postgres and Valkey are up, TLS only, with their users");
  const plain = inHost(
    `podman exec ${E2E_STATE.pg} psql "postgres://${E2E_STATE.owner}@127.0.0.1:5432/${E2E_STATE.database}?sslmode=disable" -c 'select 1' 2>&1 || true`,
  );
  expectThat(/no pg_hba\.conf entry|SSL off/.test(plain), "the external Postgres refuses a connection without TLS");
  const config = inHost(
    `podman exec -e REDISCLI_AUTH="$VK_ACL" ${E2E_STATE.valkey} valkey-cli --tls --cacert /tmp/tls/ca.crt -p 6380 ` +
      `--user ${E2E_STATE.aclUser} --no-auth-warning config get maxmemory 2>&1 || true`,
    { env: { VK_ACL: p.valkeyAcl } },
  );
  expectThat(config.includes("NOPERM"), "the instance's Valkey user may not run CONFIG");
  // That refusal is in the ACL log: start it empty, so every later entry is the stack's.
  inHost(valkeyCli("acl log reset"), { env: ADMIN_ENV() });
}

/** The sum of every BullMQ queue's job counter: it grows while the worker runs jobs. */
function jobsCreated(inHost: InHost): number {
  const out = inHost(`for k in $(${valkeyCli("--scan --pattern 'bull:*:id'")}); do ${valkeyCli('get "$k"')}; done`, {
    env: ADMIN_ENV(),
    allowFail: true,
  });
  return out
    .split("\n")
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isFinite(n))
    .reduce((a, b) => a + b, 0);
}

/** Every password the e2e gave, as given and as a URL carries it. */
const secretsOf = () => Object.values(E2E_STATE_PASSWORDS).flatMap((v) => [v, encodeURIComponent(v)]);

/** After an install, upgrade or re-install against the external servers. */
export async function checkExternalState(inHost: InHost, expectThat: Expect, label: string): Promise<void> {
  const quadlets = inHost("ls ~/.config/containers/systemd", { user: true });
  expectThat(
    !/commonair-(postgres|valkey)(\.container|-data\.volume)/.test(quadlets),
    `${label}: no bundled Postgres or Valkey unit is installed`,
  );
  const deps = inHost(
    "grep -lE '^(Wants|Requires|Requisite|BindsTo|PartOf|After|Before)=.*commonair-(postgres|valkey)\\.service' " +
      "~/.config/containers/systemd/*.container || true",
    { user: true },
  ).trim();
  expectThat(deps === "", `${label}: no unit depends on or orders after one (${deps || "none"})`);
  const containers = inHost("podman ps -a --format '{{.Names}}'; podman volume ls --format '{{.Name}}'", {
    user: true,
  });
  expectThat(
    !/^commonair-(postgres|valkey)(-data)?$/m.test(containers),
    `${label}: no commonair-postgres or commonair-valkey container or volume exists`,
  );
  const roles = inHost(
    `podman exec -u postgres ${E2E_STATE.pg} psql -XqAt -d ${E2E_STATE.database} -c ` +
      `"select string_agg(rolname, ',' order by rolname) from pg_roles where rolname in ('commonair_app', 'commonair_monitor')"`,
  ).trim();
  expectThat(
    roles === "commonair_app,commonair_monitor",
    `${label}: migrate created the app and monitor roles as the owner (${roles})`,
  );
  const owned = inHost(
    `podman exec -u postgres ${E2E_STATE.pg} psql -XqAt -d ${E2E_STATE.database} -c ` +
      `"select count(*) from pg_tables where schemaname = 'public' and tableowner = '${E2E_STATE.owner}'"`,
  ).trim();
  expectThat(Number(owned) > 50, `${label}: the schema belongs to the owner (${owned} tables)`);

  const status = inHost("sh ~/commonair/selfhost.sh status", { user: true });
  expectThat(
    /^ {2}commonair-postgres +external +reachable, TLS verified, PostgreSQL 17\./m.test(status),
    `${label}: status reports Postgres as external, reachable over verified TLS`,
  );
  expectThat(
    /^ {2}commonair-valkey +external +reachable, TLS verified, PING ok/m.test(status),
    `${label}: status reports Valkey as external, reachable over verified TLS`,
  );
  const env = inHost("cat ~/.config/commonair/commonair.env", { user: true });
  const units = inHost("cat ~/.config/containers/systemd/*", { user: true });
  for (const [where, text] of Object.entries({ status, "commonair.env": env, units }))
    expectThat(!secretsOf().some((s) => text.includes(s)), `${label}: no external password in ${where}`);

  // A job cycle: the worker's schedulers (interact-tick every 2 s) keep creating jobs.
  const before = jobsCreated(inHost);
  let after = before;
  for (let i = 0; i < 30 && after <= before; i++) {
    await Bun.sleep(2000);
    after = jobsCreated(inHost);
  }
  expectThat(after > before, `${label}: the worker runs BullMQ jobs on the external Valkey (${before} -> ${after})`);
  const denied = inHost(valkeyCli("acl log"), { env: ADMIN_ENV() }).trim();
  expectThat(
    denied === "",
    `${label}: Valkey refused no command of the stack's (ACL LOG: ${denied.slice(0, 500) || "empty"})`,
  );
}

/** migrate ran once in the upgrade: one start, no restart of a failed attempt. */
export function migrateRestarts(inHost: InHost): number {
  return Number(
    inHost("systemctl --user show commonair-migrate.service --property=NRestarts --value", { user: true }).trim(),
  );
}

/** Removes both servers (cleanup; ignores servers that are not there). */
export function externalStateTeardown(inHost: InHost): void {
  inHost(`podman rm -f ${E2E_STATE.pg} ${E2E_STATE.valkey} >/dev/null 2>&1; rm -rf ${E2E_STATE.dir}`, {
    allowFail: true,
  });
}
