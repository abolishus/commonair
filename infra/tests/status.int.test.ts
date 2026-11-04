// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * L1-status against the pinned images:
 * - blackbox_exporter accepts infra/status/blackbox.yml;
 * - the monitoring Prometheus and blackbox in one pod, with render.ts on the host: the renderer
 *   writes the targets, Prometheus probes them, the recording rule fills, and the page shows a
 *   live component up and an unreachable one down, with its mail sent to an injected transport;
 * - Grafana provisions the contact point, the policy and the ALERTS rule, with route-env.sh and
 *   without it (as the stack ran before its entrypoint sourced it), and says when there is no route.
 * Needs podman; CI's integration job has it.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vite-plus/test";
import { testOwnerArgs } from "../../scripts/test-owner.ts";
import { hostPort, podman, podmanAvailable, podmanOk } from "../../packages/db/tests/external-owner-tls.ts";
import { type MailSettings, httpProm, parseConfig, runOnce } from "../status/render.ts";

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const ROOT = new URL("../../", import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const imageOf = (unit: string) => /^Image=(.*)$/m.exec(read(unit))?.[1] ?? "";
const BLACKBOX_IMAGE = imageOf("infra/status/units/commonair-status-blackbox.container");
const PROM_IMAGE = imageOf("infra/status/units/commonair-status-prometheus.container");
const GRAFANA_IMAGE = imageOf("infra/quadlet/commonair-grafana.container");

const HAVE_PODMAN = podmanAvailable();
if (!HAVE_PODMAN) {
  if (process.env.CI) throw new Error("status.int.test.ts needs podman, and CI must run it");
  console.warn("\n*** status.int.test.ts SKIPPED: podman is not available here ***\n");
}

const id = crypto.randomUUID().slice(0, 8);
const cleanup: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanup.reverse()) c();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function tmp(): string {
  // Under podman machine (macOS) tmpdir() is shared with the VM.
  const d = mkdtempSync(join(tmpdir(), "commonair-status-int-"));
  chmodSync(d, 0o777);
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

describe.runIf(HAVE_PODMAN)("blackbox_exporter", () => {
  test("accepts blackbox.yml", () => {
    const r = podman(
      [
        "run",
        "--rm",
        ...testOwnerArgs(),
        "--network",
        "none",
        "-v",
        `${join(ROOT, "infra/status/blackbox.yml")}:/etc/blackbox_exporter/config.yml:ro,Z`,
        BLACKBOX_IMAGE,
        "--config.file=/etc/blackbox_exporter/config.yml",
        "--config.check",
      ],
      { timeoutMs: 300_000 },
    );
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/Config file is ok/i);
  });
});

