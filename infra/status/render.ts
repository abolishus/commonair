// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The public status page and the outside-in alerts, run every minute on the monitoring droplet
 * (docs/operators/status-page.md). Bun, no dependencies: cloud-init copies this one file.
 *
 *   bun render.ts      reads /config/status.json and the monitoring Prometheus, writes /data/site
 *
 * Each run it:
 * - writes the probe targets Prometheus reads (file_sd), so status.json is the one source;
 * - reads the last probes and confirms a change only after `confirmSamples` probes agree;
 * - mails (SMTP) and optionally POSTs a webhook on a confirmed change, at most once per
 *   component per `mailIntervalSeconds`, always with the recovery message;
 * - keeps the daily availability per component, so the page shows 90 days while Prometheus keeps
 *   30;
 * - renders index.html and status.json from that, plus the operator's notes and maintenance file.
 *
 * Every time comes from Prometheus (its `time()` and sample timestamps), so skew between droplets
 * cannot move a state or a day boundary. The one exception is a run that cannot read Prometheus
 * at all (`runFailed`): it uses this host's clock, which is the clock that Prometheus, on the same
 * droplet, would have answered with. Nothing personal is written: the page and the mails name
 * components, states and times only.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { join } from "node:path";

// ---------------------------------------------------------------- config

export type ProbeModule = "http_web" | "http_ready" | "websocket_chat" | "tcp_connect";
/** The modules an extra component may use. */
export const PROBE_MODULES: readonly ProbeModule[] = ["http_web", "http_ready", "websocket_chat", "tcp_connect"];
/**
 * A certificate's own probe: TLS without verification, so an expired certificate still reports
 * its expiry (http_web fails verification and reports none).
 */
export const CERT_MODULE = "http_cert";

export interface ProbeComponent {
  id: string;
  name: string;
  kind: "probe";
  module: ProbeModule;
  target: string;
}
/** A certificate's expiry, probed (CERT_MODULE) at another component's https target. */
export interface CertComponent {
  id: string;
  name: string;
  kind: "cert";
  from: string;
}

export type Locale = "en" | "es";
export const LOCALES: readonly Locale[] = ["en", "es"];
export type Component = ProbeComponent | CertComponent;

export interface StatusConfig {
  siteName: string;
  /** The page's language (its strings are in TEXT, en and es like the web app's catalog). */
  locale: Locale;
  statusDomain: string;
  components: Component[];
  /** host:port of well-known external targets: all of them down means this droplet is blind. */
  canaries: string[];
  probeIntervalSeconds: number;
  confirmSamples: number;
  mailIntervalSeconds: number;
  certWarnDays: number;
  /** Prometheus's retention: older days are never asked for. */
  retentionDays: number;
}

const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const HOST_PORT_RE = /^[A-Za-z0-9.-]+:\d{1,5}$|^\[[0-9a-fA-F:]+\]:\d{1,5}$/;

/** The default components for an instance origin (https://host) and its RTMP host:port. */
export function defaultComponents(origin: string, rtmp: string, locale: Locale = "en"): Component[] {
  const host = new URL(origin).host;
  const n = TEXT[locale].component;
  return [
    { id: "web", name: n.web, kind: "probe", module: "http_web", target: `https://${host}/` },
    // The API's readiness checks Postgres and Valkey, so a managed-cluster outage shows here.
    { id: "api", name: n.api, kind: "probe", module: "http_ready", target: `https://${host}/readyz/api` },
    { id: "chat", name: n.chat, kind: "probe", module: "websocket_chat", target: `wss://${host}/chat` },
    // The origin's readiness (Postgres, Valkey and its HLS source), not a live playlist: no
    // channel is guaranteed to be live (status-page.md, "What is probed").
    { id: "video", name: n.video, kind: "probe", module: "http_ready", target: `https://${host}/readyz/origin` },
    { id: "ingest", name: n.ingest, kind: "probe", module: "tcp_connect", target: rtmp },
    { id: "certificate", name: n.certificate, kind: "cert", from: "web" },
  ];
}

function fail(msg: string): never {
  throw new Error(`status.json: ${msg}`);
}
const str = (v: unknown, what: string): string =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : fail(`${what} must be a non-empty string`);
const int = (v: unknown, what: string, dflt: number, min: number, max: number): number => {
  if (v === undefined) return dflt;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)
    fail(`${what} must be a whole number from ${min} to ${max}`);
  return v;
};

/** Validates status.json (cloud-init writes it from the tofu variables). */
export function parseConfig(raw: unknown): StatusConfig {
  if (typeof raw !== "object" || raw === null) fail("not an object");
  const r = raw as Record<string, unknown>;
  const origin = str(r.origin, "origin");
  if (!/^https:\/\/[^/]+$/.test(origin)) fail("origin must be https://host with no path");
  const host = new URL(origin).host;
  const rtmp = r.rtmp === undefined || r.rtmp === null ? `${host}:1935` : str(r.rtmp, "rtmp");
  if (!HOST_PORT_RE.test(rtmp)) fail("rtmp must be host:port");
  const locale = (r.locale === undefined || r.locale === null ? "en" : r.locale) as Locale;
  if (!LOCALES.includes(locale)) fail(`locale must be one of ${LOCALES.join(", ")}`);
  const extra = r.extraComponents ?? [];
  if (!Array.isArray(extra)) fail("extraComponents must be a list");
  const components = [...defaultComponents(origin, rtmp, locale)];
  for (const e of extra as unknown[]) {
    const c = (typeof e === "object" && e !== null ? e : fail("each extra component is an object")) as Record<
      string,
      unknown
    >;
    const module = str(c.module, "extraComponents[].module") as ProbeModule;
    if (!PROBE_MODULES.includes(module)) fail(`extraComponents[].module must be one of ${PROBE_MODULES.join(", ")}`);
    const target = str(c.target, "extraComponents[].target");
    if (module === "tcp_connect" ? !HOST_PORT_RE.test(target) : !/^(https|wss):\/\/[^\s]+$/.test(target))
      fail(`extraComponents[].target ${target} does not suit ${module}`);
    components.push({
      id: str(c.id, "extraComponents[].id"),
      name: str(c.name, "extraComponents[].name"),
      kind: "probe",
      module,
      target,
    });
  }
  const ids = new Set<string>();
  for (const c of components) {
    if (!ID_RE.test(c.id)) fail(`component id ${c.id} must match ${ID_RE.source}`);
    if (ids.has(c.id)) fail(`component id ${c.id} is used twice`);
    ids.add(c.id);
  }
  const canaries = r.canaries ?? [];
  if (!Array.isArray(canaries) || canaries.some((c) => typeof c !== "string" || !HOST_PORT_RE.test(c)))
    fail("canaries must be a list of host:port");
  const statusDomain =
    r.statusDomain === undefined || r.statusDomain === null ? `status.${host}` : str(r.statusDomain, "statusDomain");
  if (!/^[a-z0-9.-]+$/i.test(statusDomain)) fail("statusDomain must be a host name");
  return {
    // No name given: the instance's host, never a literal (the name lives in SITE / INSTANCE_NAME).
    siteName: r.siteName === undefined || r.siteName === null ? host : str(r.siteName, "siteName"),
    locale,
    statusDomain,
    components,
    canaries: canaries as string[],
    probeIntervalSeconds: int(r.probeIntervalSeconds, "probeIntervalSeconds", 30, 5, 300),
    confirmSamples: int(r.confirmSamples, "confirmSamples", 2, 1, 10),
    mailIntervalSeconds: int(r.mailIntervalSeconds, "mailIntervalSeconds", 600, 0, 86_400),
    certWarnDays: int(r.certWarnDays, "certWarnDays", 14, 1, 90),
    retentionDays: int(r.retentionDays, "retentionDays", 30, 1, 400),
  };
}

