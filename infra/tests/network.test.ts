// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Network exposure of the production units (infra/README.md, "Ports and client addresses"):
 * the ports each unit publishes (an explicit allowlist), Caddy's and IRC's public ports as systemd
 * sockets so client addresses survive rootless Podman, whom the services believe X-Forwarded-For from,
 * and Valkey's password.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, test } from "vite-plus/test";

const ROOT = new URL("../../", import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const values = (text: string, key: string) => [...text.matchAll(new RegExp(`^${key}=(.*)$`, "gm"))].map((m) => m[1]!);
/** Lines that are not comments (`#` in units and the Caddyfile). */
const code = (text: string) =>
  text
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");

const QUADLET = join(ROOT, "infra/quadlet");
const units = Object.fromEntries(
  readdirSync(QUADLET)
    .filter((f) => f.endsWith(".container"))
    .map((f) => [f.replace(/^commonair-|\.container$/g, ""), readFileSync(join(QUADLET, f), "utf8")]),
);
const unit = (name: string) => units[name]!;
const network = read("infra/quadlet/commonair.network");
const socket = read("infra/systemd/commonair-caddy.socket");
const caddyfile = read("infra/caddy/Caddyfile");
const compose = parse(read("compose.yaml"), { merge: true }) as {
  services: Record<string, { environment?: Record<string, string>; command?: string[]; ports?: string[] }>;
};

/** IPv4 address → number. */
const v4 = (ip: string) => ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);
/** [first, last] address of a CIDR. */
function range(cidr: string): [number, number] {
  const [base, bits] = cidr.split("/");
  const size = 2 ** (32 - Number(bits));
  const start = Math.floor(v4(base!) / size) * size;
  return [start, start + size - 1];
}
const inRange = (ip: string, cidr: string) => {
  const [a, b] = range(cidr);
  return v4(ip) >= a && v4(ip) <= b;
};

describe("published ports: an explicit allowlist", () => {
  // Public: no host address, so Podman listens on IPv6 and IPv4 (IPv4 alone without IPv6).
  // Loopback: an operator procedure needs them (rclone's off-host copy, Grafana over SSH).
  const ALLOWED: Record<string, string[]> = {
    garage: ["127.0.0.1:3900:3900"],
    grafana: ["127.0.0.1:3030:3000"],
    mediamtx: ["1935:1935", "8189:8189/udp"],
  };

  test.each(Object.keys(units))("%s publishes exactly its allowlisted ports", (name) => {
    expect(values(unit(name), "PublishPort")).toEqual(ALLOWED[name] ?? []);
  });

  test("a public port binds no host address (dual-stack) and never 0.0.0.0 (IPv4 only)", () => {
    const ports = Object.entries(units).flatMap(([name, text]) => values(text, "PublishPort").map((p) => [name, p]));
    expect(ports.filter(([, p]) => !/^(127\.0\.0\.1:)?\d+:\d+(\/udp)?$/.test(p!))).toEqual([]);
  });

  test("nothing that holds data or has no login is reachable from the host", () => {
    for (const name of ["postgres", "valkey", "otel-collector", "prometheus", "loki", "tempo", "api", "web", "chat"])
      expect(values(unit(name), "PublishPort"), name).toEqual([]);
  });
});

