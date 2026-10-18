// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { looksProxied } from "../src/lib/ip.ts";
import { isPublicAddress, rateLimitSubjectIp } from "../src/lib/netrange.ts";

describe("isPublicAddress", () => {
  test.each([
    "0.0.0.0",
    "0.1.2.3",
    "10.0.0.1",
    "10.255.255.255",
    "100.64.0.1",
    "100.127.255.254",
    "127.0.0.1",
    "127.10.0.1",
    "169.254.169.254", // cloud metadata
    "169.254.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.8",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "::ffff:10.0.0.1",
    "::127.0.0.1", // deprecated IPv4-compatible
    "64:ff9b::a00:1", // NAT64 to 10.0.0.1
    "2001::1", // Teredo
    "2001:db8::1",
    "2002:a00:1::1", // 6to4 of 10.0.0.1
    "fc00::1",
    "fd00:ec2::254", // AWS IPv6 metadata
    "fe80::1",
    "fe80::1%eth0",
    "fec0::1",
    "ff02::1",
    "100::1",
    "not-an-ip",
    "",
    "1.2.3",
    "256.1.1.1",
  ])("refuses %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  test.each([
    "1.1.1.1",
    "8.8.8.8",
    "100.63.255.255",
    "100.128.0.0",
    "172.15.255.255",
    "172.32.0.0",
    "192.169.0.1",
    "198.20.0.1",
    "223.255.255.255",
    "::ffff:8.8.8.8",
    "2606:4700:4700::1111",
    "2a00:1450::1",
    "2001:4860:4860::8888",
  ])("allows %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });
});

describe("rateLimitSubjectIp", () => {
  test("IPv4 stays per address; mapped IPv6 folds to IPv4", () => {
    expect(rateLimitSubjectIp("203.0.113.9")).toBe("203.0.113.9");
    expect(rateLimitSubjectIp("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(rateLimitSubjectIp("::ffff:cb00:7109")).toBe("203.0.113.9");
  });

  test("IPv6 buckets by /64 regardless of notation", () => {
    const a = rateLimitSubjectIp("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    expect(a).toBe("2001:db8:1:2::/64");
    expect(rateLimitSubjectIp("2001:0db8:0001:0002::1")).toBe(a);
    expect(rateLimitSubjectIp("2001:DB8:1:2:ffff:ffff:ffff:ffff")).toBe(a);
    expect(rateLimitSubjectIp("2001:db8:1:3::1")).not.toBe(a);
    expect(rateLimitSubjectIp("::1")).toBe("0:0:0:0::/64");
    expect(rateLimitSubjectIp("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  test("unparseable input is returned unchanged", () => {
    expect(rateLimitSubjectIp("garbage")).toBe("garbage");
  });
});

describe("looksProxied", () => {
  test("X-Forwarded-For from an untrusted private peer", () => {
    expect(looksProxied("10.0.0.2", "198.51.100.1", [])).toBe(true);
    expect(looksProxied("127.0.0.1", "198.51.100.1", [])).toBe(true);
    expect(looksProxied("::1", "198.51.100.1", [])).toBe(true);
    expect(looksProxied("::ffff:172.17.0.1", "198.51.100.1", [])).toBe(true);
  });

  test("not when trusted, absent, or the peer is public", () => {
    expect(looksProxied("10.0.0.2", "198.51.100.1", ["10.0.0.0/8"])).toBe(false);
    expect(looksProxied("10.0.0.2", null, [])).toBe(false);
    expect(looksProxied("10.0.0.2", " ", [])).toBe(false);
    expect(looksProxied("8.8.8.8", "198.51.100.1", [])).toBe(false);
  });
});