const probes = (cfg: StatusConfig) => cfg.components.filter((c): c is ProbeComponent => c.kind === "probe");
const certs = (cfg: StatusConfig) => cfg.components.filter((c): c is CertComponent => c.kind === "cert");

/**
 * Prometheus file_sd groups: one per component, one per certificate (at its component's target)
 * and one per canary (prometheus.yml relabels).
 */
export function probeTargets(cfg: StatusConfig): { targets: string[]; labels: Record<string, string> }[] {
  return [
    ...probes(cfg).map((c) => ({
      targets: [c.target],
      labels: { component: c.id, module: c.module, role: "component" },
    })),
    ...certs(cfg).map((c) => ({
      targets: [
        probes(cfg).find((p) => p.id === c.from)?.target ?? fail(`certificate ${c.id}: no component ${c.from}`),
      ],
      labels: { component: c.id, module: CERT_MODULE, role: "cert" },
    })),
    ...cfg.canaries.map((t, i) => ({
      targets: [t],
      labels: { component: `canary-${i}`, module: "tcp_connect", role: "canary" },
    })),
  ];
}

// ---------------------------------------------------------------- Prometheus

export type Sample = [ts: number, value: number];
export interface PromSeries {
  metric: Record<string, string>;
  values?: [number, string][];
  value?: [number, string];
}
export interface PromAnswer {
  status: "success" | "error";
  data?: { resultType: "matrix" | "vector" | "scalar" | "string"; result: unknown };
  error?: string;
}
/** One instant query; `time` in Unix seconds (Prometheus's own clock when omitted). */
export type PromQuery = (expr: string, time?: number) => Promise<PromAnswer>;

export function httpProm(base: string, fetchFn: typeof fetch = fetch): PromQuery {
  return async (expr, time) => {
    const url = new URL("/api/v1/query", base);
    url.searchParams.set("query", expr);
    if (time !== undefined) url.searchParams.set("time", String(time));
    const res = await fetchFn(url, { signal: AbortSignal.timeout(15_000) });
    return (await res.json()) as PromAnswer;
  };
}

function resultOf(a: PromAnswer, want: "matrix" | "vector" | "scalar", expr: string): unknown {
  if (a.status !== "success" || !a.data) throw new Error(`prometheus: ${expr}: ${a.error ?? "error"}`);
  if (a.data.resultType !== want) throw new Error(`prometheus: ${expr}: expected ${want}, got ${a.data.resultType}`);
  return a.data.result;
}

export const SAMPLE_QUERY = (cfg: StatusConfig) =>
  `probe_success{job="status"}[${cfg.probeIntervalSeconds * (cfg.confirmSamples + 2)}s]`;
export const CERT_QUERY = `min by (component) (probe_ssl_earliest_cert_expiry{job="status",role="cert"})`;
/** Daily availability; blind periods (canaries down too) are not counted (status-rules.yml). */
export const DAY_QUERY = (seconds: number) =>
  `avg by (component) (avg_over_time(commonair_status:probe_success:sighted[${seconds}s]))`;

export interface Observation {
  /** Prometheus's evaluation time, the only clock the renderer uses. */
  now: number;
  /** probe_success samples per component id (canaries as canary-<n>), oldest first. */
  samples: Record<string, Sample[]>;
  /** probe_ssl_earliest_cert_expiry per certificate component id, Unix seconds. */
  certExpiry: Record<string, number>;
}

export async function observe(prom: PromQuery, cfg: StatusConfig): Promise<Observation> {
  const nowResult = resultOf(await prom("time()"), "scalar", "time()") as [number, string];
  const now = Math.floor(nowResult[0]);
  const sq = SAMPLE_QUERY(cfg);
  const samples: Record<string, Sample[]> = {};
  for (const s of resultOf(await prom(sq, now), "matrix", sq) as PromSeries[]) {
    const id = s.metric.component;
    if (!id) continue;
    const list = (s.values ?? []).map(([ts, v]): Sample => [ts, Number(v)]);
    // Two series for one component (a relabel change) merge by time.
    samples[id] = [...(samples[id] ?? []), ...list].sort((a, b) => a[0] - b[0]);
  }
  const certExpiry: Record<string, number> = {};
  for (const s of resultOf(await prom(CERT_QUERY, now), "vector", CERT_QUERY) as PromSeries[]) {
    const id = s.metric.component;
    if (id && s.value) certExpiry[id] = Number(s.value[1]);
  }
  return { now, samples, certExpiry };
}

// ---------------------------------------------------------------- state

export type State = "up" | "degraded" | "down" | "unknown";
export type Shown = State | "maintenance";

/**
 * The confirmed state of one probe: `confirmSamples` latest samples agree, the newest no older
 * than 3 intervals. Null means the probes disagree, so the previous state stands.
 */
export function judgeProbe(samples: Sample[], now: number, cfg: StatusConfig): "up" | "down" | "unknown" | null {
  const newest = samples.at(-1);
  if (!newest || now - newest[0] > cfg.probeIntervalSeconds * 3) return "unknown";
  const last = samples.slice(-cfg.confirmSamples);
  if (last.length < cfg.confirmSamples) return null;
  if (last.every(([, v]) => v === 1)) return "up";
  if (last.every(([, v]) => v === 0)) return "down";
  return null;
}

export function judgeCert(expiry: number | undefined, now: number, cfg: StatusConfig): State {
  if (expiry === undefined) return "unknown";
  if (expiry <= now) return "down";
  return expiry - now < cfg.certWarnDays * 86_400 ? "degraded" : "up";
}

export interface ComponentRecord {
  state: State;
  /** Prometheus time the state was first confirmed. */
  since: number;
  /** The problem state last mailed and not yet recovered from. */
  alerted: "down" | "degraded" | null;
  lastMailAt: number | null;
}
export interface Persisted {
  version: 1;
  components: Record<string, ComponentRecord>;
  /** UTC date → component id → availability (0..1), or null for no data that day. */
  days: Record<string, Record<string, number | null>>;
  blindSince: number | null;
}
export const emptyState = (): Persisted => ({ version: 1, components: {}, days: {}, blindSince: null });

/** The pseudo-component for "the probes themselves report nothing". */
export const PROBES_ID = "_probes";
/** How long the probes must report nothing before that is mailed. */
export const PROBES_SETTLE_SECONDS = 300;

export interface Judgement {
  states: Record<string, State>;
  /** Every component and every canary failing: this droplet has lost its network. */
  blind: boolean;
}

export function judge(cfg: StatusConfig, obs: Observation, prev: Persisted): Judgement {
  const states: Record<string, State> = {};
  const raw: Record<string, "up" | "down" | "unknown" | null> = {};
  for (const c of probes(cfg)) {
    const j = judgeProbe(obs.samples[c.id] ?? [], obs.now, cfg);
    raw[c.id] = j;
    states[c.id] = j ?? prev.components[c.id]?.state ?? "unknown";
  }
  for (const c of cfg.components) if (c.kind === "cert") states[c.id] = judgeCert(obs.certExpiry[c.id], obs.now, cfg);
  const canaries = cfg.canaries.map((_, i) => judgeProbe(obs.samples[`canary-${i}`] ?? [], obs.now, cfg));
  const blind =
    cfg.canaries.length > 0 && canaries.every((s) => s === "down") && probes(cfg).every((c) => raw[c.id] === "down");
  if (blind)
    // Keep what was known before: nothing here says the instance is down.
    for (const c of cfg.components) states[c.id] = prev.components[c.id]?.state ?? "unknown";
  states[PROBES_ID] = probes(cfg).every((c) => raw[c.id] === "unknown") ? "down" : "up";
  return { states, blind };
}

// ---------------------------------------------------------------- alerts

export interface AlertMessage {
  component: string;
  name: string;
  kind: "problem" | "recovery";
  state: State;
  /** For a recovery, the state recovered from. */
  from: "down" | "degraded" | null;
  /** When the state began (Prometheus time). */
  since: number;
  at: number;
}
export interface AlertIntent {
  message: AlertMessage;
  /** The record once the message is delivered; until then the base record stands. */
  after: ComponentRecord;
}
export interface AlertPlan {
  records: Record<string, ComponentRecord>;
  intents: AlertIntent[];
}