describe("Caddy's public ports are systemd sockets (client addresses survive rootless Podman)", () => {
  const caddy = unit("caddy");

  test("the unit publishes nothing and serves the sockets systemd passes in", () => {
    expect(values(caddy, "PublishPort")).toEqual([]);
    expect(values(caddy, "Environment")).toContain("CADDY_LISTEN=systemd");
    expect(values(caddy, "Wants")).toContain("commonair-caddy.socket");
    expect(values(caddy, "After")).toContain("commonair-caddy.socket");
    // Still on the network, so it reaches the services by name.
    expect(values(caddy, "Network")).toEqual(["commonair.network"]);
  });

  test("the socket unit holds 80, 443 and 443/udp, in the fd order the Caddyfile binds", () => {
    const listens = [...code(socket).matchAll(/^(Listen\w+)=(.*)$/gm)].map((m) => `${m[1]}=${m[2]}`);
    expect(listens).toEqual(["ListenStream=80", "ListenStream=443", "ListenDatagram=443"]);
    // A bare port: IPv6 and IPv4 where the host has IPv6, IPv4 where it does not.
    expect(values(socket, "BindIPv6Only")).toEqual(["both"]);
    expect(values(socket, "WantedBy")).toEqual(["sockets.target"]);
    // systemd passes them from fd 3 on, in that order.
    const snippet = (name: string) => {
      const at = caddyfile.indexOf(`(${name}) {`);
      return caddyfile.slice(at, caddyfile.indexOf("\n}", at));
    };
    expect(snippet("http-systemd")).toMatch(/bind fd\/3 \{\s+protocols h1\s+\}/);
    expect(snippet("listen-systemd")).toMatch(/bind fd\/4 \{\s+protocols h1 h2\s+\}/);
    expect(snippet("listen-systemd")).toMatch(/bind fdgram\/5 \{\s+protocols h3\s+\}/);
    expect(snippet("listen-ports")).not.toContain("bind");
    expect(snippet("http-ports")).not.toContain("bind");
  });

  test("the Caddyfile picks its listeners from CADDY_LISTEN, ports when unset (compose)", () => {
    expect(caddyfile).toContain("\nimport http-{$CADDY_LISTEN:ports}\n");
    expect(caddyfile).toContain("\timport listen-{$CADDY_LISTEN:ports}\n");
    expect(compose.services.caddy?.environment?.CADDY_LISTEN).toBeUndefined();
    expect(compose.services.caddy?.ports?.length).toBe(3);
  });

  test("Caddy believes no client's X-Forwarded-For", () => {
    expect(code(caddyfile)).not.toMatch(/trusted_proxies|client_ip_headers/);
  });
});

describe("the services believe X-Forwarded-For only from Caddy (and the API also from web)", () => {
  const subnet = values(network, "Subnet")[0]!;
  const dynamic = values(network, "IPRange")[0]!;
  const fixed = Object.fromEntries(
    Object.entries(units)
      .filter(([, text]) => values(text, "IP").length > 0)
      .map(([name, text]) => [name, values(text, "IP")[0]!]),
  );

  test("Caddy and web have fixed addresses, outside the range Podman hands out", () => {
    expect(subnet).toBe("10.89.42.0/24");
    expect(fixed).toEqual({ caddy: "10.89.42.10", web: "10.89.42.11" });
    for (const [name, ip] of Object.entries(fixed)) {
      expect(inRange(ip, subnet), name).toBe(true);
      expect(inRange(ip, dynamic), name).toBe(false);
    }
    // The gateway (.1) is outside the range too, and the range is the network's upper half.
    expect(dynamic).toBe("10.89.42.128/25");
  });

  test.each(["api", "chat", "irc", "media", "origin", "tracker", "web", "worker"])(
    "%s trusts exactly the fixed proxy addresses, never the subnet",
    (name) => {
      const [cidrs] = values(unit(name), "Environment")
        .filter((e) => e.startsWith("TRUSTED_PROXY_CIDRS="))
        .map((e) => e.slice(e.indexOf("=") + 1).split(","));
      const want = name === "api" ? [`${fixed.caddy}/32`, `${fixed.web}/32`] : [`${fixed.caddy}/32`];
      expect(cidrs).toEqual(want);
    },
  );
});

