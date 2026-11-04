// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * L1-status: the status page renderer and the outside-in alerts (infra/status), the monitoring
 * Prometheus, the Grafana alerting provisioning, and the runbooks.
 * - The renderer against recorded Prometheus answers (status-prom.json) and built ones: each
 *   state, the 90-day figure, notes, maintenance, and a blind monitor.
 * - The debounce and the recovery mail with fake (Prometheus) time and an injected transport,
 *   and the SMTP client against an in-process relay with STARTTLS.
 * - The page loads nothing from anywhere, is well-formed HTML with `lang`, and holds no address.
 * - Every `runbook` label and every runbook link in these files resolves to a heading.
 * - promtool checks the monitoring Prometheus's config and unit-tests its rule.
 * - The alerting provisioning parses and routes what L1-observability's rules fire.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSSocket } from "node:tls";
import { parse } from "yaml";
import { afterAll, describe, expect, test } from "vite-plus/test";
import { CAN_RUN_PROMTOOL, requirePromtool, runPromtool } from "./observability-promtool.ts";
import {
  CERT_QUERY,
  DAY_QUERY,
  PROBES_ID,
  PROBES_SETTLE_SECONDS,
  SAMPLE_QUERY,
  type AlertPlan,
  type ComponentRecord,
  type Judgement,
  type Log,
  type MailSettings,
  type PromAnswer,
  type PromQuery,
  type Transport,
  alertText,
  applyDelivered,
  dayOf,
  deliver,
  emptyState,
  isPlaceholder,
  judge,
  judgeCert,
  judgeProbe,
  last90,
  parseConfig,
  parseEnvFile,
  parseNote,
  percent,
  planAlerts,
  probeTargets,
  renderMarkdown,
  routeFrom,
  runOnce,
  smtpSend,
  updateHistory,
} from "../status/render.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "commonair-status-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const RAW_CONFIG = {
  siteName: "CommonAir",
  origin: "https://stream.example.org",
  statusDomain: "status.stream.example.org",
  rtmp: null,
  canaries: ["9.9.9.9:53", "1.1.1.1:53"],
  extraComponents: [],
};
const CFG = parseConfig(RAW_CONFIG);
const PROBE_IDS = ["web", "api", "chat", "video", "ingest"];
const NOW = Date.parse("2026-11-03T14:00:00Z") / 1000;
const quiet: Log = () => undefined;

// ---------------------------------------------------------------- a Prometheus that answers

const ok = (resultType: "matrix" | "vector" | "scalar", result: unknown): PromAnswer => ({
  status: "success",
  data: { resultType, result },
});

interface Scenario {
  now: number;
  /** Latest probe results per component (canaries as canary-<n>), oldest first, 30 s apart. */
  probes: Record<string, number[]>;
  certExpiry?: number | null;
  /** Availability answer for a day query, by evaluation time. */
  day?: (time: number, seconds: number) => Record<string, number>;
}

function fakeProm(s: Scenario, calls: string[] = []): PromQuery {
  return async (expr, time) => {
    calls.push(`${expr}@${time ?? "now"}`);
    if (expr === "time()") return ok("scalar", [s.now + 0.123, String(s.now + 0.123)]);
    if (expr === SAMPLE_QUERY(CFG))
      return ok(
        "matrix",
        Object.entries(s.probes).map(([component, vals]) => ({
          metric: { __name__: "probe_success", job: "status", component },
          values: vals.map((v, i) => [s.now - (vals.length - 1 - i) * 30, String(v)]),
        })),
      );
    if (expr === CERT_QUERY)
      return ok(
        "vector",
        s.certExpiry === null
          ? []
          : [{ metric: { component: "web" }, value: [s.now, String(s.certExpiry ?? s.now + 60 * 86_400)] }],
      );
    const m = /\[(\d+)s\]\)\)$/.exec(expr);
    if (m && expr === DAY_QUERY(Number(m[1]))) {
      const got = s.day?.(time ?? s.now, Number(m[1])) ?? Object.fromEntries(PROBE_IDS.map((id) => [id, 1]));
      return ok(
        "vector",
        Object.entries(got).map(([component, v]) => ({ metric: { component }, value: [time ?? s.now, String(v)] })),
      );
    }
    return { status: "error", error: `unexpected query ${expr}` };
  };
}

const allUp = (n = 4) => ({
  ...Object.fromEntries(PROBE_IDS.map((id) => [id, Array<number>(n).fill(1)])),
  "canary-0": Array<number>(n).fill(1),
  "canary-1": Array<number>(n).fill(1),
});

interface Sent {
  mails: { to: string[]; subject: string; text: string; date: number }[];
  hooks: Record<string, unknown>[];
}
function fakeTransport(opts: { failMail?: boolean } = {}): Transport & Sent {
  const sent: Sent = { mails: [], hooks: [] };
  return {
    ...sent,
    async mail(settings: MailSettings, msg) {
      if (opts.failMail) throw new Error("relay refused");
      sent.mails.push({ to: settings.to, subject: msg.subject, text: msg.text, date: msg.date });
    },
    async webhook(_url: string, body: unknown) {
      sent.hooks.push(body as Record<string, unknown>);
    },
  };
}

const ALERT_ENV = {
  SMTP_HOST: "smtp.relay.test",
  SMTP_PORT: "2587",
  SMTP_USER: "relay-user",
  SMTP_PASSWORD: "relay-password-not-real",
  MAIL_FROM: "Status <status@status.stream.test>",
  ALERT_EMAIL_TO: "oncall@ops.test",
  ALERT_WEBHOOK_URL: "https://hooks.ops.test/commonair",
};

// ---------------------------------------------------------------- config

describe("status.json", () => {
  test("derives the default components, the status host and the RTMP target from the origin", () => {
    const cfg = parseConfig({ siteName: "CommonAir", origin: "https://stream.example.org" });
    expect(cfg.components.map((c) => c.id)).toEqual(["web", "api", "chat", "video", "ingest", "certificate"]);
    expect(cfg.statusDomain).toBe("status.stream.example.org");
    expect(cfg.components.find((c) => c.id === "ingest")).toMatchObject({
      module: "tcp_connect",
      target: "stream.example.org:1935",
    });
    expect(cfg.components.find((c) => c.id === "chat")).toMatchObject({
      module: "websocket_chat",
      target: "wss://stream.example.org/chat",
    });
    expect(cfg.components.find((c) => c.id === "api")).toMatchObject({
      target: "https://stream.example.org/readyz/api",
    });
    expect(cfg).toMatchObject({
      probeIntervalSeconds: 30,
      confirmSamples: 2,
      mailIntervalSeconds: 600,
      retentionDays: 30,
    });
  });

  test("takes extra components and rejects bad ones", () => {
    const cfg = parseConfig({
      ...RAW_CONFIG,
      extraComponents: [
        { id: "relay-eu", name: "EU relay", module: "http_ready", target: "https://relay.example.org/readyz" },
      ],
    });
    expect(cfg.components.at(-1)).toMatchObject({ id: "relay-eu", kind: "probe" });
    const bad = (extra: unknown) => () => parseConfig({ ...RAW_CONFIG, extraComponents: [extra] });
    expect(bad({ id: "x", name: "X", module: "icmp", target: "a" })).toThrow(/module/);
    expect(bad({ id: "x", name: "X", module: "tcp_connect", target: "https://a" })).toThrow(/does not suit/);
    expect(bad({ id: "web", name: "Dup", module: "http_web", target: "https://a/" })).toThrow(/twice/);
    expect(bad({ id: "Bad_Id", name: "X", module: "http_web", target: "https://a/" })).toThrow(/must match/);
    expect(() => parseConfig({ ...RAW_CONFIG, origin: "http://stream.example.org" })).toThrow(/https/);
    expect(() => parseConfig({ ...RAW_CONFIG, origin: "https://stream.example.org/x" })).toThrow(/no path/);
    expect(() => parseConfig({ ...RAW_CONFIG, canaries: ["nope"] })).toThrow(/canaries/);
    expect(() => parseConfig({ ...RAW_CONFIG, siteName: "" })).toThrow(/siteName/);
    expect(() => parseConfig({ ...RAW_CONFIG, confirmSamples: 0 })).toThrow(/confirmSamples/);
  });

  test("file_sd targets: one group per probed component and per canary, never the certificate", () => {
    const groups = probeTargets(CFG);
    expect(groups.map((g) => g.labels.component)).toEqual([...PROBE_IDS, "canary-0", "canary-1"]);
    expect(groups.every((g) => g.targets.length === 1)).toBe(true);
    expect(groups.find((g) => g.labels.component === "canary-1")).toEqual({
      targets: ["1.1.1.1:53"],
      labels: { component: "canary-1", module: "tcp_connect", role: "canary" },
    });
    const modules = Object.keys(
      (parse(read("infra/status/blackbox.yml")) as { modules: Record<string, unknown> }).modules,
    );
    expect(new Set(groups.map((g) => g.labels.module))).toEqual(new Set(modules));
  });
});

