// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Self-host e2e checks for IRC's socket-activated ports (commonair-irc.socket and
 * commonair-ircs.socket): the gateway must see each client's own address, so its per-address
 * cap refuses one source at the cap and still admits another.
 *
 * The host image has no client that can pick its source address (bash's /dev/tcp cannot, and
 * neither ncat nor socat is installed), so the probe is a small Bun script run in the release's
 * own IRC image with `--network host`, where every 127.0.0.0/8 address is local. It connects
 * without registering and sends `PING`, which the gateway answers before registration (PONG)
 * and which never reaches the chat service; a refused connection gets `ERROR` instead.
 */

/** `inHost` from e2e.ts: a shell command in the host container. */
export type InHost = (
  script: string,
  opts?: { user?: boolean; env?: Record<string, string>; allowFail?: boolean },
) => string;
/** `expectThat` from e2e.ts: logs the check and throws when it fails. */
export type Expect = (ok: boolean, what: string) => void;

/** The gateway's defaults (`ircEnv` in @commonair/config); the e2e instance does not change them. */
export const IRC_DEFAULTS = { maxPerIp: 50, connectBurstPerIp: 20, connectPerSecondPerIp: 2 } as const;
/** Same as e2e.ts: selfhost.sh sets IRC_PUBLIC_HOST to the domain, and Caddy's CA signs it. */
export const IRC_E2E_DOMAIN = "selfhost.test";
const ROOT_CA =
  '"$(podman volume inspect commonair-caddy-data --format "{{.Mountpoint}}")/caddy/pki/authorities/local/root.crt"';
export const IRC_IMAGE = "localhost/commonair/irc:latest";
/** Sources on the host: `held` fills its cap, `other` and `tls` are different clients. */
export const IRC_SOURCES = { held: "127.0.0.2", other: "127.0.0.3", tls: "127.0.0.4" } as const;
/** The text of the per-address refusal (services/irc/src/admission.ts REFUSAL_TEXT). */
export const PER_IP_REFUSAL = "ERROR :Closing Link: Too many connections from your address";
/** Unregistered connections are dropped after this long (LIMITS.registrationTimeoutMs). */
export const REGISTRATION_TIMEOUT_MS = 30_000;

/**
 * Milliseconds to wait before each of `count` connections from one address so that none is
 * refused by the connect-rate bucket (`burst` at once, then `perSecond`): the first `burst - 2`
 * go at once, the rest at 1.25× the refill interval, which keeps a margin for timer slack.
 */
export function connectDelays(count: number, burst: number, perSecond: number): number[] {
  const free = Math.max(0, burst - 2);
  const gap = Math.ceil((1000 / perSecond) * 1.25);
  return Array.from({ length: count }, (_, i) => (i < free ? 0 : gap));
}

export interface ProbePlan {
  host: string;
  port: number;
  tlsPort: number;
  /** The CA certificate (PEM) and the name the TLS certificate is for. */
  tls: { ca: string; servername: string };
  sources: { held: string; other: string; tls: string };
  /** Delays before each held connection, and before each later one from `held`. */
  delays: number[];
  laterDelayMs: number;
  timeoutMs: number;
}

export interface ProbeResult {
  /** Held connections that got PONG. */
  held: number;
  /** First line each later connection got: PONG, an ERROR line, or `fail: …`. */
  overPlain: string;
  overTls: string;
  other: string;
  tls: string;
  tlsAuthorized: boolean;
  elapsedMs: number;
}

export function probePlan(over: Partial<ProbePlan> & { ca: string }): ProbePlan {
  const { ca, ...rest } = over;
  return {
    host: "127.0.0.1",
    port: 6667,
    tlsPort: 6697,
    tls: { ca, servername: IRC_E2E_DOMAIN },
    sources: { ...IRC_SOURCES },
    delays: connectDelays(IRC_DEFAULTS.maxPerIp, IRC_DEFAULTS.connectBurstPerIp, IRC_DEFAULTS.connectPerSecondPerIp),
    laterDelayMs: Math.ceil((1000 / IRC_DEFAULTS.connectPerSecondPerIp) * 1.25),
    timeoutMs: 5000,
    ...rest,
  };
}

/**
 * The probe, plain JavaScript for `bun -e`. Reads its ProbePlan from IRC_PROBE and prints one
 * ProbeResult as JSON. Every connection stays open until the end.
 */