describe("Valkey requires a password", () => {
  const valkey = unit("valkey");
  const [exec] = values(valkey, "Exec");

  test("the server gets it from its env file, as configuration on stdin, never as an argument", () => {
    expect(values(valkey, "EnvironmentFile")).toEqual(["%h/.config/commonair/unit-env/commonair-valkey.env"]);
    expect(read("infra/selfhost/env/commonair-valkey.keys")).toMatch(/\nVALKEY_PASSWORD\n$/);
    expect(exec).not.toMatch(/--requirepass/);
    expect(exec).toContain('printf "requirepass %%s\\n" "$VALKEY_PASSWORD"');
    expect(exec).toContain("docker-entrypoint.sh valkey-server - --appendonly no --save");
    // Fails closed: no password, no server.
    expect(exec).toMatch(/if \[ -z "\$VALKEY_PASSWORD" \]; then .* exit 1; fi/);
    // The server process does not keep it in its environment either.
    expect(exec).toContain("env -u VALKEY_PASSWORD");
  });

  test("the health check authenticates and wants PONG", () => {
    expect(values(valkey, "HealthCmd")).toEqual([
      '[ -z "$VALKEY_PASSWORD" ] || export VALKEYCLI_AUTH="$VALKEY_PASSWORD"; valkey-cli ping | grep -qx PONG',
    ]);
  });

  test("every service that reads VALKEY_URL gets it from the Podman secret, none from the unit", () => {
    for (const name of ["api", "chat", "media", "origin", "tracker", "worker"])
      expect(values(unit(name), "Secret"), name).toContain("commonair-valkey-url,type=env,target=VALKEY_URL");
    for (const [name, text] of Object.entries(units))
      expect(
        values(text, "Environment").filter((e) => e.startsWith("VALKEY_")),
        name,
      ).toEqual([]);
    const sh = read("scripts/selfhost.sh");
    expect(sh).toContain("podman secret create --replace commonair-valkey-url -");
    expect(sh).toContain('env_set VALKEY_URL "redis://:$_vpw@valkey:6379"');
  });

  test("compose: the same server command, the password optional (development may run without)", () => {
    const v = compose.services.valkey!;
    expect(v.environment?.VALKEY_PASSWORD).toBe("${VALKEY_PASSWORD:-}");
    const cmd = (v.command ?? []).join(" ").replaceAll("$$", "$");
    expect(cmd).not.toMatch(/--requirepass/);
    expect(cmd).toContain('printf "requirepass %s\\n" "$VALKEY_PASSWORD"');
    expect(cmd).toContain("exec env -u VALKEY_PASSWORD docker-entrypoint.sh valkey-server - --appendonly no --save");
    expect(compose.services.api?.environment?.VALKEY_URL).toBe(
      "redis://${VALKEY_PASSWORD:+:${VALKEY_PASSWORD}@}valkey:6379",
    );
  });

  test("init-env generates it (64 hex characters, safe in a URL)", () => {
    expect(read(".env.example")).toMatch(/^VALKEY_PASSWORD=__generate_hex64__$/m);
  });
});

describe("IRC's public ports are systemd sockets (client addresses survive rootless Podman)", () => {
  const irc = unit("irc");
  const ircSockets = ["commonair-irc.socket", "commonair-ircs.socket"];

  test("the unit publishes nothing and wants both sockets, which systemd passes to it", () => {
    expect(values(irc, "PublishPort")).toEqual([]);
    for (const s of ircSockets) {
      expect(values(irc, "Wants")).toContain(s);
      expect(values(irc, "After")).toContain(s);
    }
    expect(values(irc, "Sockets")).toEqual([ircSockets.join(" ")]);
    // Still on the network, so it reaches chat by name.
    expect(values(irc, "Network")).toEqual(["commonair.network"]);
  });

  test("each socket holds one public IRC port, dual-stack, at boot", () => {
    const listens = ircSockets.map((f) => {
      const text = code(read(`infra/systemd/${f}`));
      expect(values(text, "BindIPv6Only"), f).toEqual(["both"]);
      expect(values(text, "WantedBy"), f).toEqual(["sockets.target"]);
      return [...text.matchAll(/^(Listen\w+)=(.*)$/gm)].map((m) => `${m[1]}=${m[2]}`);
    });
    expect(listens).toEqual([["ListenStream=6667"], ["ListenStream=6697"]]);
  });

  test("the WebSocket listener stays behind Caddy (not a socket, not published)", () => {
    expect(values(irc, "Environment")).toContain("IRC_WS_PORT=6680");
    for (const s of ircSockets) expect(read(`infra/systemd/${s}`)).not.toMatch(/^ListenStream=6680$/m);
  });

  test("compose keeps plain binding (no socket activation there)", () => {
    expect(compose.services.irc?.ports?.map((p) => p.split(":").at(-1))).toEqual(["6667", "6697", "6680", "6681"]);
  });
});