const nameOf = (cfg: StatusConfig, id: string) =>
  id === PROBES_ID ? "Status probes" : (cfg.components.find((c) => c.id === id)?.name ?? id);

/**
 * Which mails to send. A problem (down or degraded) is mailed once, and again only after
 * `mailIntervalSeconds` since this component's last mail, so flapping sends one mail per window;
 * the recovery is always sent. Maintenance and a blind droplet send nothing, and keep what was
 * already mailed so the recovery still goes out afterwards. An undelivered message is retried.
 */
export function planAlerts(
  cfg: StatusConfig,
  prev: Record<string, ComponentRecord>,
  j: Judgement,
  now: number,
  opts: { maintenance: boolean },
): AlertPlan {
  const records: Record<string, ComponentRecord> = {};
  const intents: AlertIntent[] = [];
  for (const [id, state] of Object.entries(j.states)) {
    const old = prev[id];
    const base: ComponentRecord = old
      ? { ...old, ...(old.state === state ? {} : { state, since: now }) }
      : { state, since: now, alerted: null, lastMailAt: null };
    records[id] = base;
    if (opts.maintenance || j.blind) continue;
    const problem = state === "down" || state === "degraded" ? state : null;
    const quiet = base.lastMailAt !== null && now - base.lastMailAt < cfg.mailIntervalSeconds;
    // Probes that report nothing right after boot are Prometheus starting, not an outage.
    const settled = id !== PROBES_ID || now - base.since >= PROBES_SETTLE_SECONDS;
    if (problem && base.alerted !== problem && !quiet && settled) {
      intents.push({
        message: {
          component: id,
          name: nameOf(cfg, id),
          kind: "problem",
          state,
          from: null,
          since: base.since,
          at: now,
        },
        after: { ...base, alerted: problem, lastMailAt: now },
      });
    } else if (state === "up" && base.alerted) {
      intents.push({
        message: {
          component: id,
          name: nameOf(cfg, id),
          kind: "recovery",
          state,
          from: base.alerted,
          since: base.since,
          at: now,
        },
        after: { ...base, alerted: null, lastMailAt: now },
      });
    }
  }
  return { records, intents };
}

/** The records after delivery: a delivered intent's `after`, the base record otherwise. */
export function applyDelivered(plan: AlertPlan, delivered: ReadonlySet<string>): Record<string, ComponentRecord> {
  const out = { ...plan.records };
  for (const i of plan.intents) if (delivered.has(i.message.component)) out[i.message.component] = i.after;
  return out;
}

// ---------------------------------------------------------------- delivery

export interface MailSettings {
  host: string;
  port: number;
  /** Implicit TLS (465, 2465); otherwise STARTTLS, required whenever a user is set. */
  secure: boolean;
  user: string | null;
  password: string | null;
  from: string;
  to: string[];
  /** EHLO name. */
  helo: string;
  /** PEM CA to trust instead of the system's (tests; SMTP_CA_FILE). */
  ca: string | null;
}
export interface Route {
  mail: MailSettings | null;
  webhook: string | null;
  /** Why a channel is off, for the loud log line. */
  problems: string[];
}

const PLACEHOLDER_RE = /(^|[@.])example\.(com|org|net)$|\.invalid$|changeme|__generate__|^<.*>$|^replace/i;
export const isPlaceholder = (v: string | undefined | null): boolean => {
  const s = v?.trim() ?? "";
  // For a URL, its host decides.
  const host = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:?#]+)/i.exec(s)?.[1];
  return s === "" || PLACEHOLDER_RE.test(s) || (host !== undefined && PLACEHOLDER_RE.test(host));
};

/** Parses KEY=VALUE lines (the alert.env the operator places), ignoring comments. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    const v = m[2] ?? "";
    out[m[1] as string] = /^(["']).*\1$/.test(v) ? v.slice(1, -1) : v;
  }
  return out;
}

/** The alert route from alert.env. A placeholder or missing value turns a channel off. */
export function routeFrom(env: Record<string, string | undefined>, cfg: StatusConfig): Route {
  const problems: string[] = [];
  let mail: MailSettings | null = null;
  const to = (env.ALERT_EMAIL_TO ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (to.length === 0 || to.some(isPlaceholder)) problems.push("ALERT_EMAIL_TO is unset or a placeholder");
  else if (isPlaceholder(env.SMTP_HOST)) problems.push("SMTP_HOST is unset or a placeholder");
  else if (isPlaceholder(env.MAIL_FROM)) problems.push("MAIL_FROM is unset or a placeholder");
  else if (env.SMTP_USER && isPlaceholder(env.SMTP_PASSWORD)) problems.push("SMTP_PASSWORD is unset or a placeholder");
  else {
    const port = Number(env.SMTP_PORT ?? "2587");
    if (!Number.isInteger(port) || port < 1 || port > 65_535) problems.push("SMTP_PORT is not a port");
    else
      mail = {
        host: (env.SMTP_HOST as string).trim(),
        port,
        secure: env.SMTP_SECURE === "true",
        user: env.SMTP_USER?.trim() || null,
        password: env.SMTP_PASSWORD ?? null,
        from: (env.MAIL_FROM as string).trim(),
        to,
        helo: cfg.statusDomain,
        ca: env.SMTP_CA_PEM ?? null,
      };
  }
  const hook = env.ALERT_WEBHOOK_URL?.trim() ?? "";
  let webhook: string | null = null;
  if (hook !== "") {
    if (isPlaceholder(hook) || !/^https?:\/\/[^\s]+$/.test(hook))
      problems.push("ALERT_WEBHOOK_URL is a placeholder or not a URL");
    else webhook = hook;
  }
  return { mail, webhook, problems };
}

export const iso = (s: number) => `${new Date(s * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
export const duration = (seconds: number) => {
  const m = Math.max(0, Math.round(seconds / 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

/** Subject and body of an alert: component, state and times only (no personal data). */
export function alertText(cfg: StatusConfig, m: AlertMessage): { subject: string; text: string } {
  const what =
    m.kind === "recovery"
      ? `${m.name} has recovered`
      : m.component === PROBES_ID
        ? "Status probes are not reporting"
        : `${m.name} is ${m.state === "degraded" ? "degraded" : "down"}`;
  const lines =
    m.kind === "recovery"
      ? [`${m.name} is operational again as of ${iso(m.at)}.`, `It had been ${m.from}.`]
      : [
          // Alerts are for the operator and stay English; the page follows cfg.locale.
          `${m.name}: ${TEXT.en.state[m.state].toLowerCase()} since ${iso(m.since)}, seen from the monitoring droplet.`,
          ...(m.component === PROBES_ID
            ? ["The probes have no fresh results: check blackbox and Prometheus on the monitoring droplet."]
            : []),
        ];
  return {
    subject: `[${cfg.siteName} status] ${what}`,
    text: [
      ...lines,
      "",
      `Status page: https://${cfg.statusDomain}/`,
      "Runbook: docs/operators/incidents.md (declaring an incident) and docs/operators/on-call.md",
      "",
      `Sent by the ${cfg.siteName} status monitor. At most one problem mail per component every ${duration(cfg.mailIntervalSeconds)}; recoveries always.`,
      "",
    ].join("\r\n"),
  };
}

export interface Transport {
  mail(
    settings: MailSettings,
    msg: { subject: string; text: string; date: number; id: string },
    signal: AbortSignal,
  ): Promise<void>;
  webhook(url: string, body: unknown, signal: AbortSignal): Promise<void>;
}

/**
 * How long one run may spend delivering, all intents and channels together. Well under the
 * unit's TimeoutStartSec (120 s), so a hung relay never gets the run killed.
 */
export const DELIVERY_BUDGET_MS = 60_000;