// ---------------------------------------------------------------- states

describe("judging probes", () => {
  const s = (vals: number[], newestAge = 0): [number, number][] =>
    vals.map((v, i) => [NOW - newestAge - (vals.length - 1 - i) * 30, v]);

  test("a change needs two agreeing probes", () => {
    expect(judgeProbe(s([1, 1, 1, 1]), NOW, CFG)).toBe("up");
    expect(judgeProbe(s([1, 1, 0, 0]), NOW, CFG)).toBe("down");
    expect(judgeProbe(s([1, 1, 1, 0]), NOW, CFG)).toBeNull();
    expect(judgeProbe(s([0, 1, 0, 1]), NOW, CFG)).toBeNull();
    expect(judgeProbe(s([0]), NOW, CFG)).toBeNull();
  });

  test("no fresh probe in 3 intervals is no data", () => {
    expect(judgeProbe([], NOW, CFG)).toBe("unknown");
    expect(judgeProbe(s([1, 1], 91), NOW, CFG)).toBe("unknown");
    expect(judgeProbe(s([1, 1], 90), NOW, CFG)).toBe("up");
  });

  test("the certificate: degraded inside certWarnDays, down once expired", () => {
    expect(judgeCert(undefined, NOW, CFG)).toBe("unknown");
    expect(judgeCert(NOW + 30 * 86_400, NOW, CFG)).toBe("up");
    expect(judgeCert(NOW + 14 * 86_400 - 1, NOW, CFG)).toBe("degraded");
    expect(judgeCert(NOW, NOW, CFG)).toBe("down");
  });

  const obs = (probes: Record<string, number[]>, cert = NOW + 60 * 86_400) => ({
    now: NOW,
    samples: Object.fromEntries(
      Object.entries(probes).map(([k, v]) => [
        k,
        v.map((x, i): [number, number] => [NOW - (v.length - 1 - i) * 30, x]),
      ]),
    ),
    certExpiry: { web: cert },
  });

  test("a disagreeing probe keeps the previous state", () => {
    const prev = emptyState();
    prev.components.chat = { state: "down", since: NOW - 600, alerted: "down", lastMailAt: NOW - 600 };
    const j = judge(CFG, obs({ ...allUp(), chat: [0, 0, 0, 1] }), prev);
    expect(j.states.chat).toBe("down");
    expect(j.states.web).toBe("up");
    expect(j.blind).toBe(false);
  });

  test("every component and every canary failing is a blind monitor, and keeps the old states", () => {
    const down = Object.fromEntries(Object.keys(allUp()).map((k) => [k, [0, 0, 0]]));
    const prev = emptyState();
    for (const id of PROBE_IDS)
      prev.components[id] = { state: "up", since: NOW - 3600, alerted: null, lastMailAt: null };
    const j = judge(CFG, obs(down), prev);
    expect(j.blind).toBe(true);
    expect(PROBE_IDS.map((id) => j.states[id])).toEqual(PROBE_IDS.map(() => "up"));
    // One canary answering means the instance really is down.
    const seen = judge(CFG, obs({ ...down, "canary-1": [1, 1, 1] }), prev);
    expect(seen.blind).toBe(false);
    expect(PROBE_IDS.map((id) => seen.states[id])).toEqual(PROBE_IDS.map(() => "down"));
  });

  test("no fresh probe anywhere marks the probes themselves down", () => {
    const j = judge(CFG, { now: NOW, samples: {}, certExpiry: {} }, emptyState());
    expect(j.states[PROBES_ID]).toBe("down");
    expect(j.states.web).toBe("unknown");
    expect(j.blind).toBe(false);
  });
});

// ---------------------------------------------------------------- alerts