describe.runIf(HAVE_PODMAN)("probes to page", () => {
  test("the renderer's targets are probed, recorded and rendered, and a down component is mailed", async () => {
    const data = tmp();
    for (const sub of ["targets", "site", "state", "notes"]) {
      mkdirSync(join(data, sub));
      chmodSync(join(data, sub), 0o777);
    }
    const etc = tmp();
    // The unit's paths, with a 5 s interval so the test sees two probes quickly.
    writeFileSync(
      join(etc, "prometheus.yml"),
      read("infra/status/prometheus.yml")
        .replace("scrape_interval: 30s", "scrape_interval: 5s")
        .replace("scrape_timeout: 15s", "scrape_timeout: 4s")
        .replace("evaluation_interval: 30s", "evaluation_interval: 5s")
        .replace("refresh_interval: 1m", "refresh_interval: 5s")
        // In one pod, blackbox is 127.0.0.1:9115 rather than the unit's network alias.
        .replaceAll("blackbox:9115", "127.0.0.1:9115"),
    );
    writeFileSync(join(etc, "rules.yml"), read("infra/status/rules.yml").replace("interval: 30s", "interval: 5s"));
    const pod = `commonair-status-${id}`;
    podmanOk(["pod", "create", "--name", pod, ...testOwnerArgs(), "-p", "127.0.0.1::9090"]);
    cleanup.push(() => void podman(["pod", "rm", "-f", "-t", "0", pod]));
    podmanOk(
      [
        "run",
        "-d",
        "--pod",
        pod,
        "--name",
        `${pod}-blackbox`,
        "-v",
        `${join(ROOT, "infra/status/blackbox.yml")}:/etc/blackbox_exporter/config.yml:ro,Z`,
        BLACKBOX_IMAGE,
        "--config.file=/etc/blackbox_exporter/config.yml",
      ],
      { timeoutMs: 300_000 },
    );
    podmanOk(
      [
        "run",
        "-d",
        "--pod",
        pod,
        "--name",
        `${pod}-prometheus`,
        "-v",
        `${join(etc, "prometheus.yml")}:/etc/prometheus/prometheus.yml:ro,z`,
        "-v",
        `${join(etc, "rules.yml")}:/etc/prometheus/rules.yml:ro,z`,
        "-v",
        `${join(data, "targets")}:/etc/prometheus/targets:ro,z`,
        PROM_IMAGE,
        "--config.file=/etc/prometheus/prometheus.yml",
        "--storage.tsdb.path=/prometheus",
      ],
      { timeoutMs: 300_000 },
    );
    const base = `http://127.0.0.1:${hostPort(`${pod}-prometheus`, 9090)}`;
    // A live component (Prometheus itself, over TCP), a dead one, and a canary (blackbox).
    const cfg = parseConfig({
      siteName: "CommonAir",
      origin: "https://status-probe.invalid",
      canaries: ["127.0.0.1:9115"],
      extraComponents: [
        { id: "local", name: "Local TCP", module: "tcp_connect", target: "127.0.0.1:9090" },
        { id: "closed", name: "Closed port", module: "tcp_connect", target: "127.0.0.1:9" },
      ],
      probeIntervalSeconds: 5,
    });
    const mails: string[] = [];
    const deps = {
      cfg,
      prom: httpProm(base),
      dataDir: data,
      alertEnv: { SMTP_HOST: "smtp.relay.test", MAIL_FROM: "status@status.test", ALERT_EMAIL_TO: "oncall@ops.test" },
      transport: {
        mail: async (_s: MailSettings, m: { subject: string }) => void mails.push(m.subject),
        webhook: async () => undefined,
      },
      log: () => undefined,
    };
    const deadline = Date.now() + 240_000;
    let states: Record<string, string> = {};
    for (;;) {
      try {
        states = (await runOnce(deps)).judgement.states;
      } catch {
        // Prometheus still starting.
      }
      if ((states.local === "up" && states.closed === "down") || Date.now() > deadline) break;
      await sleep(3_000);
    }
    expect(states).toMatchObject({ local: "up", closed: "down", web: "down" });
    expect(mails).toContain("[CommonAir status] Closed port is down");
    expect(mails).not.toContain("[CommonAir status] Local TCP is down");
    const html = readFileSync(join(data, "site", "index.html"), "utf8");
    expect(html).toMatch(/<h3>Local TCP<\/h3><span class="state s-up">Operational<\/span>/);
    // The recording rule counts the probes while the canary answers.
    const rec = (await (
      await fetch(
        `${base}/api/v1/query?query=${encodeURIComponent('commonair_status:probe_success:sighted{component="local"}')}`,
      )
    ).json()) as { data: { result: { value: [number, string] }[] } };
    expect(rec.data.result[0]?.value[1]).toBe("1");
  });
});