/** Rejects when the signal aborts, even if `p` ignores it. */
function untilAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Delivers every intent on every configured channel at once (mail and webhook in parallel, so a
 * dead relay never holds back the webhook) within `budgetMs`; returns the components delivered
 * on any channel. `onDelivered` runs as each one lands, so the caller can save it straight away.
 */
export async function deliver(
  cfg: StatusConfig,
  plan: AlertPlan,
  route: Route,
  transport: Transport,
  log: Log,
  opts: { budgetMs?: number; onDelivered?: (component: string) => void } = {},
): Promise<Set<string>> {
  const delivered = new Set<string>();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error("delivery budget spent")), opts.budgetMs ?? DELIVERY_BUDGET_MS);
  const one = async (m: AlertMessage) => {
    const { subject, text } = alertText(cfg, m);
    const channels: Promise<void>[] = [];
    if (route.mail) {
      const msg = { subject, text, date: m.at, id: `${m.component}.${m.kind}.${m.at}@${cfg.statusDomain}` };
      channels.push(
        untilAbort(transport.mail(route.mail, msg, ctl.signal), ctl.signal).catch((err: unknown) => {
          log("error", "alert mail failed", { component: m.component, kind: m.kind, err: errText(err) });
          throw err;
        }),
      );
    }
    if (route.webhook) {
      const body = {
        site: cfg.siteName,
        component: m.component,
        name: m.name,
        kind: m.kind,
        state: m.state,
        from: m.from,
        since: new Date(m.since * 1000).toISOString(),
        at: new Date(m.at * 1000).toISOString(),
        page: `https://${cfg.statusDomain}/`,
        subject,
      };
      channels.push(
        untilAbort(transport.webhook(route.webhook, body, ctl.signal), ctl.signal).catch((err: unknown) => {
          log("error", "alert webhook failed", { component: m.component, kind: m.kind, err: errText(err) });
          throw err;
        }),
      );
    }
    const ok = (await Promise.allSettled(channels)).some((r) => r.status === "fulfilled");
    if (ok) {
      delivered.add(m.component);
      opts.onDelivered?.(m.component);
    }
    log(ok ? "info" : "warn", ok ? "alert sent" : "alert not delivered, retried next run", {
      component: m.component,
      kind: m.kind,
      state: m.state,
    });
  };
  try {
    await Promise.allSettled(plan.intents.map((i) => one(i.message)));
  } finally {
    clearTimeout(timer);
  }
  return delivered;
}

// ------------------------------------------------ SMTP (RFC 5321, STARTTLS RFC 3207, AUTH PLAIN)

/** One SMTP conversation: lines in, replies out. */
class SmtpSession {
  private buf = "";
  private waiters: ((line: string | Error) => void)[] = [];
  private lines: string[] = [];
  private socket: Socket | TLSSocket;

  constructor(socket: Socket | TLSSocket) {
    this.socket = socket;
    this.attach(socket);
  }

  private attach(s: Socket | TLSSocket) {
    s.setEncoding("utf8");
    s.on("data", (chunk: string) => {
      this.buf += chunk;
      for (let i = this.buf.indexOf("\n"); i >= 0; i = this.buf.indexOf("\n")) {
        const line = this.buf.slice(0, i).replace(/\r$/, "");
        this.buf = this.buf.slice(i + 1);
        const w = this.waiters.shift();
        if (w) w(line);
        else this.lines.push(line);
      }
    });
    s.on("error", (e) => this.waiters.splice(0).forEach((w) => w(e)));
    s.on("close", () => this.waiters.splice(0).forEach((w) => w(new Error("connection closed"))));
  }

  private nextLine(): Promise<string> {
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => this.waiters.push((l) => (l instanceof Error ? reject(l) : resolve(l))));
  }

  /** Reads one reply (all its lines); throws unless its code is `want`. */
  async reply(want: number): Promise<string[]> {
    const out: string[] = [];
    for (;;) {
      const line = await this.nextLine();
      out.push(line);
      if (/^\d{3}( |$)/.test(line)) break;
      if (!/^\d{3}-/.test(line)) throw new Error("smtp: malformed reply");
    }
    const code = Number(out.at(-1)?.slice(0, 3));
    // Only the code goes into the error: a reply can echo an address.
    if (code !== want) throw new Error(`smtp: expected ${want}, got ${code}`);
    return out;
  }

  send(line: string) {
    this.socket.write(`${line}\r\n`);
  }

  async starttls(servername: string, ca: string | null) {
    const plain = this.socket;
    plain.removeAllListeners("data");
    plain.removeAllListeners("close");
    plain.removeAllListeners("error");
    const secure = tlsConnect({ socket: plain as Socket, servername, ...(ca ? { ca } : {}) });
    await new Promise<void>((resolve, reject) => {
      secure.once("secureConnect", () => resolve());
      secure.once("error", reject);
    });
    this.socket = secure;
    this.buf = "";
    this.attach(secure);
  }

  close() {
    this.socket.end();
  }

  destroy(err: Error) {
    this.socket.destroy(err);
  }
}

const header = (v: string) =>
  /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;

export interface SmtpLimits {
  /** Opening the connection (and implicit TLS): the OS would wait about two minutes. */
  connectTimeoutMs?: number;
  /** Silence from the relay once connected. */
  idleTimeoutMs?: number;
  /** Aborting destroys the connection wherever the conversation is. */
  signal?: AbortSignal;
}

export async function smtpSend(
  s: MailSettings,
  msg: { subject: string; text: string; date: number; id: string },
  limits: SmtpLimits = {},
): Promise<void> {
  const { connectTimeoutMs = 10_000, idleTimeoutMs = 20_000, signal } = limits;
  signal?.throwIfAborted();
  let kill: (err: Error) => void = () => undefined;
  const onAbort = () => kill(new Error("smtp: delivery budget spent"));
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const socket = await new Promise<Socket | TLSSocket>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const connected = () => {
        clearTimeout(timer);
        resolve(sock);
      };
      const sock = s.secure
        ? tlsConnect({ host: s.host, port: s.port, servername: s.host, ...(s.ca ? { ca: s.ca } : {}) }, connected)
        : netConnect({ host: s.host, port: s.port }, connected);
      kill = (err) => sock.destroy(err);
      timer = setTimeout(() => sock.destroy(new Error("smtp: connect timed out")), connectTimeoutMs);
      sock.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    socket.setTimeout(idleTimeoutMs, () => socket.destroy(new Error("smtp: timed out")));
    const smtp = new SmtpSession(socket);
    kill = (err) => smtp.destroy(err);
    await converse(smtp, s, msg);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

async function converse(
  smtp: SmtpSession,
  s: MailSettings,
  msg: { subject: string; text: string; date: number; id: string },
): Promise<void> {
  try {
    await smtp.reply(220);
    smtp.send(`EHLO ${s.helo}`);
    let caps = await smtp.reply(250);
    if (!s.secure) {
      if (caps.some((l) => /^250[- ]STARTTLS\b/i.test(l))) {
        smtp.send("STARTTLS");
        await smtp.reply(220);
        await smtp.starttls(s.host, s.ca);
        smtp.send(`EHLO ${s.helo}`);
        caps = await smtp.reply(250);
      } else if (s.user) {
        // Never send a password in the clear.
        throw new Error("smtp: the relay offers no STARTTLS and a user is set");
      }
    }
    if (s.user) {
      smtp.send(`AUTH PLAIN ${Buffer.from(`\0${s.user}\0${s.password ?? ""}`, "utf8").toString("base64")}`);
      await smtp.reply(235);
    }
    smtp.send(`MAIL FROM:<${s.from.replace(/^.*<|>.*$/g, "")}>`);
    await smtp.reply(250);
    for (const to of s.to) {
      smtp.send(`RCPT TO:<${to}>`);
      await smtp.reply(250);
    }
    smtp.send("DATA");
    await smtp.reply(354);
    const body = [
      `From: ${s.from}`,
      `To: ${s.to.join(", ")}`,
      `Subject: ${header(msg.subject)}`,
      `Date: ${new Date(msg.date * 1000).toUTCString()}`,
      `Message-ID: <${msg.id}>`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "Auto-Submitted: auto-generated",
      "",
      ...msg.text
        .replace(/\r?\n/g, "\r\n")
        .split("\r\n")
        .map((l) => (l.startsWith(".") ? `.${l}` : l)),
    ].join("\r\n");
    smtp.send(`${body}\r\n.`);
    await smtp.reply(250);
    smtp.send("QUIT");
    await smtp.reply(221).catch(() => undefined);
  } finally {
    smtp.close();
  }
}

export const defaultTransport: Transport = {
  mail: (settings, msg, signal) => smtpSend(settings, msg, { signal }),
  async webhook(url, body, signal) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    await res.body?.cancel();
    if (!res.ok) throw new Error(`webhook: HTTP ${res.status}`);
  },
};

