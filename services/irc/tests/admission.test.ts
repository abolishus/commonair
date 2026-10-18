// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { Admission } from "../src/admission.ts";
import { connectionLimits, ircEnv, trustedProxies } from "../src/env.ts";
import { clientAddress, inCidr, ipKey, parseCidr, parseIp } from "../src/net.ts";

describe("IP parsing and CIDRs", () => {
  test.each([
    ["10.1.2.3", 32],
    ["::1", 128],
    ["2001:db8::8a2e:370:7334", 128],
    ["[::1]", 128],
    ["fe80::1%en0", 128],
    ["::ffff:10.1.2.3", 32],
  ])("parses %s", (ip, bits) => {
    expect(parseIp(ip)?.bits).toBe(bits);
  });

  test.each(["", "1.2.3", "1.2.3.256", "1.2.3.4.5", "::g", "1::2::3", "1:2:3:4:5:6:7:8:9", "abc"])(
    "rejects %j",
    (ip) => {
      expect(parseIp(ip)).toBeNull();
    },
  );

  test("v4-mapped v6 and v4 share one key", () => {
    expect(ipKey("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(ipKey("192.0.2.1")).toBe("192.0.2.1");
    expect(ipKey("::1")).toBe("0000:0000:0000:0000:0000:0000:0000:0001");
  });

  test("CIDR membership", () => {
    const net = parseCidr("10.0.0.0/8");
    const v6 = parseCidr("fd00::/8");
    const host = parseCidr("127.0.0.1");
    if (!net || !v6 || !host) throw new Error("parse failed");
    expect(inCidr(parseIp("10.200.1.1")!, net)).toBe(true);
    expect(inCidr(parseIp("11.0.0.1")!, net)).toBe(false);
    expect(inCidr(parseIp("::ffff:10.0.0.9")!, net)).toBe(true);
    expect(inCidr(parseIp("fd12::1")!, v6)).toBe(true);
    expect(inCidr(parseIp("10.0.0.1")!, v6)).toBe(false);
    expect(inCidr(parseIp("127.0.0.1")!, host)).toBe(true);
    expect(inCidr(parseIp("127.0.0.2")!, host)).toBe(false);
    expect(parseCidr("10.0.0.0/33")).toBeNull();
    expect(parseCidr("nope/8")).toBeNull();
  });
});

describe("clientAddress", () => {
  const trusted = trustedProxies(["10.0.0.0/8"]);

  test("an untrusted peer's X-Forwarded-For is ignored", () => {
    expect(clientAddress("203.0.113.5", "1.1.1.1", trusted)).toBe("203.0.113.5");
    expect(clientAddress("203.0.113.5", "1.1.1.1", [])).toBe("203.0.113.5");
  });

  test("a trusted proxy's header gives the right-most untrusted hop", () => {
    expect(clientAddress("10.0.0.2", "198.51.100.7", trusted)).toBe("198.51.100.7");
    // A client-supplied spoofed left-most entry does not win.
    expect(clientAddress("10.0.0.2", "6.6.6.6, 198.51.100.7, 10.0.0.9", trusted)).toBe("198.51.100.7");
  });

  test("garbage stops the walk at the last address we can vouch for", () => {
    expect(clientAddress("10.0.0.2", "not-an-ip, 10.0.0.3", trusted)).toBe("10.0.0.3");
    expect(clientAddress("10.0.0.2", "", trusted)).toBe("10.0.0.2");
  });

  test("bad TRUSTED_PROXY_CIDRS entries fail startup", () => {
    expect(() => trustedProxies(["10.0.0.0/8", "bogus"])).toThrow(/invalid CIDR/);
  });
});

describe("Admission", () => {
  const limits = { maxConnections: 3, maxPerIp: 2, connectBurstPerIp: 3, connectPerSecondPerIp: 1 };

  test("per-IP and global caps; release frees a slot", () => {
    let now = 0;
    const a = new Admission(limits, () => now);
    expect(a.admit("1.1.1.1")).toBeNull();
    expect(a.admit("1.1.1.1")).toBeNull();
    expect(a.admit("1.1.1.1")).toBe("too_many_from_ip");
    expect(a.admit("2.2.2.2")).toBeNull();
    expect(a.admit("3.3.3.3")).toBe("server_full");
    a.release("1.1.1.1");
    expect(a.connectionsFrom("1.1.1.1")).toBe(1);
    expect(a.admit("3.3.3.3")).toBeNull();
    a.release("nobody"); // unknown IPs are ignored, totals stay consistent
    expect(a.admit("4.4.4.4")).toBe("server_full");
    a.stop();
  });

  test("new connections per IP are rate limited, refilling over time", () => {
    let now = 0;
    const a = new Admission({ ...limits, maxPerIp: 100, maxConnections: 100 }, () => now);
    for (let i = 0; i < 3; i++) {
      expect(a.admit("5.5.5.5")).toBeNull();
      a.release("5.5.5.5");
    }
    expect(a.admit("5.5.5.5")).toBe("connecting_too_fast");
    expect(a.admit("6.6.6.6")).toBeNull(); // other addresses are unaffected
    now = 1000;
    expect(a.admit("5.5.5.5")).toBeNull();
    now = 10 * 60_000;
    a.forgetIdle();
    a.stop();
  });
});

test("ircEnv defaults and overrides", () => {
  expect(connectionLimits(ircEnv.parse({}))).toEqual({
    maxConnections: 20_000,
    maxPerIp: 50,
    connectBurstPerIp: 20,
    connectPerSecondPerIp: 2,
  });
  expect(connectionLimits(ircEnv.parse({ IRC_MAX_CONNECTIONS_PER_IP: "5" })).maxPerIp).toBe(5);
  expect(ircEnv.safeParse({ IRC_MAX_CONNECTIONS: "0" }).success).toBe(false);
});
