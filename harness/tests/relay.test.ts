// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The pure parts of the relay helper, the e2e-relay plan, and the relay process lifecycle with a stand-in binary. */
import { chmodSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import type { NetworkInterfaceInfo } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { assignmentOf, tokenOfUrl } from "../src/assignment.ts";
import {
  GoRelay,
  LineLog,
  freePort,
  parseDotenv,
  pickLanIPv4,
  privateNetworksProblem,
  relayArgv,
  relayHost,
  relaySourceFiles,
  relaySourceHash,
} from "../src/relay.ts";
import { PlanError, RELAY_STEPS, buildRelayPlan, parseBool, verifiedCountOk } from "../src/relay-plan.ts";

function iface(address: string, family: "IPv4" | "IPv6", internal = false): NetworkInterfaceInfo {
  const base = { address, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", internal, cidr: null };
  return family === "IPv4" ? { ...base, family } : { ...base, family, scopeid: 0 };
}

describe("LAN address selection", () => {
  test("first non-internal IPv4, in interface order", () => {
    expect(
      pickLanIPv4({
        lo0: [iface("127.0.0.1", "IPv4", true), iface("::1", "IPv6", true)],
        en0: [iface("fe80::1", "IPv6"), iface("192.168.1.20", "IPv4")],
        en1: [iface("10.0.0.5", "IPv4")],
      }),
    ).toBe("192.168.1.20");
  });

  test("skips link-local 169.254/16 and IPv6-only interfaces", () => {
    expect(
      pickLanIPv4({
        en0: [iface("169.254.10.2", "IPv4")],
        utun0: [iface("fd00::2", "IPv6")],
        en1: [iface("10.1.2.3", "IPv4")],
      }),
    ).toBe("10.1.2.3");
  });

  test("numeric family (older Node) still counts as IPv4", () => {
    const legacy = { ...iface("172.16.0.9", "IPv4"), family: 4 } as unknown as NetworkInterfaceInfo;
    expect(pickLanIPv4({ eth0: [legacy] })).toBe("172.16.0.9");
  });

  test("none → null; relayHost explains and points at --set relayHost", () => {
    const only = { lo0: [iface("127.0.0.1", "IPv4", true)], empty: undefined };
    expect(pickLanIPv4(only)).toBeNull();
    expect(() => relayHost(undefined, only)).toThrow(/--set relayHost=/);
    expect(relayHost("10.9.9.9", only)).toBe("10.9.9.9");
    expect(relayHost(undefined, { en0: [iface("192.168.0.2", "IPv4")] })).toBe("192.168.0.2");
  });

  test("freePort returns a usable port", async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(0);
    const srv = Bun.serve({ port, fetch: () => new Response("ok") });
    expect(srv.port).toBe(port);
    await srv.stop(true);
  });
});

describe("readiness: OUTBOUND_ALLOW_PRIVATE_NETWORKS", () => {
  test("parseDotenv: comments, quotes, export, inline comments", () => {
    const env = parseDotenv(
      ["# comment", "A=1", 'B="two words"', "export C='x#y'", "D=plain # trailing", "bad line", "E="].join("\n"),
    );
    expect(env).toEqual({ A: "1", B: "two words", C: "x#y", D: "plain", E: "" });
  });

  test("true/1 in the process env or .env passes; the process env wins", () => {
    expect(privateNetworksProblem({ OUTBOUND_ALLOW_PRIVATE_NETWORKS: "true" }, null)).toBeNull();
    expect(privateNetworksProblem({}, { OUTBOUND_ALLOW_PRIVATE_NETWORKS: "1" })).toBeNull();
    expect(privateNetworksProblem({ OUTBOUND_ALLOW_PRIVATE_NETWORKS: "TRUE " }, null)).toBeNull();
    expect(
      privateNetworksProblem({ OUTBOUND_ALLOW_PRIVATE_NETWORKS: "false" }, { OUTBOUND_ALLOW_PRIVATE_NETWORKS: "true" }),
    ).toMatch(/"false"/);
  });

  test("unset or false: an actionable message", () => {
    expect(privateNetworksProblem({}, null)).toMatch(/unset.*OUTBOUND_ALLOW_PRIVATE_NETWORKS=true in \.env/);
    expect(privateNetworksProblem({}, { OUTBOUND_ALLOW_PRIVATE_NETWORKS: "false" })).toMatch(/"false"/);
  });
});

describe("relay build inputs", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  test("hash covers Go sources and go.mod/go.sum, not tests or other files", () => {
    dir = mkdtempSync(join(tmpdir(), "relay-hash-"));
    mkdirSync(join(dir, "cmd", "x"), { recursive: true });
    writeFileSync(join(dir, "go.mod"), "module x\n");
    writeFileSync(join(dir, "cmd", "x", "main.go"), "package main\n");
    writeFileSync(join(dir, "cmd", "x", "main_test.go"), "package main\n");
    writeFileSync(join(dir, "README.md"), "docs\n");
    expect(relaySourceFiles(dir).map((f) => f.slice(dir!.length + 1))).toEqual(["cmd/x/main.go", "go.mod"]);
    const h1 = relaySourceHash(dir);
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
    writeFileSync(join(dir, "cmd", "x", "main_test.go"), "package main // changed\n");
    writeFileSync(join(dir, "README.md"), "changed\n");
    expect(relaySourceHash(dir)).toBe(h1);
    writeFileSync(join(dir, "cmd", "x", "main.go"), "package main // changed\n");
    expect(relaySourceHash(dir)).not.toBe(h1);
  });

  test("the real relay/ has sources to hash", () => {
    expect(relaySourceFiles().some((f) => f.endsWith("cmd/commonair-relay/main.go"))).toBe(true);
  });

  test("argv follows the e3 recipe; the token is not on the command line", () => {
    const argv = relayArgv({
      binary: "/tmp/commonair-relay",
      api: "http://localhost:3001",
      host: "192.168.1.20",
      port: 18443,
      dataDir: "/tmp/data",
    });
    expect(argv).toEqual([
      "/tmp/commonair-relay",
      "--api",
      "http://localhost:3001",
      "--public-url",
      "http://192.168.1.20:18443",
      "--listen",
      ":18443",
      "--data-dir",
      "/tmp/data",
      "--capacity-mbps",
      "1000",
    ]);
    expect(argv.join(" ")).not.toContain("relay_");
  });
});