// ---------------------------------------------------------------- history

export const dayOf = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);
const dayStart = (day: string) => Date.parse(`${day}T00:00:00Z`) / 1000;
/** The 90 UTC dates ending today (Prometheus's today), oldest first. */
export const last90 = (now: number) =>
  Array.from({ length: 90 }, (_, i) => dayOf(dayStart(dayOf(now)) - (89 - i) * 86_400));

function byComponent(a: PromAnswer, expr: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of resultOf(a, "vector", expr) as PromSeries[])
    if (s.metric.component && s.value) out[s.metric.component] = Number(s.value[1]);
  return out;
}

/**
 * Fills the finished days the history lacks (within Prometheus's retention, two minutes after
 * the day ends so its last samples are in) and returns today's figures so far.
 */
export async function updateHistory(
  prom: PromQuery,
  cfg: StatusConfig,
  days: Persisted["days"],
  now: number,
  maxQueries = 40,
): Promise<{ days: Persisted["days"]; today: Record<string, number> }> {
  const out: Persisted["days"] = {};
  const window = last90(now);
  for (const d of window) if (days[d]) out[d] = days[d];
  const today = dayOf(now);
  let asked = 0;
  for (const d of window) {
    if (d === today || out[d] || asked >= maxQueries) continue;
    const end = dayStart(d) + 86_400;
    if (end < now - cfg.retentionDays * 86_400 || now < end + 120) continue;
    const q = DAY_QUERY(86_400);
    const got = byComponent(await prom(q, end), q);
    asked++;
    out[d] = Object.fromEntries(probes(cfg).map((c) => [c.id, got[c.id] ?? null]));
  }
  const elapsed = now - dayStart(today);
  const q = DAY_QUERY(Math.max(elapsed, 1));
  return { days: out, today: elapsed >= 60 ? byComponent(await prom(q, now), q) : {} };
}

// ---------------------------------------------------------------- notes

export type NoteStatus = "investigating" | "identified" | "monitoring" | "resolved" | "maintenance";
const NOTE_STATUSES: readonly NoteStatus[] = ["investigating", "identified", "monitoring", "resolved", "maintenance"];

export interface Note {
  file: string;
  title: string;
  /** Unix seconds. */
  date: number;
  status: NoteStatus;
  components: string[];
  body: string;
}

/** A note: front matter (title, date, status, components) between `---` lines, then markdown. */
export function parseNote(file: string, text: string): Note | string {
  const m = /^(?:\s*<!--[\s\S]*?-->\s*)?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return `${file}: no front matter`;
  const meta: Record<string, string> = {};
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const kv = /^([a-z]+):\s*(.*?)\s*$/.exec(line);
    if (kv) meta[kv[1] as string] = (kv[2] ?? "").replace(/^(["'])(.*)\1$/, "$2");
  }
  if (!meta.title) return `${file}: no title`;
  const date = Date.parse(meta.date ?? "");
  if (!Number.isFinite(date) || !/(Z|[+-]\d\d:?\d\d)$/.test(meta.date ?? ""))
    return `${file}: date is not ISO 8601 with an offset`;
  const status = (meta.status ?? "investigating") as NoteStatus;
  if (!NOTE_STATUSES.includes(status)) return `${file}: status must be one of ${NOTE_STATUSES.join(", ")}`;
  return {
    file,
    title: meta.title,
    date: Math.floor(date / 1000),
    status,
    components: (meta.components ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    body: (m[2] ?? "").trim(),
  };
}

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

function inline(s: string): string {
  // Code spans first, so their content is never formatted.
  return s
    .split(/(`[^`]+`)/)
    .map((part) =>
      part.startsWith("`") && part.endsWith("`") && part.length > 1
        ? `<code>${escapeHtml(part.slice(1, -1))}</code>`
        : escapeHtml(part)
            // A link keeps its text only: the page never points anywhere else.
            .replace(/\[([^\]]+)\]\([^)\s]*\)/g, "$1")
            .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
            .replace(/(^|[\s(])[*_]([^*_]+)[*_](?=$|[\s).,;:!?])/g, "$1<em>$2</em>"),
    )
    .join("");
}

/** The small markdown subset notes use: headings, paragraphs, lists, code, bold, italics. */
export function renderMarkdown(md: string): string {
  const out: string[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    if (list.length) out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join("")}</ul>`);
    para = [];
    list = [];
  };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    const item = /^[-*]\s+(.*)$/.exec(line);
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (line === "") flush();
    else if (heading) {
      flush();
      out.push(`<h4>${inline(heading[1] ?? "")}</h4>`);
    } else if (item) {
      if (para.length) flush();
      list.push(item[1] ?? "");
    } else {
      if (list.length) flush();
      para.push(line);
    }
  }
  flush();
  return out.join("\n");
}

export function readNotes(dir: string, log: Log): Note[] {
  if (!existsSync(dir)) return [];
  const notes: Note[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".md")) continue;
    const n = parseNote(f, readFileSync(join(dir, f), "utf8"));
    if (typeof n === "string") log("warn", "note skipped", { why: n });
    else notes.push(n);
  }
  return notes;
}

// ---------------------------------------------------------------- the page

export interface PageComponent {
  id: string;
  name: string;
  state: State;
  shown: Shown;
  since: number | null;
  /** Oldest first; null is a day with no data; absent for a certificate. */
  days: { date: string; availability: number | null }[] | null;
  availability: number | null;
}
export interface PageModel {
  siteName: string;
  statusDomain: string;
  now: number;
  overall: Shown;
  maintenance: { active: boolean; note: string };
  blind: { active: boolean; since: number | null };
  components: PageComponent[];
  incidents: { open: Note[]; past: Note[] };
}

export function pageModel(
  cfg: StatusConfig,
  now: number,
  states: Record<string, State>,
  records: Record<string, ComponentRecord>,
  days: Persisted["days"],
  today: Record<string, number>,
  notes: Note[],
  maintenance: string | null,
  blind: { active: boolean; since: number | null },
): PageModel {
  const window = last90(now);
  const todayKey = dayOf(now);
  const components = cfg.components.map((c): PageComponent => {
    const state = states[c.id] ?? "unknown";
    const shown: Shown = maintenance !== null && state !== "up" ? "maintenance" : state;
    if (c.kind === "cert")
      return {
        id: c.id,
        name: c.name,
        state,
        shown,
        since: records[c.id]?.since ?? null,
        days: null,
        availability: null,
      };
    const series = window.map((d) => ({
      date: d,
      availability: d === todayKey ? (today[c.id] ?? null) : (days[d]?.[c.id] ?? null),
    }));
    const known = series.map((d) => d.availability).filter((v): v is number => v !== null);
    return {
      id: c.id,
      name: c.name,
      state,
      shown,
      since: records[c.id]?.since ?? null,
      days: series,
      availability: known.length ? known.reduce((a, b) => a + b, 0) / known.length : null,
    };
  });
  const shownStates = components.map((c) => c.shown);
  const overall: Shown =
    maintenance !== null
      ? "maintenance"
      : shownStates.includes("down")
        ? "down"
        : shownStates.includes("degraded")
          ? "degraded"
          : shownStates.includes("unknown")
            ? "unknown"
            : "up";
  const cutoff = now - 90 * 86_400;
  return {
    siteName: cfg.siteName,
    statusDomain: cfg.statusDomain,
    now,
    overall,
    maintenance: { active: maintenance !== null, note: maintenance ?? "" },
    blind,
    components,
    incidents: {
      open: notes.filter((n) => n.status !== "resolved").sort((a, b) => b.date - a.date),
      past: notes.filter((n) => n.status === "resolved" && n.date >= cutoff).sort((a, b) => b.date - a.date),
    },
  };
}

