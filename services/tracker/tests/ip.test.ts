// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { trustedProxies } from "../src/env.ts";
import { canonicalIp, clientIp, isValidCidr, networkPrefix } from "../src/ip.ts";

describe("networkPrefix", () => {
  test.each([
    ["203.0.113.77", "203.0.113.0/24"],
    ["203.0.113.0", "203.0.113.0/24"],
    ["10.1.2.255", "10.1.2.0/24"],
    ["::ffff:198.51.100.9", "198.51.100.0/24"],
    ["::FFFF:c633:6409", "198.51.100.0/24"],
    ["2001:db8:abcd:12:1:2:3:4", "2001:db8:abcd::/48"],
    ["2001:DB8:ABCD:FFFF::1", "2001:db8:abcd::/48"],
    ["[2001:db8::1]", "2001:db8::/48"],
    ["fe80::1%eth0", "fe80::/48"],
    ["::1", "::/48"],
  ])("%s → %s", (ip, want) => {
    expect(networkPrefix(ip)).toBe(want);
  });
  test("same /24 and same /48 share a prefix, neighbours do not", () => {
    expect(networkPrefix("192.0.2.1")).toBe(networkPrefix("192.0.2.254"));
    expect(networkPrefix("192.0.2.1")).not.toBe(networkPrefix("192.0.3.1"));
    expect(networkPrefix("2001:db8:1:ffff::1")).toBe(networkPrefix("2001:db8:1::2"));
    expect(networkPrefix("2001:db8:1::1")).not.toBe(networkPrefix("2001:db8:2::1"));
  });
  test("unparseable input", () => {
    expect(networkPrefix("not-an-ip")).toBeNull();
    expect(networkPrefix("256.1.1.1")).toBeNull();
  });
});

describe("clientIp / canonicalIp", () => {
  const trusted = ["10.0.0.0/8", "fd00::/8"];
  test("X-Forwarded-For only from a trusted peer, rightmost untrusted hop", () => {
    expect(clientIp("10.0.0.5", "198.51.100.1, 203.0.113.9", trusted)).toBe("203.0.113.9");
    expect(clientIp("10.0.0.5", "198.51.100.1, 10.0.0.7", trusted)).toBe("198.51.100.1");
    expect(clientIp("203.0.113.1", "198.51.100.1", trusted)).toBe("203.0.113.1");
    expect(clientIp("10.0.0.5", "garbage", trusted)).toBe("10.0.0.5");
    expect(clientIp("10.0.0.5", null, trusted)).toBe("10.0.0.5");
  });
  test("canonical spellings", () => {
    expect(canonicalIp("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(canonicalIp("2001:0DB8:0000:0000:0000:0000:0000:0001")).toBe("2001:db8::1");
  });
  test("CIDR validation", () => {
    expect(isValidCidr("10.0.0.0/8")).toBe(true);
    expect(isValidCidr("::1")).toBe(true);
    expect(isValidCidr("10.0.0.0/33")).toBe(false);
    expect(isValidCidr("10.0.0.0/x")).toBe(false);
    expect(isValidCidr("nope/8")).toBe(false);
    expect(() => trustedProxies(["10.0.0.0/8", "bad"])).toThrow(/invalid CIDR/);
  });
});
