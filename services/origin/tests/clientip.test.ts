// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { FailureLimiter, clientIp, inCidrs, parseCidr, parseIp } from "../src/clientip.ts";

const cidrs = (...c: string[]) => c.map((x) => parseCidr(x)).filter((x) => x !== null);

describe("IP parsing", () => {
  test("IPv4, IPv6, mapped IPv4, brackets and zones", () => {
    expect(parseIp("10.0.0.1")).toEqual({ v: 4, n: 0x0a000001n });
    expect(parseIp("::1")).toEqual({ v: 6, n: 1n });
    expect(parseIp("[2001:db8::1]")).toEqual({ v: 6, n: 0x20010db8000000000000000000000001n });
    expect(parseIp("::ffff:10.0.0.1")).toEqual({ v: 4, n: 0x0a000001n });
    expect(parseIp("fe80::1%eth0")?.v).toBe(6);
  });
  test.each(["", "1.2.3", "256.1.1.1", "1:2:3:4:5:6:7:8:9", "1::2::3", "x::1", "01234::"])("rejects %s", (s) => {
    expect(parseIp(s)).toBeNull();
  });
  test("CIDR membership", () => {
    const c = cidrs("10.0.0.0/8", "2001:db8::/32");
    expect(inCidrs(parseIp("10.200.1.1")!, c)).toBe(true);
    expect(inCidrs(parseIp("11.0.0.1")!, c)).toBe(false);
    expect(inCidrs(parseIp("2001:db8:ffff::1")!, c)).toBe(true);
    expect(inCidrs(parseIp("2001:db9::1")!, c)).toBe(false);
    expect(parseCidr("10.0.0.0/33")).toBeNull();
  });
});

describe("clientIp", () => {
  const trusted = cidrs("10.0.0.0/8");
  test("untrusted peers are the client, whatever X-Forwarded-For says", () => {
    expect(clientIp("203.0.113.5", "1.1.1.1", trusted)).toBe("203.0.113.5");
  });
  test("from a trusted proxy: the right-most untrusted hop", () => {
    expect(clientIp("10.0.0.2", "198.51.100.7, 203.0.113.5, 10.0.0.9", trusted)).toBe("203.0.113.5");
    expect(clientIp("10.0.0.2", null, trusted)).toBe("10.0.0.2");
    expect(clientIp("10.0.0.2", "garbage", trusted)).toBe("10.0.0.2");
  });
});

describe("FailureLimiter", () => {
  test("blocks after max failures within the window, then resets", () => {
    let now = 0;
    const l = new FailureLimiter(3, 60_000, 100, () => now);
    for (let i = 0; i < 3; i++) {
      expect(l.blocked("a")).toBe(false);
      l.fail("a");
    }
    expect(l.blocked("a")).toBe(true);
    expect(l.blocked("b")).toBe(false);
    now = 60_000;
    expect(l.blocked("a")).toBe(false);
  });
  test("bounded key count", () => {
    const l = new FailureLimiter(1, 60_000, 2);
    l.fail("a");
    l.fail("b");
    l.fail("c");
    expect(l.blocked("a")).toBe(false);
    expect(l.blocked("c")).toBe(true);
  });
});