/** Never rounds up: 99.996% shows as 99.99%, and only a full day of successes is 100%. */
export function percent(v: number): string {
  if (v >= 1) return "100%";
  return `${(Math.floor(Math.max(0, v) * 10_000) / 100).toFixed(2)}%`;
}

/**
 * Every string the page shows, per locale (en and es, as the web app's catalog). The page runs
 * no script and cloud-init copies this file alone, so the table lives here, not in apps/web.
 * Notes and maintenance text are the operator's own words and are shown as written.
 */
export interface PageText {
  state: Record<Shown, string>;
  overall: Record<Shown, string>;
  note: Record<NoteStatus, string>;
  component: Record<"web" | "api" | "chat" | "video" | "ingest" | "certificate", string>;
  title: (site: string) => string;
  checked: (seconds: number, updated: string) => string;
  since: string;
  noData90: string;
  available90: (percent: string) => string;
  noDataDay: string;
  dailyFor: (name: string) => string;
  dayUtc: string;
  available: string;
  maintenance: string;
  maintenanceDefault: string;
  blind: (at: string | null) => string;
  blindAfter: string;
  stale: (updated: string) => string;
  staleAfter: string;
  currentIncidents: string;
  components: string;
  pastIncidents: string;
  noIncidents: string;
  machineReadable: string;
  footer: string;
}

export const TEXT: Record<Locale, PageText> = {
  en: {
    state: { up: "Operational", degraded: "Degraded", down: "Down", unknown: "No data", maintenance: "Maintenance" },
    overall: {
      up: "All systems operational",
      degraded: "Some systems are degraded",
      down: "Some systems are down",
      unknown: "Some systems have no recent data",
      maintenance: "Planned maintenance in progress",
    },
    note: {
      investigating: "Investigating",
      identified: "Identified",
      monitoring: "Monitoring",
      resolved: "Resolved",
      maintenance: "Maintenance",
    },
    component: {
      web: "Website",
      api: "API and database",
      chat: "Chat",
      video: "Video playback",
      ingest: "Stream ingest (RTMP)",
      certificate: "TLS certificate",
    },
    title: (site) => `${site} status`,
    checked: (seconds, updated) => `Checked from outside, every ${seconds} seconds. Updated ${updated}.`,
    since: "Since",
    noData90: "No data in the last 90 days",
    available90: (p) => `${p} available over the last 90 days`,
    noDataDay: "no data",
    dailyFor: (name) => `Daily figures for ${name}`,
    dayUtc: "Day (UTC)",
    available: "Available",
    maintenance: "Planned maintenance.",
    maintenanceDefault: "The service may be briefly unavailable.",
    blind: (at) => `The status monitor lost its own network${at ? ` at ${at}` : ""}.`,
    blindAfter: "The states below are from before then.",
    stale: (updated) => `This page has not been updated since ${updated}.`,
    staleAfter: "The status monitor cannot read its own probe results; the states below are from then.",
    currentIncidents: "Current incidents",
    components: "Components",
    pastIncidents: "Past incidents",
    noIncidents: "No incidents in the last 90 days.",
    machineReadable: "Machine-readable:",
    footer:
      "Times are UTC. Availability is the share of successful probes each day, not counting time the monitor itself was offline.",
  },
  es: {
    state: {
      up: "Operativo",
      degraded: "Degradado",
      down: "Caído",
      unknown: "Sin datos",
      maintenance: "Mantenimiento",
    },
    overall: {
      up: "Todos los sistemas funcionan",
      degraded: "Algunos sistemas están degradados",
      down: "Algunos sistemas están caídos",
      unknown: "Algunos sistemas no tienen datos recientes",
      maintenance: "Mantenimiento programado en curso",
    },
    note: {
      investigating: "Investigando",
      identified: "Identificado",
      monitoring: "En observación",
      resolved: "Resuelto",
      maintenance: "Mantenimiento",
    },
    component: {
      web: "Sitio web",
      api: "API y base de datos",
      chat: "Chat",
      video: "Reproducción de vídeo",
      ingest: "Ingesta de emisiones (RTMP)",
      certificate: "Certificado TLS",
    },
    title: (site) => `Estado de ${site}`,
    checked: (seconds, updated) => `Comprobado desde fuera, cada ${seconds} segundos. Actualizado: ${updated}.`,
    since: "Desde",
    noData90: "Sin datos en los últimos 90 días",
    available90: (p) => `${p} de disponibilidad en los últimos 90 días`,
    noDataDay: "sin datos",
    dailyFor: (name) => `Cifras diarias de ${name}`,
    dayUtc: "Día (UTC)",
    available: "Disponible",
    maintenance: "Mantenimiento programado.",
    maintenanceDefault: "Puede que el servicio no esté disponible durante un momento.",
    blind: (at) => `El monitor de estado perdió su propia red${at ? ` (${at})` : ""}.`,
    blindAfter: "Los estados de abajo son de antes de ese momento.",
    stale: (updated) => `Esta página no se actualiza desde ${updated}.`,
    staleAfter: "El monitor de estado no puede leer sus propias comprobaciones; los estados de abajo son de entonces.",
    currentIncidents: "Incidentes en curso",
    components: "Componentes",
    pastIncidents: "Incidentes anteriores",
    noIncidents: "Ningún incidente en los últimos 90 días.",
    machineReadable: "Legible por máquina:",
    footer:
      "Las horas están en UTC. La disponibilidad es la proporción de comprobaciones correctas de cada día, sin contar el tiempo en que el propio monitor estuvo sin conexión.",
  },
};

/** The stale banner's slot in index.html, filled by a run that cannot read Prometheus. */
const STALE_SLOT = /<!--stale-->[\s\S]*?<!--\/stale-->/;
export const staleBanner = (t: PageText, updatedAt: number) =>
  `<!--stale--><div class="banner s-unknown"><p><strong>${t.stale(iso(updatedAt))}</strong> ${t.staleAfter}</p></div><!--/stale-->`;

const dayClass = (v: number | null) => (v === null ? "none" : v >= 0.999 ? "ok" : v >= 0.99 ? "minor" : "major");