describe("relay process lifecycle (stand-in binary)", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  test("start → /healthz → SIGTERM drain → exit 0 → restart, with logs captured", async () => {
    dir = mkdtempSync(join(tmpdir(), "relay-fake-"));
    const binary = join(dir, "fake-relay");
    // Behaves like the relay on the outside: flags, token from env, /healthz, SIGTERM drain.
    writeFileSync(
      binary,
      `#!/usr/bin/env bun
const args = process.argv.slice(2);
const flag = (n) => args[args.indexOf(n) + 1];
const port = Number(flag("--listen").slice(1));
let draining = false;
const srv = Bun.serve({ port, fetch: () => Response.json({ status: draining ? "draining" : "ok", version: "fake", viewers: 3 }, { status: draining ? 503 : 200 }) });
console.error(JSON.stringify({ msg: "listening", token: process.env.COMMONAIR_RELAY_TOKEN ? "set" : "missing", publicUrl: flag("--public-url") }));
process.on("SIGTERM", () => { draining = true; console.error("draining"); setTimeout(() => { srv.stop(true); process.exit(0); }, 200); });
`,
    );
    chmodSync(binary, 0o755);
    const port = await freePort();
    const relay = new GoRelay({
      binary,
      api: "http://127.0.0.1:1",
      host: "127.0.0.1",
      port,
      dataDir: dir,
      token: "relay_test",
    });
    try {
      relay.start();
      expect(() => relay.start()).toThrow(/already running/);
      const h = await relay.waitHealthy(10_000);
      expect(h).toEqual({ status: "ok", version: "fake", viewers: 3 });
      expect(relay.url).toBe(`http://127.0.0.1:${port}`);
      expect(await relay.terminate(5_000)).toBe(0);
      expect(relay.running).toBe(false);
      relay.start();
      await relay.waitHealthy(10_000);
      await relay.stop();
      const lines = relay.logs.lines().join("\n");
      expect(lines).toContain('"token":"set"');
      expect(lines).toContain(`"publicUrl":"http://127.0.0.1:${port}"`);
      expect(lines).toContain("SIGTERM");
      expect(lines).toContain("draining");
      expect(lines).toMatch(/start #2/);
      expect(lines).not.toContain("relay_test");
    } finally {
      await relay.stop();
    }
  });

  test("LineLog keeps the last lines", () => {
    const log = new LineLog(3);
    for (let i = 0; i < 5; i++) log.push("stdout", `l${i}`);
    expect(log.lines().map((l) => l.split(" ").at(-1))).toEqual(["l2", "l3", "l4"]);
    expect(log.lines(1)).toHaveLength(1);
  });
});