describe.runIf(HAVE_PODMAN)("Grafana alerting provisioning", () => {
  let grafanas = 0;
  async function grafana(opts: { routeEnv: boolean; env: Record<string, string> }) {
    const name = `commonair-status-grafana-${id}-${++grafanas}`;
    const password = crypto.randomUUID().replaceAll("-", "");
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
        ...Object.entries(opts.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
        "-v",
        `${join(ROOT, "infra/grafana/provisioning")}:/etc/grafana/provisioning:ro,Z`,
        ...(opts.routeEnv ? ["--entrypoint", "/bin/sh"] : []),
        GRAFANA_IMAGE,
        ...(opts.routeEnv ? ["-c", ". /etc/grafana/provisioning/alerting/route-env.sh && exec /run.sh"] : []),
      ],
      { timeoutMs: 600_000 },
    );
    cleanup.push(() => void podman(["rm", "-f", "-t", "0", name]));
    const port = hostPort(name, 3000);
    const auth = { authorization: `Basic ${btoa(`admin:${password}`)}` };
    const get = async (path: string) => {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers: auth });
      return r.ok ? ((await r.json()) as unknown) : null;
    };
    const deadline = Date.now() + 180_000;
    let rules: unknown = null;
    while (Date.now() < deadline) {
      rules = await get("/api/v1/provisioning/alert-rules").catch(() => null);
      if (Array.isArray(rules) && rules.length > 0) break;
      if (podman(["inspect", "-f", "{{.State.Running}}", name]).out.trim() !== "true") break;
      await sleep(2_000);
    }
    return { name, get, rules, logs: () => podman(["logs", name]).out };
  }

  test("with route-env.sh and no route: provisioned, and the log says so", async () => {
    const g = await grafana({ routeEnv: true, env: {} });
    expect(g.logs()).toContain("NO ALERT ROUTE");
    const [rule] = g.rules as {
      uid: string;
      data: { model: { expr?: string } }[];
      annotations: Record<string, string>;
    }[];
    expect(rule?.uid).toBe("commonair-prometheus-alerts");
    // `$$` reached Grafana as `$`, and nothing else was expanded.
    expect(rule?.data[0]?.model.expr).toBe(
      'label_replace(ALERTS{alertstate="firing"}, "prometheus_alert", "$1", "alertname", "(.+)")',
    );
    expect(rule?.annotations.summary).toBe('{{ index $labels "summary" }}');
    const cps = (await g.get("/api/v1/provisioning/contact-points")) as {
      name: string;
      type: string;
      settings: Record<string, unknown>;
    }[];
    const ours = cps.filter((c) => c.name === "commonair-oncall");
    expect(ours.map((c) => c.type)).toEqual(["email"]);
    expect(ours.find((c) => c.type === "email")?.settings.addresses).toBe("no-route@alerts.invalid");
    const policy = (await g.get("/api/v1/provisioning/policies")) as {
      receiver: string;
      routes: { object_matchers: string[][] }[];
    };
    expect(policy.receiver).toBe("commonair-oncall");
    expect(policy.routes.map((r) => r.object_matchers[0]?.[2])).toEqual(["page", "ticket"]);
  });

  test("with a route: the recipient comes from ALERT_EMAIL_TO", async () => {
    const g = await grafana({
      routeEnv: true,
      env: { ALERT_EMAIL_TO: "oncall@ops.test", SMTP_HOST: "smtp.relay.test", SMTP_PORT: "2587" },
    });
    expect(g.logs()).toContain("alert route: mail");
    const cps = (await g.get("/api/v1/provisioning/contact-points")) as {
      name: string;
      type: string;
      settings: Record<string, unknown>;
    }[];
    expect(cps.find((c) => c.name === "commonair-oncall" && c.type === "email")?.settings.addresses).toBe(
      "oncall@ops.test",
    );
  });

  test("without route-env.sh (an entrypoint not yet changed): Grafana starts, with no alerting", async () => {
    const g = await grafana({ routeEnv: false, env: {} });
    expect(podman(["inspect", "-f", "{{.State.Running}}", g.name]).out.trim(), g.logs().slice(-3000)).toBe("true");
    const health = (await g.get("/api/health")) as { database?: string } | null;
    expect(health?.database).toBe("ok");
  });
});