// Colours as custom properties, dark and light by prefers-color-scheme; text carries every
// state, so the page reads the same with no CSS or no colour.
const CSS = `
:root{color-scheme:light dark;--bg:#fafafa;--fg:#18181b;--muted:#52525b;--line:#d4d4d8;--card:#fff;--ok:#15803d;--minor:#b45309;--major:#b91c1c;--none:#d4d4d8;--info:#1d4ed8}
@media (prefers-color-scheme:dark){:root{--bg:#09090b;--fg:#fafafa;--muted:#a1a1aa;--line:#3f3f46;--card:#18181b;--ok:#4ade80;--minor:#fbbf24;--major:#f87171;--none:#3f3f46;--info:#93c5fd}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-inline-size:48rem;margin-inline:auto;padding:1.5rem 1rem 3rem}
h1{font-size:1.5rem;margin:0 0 .5rem}
h2{font-size:1.125rem;margin:2rem 0 .75rem}
h3{font-size:1rem;margin:0}
.muted{color:var(--muted);font-size:.875rem}
.banner{border:1px solid var(--line);border-inline-start:.375rem solid var(--info);background:var(--card);padding:.75rem 1rem;border-radius:.375rem;margin:1rem 0}
.banner.s-up{border-inline-start-color:var(--ok)}.banner.s-degraded,.banner.s-unknown{border-inline-start-color:var(--minor)}.banner.s-down{border-inline-start-color:var(--major)}
.banner p{margin:0}
ul.components{list-style:none;margin:0;padding:0}
ul.components>li{background:var(--card);border:1px solid var(--line);border-radius:.375rem;padding:.75rem 1rem;margin-block-end:.75rem}
.row{display:flex;flex-wrap:wrap;justify-content:space-between;gap:.25rem .75rem;align-items:baseline}
.state{font-weight:600;font-size:.875rem}
.state.s-up{color:var(--ok)}.state.s-degraded,.state.s-unknown{color:var(--minor)}.state.s-down{color:var(--major)}.state.s-maintenance{color:var(--info)}
.bars{display:flex;gap:1px;block-size:1.75rem;margin-block:.5rem .25rem}
.bars span{flex:1 1 0;min-inline-size:0;border-radius:1px;background:var(--none)}
.bars .ok{background:var(--ok)}.bars .minor{background:var(--minor)}.bars .major{background:var(--major)}
details{margin-block-start:.25rem;font-size:.875rem}
summary{cursor:pointer;color:var(--muted)}
summary:focus-visible{outline:2px solid var(--info);outline-offset:2px}
table{border-collapse:collapse;margin-block-start:.5rem}
td,th{padding:.125rem .75rem .125rem 0;text-align:start;font-variant-numeric:tabular-nums}
article{background:var(--card);border:1px solid var(--line);border-radius:.375rem;padding:.75rem 1rem;margin-block-end:.75rem}
article h4{font-size:.9375rem;margin:.75rem 0 .25rem}
article p,article ul{margin:.5rem 0}
code{font-size:.875em}
footer{margin-block-start:2rem}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`
  .trim()
  .replace(/\n/g, "");

function noteHtml(n: Note, cfg: StatusConfig): string {
  const t = TEXT[cfg.locale];
  const names = n.components.map((id) => cfg.components.find((c) => c.id === id)?.name ?? id);
  return [
    `<article>`,
    `<h3>${escapeHtml(n.title)}</h3>`,
    `<p class="muted">${t.note[n.status]} · <time datetime="${new Date(n.date * 1000).toISOString()}">${iso(n.date)}</time>${
      names.length ? ` · ${escapeHtml(names.join(", "))}` : ""
    }</p>`,
    renderMarkdown(n.body),
    `</article>`,
  ].join("\n");
}

export function renderHtml(p: PageModel, cfg: StatusConfig): string {
  const t = TEXT[cfg.locale];
  const title = t.title(p.siteName);
  const comp = (c: PageComponent) => {
    const head = `<div class="row"><h3>${escapeHtml(c.name)}</h3><span class="state s-${c.shown}">${t.state[c.shown]}</span></div>`;
    const since =
      c.since !== null && c.state !== "up"
        ? `<p class="muted">${t.since} <time datetime="${new Date(c.since * 1000).toISOString()}">${iso(c.since)}</time></p>`
        : "";
    if (!c.days) return `<li>${head}${since}</li>`;
    const bars = `<div class="bars" aria-hidden="true">${c.days.map((d) => `<span class="${dayClass(d.availability)}"></span>`).join("")}</div>`;
    const avail = `<p class="muted">${c.availability === null ? t.noData90 : t.available90(percent(c.availability))}</p>`;
    const rows = [...c.days]
      .reverse()
      .map(
        (d) => `<tr><td>${d.date}</td><td>${d.availability === null ? t.noDataDay : percent(d.availability)}</td></tr>`,
      )
      .join("");
    const table = `<details><summary>${escapeHtml(t.dailyFor(c.name))}</summary><table><thead><tr><th scope="col">${t.dayUtc}</th><th scope="col">${t.available}</th></tr></thead><tbody>${rows}</tbody></table></details>`;
    return `<li>${head}${since}${bars}${avail}${table}</li>`;
  };
  const banners = [
    "<!--stale--><!--/stale-->",
    `<div class="banner s-${p.overall}"><p><strong>${t.overall[p.overall]}</strong></p></div>`,
    p.maintenance.active
      ? `<div class="banner s-maintenance"><p><strong>${t.maintenance}</strong> ${escapeHtml(p.maintenance.note) || t.maintenanceDefault}</p></div>`
      : "",
    p.blind.active
      ? `<div class="banner s-unknown"><p><strong>${t.blind(p.blind.since !== null ? iso(p.blind.since) : null)}</strong> ${t.blindAfter}</p></div>`
      : "",
  ].join("");
  return `<!doctype html>
<html lang="${cfg.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="refresh" content="60">
<meta name="robots" content="noarchive">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
<header>
<h1>${escapeHtml(title)}</h1>
<p class="muted">${t.checked(cfg.probeIntervalSeconds, `<time datetime="${new Date(p.now * 1000).toISOString()}">${iso(p.now)}</time>`)}</p>
</header>
<main>
${banners}
${
  p.incidents.open.length
    ? `<section aria-labelledby="open"><h2 id="open">${t.currentIncidents}</h2>\n${p.incidents.open.map((n) => noteHtml(n, cfg)).join("\n")}</section>`
    : ""
}
<section aria-labelledby="components"><h2 id="components">${t.components}</h2>
<ul class="components">
${p.components.map(comp).join("\n")}
</ul>
</section>
<section aria-labelledby="past"><h2 id="past">${t.pastIncidents}</h2>
${p.incidents.past.length ? p.incidents.past.map((n) => noteHtml(n, cfg)).join("\n") : `<p class="muted">${t.noIncidents}</p>`}
</section>
</main>
<footer><p class="muted">${t.machineReadable} <a href="status.json">status.json</a>. ${t.footer}</p></footer>
</div>
</body>
</html>
`;
}

export function renderJson(p: PageModel): string {
  return `${JSON.stringify(
    {
      site: p.siteName,
      updatedAt: new Date(p.now * 1000).toISOString(),
      // True while the monitor cannot read its probes (runFailed): every state below is old.
      stale: false,
      overall: p.overall,
      maintenance: p.maintenance,
      monitorOffline: p.blind.active,
      components: p.components.map((c) => ({
        id: c.id,
        name: c.name,
        state: c.shown,
        observed: c.state,
        since: c.since === null ? null : new Date(c.since * 1000).toISOString(),
        availability90d: c.availability,
        days: c.days,
      })),
      incidents: [...p.incidents.open, ...p.incidents.past].map((n) => ({
        title: n.title,
        date: new Date(n.date * 1000).toISOString(),
        status: n.status,
        components: n.components,
        body: n.body,
      })),
    },
    null,
    2,
  )}\n`;
}

// ---------------------------------------------------------------- one run

export type Log = (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;
export const jsonLog: Log = (level, msg, fields) =>
  void process.stdout.write(`${JSON.stringify({ level, msg, service: "status-render", ...fields })}\n`);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function writeAtomic(path: string, text: string) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o644 });
  renameSync(tmp, path);
}

export interface RunDeps {
  cfg: StatusConfig;
  prom: PromQuery;
  /** /data: site/, state/, targets/, notes/ and the maintenance file. */
  dataDir: string;
  alertEnv: Record<string, string | undefined>;
  transport: Transport;
  log: Log;
  /** DELIVERY_BUDGET_MS unless a test shortens it. */
  deliveryBudgetMs?: number;
}

export interface RunResult {
  now: number;
  judgement: Judgement;
  plan: AlertPlan;
  delivered: Set<string>;
  model: PageModel;
}