describe("e2e-relay plan from --set knobs", () => {
  test("defaults: web, 4 HTTP + 2 Chromium, 12 bots, liar and drain on", () => {
    const plan = buildRelayPlan({});
    expect(plan).toMatchObject({
      via: "web",
      httpViewers: 4,
      browserViewers: 2,
      bots: 12,
      liar: true,
      drain: true,
      liarFactor: 5,
      minRelayAssigned: 2,
      relayHost: undefined,
      relayPort: undefined,
    });
    expect(plan.steps).toEqual(Object.values(RELAY_STEPS));
  });

  test("via=api: HTTP viewers only; asking for browsers is an error", () => {
    const plan = buildRelayPlan({ via: "api" });
    expect(plan.browserViewers).toBe(0);
    expect(plan.httpViewers).toBe(4);
    expect(() => buildRelayPlan({ via: "api", browserViewers: "1" })).toThrow(/HTTP viewers, no browsers/);
    expect(buildRelayPlan({ via: "api", browserViewers: "0" }).browserViewers).toBe(0);
    expect(() => buildRelayPlan({ via: "ui" })).toThrow(/expected one of web, api/);
  });

  test("liar=false / drain=false drop their steps", () => {
    expect(buildRelayPlan({ liar: "false" }).steps).not.toContain(RELAY_STEPS.liar);
    expect(buildRelayPlan({ drain: "0" }).steps).not.toContain(RELAY_STEPS.drain);
    expect(buildRelayPlan({ liar: "off", drain: "no" }).steps).toEqual([
      RELAY_STEPS.setup,
      RELAY_STEPS.viewers,
      RELAY_STEPS.bots,
      RELAY_STEPS.verify,
    ]);
  });

  test("relayHost, relayPort and counts", () => {
    const plan = buildRelayPlan({
      relayHost: "10.0.0.7",
      relayPort: "18443",
      httpViewers: "10",
      browserViewers: "1",
      bots: "0",
      liarViewers: "3",
    });
    expect(plan).toMatchObject({
      relayHost: "10.0.0.7",
      relayPort: 18443,
      httpViewers: 10,
      browserViewers: 1,
      bots: 0,
      liarViewers: 3,
    });
  });

  test("bad values are usage errors", () => {
    expect(() => buildRelayPlan({ bots: "-1" })).toThrow(PlanError);
    expect(() => buildRelayPlan({ httpViewers: "two" })).toThrow(/whole number/);
    expect(() => buildRelayPlan({ relayPort: "70000" })).toThrow(/1–65535/);
    expect(() => buildRelayPlan({ relayHost: "http://x/" })).toThrow(/address/);
    expect(() => buildRelayPlan({ httpViewers: "0", browserViewers: "0" })).toThrow(/at least one honest viewer/);
    expect(() => buildRelayPlan({ liar: "maybe" })).toThrow(/true or false/);
    expect(() => buildRelayPlan({ liarFactor: "1" })).toThrow(/over-report/);
    expect(() => buildRelayPlan({ maxSessions: "3" })).toThrow(/maxSessions/);
  });

  test("parseBool and the verified-count bound", () => {
    expect(parseBool("x", undefined, true)).toBe(true);
    expect(parseBool("x", "", false)).toBe(false);
    expect(parseBool("x", "YES", false)).toBe(true);
    expect(verifiedCountOk(5, 5)).toBe(true);
    expect(verifiedCountOk(4, 5)).toBe(false);
    expect(verifiedCountOk(6, 5, 2)).toBe(false);
    expect(verifiedCountOk(3, 5, 2)).toBe(true);
    expect(verifiedCountOk(2, 5, 2)).toBe(false);
  });
});

describe("assignment from the playback token", () => {
  const token = (claims: object) => `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

  test("relay and origin tokens", () => {
    expect(assignmentOf(token({ v: 1, src: "relay", rid: "r-1" }))).toEqual({ source: "relay", relayId: "r-1" });
    expect(assignmentOf(token({ v: 1, src: "origin" }))).toEqual({ source: "origin", relayId: null });
  });

  test("malformed tokens → null", () => {
    expect(assignmentOf("")).toBeNull();
    expect(assignmentOf("abc")).toBeNull();
    expect(assignmentOf("a.b.c")).toBeNull();
    expect(assignmentOf("!!!.sig")).toBeNull();
    expect(assignmentOf(token({ src: "carrier-pigeon" }))).toBeNull();
  });

  test("token from a playlist URL", () => {
    expect(tokenOfUrl("http://x/hls/live/a/index.m3u8?t=abc.def")).toBe("abc.def");
    expect(tokenOfUrl("http://x/hls/live/a/index.m3u8")).toBeNull();
    expect(tokenOfUrl("not a url")).toBeNull();
  });
});
