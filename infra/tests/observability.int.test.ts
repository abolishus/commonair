// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * L1-observability, live:
 * - the pinned collector image runs infra/otel-collector/config.yaml against a Postgres and a
 *   Valkey with the read-only monitor role (infra/postgres/monitor-role.sql) created here, in both
 *   state modes of contract step §3.7:
 *   - bundled: plain TCP, the role applied by a superuser (pg_monitor granted), Valkey's default
 *     user with a password. The collector starts before either is up and recovers.
 *   - external: TLS only on both (pg_hba hostssl, Valkey --port 0), verified against a private CA
 *     made here, the role applied by a CREATEROLE owner (pg_monitor not grantable).
 *   - external with a CA that did not sign the servers: no state series, the scrape errors are
 *     counted, and the collector keeps running.
 *   Then its Prometheus endpoint has system_*, postgresql_* and redis_* series with the right
 *   state_mode, and no password is in its output or logs.
 * - promtool's rule unit tests (observability-rules-*.test.yml) pass.
 * - Grafana (the pinned image) provisions all six dashboards.
 * Each mode runs in its own pod, so the servers are `localhost` to the collector, as the test
 * certificate names them. Needs podman; CI's integration job has it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vite-plus/test";
import { PORT_RACE_ATTEMPTS, isPortRace } from "../../scripts/test-podman.ts";
import { testOwnerArgs } from "../../scripts/test-owner.ts";
import {
  POSTGRES_IMAGE,
  type TestCerts,
  VALKEY_IMAGE,
  makeTestCerts,
  podman,
  podmanAvailable,
  podmanOk,
} from "../../packages/db/tests/external-owner-tls.ts";
import { CAN_RUN_PROMTOOL, requirePromtool, runPromtool } from "./observability-promtool.ts";

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const ROOT = new URL("../../", import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const COLLECTOR_IMAGE = /BASE_IMAGE: "(ghcr\.io\/open-telemetry\/[^"]+)"/.exec(read("compose.yaml"))?.[1] ?? "";
const GRAFANA_IMAGE = /^Image=(.*)$/m.exec(read("infra/quadlet/commonair-grafana.container"))?.[1] ?? "";
const MONITOR_SQL = read("infra/postgres/monitor-role.sql");

const HAVE_PODMAN = podmanAvailable();
if (!HAVE_PODMAN) {
  if (process.env.CI) throw new Error("observability.int.test.ts needs podman, and CI must run it");
  console.warn("\n*** observability.int.test.ts SKIPPED: podman is not available here ***\n");
}
requirePromtool("observability.int.test.ts");

const id = crypto.randomUUID().slice(0, 8);
const secret = () => crypto.randomUUID().replaceAll("-", "");
const SUPER_PASSWORD = secret();
const MONITOR_PASSWORD = secret();
const VALKEY_PASSWORD = secret();
const pods: string[] = [];
let certs: TestCerts | undefined;