function readState(path: string, log: Log): Persisted {
  if (!existsSync(path)) return emptyState();
  try {
    const p = JSON.parse(readFileSync(path, "utf8")) as Persisted;
    if (p.version === 1) return { ...emptyState(), ...p };
  } catch (err) {
    log("warn", "state unreadable, starting fresh", { err: errText(err) });
  }
  return emptyState();
}

function readMaintenance(dataDir: string): string | null {
  const path = join(dataDir, "maintenance");
  return existsSync(path) ? readFileSync(path, "utf8").trim().slice(0, 500) : null;
}

function alertRoute(d: RunDeps): Route {
  const route = routeFrom(d.alertEnv, d.cfg);
  if (!route.mail && !route.webhook)
    d.log("error", "NO ALERT ROUTE: outages will not reach anyone (docs/operators/status-page.md#the-alert-route)", {
      problems: route.problems,
    });
  else if (route.problems.length) d.log("warn", "alert route incomplete", { problems: route.problems });
  return route;
}

/**
 * Saves the state before delivering (the base records, so an interrupted run retries every
 * intent), then again as each intent lands, so a run killed mid-delivery never resends what
 * was already accepted.
 */
async function deliverAndSave(
  d: RunDeps,
  plan: AlertPlan,
  route: Route,
  save: (records: Record<string, ComponentRecord>) => void,
): Promise<Set<string>> {
  save(plan.records);
  if (!plan.intents.length) return new Set();
  const landed = new Set<string>();
  return deliver(d.cfg, plan, route, d.transport, d.log, {
    budgetMs: d.deliveryBudgetMs,
    onDelivered: (id) => {
      landed.add(id);
      save(applyDelivered(plan, landed));
    },
  });
}

export async function runOnce(d: RunDeps): Promise<RunResult> {
  const { cfg, dataDir, log } = d;
  for (const sub of ["site", "state", "targets"]) mkdirSync(join(dataDir, sub), { recursive: true });
  // Targets first: Prometheus picks them up even if the rest of this run fails.
  writeAtomic(join(dataDir, "targets", "status.json"), `${JSON.stringify(probeTargets(cfg), null, 2)}\n`);

  const statePath = join(dataDir, "state", "state.json");
  const prev = readState(statePath, log);
  const route = alertRoute(d);

  const obs = await observe(d.prom, cfg);
  const judgement = judge(cfg, obs, prev);
  const maintenance = readMaintenance(dataDir);
  const plan = planAlerts(cfg, prev.components, judgement, obs.now, { maintenance: maintenance !== null });
  if (judgement.blind) log("warn", "monitoring is blind: every component and every canary failing", {});

  const history = await updateHistory(d.prom, cfg, prev.days, obs.now);
  const blindSince = judgement.blind ? (prev.blindSince ?? obs.now) : null;

  // The page before any delivery: a slow relay must never hold back what the public sees.
  // It reads only each record's state and since, which delivery does not change.
  const notes = readNotes(join(dataDir, "notes"), log);
  const model = pageModel(
    cfg,
    obs.now,
    judgement.states,
    plan.records,
    history.days,
    history.today,
    notes,
    maintenance,
    {
      active: judgement.blind,
      since: blindSince,
    },
  );
  writeAtomic(join(dataDir, "site", "index.html"), renderHtml(model, cfg));
  writeAtomic(join(dataDir, "site", "status.json"), renderJson(model));

  const save = (records: Record<string, ComponentRecord>) =>
    writeAtomic(
      statePath,
      `${JSON.stringify({ version: 1, components: records, days: history.days, blindSince } satisfies Persisted)}\n`,
    );
  const delivered = await deliverAndSave(d, plan, route, save);
  log("info", "rendered", { overall: model.overall, blind: judgement.blind, alerts: plan.intents.length });
  return { now: obs.now, judgement, plan, delivered, model };
}

export interface FailedRun {
  plan: AlertPlan;
  delivered: Set<string>;
  /** Whether a page was there to mark stale. */
  markedStale: boolean;
}

/**
 * A run that could not read Prometheus (crashed, disk full, bad config). The probes then report
 * nothing at all, so this is the "probes are not reporting" problem: mailed once it has lasted
 * PROBES_SETTLE_SECONDS, with its recovery sent by the first good run. `now` is this host's
 * clock (see the file comment). The last page stays up, marked stale.
 */
export async function runFailed(d: RunDeps, now: number): Promise<FailedRun> {
  const { cfg, dataDir, log } = d;
  mkdirSync(join(dataDir, "state"), { recursive: true });
  const statePath = join(dataDir, "state", "state.json");
  const prev = readState(statePath, log);
  const route = alertRoute(d);
  const states: Record<string, State> = Object.fromEntries(
    Object.entries(prev.components).map(([id, r]) => [id, r.state]),
  );
  states[PROBES_ID] = "down";
  const all = planAlerts(cfg, prev.components, { states, blind: false }, now, {
    maintenance: readMaintenance(dataDir) !== null,
  });
  const probesRecord = all.records[PROBES_ID] as ComponentRecord;
  // Only the probes' own alert: every other state is as old as the last good run.
  const plan: AlertPlan = {
    records: { ...prev.components, [PROBES_ID]: probesRecord },
    intents: all.intents.filter((i) => i.message.component === PROBES_ID),
  };

  const markedStale = markStale(dataDir, cfg);
  const save = (records: Record<string, ComponentRecord>) =>
    writeAtomic(statePath, `${JSON.stringify({ ...prev, components: records } satisfies Persisted)}\n`);
  const delivered = await deliverAndSave(d, plan, route, save);
  return { plan, delivered, markedStale };
}

/** Puts the stale banner on the last page and `stale: true` in its status.json. */
function markStale(dataDir: string, cfg: StatusConfig): boolean {
  const htmlPath = join(dataDir, "site", "index.html");
  const jsonPath = join(dataDir, "site", "status.json");
  if (!existsSync(htmlPath) || !existsSync(jsonPath)) return false;
  const json = JSON.parse(readFileSync(jsonPath, "utf8")) as { updatedAt: string; stale?: boolean };
  const updatedAt = Math.floor(Date.parse(json.updatedAt) / 1000);
  const html = readFileSync(htmlPath, "utf8");
  if (!STALE_SLOT.test(html)) return false;
  writeAtomic(htmlPath, html.replace(STALE_SLOT, staleBanner(TEXT[cfg.locale], updatedAt)));
  writeAtomic(jsonPath, `${JSON.stringify({ ...json, stale: true }, null, 2)}\n`);
  return true;
}

export async function main(env: Record<string, string | undefined>): Promise<number> {
  const configPath = env.STATUS_CONFIG ?? "/config/status.json";
  const alertPath = env.STATUS_ALERT_ENV ?? "/config/alert.env";
  let deps: RunDeps;
  try {
    const cfg = parseConfig(JSON.parse(readFileSync(configPath, "utf8")));
    const alertEnv = existsSync(alertPath) ? parseEnvFile(readFileSync(alertPath, "utf8")) : {};
    if (alertEnv.SMTP_CA_FILE) alertEnv.SMTP_CA_PEM = readFileSync(alertEnv.SMTP_CA_FILE, "utf8");
    deps = {
      cfg,
      prom: httpProm(env.STATUS_PROMETHEUS_URL ?? "http://prometheus:9090"),
      dataDir: env.STATUS_DATA ?? "/data",
      alertEnv,
      transport: defaultTransport,
      log: jsonLog,
    };
  } catch (err) {
    jsonLog("error", "render failed: unreadable config", { err: errText(err) });
    return 1;
  }
  try {
    await runOnce(deps);
    return 0;
  } catch (err) {
    // The timer tries again in a minute; meanwhile the page says it is stale, and a failure
    // that lasts is mailed as the probes not reporting.
    jsonLog("error", "render failed", { err: errText(err) });
    try {
      await runFailed(deps, Math.floor(Date.now() / 1000));
    } catch (err2) {
      jsonLog("error", "could not record the failed run", { err: errText(err2) });
    }
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.env));
