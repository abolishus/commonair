// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { canonicalIp, rateLimitSubjectIp } from "../src/lib/netrange.ts";

describe("canonicalIp", () => {
  test.each([
    // IPv4
    ["203.0.113.9", "203.0.113.9"],
    [" 203.0.113.9 ", "203.0.113.9"],
    ["0.0.0.0", "0.0.0.0"],
    ["255.255.255.255", "255.255.255.255"],
    ["010.001.000.009", "10.1.0.9"],
    // IPv4-mapped IPv6 unwraps to IPv4, in any spelling
    ["::ffff:1.2.3.4", "1.2.3.4"],
    ["::FFFF:1.2.3.4", "1.2.3.4"],
    ["::ffff:0102:0304", "1.2.3.4"],
    ["0:0:0:0:0:ffff:102:304", "1.2.3.4"],
    ["0000:0000:0000:0000:0000:ffff:0102:0304", "1.2.3.4"],
    ["[::ffff:1.2.3.4]", "1.2.3.4"],
    ["::ffff:1.2.3.4%eth0", "1.2.3.4"],
    // IPv6: lower case, leading zeros dropped (RFC 5952 4.1, 4.3)
    ["2001:DB8::1", "2001:db8::1"],
    ["2001:0db8:0000:0000:0000:0000:0000:0001", "2001:db8::1"],
    ["2001:db8:0:0:0:0:2:1", "2001:db8::2:1"],
    // A single zero group is not compressed (4.2.2)
    ["2001:db8:0:1:1:1:1:1", "2001:db8:0:1:1:1:1:1"],
    ["2001:db8::1:1:1:1:1", "2001:db8:0:1:1:1:1:1"],
    // The longest run wins; of equal runs, the first (4.2.3)
    ["2001:0:0:1:0:0:0:1", "2001:0:0:1::1"],
    ["2001:db8:0:0:1:0:0:1", "2001:db8::1:0:0:1"],
    // Runs at either end
    ["0:0:0:0:0:0:0:0", "::"],
    ["::", "::"],
    ["::1", "::1"],
    ["0:0:0:0:0:0:0:1", "::1"],
    ["1:0:0:0:0:0:0:0", "1::"],
    ["fe80:0:0:0:0:0:0:0", "fe80::"],
    ["ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
    // Zone ids and brackets are dropped
    ["fe80::1%eth0", "fe80::1"],
    ["FE80::0001%25en0", "fe80::1"],
    ["[2001:db8::1]", "2001:db8::1"],
    // Other embedded-IPv4 forms are plain IPv6 (only ::ffff: is unwrapped)
    ["::1.2.3.4", "::102:304"],
    ["64:ff9b::1.2.3.4", "64:ff9b::102:304"],
    ["::ffff:0:1.2.3.4", "::ffff:0:102:304"],
  ])("%s → %s", (input, expected) => {
    expect(canonicalIp(input)).toBe(expected);
  });

  test.each(["", "Not-An-IP", "1.2.3", "1.2.3.256", "2001:db8:::1", "1:2:3:4:5:6:7:8:9", "g::1"])(
    "unparseable %j is returned trimmed and lower-cased",
    (input) => {
      expect(canonicalIp(input)).toBe(input.trim().toLowerCase());
    },
  );

  test("idempotent", () => {
    for (const ip of ["::ffff:1.2.3.4", "2001:0DB8::0:1", "fe80::1%lo", "1.2.3.4", "::"]) {
      const once = canonicalIp(ip);
      expect(canonicalIp(once)).toBe(once);
    }
  });

  test("spellings of one client agree on the hash input and the rate-limit subject", () => {
    const spellings = ["2001:DB8:1:2::7", "2001:0db8:0001:0002:0000:0000:0000:0007", "[2001:db8:1:2::7]"];
    expect(new Set(spellings.map(canonicalIp)).size).toBe(1);
    expect(new Set(spellings.map((s) => rateLimitSubjectIp(canonicalIp(s)))).size).toBe(1);
  });
});