export const PROBE_SCRIPT = String.raw`
const net = require("node:net");
const tls = require("node:tls");
const plan = JSON.parse(process.env.IRC_PROBE);
const started = Date.now();
const open = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function attempt(local, secure) {
  return new Promise((resolve) => {
    const port = secure ? plan.tlsPort : plan.port;
    // An IPv6 source (local tests on a host with only 127.0.0.1) reaches the dual-stack socket on ::1.
    const opts = { host: local.includes(":") ? "::1" : plan.host, port, localAddress: local };
    const s = secure
      ? tls.connect({ ...opts, ca: plan.tls.ca, servername: plan.tls.servername })
      : net.connect(opts);
    open.push(s);
    let buf = "";
    const done = (line) => { clearTimeout(timer); resolve({ line, authorized: secure ? s.authorized === true : null }); };
    const timer = setTimeout(() => done("fail: timeout"), plan.timeoutMs);
    s.once(secure ? "secureConnect" : "connect", () => s.write("PING :e2e\r\n"));
    s.on("data", (d) => {
      buf += d.toString("utf8");
      const line = buf.split("\r\n").find((l) => / PONG |^ERROR /.test(l));
      if (line !== undefined) done(line.startsWith("ERROR ") ? line : "PONG");
    });
    s.on("error", (e) => done("fail: " + (e.code || e.message)));
    s.on("close", () => done("fail: closed"));
  });
}
let held = 0;
for (const d of plan.delays) {
  if (d > 0) await sleep(d);
  if ((await attempt(plan.sources.held, false)).line === "PONG") held++;
}
await sleep(plan.laterDelayMs);
const overPlain = (await attempt(plan.sources.held, false)).line;
await sleep(plan.laterDelayMs);
const overTls = (await attempt(plan.sources.held, true)).line;
const other = (await attempt(plan.sources.other, false)).line;
const t = await attempt(plan.sources.tls, true);
console.log(JSON.stringify({ held, overPlain, overTls, other, tls: t.line, tlsAuthorized: t.authorized, elapsedMs: Date.now() - started }));
for (const s of open) s.destroy();
process.exit(0);
`;

/** The last JSON line of the probe's output, or null. */
export function parseProbe(output: string): ProbeResult | null {
  const line = output
    .trim()
    .split("\n")
    .reverse()
    .find((l) => l.trim().startsWith("{"));
  if (!line) return null;
  try {
    return JSON.parse(line) as ProbeResult;
  } catch {
    return null;
  }
}

/** The checks a probe result must pass, as [ok, what] in the order they are reported. */
export function judgeProbe(r: ProbeResult | null, plan: ProbePlan): [boolean, string][] {
  if (!r) return [[false, "the IRC probe printed a result"]];
  const { held, other, tls } = plan.sources;
  const n = plan.delays.length;
  return [
    [r.held === n, `${n} IRC connections from ${held} are admitted, the per-address cap (${r.held} answered PING)`],
    [r.overPlain === PER_IP_REFUSAL, `one more from ${held} on ${plan.port} is refused per address (${r.overPlain})`],
    [r.overTls === PER_IP_REFUSAL, `one more from ${held} on ${plan.tlsPort} (TLS) is refused too (${r.overTls})`],
    [r.other === "PONG", `${other} is a different IRC client and is admitted (${r.other})`],
    [
      r.tls === "PONG" && r.tlsAuthorized,
      `${tls} over TLS on ${plan.tlsPort} is admitted with a certificate for ${plan.tls.servername} from the internal CA (${r.tls}, authorized: ${r.tlsAuthorized})`,
    ],
    [
      r.elapsedMs < REGISTRATION_TIMEOUT_MS,
      `the probe finished (${r.elapsedMs} ms) before unregistered connections time out`,
    ],
  ];
}

/** The command that runs the probe in the IRC image, on the host's network (as the instance user). */
export function probeCommand(image = IRC_IMAGE): string {
  return `podman run --rm --network host -e IRC_PROBE -e IRC_PROBE_SCRIPT --entrypoint bun ${image} -e "$IRC_PROBE_SCRIPT"`;
}

/**
 * IRC sees each client's own address through its systemd sockets: run after the stack is
 * healthy (IRC included) and after `checkClientAddresses`, whose sources (127.0.0.2–4) only
 * spend the API's budget, not IRC's.
 */
export function checkIrcClientAddresses(inHost: InHost, expectThat: Expect): void {
  const ca = inHost(`cat ${ROOT_CA}`, { user: true });
  expectThat(ca.includes("BEGIN CERTIFICATE"), "the internal CA's root certificate is readable for the IRC probe");
  const plan = probePlan({ ca });
  const out = inHost(probeCommand(), {
    user: true,
    env: { IRC_PROBE: JSON.stringify(plan), IRC_PROBE_SCRIPT: PROBE_SCRIPT },
    allowFail: true,
  });
  for (const [ok, what] of judgeProbe(parseProbe(out), plan)) expectThat(ok, what);
}