describe("alert debounce and recovery (fake time)", () => {
  const judgement = (states: Record<string, string>, blind = false): Judgement => ({
    states: {
      [PROBES_ID]: "up",
      ...PROBE_IDS.reduce((a, id) => ({ ...a, [id]: "up" }), {}),
      ...states,
    } as Judgement["states"],
    blind,
  });

  /** Steps through time: each step plans, delivers all, and returns the messages sent. */
  function machine(opts: { maintenanceAt?: (t: number) => boolean; deliverIf?: (t: number) => boolean } = {}) {
    let records: Record<string, ComponentRecord> = {};
    return (t: number, states: Record<string, string>, blind = false) => {
      const plan: AlertPlan = planAlerts(CFG, records, judgement(states, blind), t, {
        maintenance: opts.maintenanceAt?.(t) ?? false,
      });
      const delivered = new Set(opts.deliverIf?.(t) === false ? [] : plan.intents.map((i) => i.message.component));
      records = applyDelivered(plan, delivered);
      return plan.intents.map((i) => `${i.message.component}:${i.message.kind}:${i.message.state}`);
    };
  }

  test("one mail on down, none while it stays down, the recovery always", () => {
    const step = machine();
    expect(step(0, {})).toEqual([]);
    expect(step(60, { api: "down" })).toEqual(["api:problem:down"]);
    expect(step(120, { api: "down" })).toEqual([]);
    expect(step(1_000, { api: "down" })).toEqual([]);
    expect(step(1_060, {})).toEqual(["api:recovery:up"]);
    expect(step(1_120, {})).toEqual([]);
  });

  test("flapping: at most one problem mail per 10 minutes, recoveries every time", () => {
    const step = machine();
    expect(step(0, { chat: "down" })).toEqual(["chat:problem:down"]);
    expect(step(60, {})).toEqual(["chat:recovery:up"]);
    // Down again 2 minutes after the recovery mail: inside the window, so no mail yet.
    expect(step(180, { chat: "down" })).toEqual([]);
    expect(step(240, {})).toEqual([]);
    expect(step(300, { chat: "down" })).toEqual([]);
    // Still down once the window since the last mail (60 s) has passed: mailed now.
    expect(step(659, { chat: "down" })).toEqual([]);
    expect(step(660, { chat: "down" })).toEqual(["chat:problem:down"]);
    expect(step(700, {})).toEqual(["chat:recovery:up"]);
  });

  test("a flap shorter than the window never mails a recovery it never announced", () => {
    const step = machine();
    expect(step(0, { video: "down" })).toEqual(["video:problem:down"]);
    expect(step(30, {})).toEqual(["video:recovery:up"]);
    expect(step(90, { video: "down" })).toEqual([]);
    expect(step(120, {})).toEqual([]);
  });

  test("degraded mails as a problem; components are debounced independently", () => {
    const step = machine();
    expect(step(0, { certificate: "degraded", api: "down" }).sort()).toEqual([
      "api:problem:down",
      "certificate:problem:degraded",
    ]);
    expect(step(30, { certificate: "degraded", api: "down", web: "down" })).toEqual(["web:problem:down"]);
  });

  test("escalating from degraded to down waits for the window too", () => {
    const step = machine();
    expect(step(0, { certificate: "degraded" })).toEqual(["certificate:problem:degraded"]);
    expect(step(60, { certificate: "down" })).toEqual([]);
    expect(step(600, { certificate: "down" })).toEqual(["certificate:problem:down"]);
  });

  test("maintenance suppresses every mail, and the recovery follows once it ends", () => {
    const step = machine({ maintenanceAt: (t) => t >= 100 && t < 1_000 });
    expect(step(0, { api: "down" })).toEqual(["api:problem:down"]);
    expect(step(100, { api: "down", web: "down" })).toEqual([]);
    expect(step(500, {})).toEqual([]);
    expect(step(1_000, {})).toEqual(["api:recovery:up"]);
  });

  test("an outage that starts and ends inside maintenance sends nothing", () => {
    const step = machine({ maintenanceAt: (t) => t < 1_000 });
    expect(step(0, { api: "down" })).toEqual([]);
    expect(step(500, {})).toEqual([]);
    expect(step(1_000, {})).toEqual([]);
  });

  test("a blind monitor sends nothing", () => {
    const step = machine();
    expect(step(0, Object.fromEntries(PROBE_IDS.map((id) => [id, "up"])), true)).toEqual([]);
  });

  test("an undelivered mail is retried at the next run", () => {
    const step = machine({ deliverIf: (t) => t >= 120 });
    expect(step(0, { api: "down" })).toEqual(["api:problem:down"]);
    expect(step(60, { api: "down" })).toEqual(["api:problem:down"]);
    expect(step(120, { api: "down" })).toEqual(["api:problem:down"]);
    expect(step(180, { api: "down" })).toEqual([]);
  });

  test("probes that report nothing are mailed only after they settle", () => {
    const step = machine();
    expect(step(0, { [PROBES_ID]: "down" })).toEqual([]);
    expect(step(PROBES_SETTLE_SECONDS - 1, { [PROBES_ID]: "down" })).toEqual([]);
    expect(step(PROBES_SETTLE_SECONDS, { [PROBES_ID]: "down" })).toEqual([`${PROBES_ID}:problem:down`]);
  });

  test("the mail names a component, a state and times, and nothing personal", () => {
    const { subject, text } = alertText(CFG, {
      component: "api",
      name: "API and database",
      kind: "problem",
      state: "down",
      from: null,
      since: NOW - 120,
      at: NOW,
    });
    expect(subject).toBe("[CommonAir status] API and database is down");
    expect(text).toContain("since 2026-11-03 13:58 UTC");
    expect(text).toContain("https://status.stream.example.org/");
    expect(text).not.toMatch(/@/);
    const rec = alertText(CFG, {
      component: "api",
      name: "API and database",
      kind: "recovery",
      state: "up",
      from: "down",
      since: NOW,
      at: NOW,
    });
    expect(rec.subject).toBe("[CommonAir status] API and database has recovered");
  });

  test("delivery: mail and webhook; one channel is enough; a failure is logged without the password", async () => {
    const plan = planAlerts(CFG, {}, judgement({ api: "down" }), NOW, { maintenance: false });
    const route = routeFrom(ALERT_ENV, CFG);
    const t = fakeTransport();
    expect([...(await deliver(CFG, plan, route, t, quiet))]).toEqual(["api"]);
    expect(t.mails).toHaveLength(1);
    expect(t.mails[0]?.to).toEqual(["oncall@ops.test"]);
    expect(t.hooks[0]).toMatchObject({
      component: "api",
      kind: "problem",
      state: "down",
      page: "https://status.stream.example.org/",
    });
    const logs: string[] = [];
    const failing = fakeTransport({ failMail: true });
    const delivered = await deliver(CFG, plan, route, failing, (_l, msg, f) =>
      logs.push(`${msg} ${JSON.stringify(f)}`),
    );
    expect([...delivered]).toEqual(["api"]);
    expect(logs.join("\n")).toContain("alert mail failed");
    expect(logs.join("\n")).not.toContain(ALERT_ENV.SMTP_PASSWORD);
  });
});

// ---------------------------------------------------------------- route

describe("the alert route", () => {
  test("alert.env parses, and a complete route has mail and webhook", () => {
    const env = parseEnvFile(
      "# comment\nSMTP_HOST=smtp.relay.test\nSMTP_PORT='2587'\nALERT_EMAIL_TO=\"a@ops.test, b@ops.test\"\n\n",
    );
    expect(env).toEqual({ SMTP_HOST: "smtp.relay.test", SMTP_PORT: "2587", ALERT_EMAIL_TO: "a@ops.test, b@ops.test" });
    const r = routeFrom(ALERT_ENV, CFG);
    expect(r.problems).toEqual([]);
    expect(r.mail).toMatchObject({
      host: "smtp.relay.test",
      port: 2587,
      secure: false,
      user: "relay-user",
      to: ["oncall@ops.test"],
      helo: "status.stream.example.org",
    });
    expect(r.webhook).toBe("https://hooks.ops.test/commonair");
  });

  test("placeholders turn a channel off", () => {
    expect(isPlaceholder("oncall@example.org")).toBe(true);
    expect(isPlaceholder("no-route@alerts.invalid")).toBe(true);
    expect(isPlaceholder("__generate__")).toBe(true);
    expect(isPlaceholder("")).toBe(true);
    expect(isPlaceholder("oncall@ops.test")).toBe(false);
    const none = routeFrom({}, CFG);
    expect(none.mail).toBeNull();
    expect(none.webhook).toBeNull();
    expect(routeFrom({ ...ALERT_ENV, ALERT_EMAIL_TO: "you@example.com" }, CFG).mail).toBeNull();
    expect(routeFrom({ ...ALERT_ENV, SMTP_PASSWORD: "" }, CFG).problems).toEqual([
      "SMTP_PASSWORD is unset or a placeholder",
    ]);
    expect(routeFrom({ ...ALERT_ENV, ALERT_WEBHOOK_URL: "https://hooks.example.com/x" }, CFG).webhook).toBeNull();
    expect(routeFrom({ ...ALERT_ENV, SMTP_PORT: "port" }, CFG).mail).toBeNull();
  });

  test("no route is logged loudly at every run", async () => {
    const data = tmp();
    const logs: string[] = [];
    await runOnce({
      cfg: CFG,
      prom: fakeProm({ now: NOW, probes: allUp() }),
      dataDir: data,
      alertEnv: {},
      transport: fakeTransport(),
      log: (l, m) => logs.push(`${l} ${m}`),
    });
    expect(logs.find((l) => l.startsWith("error NO ALERT ROUTE"))).toBeDefined();
  });
});

// ---------------------------------------------------------------- SMTP