afterAll(() => {
  if (!HAVE_PODMAN) return;
  for (const p of pods) podman(["pod", "rm", "-f", "-t", "0", p]);
  certs?.cleanup();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function createPod(name: string): void {
  pods.push(name);
  // Start the infra container now, so the published ports are bound here, where losing one to
  // another process is retried, and not at the first member's start (scripts/test-podman.ts).
  for (let attempt = 1; ; attempt++) {
    podmanOk(["pod", "create", "--name", name, ...testOwnerArgs(), "-p", "127.0.0.1::9464", "-p", "127.0.0.1::8888"]);
    const started = podman(["pod", "start", name]);
    if (started.code === 0) return;
    if (!isPortRace(started.out) || attempt >= PORT_RACE_ATTEMPTS)
      throw new Error(`podman pod start ${name} failed (${started.code}):\n${started.out}`);
    podman(["pod", "rm", "-f", "-t", "0", name]);
  }
}
function podPort(pod: string, port: number): number {
  const out = podmanOk(["pod", "inspect", pod, "--format", "{{json .InfraConfig.PortBindings}}"]);
  const bindings = JSON.parse(out) as Record<string, { HostPort: string }[]>;
  const p = Number(bindings[`${port}/tcp`]?.[0]?.HostPort);
  if (!p) throw new Error(`no host port for ${pod}:${port}: ${out}`);
  return p;
}

/** psql inside the Postgres container over the local socket (trust), as `user`. */
function psql(container: string, user: string, sql: string): string {
  return podmanOk(
    ["exec", "-i", container, "psql", "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", "commonair"],
    {
      stdin: new TextEncoder().encode(sql),
    },
  ).trim();
}
async function waitForPostgres(container: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (podman(["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]).code !== 0) {
    if (Date.now() > deadline) throw new Error(`postgres never started:\n${podman(["logs", container]).out}`);
    await sleep(500);
  }
}
/** monitor-role.sql exactly as apply-app-role.ts runs it: one transaction, the password transaction-local. */
function applyMonitorRole(container: string, asUser: string): boolean {
  psql(
    container,
    asUser,
    `BEGIN;\nSELECT set_config('commonair.monitor_password', '${MONITOR_PASSWORD}', true);\n${MONITOR_SQL}\nCOMMIT;\n`,
  );
  return psql(container, "postgres", "select pg_has_role('commonair_monitor', 'pg_monitor', 'MEMBER')") === "t";
}

function startCollector(pod: string, name: string, env: Record<string, string>, mounts: string[] = []): void {
  const args = ["run", "-d", "--pod", pod, "--name", name, ...testOwnerArgs()];
  for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
  args.push(
    "-v",
    `${join(ROOT, "infra/otel-collector")}:/etc/otelcol-contrib:ro,Z`,
    // As the Quadlet unit mounts it.
    "-v",
    "/proc:/hostfs/proc:ro",
    ...mounts,
    COLLECTOR_IMAGE,
    "--config=/etc/otelcol-contrib/config.yaml",
  );
  podmanOk(args, { timeoutMs: 600_000 });
}

async function scrape(port: number): Promise<string> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/metrics`, { signal: AbortSignal.timeout(5_000) });
    return res.ok ? await res.text() : "";
  } catch {
    return "";
  }
}
/** Waits until every pattern is in the collector's Prometheus output; returns that output. */
async function waitForSeries(
  port: number,
  patterns: RegExp[],
  container: string,
  timeoutMs = 150_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  for (;;) {
    last = await scrape(port);
    if (patterns.every((p) => p.test(last))) return last;
    if (Date.now() > deadline) {
      const missing = patterns.filter((p) => !p.test(last)).map(String);
      throw new Error(
        `missing ${missing.join(", ")}\n--- collector logs ---\n${podman(["logs", container]).out.slice(-4000)}`,
      );
    }
    await sleep(2_000);
  }
}
const series = (name: string, mode: string) => new RegExp(`^${name}\\{[^}]*state_mode="${mode}"`, "m");
const stateSeries = (mode: string) => [
  series("system_cpu_time_seconds_total", mode),
  series("system_memory_usage_bytes", mode),
  series("system_filesystem_utilization_ratio", mode),
  series("postgresql_backends", mode),
  series("postgresql_connection_max", mode),
  series("postgresql_db_size_bytes", mode),
  series("commonair_postgres_active_time_seconds_total", mode),
  series("redis_memory_used_bytes", mode),
  series("redis_maxmemory_bytes", mode),
];

/** The collector's own count of metric points a receiver failed to scrape (0 when never counted). */
async function erroredPoints(internalPort: number, receiver: string): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${internalPort}/metrics`).catch(() => null);
  const telemetry = res?.ok ? await res.text() : "";
  return Number(
    new RegExp(`^otelcol_scraper_errored_metric_points\\{[^}]*receiver="${receiver}"[^}]*\\} (\\S+)$`, "m").exec(
      telemetry,
    )?.[1] ?? 0,
  );
}

function expectNoSecrets(text: string): void {
  for (const pw of [SUPER_PASSWORD, MONITOR_PASSWORD, VALKEY_PASSWORD]) expect(text.includes(pw)).toBe(false);
}

describe.runIf(HAVE_PODMAN)("the collector against Postgres and Valkey", () => {
  test("bundled: starts before the state is up, then reads both as commonair_monitor (pg_monitor granted)", async () => {
    const pod = `commonair-obs-bundled-${id}`;
    createPod(pod);
    const otel = `${pod}-otel`;
    // The collector first: neither server answers yet, and it must not crash-loop.
    startCollector(pod, otel, {
      OBSERVABILITY_STATE_MODE: "bundled",
      PG_MONITOR_ENDPOINT: "localhost:5432",
      PG_MONITOR_TLS: "disable",
      PG_MONITOR_PASSWORD: MONITOR_PASSWORD,
      VALKEY_MONITOR_ENDPOINT: "localhost:6379",
      VALKEY_MONITOR_TLS: "off",
      VALKEY_MONITOR_PASSWORD: VALKEY_PASSWORD,
    });
    const port = podPort(pod, 9464);
    await waitForSeries(port, [series("system_cpu_time_seconds_total", "bundled")], otel);
    expect(podmanOk(["inspect", otel, "--format", "{{.State.Running}}"]).trim()).toBe("true");

    const pg = `${pod}-pg`;
    podmanOk(
      [
        "run",
        "-d",
        "--pod",
        pod,
        "--name",
        pg,
        ...testOwnerArgs(),
        "-e",
        `POSTGRES_PASSWORD=${SUPER_PASSWORD}`,
        "-e",
        "POSTGRES_DB=commonair",
        POSTGRES_IMAGE,
      ],
      { timeoutMs: 600_000 },
    );
    podmanOk(
      [
        "run",
        "-d",
        "--pod",
        pod,
        "--name",
        `${pod}-valkey`,
        ...testOwnerArgs(),
        VALKEY_IMAGE,
        "valkey-server",
        "--requirepass",
        VALKEY_PASSWORD,
        "--maxmemory",
        "64mb",
        "--save",
        "",
        "--appendonly",
        "no",
      ],
      { timeoutMs: 600_000 },
    );
    await waitForPostgres(pg);
    // A superuser applies it on the bundled stack, so pg_monitor is granted.
    expect(applyMonitorRole(pg, "postgres")).toBe(true);

    const out = await waitForSeries(port, stateSeries("bundled"), otel);
    expect(out).toMatch(/^redis_maxmemory_bytes\{[^}]*\} 6\.7108864e\+07$/m);
    expectNoSecrets(out);
    expectNoSecrets(podman(["logs", otel]).out);
    // The monitor role is read-only: a write is refused even where a grant would allow it.
    const write = podman([
      "exec",
      "-e",
      `PGPASSWORD=${MONITOR_PASSWORD}`,
      pg,
      "psql",
      "-X",
      "-h",
      "127.0.0.1",
      "-U",
      "commonair_monitor",
      "-d",
      "commonair",
      "-c",
      "create table t (x int)",
    ]);
    expect(write.code).not.toBe(0);
    expect(write.out).toMatch(/read-only transaction|permission denied/);
  });

  describe("external: TLS only, verified against a private CA", () => {
    const pod = `commonair-obs-external-${id}`;
    const pg = `${pod}-pg`;
    const tlsEnv = (caFile: string) => ({
      OBSERVABILITY_STATE_MODE: "external",
      PG_MONITOR_ENDPOINT: "localhost:5432",
      PG_MONITOR_TLS: "verify-full",
      PG_MONITOR_PASSWORD: MONITOR_PASSWORD,
      DATABASE_CA_FILE: caFile,
      VALKEY_MONITOR_ENDPOINT: "localhost:6379",
      VALKEY_MONITOR_TLS: "on",
      VALKEY_MONITOR_PASSWORD: VALKEY_PASSWORD,
      VALKEY_CA_FILE: caFile,
    });

    test("the managed side: a CREATEROLE owner applies the role, and cannot grant pg_monitor", async () => {
      certs = makeTestCerts();
      writeFileSync(
        join(certs.dir, "pg_hba.conf"),
        "local all all trust\nhostssl all all 0.0.0.0/0 scram-sha-256\nhostssl all all ::/0 scram-sha-256\n",
      );
      createPod(pod);
      const pgStart = [
        "set -eu",
        "install -d -o postgres -g postgres -m 0700 /etc/pgtls",
        "install -o postgres -g postgres -m 0600 /certs/server.key /etc/pgtls/server.key",
        "install -o postgres -g postgres -m 0644 /certs/server.crt /certs/pg_hba.conf /etc/pgtls/",
        "exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/etc/pgtls/server.crt" +
          " -c ssl_key_file=/etc/pgtls/server.key -c ssl_min_protocol_version=TLSv1.2 -c hba_file=/etc/pgtls/pg_hba.conf",
      ].join("\n");
      podmanOk(
        [
          "run",
          "-d",
          "--pod",
          pod,
          "--name",
          pg,
          ...testOwnerArgs(),
          "-e",
          `POSTGRES_PASSWORD=${SUPER_PASSWORD}`,
          "-v",
          `${certs.dir}:/certs:ro,Z`,
          "--entrypoint",
          "sh",
          POSTGRES_IMAGE,
          "-c",
          pgStart,
        ],
        { timeoutMs: 600_000 },
      );
      const valkeyStart = [
        "set -eu",
        "install -d -m 0755 /tmp/tls",
        "install -m 0644 /certs/server.crt /certs/commonair-test-ca.crt /certs/server.key /tmp/tls/",
        "exec docker-entrypoint.sh valkey-server --port 0 --tls-port 6379 --tls-cert-file /tmp/tls/server.crt" +
          " --tls-key-file /tmp/tls/server.key --tls-ca-cert-file /tmp/tls/commonair-test-ca.crt --tls-auth-clients no" +
          ' --requirepass "$VALKEY_TEST_PASSWORD" --maxmemory 64mb --save "" --appendonly no',
      ].join("\n");
      podmanOk(
        [
          "run",
          "-d",
          "--pod",
          pod,
          "--name",
          `${pod}-valkey`,
          ...testOwnerArgs(),
          "-e",
          `VALKEY_TEST_PASSWORD=${VALKEY_PASSWORD}`,
          "-v",
          `${certs.dir}:/certs:ro,Z`,
          "--entrypoint",
          "sh",
          VALKEY_IMAGE,
          "-c",
          valkeyStart,
        ],
        { timeoutMs: 600_000 },
      );
      await waitForPostgres(pg);
      podmanOk(["exec", pg, "psql", "-X", "-U", "postgres", "-c", "create role owner login createrole"]);
      podmanOk(["exec", pg, "psql", "-X", "-U", "postgres", "-c", "create database commonair owner owner"]);
      expect(applyMonitorRole(pg, "owner")).toBe(false);
    });

    test("reads both with verify-full and the CA, without pg_monitor", async () => {
      const otel = `${pod}-otel`;
      startCollector(pod, otel, tlsEnv("/certs/commonair-test-ca.crt"), ["-v", `${certs?.dir}:/certs:ro,Z`]);
      const out = await waitForSeries(podPort(pod, 9464), stateSeries("external"), otel);
      expectNoSecrets(out);
      expectNoSecrets(podman(["logs", otel]).out);
      // pg_hba allows hostssl only, so every session of the monitor role is TLS.
      const ssl = psql(
        pg,
        "postgres",
        "select count(*) filter (where not s.ssl) from pg_stat_ssl s join pg_stat_activity a using (pid) where a.usename = 'commonair_monitor'",
      );
      expect(ssl).toBe("0");
      // Nothing the receiver queries needs pg_monitor: a permission error on any scrape would be
      // counted here and fire CommonairStateScrapeFailing on every managed install.
      const internal = podPort(pod, 8888);
      const before = await erroredPoints(internal, "postgresql");
      await sleep(65_000);
      expect(before).toBe(0);
      expect(await erroredPoints(internal, "postgresql")).toBe(0);
      expect(podman(["logs", otel]).out).not.toMatch(/permission denied/i);
      podmanOk(["rm", "-f", "-t", "0", otel]);
    });

    test("a CA that did not sign the servers: no state series, the errors are counted, it keeps running", async () => {
      const otel = `${pod}-otel-wrong-ca`;
      startCollector(pod, otel, tlsEnv("/certs/commonair-other-ca.crt"), ["-v", `${certs?.dir}:/certs:ro,Z`]);
      const port = podPort(pod, 9464);
      await waitForSeries(port, [series("system_cpu_time_seconds_total", "external")], otel);
      const internal = podPort(pod, 8888);
      const deadline = Date.now() + 150_000;
      // The redis receiver does not count its failures; its series are simply missing (below).
      while ((await erroredPoints(internal, "postgresql")) === 0) {
        if (Date.now() > deadline) throw new Error("no postgresql scrape errors counted");
        await sleep(2_000);
      }
      const out = await scrape(port);
      expect(out).not.toMatch(/^postgresql_backends\{/m);
      expect(out).not.toMatch(/^redis_memory_used_bytes\{/m);
      expect(podmanOk(["inspect", otel, "--format", "{{.State.Running}} {{.RestartCount}}"]).trim()).toBe("true 0");
      const logs = podman(["logs", otel]).out;
      expect(logs).toMatch(/certificate|x509|tls/i);
      // The TLS failure path is where a driver would print its DSN, which holds the password.
      expectNoSecrets(logs);
    });
  });
});

describe.runIf(CAN_RUN_PROMTOOL)("promtool rule unit tests", () => {
  test("thresholds, the slo_target label and its 0.995 fallback behave as ADR 0032 says", () => {
    const r = runPromtool(
      [
        "set -eu",
        "COMMONAIR_PROMETHEUS_GENERATED=/tmp/commonair-rules-ours SLO_TARGET=0.999 EGRESS_BUDGET_GIB=500" +
          " LIVE_STREAMS_PER_HOST=8 sh /etc/prometheus/start.sh --render-only",
        "promtool test rules /infra/tests/observability-rules-default.test.yml /infra/tests/observability-rules-ours.test.yml",
      ].join("\n"),
    );
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain("FAILED");
  });
});

describe.runIf(HAVE_PODMAN)("Grafana", () => {
  test("provisions the six dashboards", async () => {
    const name = `commonair-obs-grafana-${id}`;
    const password = secret();
    podmanOk(
      [
        "run",
        "-d",
        "--name",
        name,
        ...testOwnerArgs(),
        "-p",
        "127.0.0.1::3000",
        "-e",
        `GF_SECURITY_ADMIN_PASSWORD=${password}`,
        "-e",
        "GF_ANALYTICS_REPORTING_ENABLED=false",
        "-e",
        "GF_ANALYTICS_CHECK_FOR_UPDATES=false",
        "-e",
        "GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES=false",
        "-v",
        `${join(ROOT, "infra/grafana/provisioning")}:/etc/grafana/provisioning:ro,Z`,
        "-v",
        `${join(ROOT, "infra/grafana/dashboards")}:/var/lib/grafana/dashboards:ro,Z`,
        GRAFANA_IMAGE,
      ],
      { timeoutMs: 600_000 },
    );
    try {
      const port = Number(/:(\d+)\s*$/m.exec(podmanOk(["port", name, "3000/tcp"]).trim())?.[1]);
      const auth = `Basic ${btoa(`admin:${password}`)}`;
      const deadline = Date.now() + 180_000;
      let titles: string[] = [];
      for (;;) {
        const res = await fetch(`http://127.0.0.1:${port}/api/search?type=dash-db`, {
          headers: { authorization: auth },
        }).catch(() => null);
        titles = res?.ok ? ((await res.json()) as { title: string }[]).map((d) => d.title).sort() : [];
        if (titles.length >= 6 || Date.now() > deadline) break;
        await sleep(2_000);
      }
      expect(titles).toEqual(["App", "Availability", "Host", "Postgres", "Stage triggers", "Valkey"]);
    } finally {
      podman(["rm", "-f", "-t", "0", name]);
    }
  });
});
