// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * coturn (P1-turn, ADR 0005 amendment 1 decision 2): the rendered configuration (STUN only by
 * default, the relay with its secret, range and quotas when switched on), the denied peer ranges
 * generated from the API's netrange.ts, and compose and Quadlet running the same thing.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { BlockList, isIPv4 } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterAll, describe, expect, test } from "vite-plus/test";
import { blockedList, deniedPeerLines, intToV6, withDeniedBlock } from "../coturn/denied-peers.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const values = (text: string, key: string) => [...text.matchAll(new RegExp(`^${key}=(.*)$`, "gm"))].map((m) => m[1]!);

const IMAGE =
  "docker.io/coturn/coturn:4.18.0-trixie@sha256:bbefd3e1fdfdc0d58770fe01b581fd8b00d9f3a5580d00acb77cf719a6bc78e3";
const BASE = join(ROOT, "infra/coturn/turnserver.conf");
const SCRIPT = join(ROOT, "infra/coturn/start.sh");
const SECRET = "Zm9vYmFyLWJhei0wMTIzNDU2Nzg5LWFiY2RlZg-_x";
const netrange = read("services/api/src/lib/netrange.ts");

const dir = mkdtempSync(join(tmpdir(), "coturn-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;

/** Runs start.sh --render-only with exactly this environment; the file it wrote, if any. */
function render(env: Record<string, string> = {}) {
  const out = join(dir, `t${n++}.conf`);
  const r = Bun.spawnSync(["/bin/sh", SCRIPT, "--render-only"], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", COTURN_BASE_CONF: BASE, COTURN_CONF: out, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  let conf = "";
  try {
    conf = readFileSync(out, "utf8");
  } catch {
    // nothing written
  }
  return { code: r.exitCode, err: r.stderr.toString(), conf, path: out };
}

/** Option lines (comments and blanks dropped), `name` or `name=value`. */
const options = (conf: string) =>
  conf
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
const names = (conf: string) => new Set(options(conf).map((l) => l.split("=")[0]));

const RELAY = { P2P_TURN_URLS: "turn:stream.example.org:3478?transport=udp", TURN_SHARED_SECRET: SECRET };

// Every option this configuration may use, checked against coturn 4.18.0's long_options
// (src/apps/relay/mainrelay.c). coturn only warns about an unknown option, so a typo would
// silently drop a setting: nothing outside this list may appear.
const KNOWN_OPTIONS = new Set([
  "denied-peer-ip",
  "external-ip",
  "fingerprint",
  "listening-port",
  "log-file",
  "max-bps",
  "max-port",
  "min-port",
  "no-cli",
  "no-multicast-peers",
  "no-stdout-log",
  "no-tcp",
  "no-tcp-relay",
  "no-tls",
  "pidfile",
  "realm",
  "simple-log",
  "stale-nonce",
  "static-auth-secret",
  "stun-only",
  "total-quota",
  "use-auth-secret",
  "user-quota",
]);

describe("the denied peer ranges", () => {
  const conf = read("infra/coturn/turnserver.conf");
  const v4 = blockedList(netrange, "BLOCKED_V4");
  const v6 = blockedList(netrange, "BLOCKED_V6");
  const lines = values(conf, "denied-peer-ip");

  test("are generated from netrange.ts and up to date (bun infra/coturn/denied-peers.ts)", () => {
    expect(v4.length).toBeGreaterThanOrEqual(15);
    expect(v6.length).toBeGreaterThanOrEqual(12);
    expect(withDeniedBlock(conf, deniedPeerLines(netrange))).toBe(conf);
    // IPv4, IPv6 and the IPv4-mapped form of each IPv4 range, nothing else.
    expect(lines).toHaveLength(v4.length * 2 + v6.length);
  });

  test("each IPv4 range covers exactly its CIDR, in plain and IPv4-mapped form", () => {
    for (const [i, cidr] of v4.entries()) {
      const [base = "", bits = ""] = cidr.split("/");
      const [start = "", end = ""] = lines[i]!.split("-");
      expect(start, cidr).toBe(base);
      expect(isIPv4(end), cidr).toBe(true);
      const size = 2 ** (32 - Number(bits));
      const num = (ip: string) => ip.split(".").reduce((a, o) => a * 256 + Number(o), 0);
      expect(num(end) - num(start) + 1, cidr).toBe(size);
      const subnet = new BlockList();
      subnet.addSubnet(base, Number(bits), "ipv4");
      expect(subnet.check(end, "ipv4"), cidr).toBe(true);
      expect(lines[v4.length + v6.length + i]).toBe(`::ffff:${start}-::ffff:${end}`);
    }
  });

  test("each IPv6 range starts at its prefix and ends inside it (node:net checks containment)", () => {
    for (const [i, cidr] of v6.entries()) {
      const [base = "", bits = ""] = cidr.split("/");
      const [start = "", end = ""] = lines[v4.length + i]!.split("-");
      const subnet = new BlockList();
      subnet.addSubnet(base, Number(bits), "ipv6");
      expect(subnet.check(start, "ipv6"), cidr).toBe(true);
      expect(subnet.check(end, "ipv6"), cidr).toBe(true);
      // The end is the last address: its host bits (at least the last group: every prefix is
      // /112 or shorter) are all ones.
      expect(Number(bits), cidr).toBeLessThanOrEqual(112);
      expect(end.split(":").at(-1), cidr).toBe("ffff");
    }
  });

  test("loopback, private space and the metadata address are refused, mapped forms too", () => {
    for (const r of [
      "127.0.0.0-127.255.255.255",
      "10.0.0.0-10.255.255.255",
      "169.254.0.0-169.254.255.255",
      "::ffff:127.0.0.0-::ffff:127.255.255.255",
      "::-::ffff:ffff",
      "fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      "64:ff9b::-64:ff9b::ffff:ffff",
    ])
      expect(lines).toContain(r);
  });

  test("IPv6 text is RFC 5952 (what coturn's inet_pton reads; the longest zero run compressed)", () => {
    expect(intToV6(0n)).toBe("::");
    expect(intToV6(1n)).toBe("::1");
    expect(intToV6(0x20010db8000000000000000000000001n)).toBe("2001:db8::1");
    expect(intToV6(0x00010000000100000000000000000000n)).toBe("1:0:1::");
    expect(intToV6(0xffffffffffffffffffffffffffffffffn)).toBe("ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff");
  });
});

describe("start.sh: relay off by default (STUN only)", () => {
  const r = render();

  test("renders, owner-only", () => {
    expect(r.code, r.err).toBe(0);
    expect(statSync(r.path).mode & 0o777).toBe(0o600);
  });

  test("answers STUN only: stun-only, and nothing a relay or credential needs", () => {
    const opts = names(r.conf);
    expect(opts.has("stun-only")).toBe(true);
    for (const o of ["use-auth-secret", "static-auth-secret", "min-port", "max-port", "user-quota", "lt-cred-mech"])
      expect(opts.has(o), o).toBe(false);
  });

  test("the fixed options: port, realm, fingerprint, no CLI, no TCP/TLS, no multicast peers, stale nonces", () => {
    const o = options(r.conf);
    for (const want of [
      "listening-port=3478",
      "realm=localhost",
      "fingerprint",
      "stale-nonce=600",
      "no-cli",
      "no-tcp",
      "no-tls",
      "no-tcp-relay",
      "no-multicast-peers",
    ])
      expect(o, want).toContain(want);
    expect(names(r.conf).has("external-ip")).toBe(false);
  });

  test("TLS 1.0/1.1, DTLS, the CLI, loopback peers and Prometheus are never switched on", () => {
    for (const o of ["tlsv1", "tlsv1_1", "dtls", "cli", "allow-loopback-peers", "allowed-peer-ip", "prometheus"])
      expect(names(r.conf).has(o), o).toBe(false);
  });

  test("no log, so no client address, username or peer reaches the journal or Loki", () => {
    const o = options(r.conf);
    expect(o).toEqual(expect.arrayContaining(["no-stdout-log", "simple-log", "log-file=/dev/null"]));
    for (const noisy of ["verbose", "Verbose", "log-binding", "syslog"])
      expect(names(r.conf).has(noisy), noisy).toBe(false);
  });

  test("every option is one coturn 4.18 knows", () => {
    expect([...names(r.conf)].filter((o) => !KNOWN_OPTIONS.has(o!))).toEqual([]);
  });

  test("commas and blanks alone in P2P_TURN_URLS are no relay (as the API parses the list)", () => {
    expect(names(render({ P2P_TURN_URLS: " , " }).conf).has("stun-only")).toBe(true);
  });
});

describe("start.sh: the relay switched on (P2P_TURN_URLS set)", () => {
  const r = render({ ...RELAY, PUBLIC_HOSTNAME: "stream.example.org", TURN_EXTERNAL_IP: "203.0.113.7" });

  test("TURN REST auth with the shared secret, the default range and the quotas", () => {
    expect(r.code, r.err).toBe(0);
    const o = options(r.conf);
    for (const want of [
      "use-auth-secret",
      `static-auth-secret=${SECRET}`,
      "min-port=49160",
      "max-port=49199",
      "user-quota=8",
      "total-quota=400",
      "max-bps=1250000",
      "realm=stream.example.org",
      "external-ip=203.0.113.7",
      "no-tcp-relay",
    ])
      expect(o, want).toContain(want);
    expect(names(r.conf).has("stun-only")).toBe(false);
    expect([...names(r.conf)].filter((x) => !KNOWN_OPTIONS.has(x!))).toEqual([]);
  });

  test("the operator's relay range", () => {
    const c = options(render({ ...RELAY, TURN_RELAY_PORT_MIN: "50000", TURN_RELAY_PORT_MAX: "50100" }).conf);
    expect(c).toContain("min-port=50000");
    expect(c).toContain("max-port=50100");
  });

  test("the private ranges stay denied with the relay on", () => {
    expect(values(r.conf, "denied-peer-ip").map((v) => `denied-peer-ip=${v}`)).toEqual(deniedPeerLines(netrange));
  });
});

describe("start.sh refuses what it cannot render safely (and writes nothing)", () => {
  test.each([
    ["the relay without a secret", { P2P_TURN_URLS: RELAY.P2P_TURN_URLS }, "needs TURN_SHARED_SECRET"],
    ["a short secret", { ...RELAY, TURN_SHARED_SECRET: "short" }, "needs TURN_SHARED_SECRET"],
    [
      "a secret with a newline (an extra option)",
      { ...RELAY, TURN_SHARED_SECRET: `${SECRET}\nallow-loopback-peers` },
      "may hold only",
    ],
    ["a port below 1024", { TURN_PORT: "80" }, "TURN_PORT"],
    ["a non-numeric port", { TURN_PORT: "3478\nverbose" }, "TURN_PORT"],
    ["a realm with a newline", { PUBLIC_HOSTNAME: "a.example\ncli" }, "PUBLIC_HOSTNAME"],
    ["an external address list", { TURN_EXTERNAL_IP: "203.0.113.7,2001:db8::1" }, "TURN_EXTERNAL_IP"],
    ["an external address with a newline", { TURN_EXTERNAL_IP: "203.0.113.7\nverbose" }, "TURN_EXTERNAL_IP"],
    ["a range upside down", { ...RELAY, TURN_RELAY_PORT_MIN: "50000", TURN_RELAY_PORT_MAX: "49999" }, "above"],
    ["the listening port inside the range", { ...RELAY, TURN_PORT: "49170" }, "inside the relay range"],
  ] as [string, Record<string, string>, string][])("%s", (_, env, message) => {
    const r = render(env);
    expect(r.code).toBe(1);
    expect(r.err).toContain(message);
    expect(r.conf).toBe("");
  });

  test("an error never echoes the secret", () => {
    const r = render({ ...RELAY, TURN_RELAY_PORT_MIN: "x" });
    expect(r.code).toBe(1);
    expect(r.err).not.toContain(SECRET);
  });
});

describe("no secret in git or the image", () => {
  test("the static file has no secret, and the script takes it only from the environment", () => {
    const conf = read("infra/coturn/turnserver.conf");
    expect(conf).not.toMatch(/^static-auth-secret|^use-auth-secret|^lt-cred-mech|^user=/m);
    expect(read("infra/coturn/start.sh")).toContain("static-auth-secret=%s");
    // The server process does not keep it in its environment.
    expect(read("infra/coturn/start.sh")).toContain("exec env -u TURN_SHARED_SECRET turnserver -c");
  });

  test("compose passes it from .env with no default", () => {
    const c = parse(read("compose.yaml"), { merge: true }) as {
      services: { coturn: { environment: Record<string, string> } };
    };
    expect(c.services.coturn.environment.TURN_SHARED_SECRET).toBe("${TURN_SHARED_SECRET:-}");
  });
});

describe("compose and Quadlet run the same coturn", () => {
  type Svc = {
    image: string;
    entrypoint: string[];
    ports: string[];
    volumes: string[];
    environment: Record<string, string>;
    healthcheck: { test: string[] };
    profiles?: string[];
  };
  const compose = parse(read("compose.yaml"), { merge: true }) as { services: Record<string, Svc> };
  const svc = compose.services.coturn!;
  const unit = read("infra/quadlet/commonair-coturn.container");
  const example = Object.fromEntries(
    read(".env.example")
      .split("\n")
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );

  test("the pinned image, licensed", () => {
    expect(svc.image).toBe(IMAGE);
    expect(values(unit, "Image")).toEqual([IMAGE]);
    const licenses = JSON.parse(read("infra/image-licenses.json")) as Record<string, { license: string; tag: string }>;
    expect(licenses["docker.io/coturn/coturn"]).toMatchObject({ license: "BSD-3-Clause", tag: "4.18.0-trixie" });
  });

  test("in the default profile, the same entrypoint, files and health check", () => {
    expect(svc.profiles).toBeUndefined();
    expect(svc.entrypoint).toEqual(["/bin/sh", "/etc/coturn/commonair/start.sh"]);
    expect([...values(unit, "Entrypoint"), ...values(unit, "Exec")]).toEqual(svc.entrypoint);
    const target = (v: string) => v.split(":")[1];
    expect(values(unit, "Volume").map(target)).toEqual(svc.volumes.map(target));
    expect(values(unit, "Volume").map((v) => v.split(":")[0]!.replace("%h/commonair/", "./"))).toEqual(
      svc.volumes.map((v) => v.split(":")[0]),
    );
    expect(values(unit, "HealthCmd")).toEqual([svc.healthcheck.test.join(" ")]);
  });

  test("the same port: 3478/udp in the container, TURN_PORT on the host (compose), 3478 in the unit", () => {
    expect(svc.environment.TURN_PORT).toBe("3478");
    expect(values(unit, "Environment")).toEqual(["TURN_PORT=3478"]);
    expect(svc.ports).toEqual(["${BIND_ADDRESS:-127.0.0.1}:${TURN_PORT:-3478}:3478/udp"]);
    expect(example.TURN_PORT).toBe("3478");
    // P2P_STUN_URLS points the players at it (selfhost.sh writes stun:<host>:3478).
    expect(example.P2P_STUN_URLS).toBe("stun:localhost:3478");
  });

  test("the relay range defaults agree with .env.example, and only the override publishes it", () => {
    expect(svc.environment.TURN_RELAY_PORT_MIN).toBe(`\${TURN_RELAY_PORT_MIN:-${example.TURN_RELAY_PORT_MIN}}`);
    expect(svc.environment.TURN_RELAY_PORT_MAX).toBe(`\${TURN_RELAY_PORT_MAX:-${example.TURN_RELAY_PORT_MAX}}`);
    const relay = parse(read("infra/coturn/compose.turn-relay.yaml")) as { services: { coturn: { ports: string[] } } };
    const range = "${TURN_RELAY_PORT_MIN:-49160}-${TURN_RELAY_PORT_MAX:-49199}";
    expect(relay.services.coturn.ports).toEqual([`\${BIND_ADDRESS:-127.0.0.1}:${range}:${range}/udp`]);
    expect([example.TURN_RELAY_PORT_MIN, example.TURN_RELAY_PORT_MAX]).toEqual(["49160", "49199"]);
  });

  test("the relay is off by default everywhere: P2P_TURN_URLS is empty in .env.example", () => {
    expect(example.P2P_TURN_URLS).toBe("");
    expect(svc.environment.P2P_TURN_URLS).toBe("${P2P_TURN_URLS:-}");
  });
});