/** A relay that speaks just enough SMTP, with STARTTLS when given a certificate. */
async function fakeRelay(tls: { key: string; cert: string } | null, opts: { requireAuth?: boolean } = {}) {
  const lines: string[] = [];
  const server = createServer((raw) => {
    let sock: Socket | TLSSocket = raw;
    let buf = "";
    let inData = false;
    const say = (s: string) => sock.write(`${s}\r\n`);
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      for (let i = buf.indexOf("\r\n"); i >= 0; i = buf.indexOf("\r\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        lines.push(`${sock instanceof TLSSocket ? "tls" : "plain"} ${line}`);
        if (inData) {
          if (line === ".") {
            inData = false;
            say("250 queued");
          }
          continue;
        }
        if (line.startsWith("EHLO"))
          say(
            `250-relay.test\r\n250-AUTH PLAIN\r\n250 ${tls && !(sock instanceof TLSSocket) ? "STARTTLS" : "8BITMIME"}`,
          );
        else if (line === "STARTTLS" && tls) {
          say("220 ready");
          raw.removeListener("data", onData);
          sock = new TLSSocket(raw, { isServer: true, key: tls.key, cert: tls.cert });
          sock.on("data", onData);
        } else if (line.startsWith("AUTH PLAIN "))
          say(line.endsWith(Buffer.from("\0u\0p").toString("base64")) ? "235 ok" : "535 no");
        else if (line.startsWith("MAIL") && opts.requireAuth && !lines.some((l) => l.includes("AUTH")))
          say("530 auth first");
        else if (line === "RCPT TO:<bad@ops.test>") say("550 5.1.1 <bad@ops.test> unknown");
        else if (line.startsWith("MAIL") || line.startsWith("RCPT")) say("250 ok");
        else if (line === "DATA") {
          inData = true;
          say("354 go");
        } else if (line === "QUIT") {
          say("221 bye");
          sock.end();
        } else say("502 no");
      }
    };
    raw.on("data", onData);
    say("220 relay.test ESMTP");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { lines, port: (server.address() as AddressInfo).port, close: () => server.close() };
}

function selfSigned(): { key: string; cert: string } | null {
  if (!Bun.which("openssl")) return null;
  const d = tmp();
  writeFileSync(
    join(d, "c.cnf"),
    "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost\nbasicConstraints=critical,CA:TRUE\n",
  );
  const r = Bun.spawnSync(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(d, "k.pem"),
      "-out",
      join(d, "c.pem"),
      "-days",
      "2",
      "-config",
      join(d, "c.cnf"),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (r.exitCode !== 0) return null;
  return { key: readFileSync(join(d, "k.pem"), "utf8"), cert: readFileSync(join(d, "c.pem"), "utf8") };
}

describe("SMTP client", () => {
  const settings = (port: number, extra: Partial<MailSettings> = {}): MailSettings => ({
    host: "localhost",
    port,
    secure: false,
    user: null,
    password: null,
    from: "Status <status@status.test>",
    to: ["oncall@ops.test", "second@ops.test"],
    helo: "status.test",
    ca: null,
    ...extra,
  });
  const msg = {
    subject: "[CommonAir status] Chat is down",
    text: "line one\n.leading dot\n",
    date: NOW,
    id: "chat.problem.1@status.test",
  };

  test("plain relay (no auth): envelope, headers and dot-stuffing", async () => {
    const relay = await fakeRelay(null);
    try {
      await smtpSend(settings(relay.port), msg);
      const l = relay.lines.map((x) => x.replace(/^plain /, ""));
      expect(l).toContain("EHLO status.test");
      expect(l).toContain("MAIL FROM:<status@status.test>");
      expect(l).toContain("RCPT TO:<second@ops.test>");
      expect(l).toContain("Subject: [CommonAir status] Chat is down");
      expect(l).toContain("Date: Tue, 03 Nov 2026 14:00:00 GMT");
      expect(l).toContain("..leading dot");
      expect(l.at(-1)).toBe("QUIT");
    } finally {
      relay.close();
    }
  });

  test("never sends a password without TLS", async () => {
    const relay = await fakeRelay(null);
    try {
      await expect(smtpSend(settings(relay.port, { user: "u", password: "p" }), msg)).rejects.toThrow(/STARTTLS/);
      expect(relay.lines.some((l) => l.includes("AUTH"))).toBe(false);
    } finally {
      relay.close();
    }
  });

  const tlsPair = selfSigned();
  if (!tlsPair && process.env.CI)
    throw new Error("status.test.ts needs openssl for the STARTTLS test, and CI must run it");
  test.runIf(tlsPair !== null)("STARTTLS, then AUTH PLAIN inside TLS (Resend on 2587)", async () => {
    const pair = tlsPair as { key: string; cert: string };
    const relay = await fakeRelay(pair, { requireAuth: true });
    try {
      await smtpSend(settings(relay.port, { user: "u", password: "p", ca: pair.cert }), msg);
      expect(relay.lines.findIndex((l) => l === "plain STARTTLS")).toBeGreaterThan(0);
      expect(relay.lines.filter((l) => l.startsWith("plain ")).some((l) => l.includes("AUTH"))).toBe(false);
      expect(relay.lines).toContain(`tls AUTH PLAIN ${Buffer.from("\0u\0p").toString("base64")}`);
      expect(relay.lines).toContain("tls RCPT TO:<oncall@ops.test>");
    } finally {
      relay.close();
    }
  });

  test.runIf(tlsPair !== null)("refuses a relay whose certificate it cannot verify", async () => {
    const pair = tlsPair as { key: string; cert: string };
    const relay = await fakeRelay(pair);
    try {
      await expect(smtpSend(settings(relay.port, { user: "u", password: "p" }), msg)).rejects.toThrow(
        /certificate|self.signed|verify/i,
      );
      expect(relay.lines.some((l) => l.includes("AUTH"))).toBe(false);
    } finally {
      relay.close();
    }
  });

  test("a rejected recipient fails the send with the code only", async () => {
    const relay = await fakeRelay(null);
    try {
      const err = await smtpSend(settings(relay.port, { to: ["bad@ops.test"] }), msg).catch((e: unknown) => e);
      expect(String(err)).toContain("expected 250, got 550");
      expect(String(err)).not.toContain("bad@ops.test");
      expect(relay.lines.some((l) => l.endsWith("DATA"))).toBe(false);
    } finally {
      relay.close();
    }
  });
});

// ---------------------------------------------------------------- history

describe("90 days of history", () => {
  test("last90 ends today (Prometheus's today) and has 90 days", () => {
    const days = last90(NOW);
    expect(days).toHaveLength(90);
    expect(days.at(-1)).toBe("2026-11-03");
    expect(days[0]).toBe("2026-08-06");
    expect(dayOf(NOW - 14 * 3600 - 1)).toBe("2026-11-02");
  });

  test("fills finished days within retention once, keeps older history, drops days past 90", async () => {
    const calls: string[] = [];
    const prom = fakeProm({ now: NOW, probes: allUp(), day: () => ({ web: 0.5, api: 1 }) }, calls);
    const kept = { "2026-09-01": { web: 0.98 }, "2026-01-01": { web: 1 } };
    const h = await updateHistory(prom, CFG, kept, NOW);
    expect(h.days["2026-09-01"]).toEqual({ web: 0.98 });
    expect(h.days["2026-01-01"]).toBeUndefined();
    // Retention is 30 days: 2026-10-04 (ends 10-05 00:00, 29.6 days ago) is asked; 10-02 is not.
    expect(h.days["2026-10-04"]).toEqual({ web: 0.5, api: 1, chat: null, video: null, ingest: null });
    expect(h.days["2026-10-02"]).toBeUndefined();
    expect(h.days["2026-11-03"]).toBeUndefined();
    const dayCalls = calls.filter((c) => c.includes("[86400s]"));
    expect(dayCalls).toHaveLength(30);
    expect(dayCalls).toContain(`${DAY_QUERY(86_400)}@${Date.parse("2026-11-03T00:00:00Z") / 1000}`);
    expect(h.today).toEqual({ web: 0.5, api: 1 });
    expect(calls).toContain(`${DAY_QUERY(14 * 3600)}@${NOW}`);
    // The second run asks only for today.
    const again: string[] = [];
    await updateHistory(fakeProm({ now: NOW + 60, probes: allUp() }, again), CFG, h.days, NOW + 60);
    expect(again.filter((c) => c.includes("[86400s]"))).toEqual([]);
  });

  test("a day is asked for only two minutes after it ends", async () => {
    const midnight = Date.parse("2026-11-03T00:00:00Z") / 1000;
    const calls: string[] = [];
    await updateHistory(fakeProm({ now: midnight + 60, probes: allUp() }, calls), CFG, {}, midnight + 60);
    expect(calls.some((c) => c.endsWith(`@${midnight}`))).toBe(false);
    const later: string[] = [];
    await updateHistory(fakeProm({ now: midnight + 120, probes: allUp() }, later), CFG, {}, midnight + 120);
    expect(later.some((c) => c.endsWith(`@${midnight}`))).toBe(true);
  });

  test("percentages never round up", () => {
    expect(percent(1)).toBe("100%");
    expect(percent(0.99996)).toBe("99.99%");
    expect(percent(0.999)).toBe("99.90%");
    expect(percent(0)).toBe("0.00%");
  });
});

// ---------------------------------------------------------------- notes

describe("incident notes", () => {
  test("front matter and the markdown subset", () => {
    const n = parseNote(
      "2026-11-03-chat.md",
      "<!-- an operator comment -->\n---\ntitle: Chat delayed\ndate: 2026-11-03T13:50:00Z\nstatus: identified\ncomponents: chat, api\n---\nMessages arrive **late**.\n\n- step one\n- `code` here\n\n## 14:10 update\nSee [the runbook](https://elsewhere.test/x).",
    );
    expect(n).toMatchObject({
      title: "Chat delayed",
      status: "identified",
      components: ["chat", "api"],
      date: NOW - 600,
    });
    const html = renderMarkdown(typeof n === "string" ? "" : n.body);
    expect(html).toContain("<p>Messages arrive <strong>late</strong>.</p>");
    expect(html).toContain("<ul><li>step one</li><li><code>code</code> here</li></ul>");
    expect(html).toContain("<h4>14:10 update</h4>");
    expect(html).toContain("See the runbook.");
    expect(html).not.toContain("elsewhere.test");
  });

  test("escapes HTML and rejects a note it cannot place", () => {
    expect(renderMarkdown("<script>x</script> & *it*")).toBe("<p>&lt;script&gt;x&lt;/script&gt; &amp; <em>it</em></p>");
    expect(parseNote("a.md", "no front matter")).toMatch(/front matter/);
    expect(parseNote("a.md", "---\ndate: 2026-11-03T13:50:00Z\n---\n")).toMatch(/title/);
    expect(parseNote("a.md", "---\ntitle: x\ndate: 2026-11-03 13:50\n---\n")).toMatch(/offset/);
    expect(parseNote("a.md", "---\ntitle: x\ndate: 2026-11-03T13:50:00Z\nstatus: panic\n---\n")).toMatch(/status/);
  });
});

// ---------------------------------------------------------------- whole runs

const VOID = new Set(["meta", "link", "br", "hr", "img", "input"]);
/** Well-formedness: doctype, lang, balanced non-void tags, unique ids, quoted attributes. */
function htmlProblems(html: string): string[] {
  const problems: string[] = [];
  if (!html.startsWith("<!doctype html>\n")) problems.push("no doctype");
  if (!/<html lang="[a-z]{2}">/.test(html)) problems.push("no lang");
  if (!/<meta charset="utf-8">/.test(html)) problems.push("no charset");
  if (!/<title>[^<]+<\/title>/.test(html)) problems.push("no title");
  const stack: string[] = [];
  const body = html.replace(/<style>[\s\S]*?<\/style>/, "<style></style>");
  for (const m of body.matchAll(/<(\/?)([a-z][a-z0-9]*)((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*>|<(?!!doctype)[^>]*>/g)) {
    if (!m[2]) {
      problems.push(`malformed tag ${m[0]}`);
      continue;
    }
    if (m[1]) {
      const open = stack.pop();
      if (open !== m[2]) problems.push(`</${m[2]}> closes <${open}>`);
    } else if (!VOID.has(m[2])) stack.push(m[2]);
  }
  if (stack.length) problems.push(`unclosed ${stack.join(",")}`);
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  if (new Set(ids).size !== ids.length) problems.push("duplicate id");
  for (const m of html.matchAll(/aria-labelledby="([^"]+)"/g)) if (!ids.includes(m[1])) problems.push(`no id ${m[1]}`);
  return problems;
}

/** Every URL the page could load or link: none may leave it. */
function externalRefs(text: string): string[] {
  return [
    ...[...text.matchAll(/(?:src|href|action|srcset|poster|data)\s*=\s*"([^"]*)"/gi)]
      .map((m) => m[1] as string)
      .filter((u) => /^(?:[a-z]+:)?\/\//i.test(u)),
    ...[...text.matchAll(/url\(([^)]*)\)|@import/gi)].map((m) => m[0]),
    ...[...text.matchAll(/<(?:script|link|iframe|img|object|embed|video|audio)\b/gi)].map((m) => m[0]),
  ];
}

function setupData(notes: Record<string, string> = {}, maintenance?: string) {
  const data = tmp();
  mkdirSync(join(data, "notes"), { recursive: true });
  for (const [f, t] of Object.entries(notes)) writeFileSync(join(data, "notes", f), t);
  if (maintenance !== undefined) writeFileSync(join(data, "maintenance"), maintenance);
  return data;
}

describe("a run against the recorded Prometheus answers", () => {
  const recorded = JSON.parse(read("infra/tests/status-prom.json")) as { answers: Record<string, PromAnswer> };
  const prom: PromQuery = async (expr) => recorded.answers[expr] ?? { status: "error", error: `not recorded: ${expr}` };
  const notes = {
    "2026-11-03-api.md":
      "---\ntitle: API errors\ndate: 2026-11-03T13:58:00Z\nstatus: investigating\ncomponents: api\n---\nWe are looking into failing requests.\n",
    "2026-10-20-chat.md":
      "---\ntitle: Chat outage\ndate: 2026-10-20T08:00:00Z\nstatus: resolved\ncomponents: chat\n---\nChat was down for 12 minutes.\n",
    "2026-06-01-old.md": "---\ntitle: Too old to show\ndate: 2026-06-01T08:00:00Z\nstatus: resolved\n---\nx\n",
    "broken.md": "no front matter",
  };

  test("each state, the 90-day figure, notes; then the alerts", async () => {
    const data = setupData(notes);
    const prev = emptyState();
    prev.components.chat = { state: "up", since: NOW - 7200, alerted: null, lastMailAt: null };
    mkdirSync(join(data, "state"), { recursive: true });
    writeFileSync(
      join(data, "state", "state.json"),
      JSON.stringify({ ...prev, days: { "2026-08-10": { web: 0.95, api: 1, chat: 1, video: 1, ingest: 1 } } }),
    );
    const t = fakeTransport();
    const r = await runOnce({ cfg: CFG, prom, dataDir: data, alertEnv: ALERT_ENV, transport: t, log: quiet });
    expect(r.now).toBe(NOW);
    expect(r.judgement.states).toMatchObject({
      web: "up",
      api: "down",
      chat: "up",
      video: "up",
      ingest: "up",
      certificate: "degraded",
    });
    expect(r.model.overall).toBe("down");
    expect(t.mails.map((m) => m.subject).sort()).toEqual([
      "[CommonAir status] API and database is down",
      "[CommonAir status] TLS certificate is degraded",
    ]);
    // The Date header is Prometheus's time, not this host's.
    expect(t.mails.every((m) => m.date === NOW)).toBe(true);

    const json = JSON.parse(readFileSync(join(data, "site", "status.json"), "utf8")) as {
      components: {
        id: string;
        state: string;
        availability90d: number | null;
        days: { date: string; availability: number | null }[] | null;
      }[];
      incidents: { title: string }[];
      updatedAt: string;
    };
    expect(json.updatedAt).toBe("2026-11-03T14:00:00.000Z");
    const api = json.components.find((c) => c.id === "api");
    const web = json.components.find((c) => c.id === "web");
    expect(api?.days).toHaveLength(90);
    expect(api?.days?.at(-1)).toEqual({ date: "2026-11-03", availability: 0.9952380952380953 });
    // 30 recorded days at 0.99930…, today at 0.99523…, and the kept day 2026-08-10 at 1.
    expect(api?.availability90d).toBeCloseTo((30 * 0.9993055555555556 + 0.9952380952380953 + 1) / 32, 12);
    expect(web?.availability90d).toBeCloseTo((31 + 0.95) / 32, 12);
    expect(api?.days?.filter((d) => d.availability === null)).toHaveLength(58);
    expect(json.components.find((c) => c.id === "certificate")?.days).toBeNull();
    expect(json.incidents.map((i) => i.title)).toEqual(["API errors", "Chat outage"]);

    const html = readFileSync(join(data, "site", "index.html"), "utf8");
    expect(html).toContain("Some systems are down");
    expect(html).toContain('<span class="state s-down">Down</span>');
    expect(html).toContain("Current incidents");
    expect(html).toContain("API errors");
    expect(html).toContain("Chat outage");
    expect(html).not.toContain("Too old to show");
    expect(html).toContain("2026-11-03</td><td>99.52%");
    expect(html).toContain("<title>CommonAir status</title>");

    const targets = JSON.parse(readFileSync(join(data, "targets", "status.json"), "utf8")) as unknown[];
    expect(targets).toEqual(probeTargets(CFG));

    const state = JSON.parse(readFileSync(join(data, "state", "state.json"), "utf8")) as {
      components: Record<string, ComponentRecord>;
    };
    expect(state.components.api).toEqual({ state: "down", since: NOW, alerted: "down", lastMailAt: NOW });
    expect(state.components.chat?.state).toBe("up");
  });

  test("the page is static: no script, no external URL, valid HTML with lang, no address", async () => {
    const data = setupData(notes);
    await runOnce({ cfg: CFG, prom, dataDir: data, alertEnv: ALERT_ENV, transport: fakeTransport(), log: quiet });
    const html = readFileSync(join(data, "site", "index.html"), "utf8");
    const json = readFileSync(join(data, "site", "status.json"), "utf8");
    expect(htmlProblems(html)).toEqual([]);
    expect(externalRefs(html)).toEqual([]);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<script|\son[a-z]+=/i);
    expect(html).not.toMatch(/\btitle="/);
    // No mail address, relay or webhook from alert.env reaches the page.
    for (const [k, v] of Object.entries(ALERT_ENV)) {
      if (k === "SMTP_PORT") continue;
      expect(html).not.toContain(v);
      expect(json).not.toContain(v);
    }
    expect(json).not.toMatch(/@/);
    expect(html).toMatch(/@media \(prefers-color-scheme:dark\)/);
    // 320 px: nothing has a fixed width; the bars shrink.
    expect(html).not.toMatch(/(?:^|[;{])\s*(?:width|min-width|inline-size|min-inline-size)\s*:\s*\d{3,}px/);
  });
});

describe("runs over time (built answers)", () => {
  test("maintenance: the page says so, nothing is mailed, the time still counts", async () => {
    const data = setupData({}, "Upgrading to v0.1.1.\n");
    const t = fakeTransport();
    const probes = { ...allUp(), web: [0, 0, 0, 0], api: [0, 0, 0, 0] };
    const r = await runOnce({
      cfg: CFG,
      prom: fakeProm({ now: NOW, probes, day: () => ({ web: 0.99 }) }),
      dataDir: data,
      alertEnv: ALERT_ENV,
      transport: t,
      log: quiet,
    });
    expect(t.mails).toEqual([]);
    expect(t.hooks).toEqual([]);
    expect(r.model.overall).toBe("maintenance");
    expect(r.model.components.find((c) => c.id === "web")).toMatchObject({ state: "down", shown: "maintenance" });
    expect(r.model.components.find((c) => c.id === "chat")?.shown).toBe("up");
    const html = readFileSync(join(data, "site", "index.html"), "utf8");
    expect(html).toContain("Planned maintenance in progress");
    expect(html).toContain("Upgrading to v0.1.1.");
    // The availability is Prometheus's, maintenance included (ADR 0032 §1).
    expect(r.model.components.find((c) => c.id === "web")?.days?.at(-1)?.availability).toBe(0.99);

    // Maintenance over, still down: the mail goes out now.
    rmSync(join(data, "maintenance"));
    const t2 = fakeTransport();
    await runOnce({
      cfg: CFG,
      prom: fakeProm({ now: NOW + 60, probes }),
      dataDir: data,
      alertEnv: ALERT_ENV,
      transport: t2,
      log: quiet,
    });
    expect(t2.mails.map((m) => m.subject).sort()).toEqual([
      "[CommonAir status] API and database is down",
      "[CommonAir status] Website is down",
    ]);
  });

  test("blind: no page of everything down, no mail, a banner instead", async () => {
    const data = setupData();
    const t = fakeTransport();
    await runOnce({
      cfg: CFG,
      prom: fakeProm({ now: NOW, probes: allUp() }),
      dataDir: data,
      alertEnv: ALERT_ENV,
      transport: t,
      log: quiet,
    });
    const down = Object.fromEntries(Object.keys(allUp()).map((k) => [k, [0, 0, 0, 0]]));
    const r = await runOnce({
      cfg: CFG,
      prom: fakeProm({ now: NOW + 60, probes: down }),
      dataDir: data,
      alertEnv: ALERT_ENV,
      transport: t,
      log: quiet,
    });
    expect(r.judgement.blind).toBe(true);
    expect(t.mails).toEqual([]);
    expect(r.model.overall).toBe("up");
    const html = readFileSync(join(data, "site", "index.html"), "utf8");
    expect(html).toContain("The status monitor lost its own network at 2026-11-03 14:01 UTC");
    const r2 = await runOnce({
      cfg: CFG,
      prom: fakeProm({ now: NOW + 120, probes: down }),
      dataDir: data,
      alertEnv: ALERT_ENV,
      transport: t,
      log: quiet,
    });
    expect(r2.model.blind).toEqual({ active: true, since: NOW + 60 });
  });

  test("an outage end to end: down, held, recovered; one mail and one recovery", async () => {
    const data = setupData();
    const t = fakeTransport();
    const at = (now: number, chat: number[]) =>
      runOnce({
        cfg: CFG,
        prom: fakeProm({ now, probes: { ...allUp(), chat } }),
        dataDir: data,
        alertEnv: ALERT_ENV,
        transport: t,
        log: quiet,
      });
    await at(NOW, [1, 1, 1, 1]);
    await at(NOW + 60, [1, 1, 1, 0]); // one failed probe: not yet
    expect(t.mails).toHaveLength(0);
    const r = await at(NOW + 120, [1, 1, 0, 0]);
    expect(r.model.components.find((c) => c.id === "chat")).toMatchObject({ state: "down", since: NOW + 120 });
    await at(NOW + 180, [0, 0, 0, 0]);
    await at(NOW + 240, [0, 0, 1, 1]);
    expect(t.mails.map((m) => m.subject)).toEqual([
      "[CommonAir status] Chat is down",
      "[CommonAir status] Chat has recovered",
    ]);
    expect(t.hooks).toHaveLength(2);
  });

  test("no data at all: the page says no data, and Prometheus failing leaves the last page", async () => {
    const data = setupData();
    const r = await runOnce({
      cfg: CFG,
      prom: fakeProm({ now: NOW, probes: {}, certExpiry: null }),
      dataDir: data,
      alertEnv: {},
      transport: fakeTransport(),
      log: quiet,
    });
    expect(r.model.overall).toBe("unknown");
    const before = readFileSync(join(data, "site", "index.html"), "utf8");
    const broken: PromQuery = async () => ({ status: "error", error: "down" });
    await expect(
      runOnce({ cfg: CFG, prom: broken, dataDir: data, alertEnv: {}, transport: fakeTransport(), log: quiet }),
    ).rejects.toThrow(/prometheus: time\(\): down/);
    expect(readFileSync(join(data, "site", "index.html"), "utf8")).toBe(before);
    // The targets are written before Prometheus is asked.
    expect(existsSync(join(data, "targets", "status.json"))).toBe(true);
  });
});

// ---------------------------------------------------------------- self-containment and units

describe("what the droplet runs", () => {
  test("render.ts imports only Bun's node: built-ins (cloud-init copies it alone)", () => {
    const src = read("infra/status/render.ts");
    const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((i) => i?.startsWith("node:"))).toBe(true);
  });

  const units = readdirSync(join(ROOT, "infra/status/units"));
  const unit = (f: string) => read(`infra/status/units/${f}`);
  const imageOf = (text: string) => /^Image=(.*)$/m.exec(text)?.[1] ?? "";

  test("every image is pinned by digest, and Prometheus, Caddy and Bun are the stack's own", () => {
    for (const f of units.filter((u) => u.endsWith(".container")))
      expect(imageOf(unit(f)), f).toMatch(/^[a-z0-9./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/);
    expect(imageOf(unit("commonair-status-prometheus.container"))).toBe(
      imageOf(read("infra/quadlet/commonair-prometheus.container")),
    );
    expect(imageOf(unit("commonair-status-caddy.container"))).toBe(
      imageOf(read("infra/quadlet/commonair-caddy.container")),
    );
    expect(read("infra/containers/service.Containerfile")).toContain(
      imageOf(unit("commonair-status-render.container")),
    );
    expect(imageOf(unit("commonair-status-blackbox.container"))).toMatch(
      /^quay\.io\/prometheus\/blackbox-exporter:v0\.29\.1@/,
    );
  });

  test("the units mount what cloud-init writes, and only Caddy is public", () => {
    const tf = read("infra/tofu/digitalocean/modules/instance/monitoring.tf");
    for (const f of ["render.ts", "blackbox.yml", "prometheus.yml", "rules.yml", "Caddyfile"])
      expect(tf).toContain(`"${f}"`);
    const all = units.map(unit).join("\n");
    for (const m of all.matchAll(/^Volume=(\/etc\/commonair-status\/[^:]+):/gm))
      expect([
        "/etc/commonair-status/blackbox.yml",
        "/etc/commonair-status/prometheus.yml",
        "/etc/commonair-status/rules.yml",
        "/etc/commonair-status/Caddyfile",
      ]).toContain(m[1]);
    const published = units.flatMap((f) => [...unit(f).matchAll(/^PublishPort=(.*)$/gm)].map((m) => `${f} ${m[1]}`));
    expect(published).toEqual([
      "commonair-status-caddy.container 80:80",
      "commonair-status-caddy.container 443:443",
      "commonair-status-caddy.container 443:443/udp",
      "commonair-status-prometheus.container 127.0.0.1:9090:9090",
    ]);
    expect(unit("commonair-status-prometheus.container")).toContain("--storage.tsdb.retention.time=30d");
    expect(unit("commonair-status-render.container")).toMatch(/^User=65534$/m);
    for (const f of units.filter((u) => u.endsWith(".container")))
      expect(unit(f), f).toMatch(/^NoNewPrivileges=true$/m);
  });

  test("the probe interval is 30 s everywhere", () => {
    const prom = parse(read("infra/status/prometheus.yml")) as { global: { scrape_interval: string } };
    expect(prom.global.scrape_interval).toBe("30s");
    expect(CFG.probeIntervalSeconds).toBe(30);
  });

  test("the Caddyfile serves static files only, with a CSP that allows no script", () => {
    const c = read("infra/status/Caddyfile");
    expect(c).toContain("{$STATUS_DOMAIN}");
    expect(c).not.toContain("reverse_proxy");
    expect(c).toMatch(/default-src 'none'/);
    expect(c).not.toMatch(/script-src/);
  });

  test("place-secret.sh refuses unknown keys and installs alert.env 0400 for the renderer", () => {
    const bin = tmp();
    const captured = join(bin, "captured");
    writeFileSync(join(bin, "ssh"), `#!/bin/sh\nprintf '%s\\n' "$2" > "${captured}.cmd"\ncat > "${captured}"\n`);
    chmodSync(join(bin, "ssh"), 0o755);
    const run = (stdin: string) =>
      Bun.spawnSync(["sh", join(ROOT, "infra/status/place-secret.sh"), "root@192.0.2.20"], {
        stdin: Buffer.from(stdin),
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        stdout: "pipe",
        stderr: "pipe",
      });
    const bad = run("SMTP_HOST=smtp.relay.test\nAWS_SECRET=x\n");
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr.toString()).toContain("AWS_SECRET");
    expect(existsSync(captured)).toBe(false);
    const good = run("# relay\nSMTP_HOST=smtp.relay.test\nSMTP_PASSWORD=p\nALERT_EMAIL_TO=oncall@ops.test\n");
    expect(good.exitCode, good.stderr.toString()).toBe(0);
    expect(readFileSync(captured, "utf8")).toContain("SMTP_PASSWORD=p");
    const cmd = readFileSync(`${captured}.cmd`, "utf8");
    expect(cmd).toContain("chown 65534:65534");
    expect(cmd).toContain("chmod 0400");
    expect(cmd).not.toContain("SMTP_PASSWORD");
  });
});

// ---------------------------------------------------------------- runbooks

const DOCS = ["monitoring", "incidents", "on-call", "status-page"];
const slug = (h: string) =>
  h
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .replaceAll(" ", "-");
const anchorsOf = (doc: string) =>
  new Set([...read(`docs/operators/${doc}.md`).matchAll(/^#{1,4} (.+)$/gm)].map((m) => slug(m[1] as string)));

describe("runbooks", () => {
  const anchors = Object.fromEntries(DOCS.map((d) => [d, anchorsOf(d)]));

  test("every runbook label in L1-observability's rules resolves", () => {
    const dir = join(ROOT, "infra/prometheus/rules");
    const labels = readdirSync(dir)
      .filter((f) => f.endsWith(".yml"))
      .flatMap(
        (f) =>
          (parse(readFileSync(join(dir, f), "utf8")) as { groups: { rules: { labels?: Record<string, string> }[] }[] })
            .groups,
      )
      .flatMap((g) => g.rules)
      .map((r) => r.labels?.runbook)
      .filter((r): r is string => r !== undefined);
    expect(labels.length).toBeGreaterThan(10);
    for (const r of labels) {
      const m = /^docs\/operators\/([a-z-]+)\.md#([a-z0-9-]+)$/.exec(r);
      expect(m, r).not.toBeNull();
      expect(DOCS, r).toContain(m?.[1]);
      expect(anchors[m?.[1] as string], r).toContain(m?.[2]);
    }
  });

  test("every runbook link in L1-status's files and docs resolves", () => {
    const files = [
      "infra/status/render.ts",
      "infra/status/rules.yml",
      "infra/status/place-secret.sh",
      "infra/grafana/provisioning/alerting/commonair.yaml",
      "infra/grafana/provisioning/alerting/route-env.sh",
      "infra/tofu/digitalocean/modules/instance/monitoring.tf",
      "infra/tofu/digitalocean/modules/instance/variables.tf",
      ...DOCS.filter((d) => d !== "monitoring").map((d) => `docs/operators/${d}.md`),
    ];
    let seen = 0;
    for (const f of files)
      for (const m of read(f).matchAll(/(?:docs\/operators\/|\]\(\.?\/?)([a-z-]+)\.md#([a-z0-9-]+)/g)) {
        if (!DOCS.includes(m[1] as string)) continue;
        seen++;
        expect(anchors[m[1] as string], `${f}: ${m[0]}`).toContain(m[2]);
      }
    for (const d of DOCS.filter((x) => x !== "monitoring"))
      for (const m of read(`docs/operators/${d}.md`).matchAll(/\]\(#([a-z0-9-]+)\)/g)) {
        seen++;
        expect(anchors[d], `${d}.md: #${m[1]}`).toContain(m[1]);
      }
    expect(seen).toBeGreaterThan(5);
  });

  test("the on-call template states the 99.9% budget and response targets", () => {
    const oncall = read("docs/operators/on-call.md");
    expect(oncall).toMatch(/99\.9%/);
    expect(oncall).toMatch(/43 min/);
    expect(read("docs/operators/incidents.md")).toMatch(/## Post-incident write-up/i);
  });
});

// ---------------------------------------------------------------- Grafana alerting

interface Provisioning {
  apiVersion: number;
  contactPoints: { name: string; receivers: { uid: string; type: string; settings: Record<string, unknown> }[] }[];
  policies: {
    receiver: string;
    group_by: string[];
    routes: {
      receiver: string;
      object_matchers: string[][];
      group_by: string[];
      group_wait: string;
      group_interval: string;
      repeat_interval: string;
    }[];
  }[];
  groups: {
    folder: string;
    interval: string;
    rules: {
      uid: string;
      title: string;
      condition: string;
      noDataState: string;
      data: { refId: string; datasourceUid: string; model: { expr?: string; type?: string; expression?: string } }[];
      annotations: Record<string, string>;
    }[];
  }[];
}

describe("Grafana alerting provisioning", () => {
  const text = read("infra/grafana/provisioning/alerting/commonair.yaml");
  const p = parse(text) as Provisioning;
  const datasources = parse(read("infra/grafana/provisioning/datasources/datasources.yaml")) as {
    datasources: { uid: string; type: string }[];
  };

  test("parses: contact points by email and webhook, from env", () => {
    expect(p.apiVersion).toBe(1);
    const [cp] = p.contactPoints;
    expect(cp?.receivers.map((r) => r.type)).toEqual(["email", "webhook"]);
    expect(cp?.receivers[0]?.settings.addresses).toBe("${ALERT_EMAIL_TO}");
    expect(cp?.receivers[1]?.settings.url).toBe("${ALERT_WEBHOOK_URL}");
  });

  test("one policy: page now, ticket in a daily digest", () => {
    const [root] = p.policies;
    const names = new Set(p.contactPoints.map((c) => c.name));
    expect(names).toContain(root?.receiver);
    const page = root?.routes.find((r) => r.object_matchers[0]?.join(" ") === "severity = page");
    const ticket = root?.routes.find((r) => r.object_matchers[0]?.join(" ") === "severity = ticket");
    expect(names).toContain(page?.receiver);
    expect(page?.group_wait).toBe("10s");
    expect(ticket).toMatchObject({ group_by: ["severity"], group_interval: "24h", repeat_interval: "24h" });
  });

  test('one Grafana-managed rule on ALERTS{alertstate="firing"}, carrying severity, summary and runbook', () => {
    expect(p.groups).toHaveLength(1);
    const [rule] = p.groups[0]?.rules ?? [];
    const query = rule?.data.find((d) => d.refId === "A");
    expect(query?.datasourceUid).toBe(datasources.datasources.find((d) => d.type === "prometheus")?.uid);
    expect(query?.model.expr).toContain('ALERTS{alertstate="firing"}');
    expect(rule?.data.find((d) => d.refId === rule.condition)?.model).toMatchObject({
      type: "threshold",
      expression: "A",
    });
    expect(rule?.noDataState).toBe("OK");
    expect(rule?.annotations.summary).toContain('"summary"');
    expect(rule?.annotations.runbook_url).toContain('"runbook"');
    // Every severity L1-observability uses is routed.
    const severities = new Set(
      readdirSync(join(ROOT, "infra/prometheus/rules")).flatMap((f) =>
        [...read(`infra/prometheus/rules/${f}`).matchAll(/severity: (\w+)/g)].map((m) => m[1]),
      ),
    );
    expect([...severities].sort((a, b) => String(a).localeCompare(String(b)))).toEqual(["page", "ticket"]);
  });

  test("every $ is escaped except the two env references", () => {
    const body = text
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n")
      .replaceAll("$$", "");
    expect([...body.matchAll(/\$\{?([A-Za-z_0-9]+)/g)].map((m) => m[1])).toEqual([
      "ALERT_EMAIL_TO",
      "ALERT_WEBHOOK_URL",
    ]);
  });

  const routeEnv = (env: Record<string, string>) => {
    const r = Bun.spawnSync(
      ["sh", "-c", `. "${join(ROOT, "infra/grafana/provisioning/alerting/route-env.sh")}" && env`],
      {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(r.exitCode).toBe(0);
    return { env: parseEnvFile(r.stdout.toString()), log: r.stderr.toString() };
  };

  test("route-env.sh: no route is loud, placeholders keep Grafana provisioning", () => {
    const none = routeEnv({});
    expect(none.log).toContain("NO ALERT ROUTE");
    expect(none.env.ALERT_EMAIL_TO).toBe("no-route@alerts.invalid");
    expect(none.env.ALERT_WEBHOOK_URL).toBe("http://127.0.0.1:9/no-webhook-configured");
    expect(routeEnv({ ALERT_EMAIL_TO: "you@example.com" }).log).toContain("NO ALERT ROUTE");
  });

  test("route-env.sh: the instance's relay becomes Grafana's SMTP, STARTTLS required with a user", () => {
    const r = routeEnv({
      SMTP_HOST: "smtp.relay.test",
      SMTP_PORT: "2587",
      SMTP_USER: "resend",
      SMTP_PASSWORD: "secret-not-real",
      MAIL_FROM: "Alerts <alerts@ops.test>",
      ALERT_EMAIL_TO: "oncall@ops.test",
    });
    expect(r.env).toMatchObject({
      GF_SMTP_ENABLED: "true",
      GF_SMTP_HOST: "smtp.relay.test:2587",
      GF_SMTP_USER: "resend",
      GF_SMTP_FROM_ADDRESS: "alerts@ops.test",
      GF_SMTP_STARTTLS_POLICY: "MandatoryStartTLS",
      ALERT_EMAIL_TO: "oncall@ops.test",
    });
    expect(r.log).toContain("alert route: mail");
    expect(r.log).not.toContain("secret-not-real");
    // Explicit GF_SMTP_* win.
    expect(
      routeEnv({
        GF_SMTP_HOST: "other.test:25",
        GF_SMTP_ENABLED: "true",
        SMTP_HOST: "smtp.relay.test",
        ALERT_EMAIL_TO: "oncall@ops.test",
      }).env.GF_SMTP_HOST,
    ).toBe("other.test:25");
    expect(routeEnv({ ALERT_EMAIL_TO: "oncall@ops.test" }).log).toContain("NO ALERT ROUTE");
    expect(routeEnv({ ALERT_WEBHOOK_URL: "https://hooks.ops.test/x" }).log).toContain("webhook only");
  });
});

// ---------------------------------------------------------------- promtool

requirePromtool("status.test.ts");
describe.runIf(CAN_RUN_PROMTOOL)("promtool", () => {
  test("check config and rules on the monitoring Prometheus, and the rule's unit tests", () => {
    // The unit's mounts, re-rooted in /tmp: prometheus.yml names /etc/prometheus/{rules.yml,targets}.
    const r = runPromtool(
      [
        "set -e",
        "d=$(mktemp -d)",
        "mkdir -p $d/targets",
        // [p]: runPromtool's no-podman fallback rewrites the literal path.
        'sed "s#/etc/[p]rometheus/#$d/#g" /infra/status/prometheus.yml > $d/prometheus.yml',
        "cp /infra/status/rules.yml $d/rules.yml",
        "promtool check config $d/prometheus.yml",
        "promtool check rules /infra/status/rules.yml",
        "promtool test rules /infra/tests/status-rules.test.yml",
      ].join("\n"),
      300_000,
    );
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("SUCCESS");
    expect(r.out).not.toContain("FAILED");
  });
});
