// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  CidrClassifier,
  PRIVACY_RELAY_LABEL_PREFIX,
  SAMPLE_HOSTING_CIDRS_FILE,
  classifierFromEnv,
  loadNetworkList,
  parseCidr,
  parseIp,
  parseNetworkList,
} from "../src/network.ts";

describe("parseIp", () => {
  test.each([
    ["192.0.2.1", 4, 0xc0000201n],
    ["0.0.0.0", 4, 0n],
    ["255.255.255.255", 4, 0xffffffffn],
    ["::1", 6, 1n],
    ["2001:db8::", 6, 0x20010db8n << 96n],
    ["::ffff:192.0.2.1", 4, 0xc0000201n],
    ["::ffff:c000:201", 4, 0xc0000201n],
    ["fe80::1%eth0", 6, (0xfe80n << 112n) | 1n],
    ["1:2:3:4:5:6:7:8", 6, 0x00010002000300040005000600070008n],
  ])("%s", (ip, family, value) => {
    expect(parseIp(ip)).toEqual({ family, value });
  });

  test.each([
    "256.1.1.1",
    "1.2.3",
    "01.2.3.4",
    "0x7f.0.0.1",
    "1.2.3.4.5",
    "",
    "::1::2",
    "1:2:3:4:5:6:7:8:9",
    "gggg::",
    "1.2.3.-1",
  ])("rejects %s", (ip) => {
    expect(parseIp(ip)).toBeNull();
  });
});

describe("parseCidr", () => {
  test("normalizes the network address and computes the inclusive range", () => {
    expect(parseCidr("192.0.2.77/24")).toEqual({ family: 4, start: 0xc0000200n, end: 0xc00002ffn });
    expect(parseCidr("10.0.0.1")).toEqual({ family: 4, start: 0x0a000001n, end: 0x0a000001n });
    expect(parseCidr("0.0.0.0/0")).toEqual({ family: 4, start: 0n, end: 0xffffffffn });
    const v6 = parseCidr("2001:db8::/32")!;
    expect(v6.end - v6.start + 1n).toBe(1n << 96n);
  });

  test("rejects malformed prefixes", () => {
    expect(parseCidr("192.0.2.0/33")).toBeNull();
    expect(parseCidr("192.0.2.0/-1")).toBeNull();
    expect(parseCidr("192.0.2.0/24/1")).toBeNull();
    expect(parseCidr("2001:db8::/129")).toBeNull();
  });
});

describe("CidrClassifier", () => {
  const { classifier, invalidLines } = parseNetworkList(`
# comment
203.0.113.0/24   Example Hosting
10.0.0.0/8       Big Range
10.1.0.0/16      Nested
2001:db8::/32    Example v6
AS64500          Example Transit
not-a-cidr
999.1.1.1/8
`);

  test("reports invalid lines without failing", () => {
    expect(invalidLines).toEqual([8, 9]);
    expect(classifier.size).toBe(5);
  });

  test("matches IPv4, IPv6, mapped addresses and ASNs with labels", () => {
    expect(classifier.classify("203.0.113.9")).toEqual({
      hosting: true,
      label: "Example Hosting",
      asn: null,
      kind: "hosting",
    });
    expect(classifier.classify("::ffff:203.0.113.9").hosting).toBe(true);
    expect(classifier.classify("2001:db8:1::5")).toMatchObject({ hosting: true, label: "Example v6" });
    expect(classifier.classify(null, 64500)).toEqual({
      hosting: true,
      label: "Example Transit",
      asn: 64500,
      kind: "hosting",
    });
    expect(classifier.classify("198.51.100.1", 64501)).toEqual({ hosting: false, label: null, asn: 64501, kind: null });
  });

  test("class tokens: privacy relays are listed but labelled with the prefix; unknown classes are invalid", () => {
    const r = parseNetworkList(
      [
        "3fff::/20 class=privacy_relay Example Relay",
        "AS64600 class=privacy_relay",
        "192.0.2.0/24 class=hosting Example Host",
        "198.51.100.0/24 class=bogus Nope",
        "203.0.113.0/24 class=privacy_relay",
      ].join("\n"),
    );
    expect(r.invalidLines).toEqual([4]);
    expect(r.classifier.classify("3fff::1")).toEqual({
      hosting: true,
      label: `${PRIVACY_RELAY_LABEL_PREFIX}Example Relay`,
      asn: null,
      kind: "privacy_relay",
    });
    expect(r.classifier.classify(null, 64600)).toMatchObject({
      label: PRIVACY_RELAY_LABEL_PREFIX,
      kind: "privacy_relay",
    });
    expect(r.classifier.classify("192.0.2.1")).toMatchObject({ label: "Example Host", kind: "hosting" });
    expect(r.classifier.classify("203.0.113.1").label).toBe(PRIVACY_RELAY_LABEL_PREFIX);
    expect(r.classifier.classify("198.51.100.1").hosting).toBe(false);
  });

  test("the constructor still accepts plain ASN labels", () => {
    const c = new CidrClassifier([], new Map([[1, "One"]]));
    expect(c.classify(null, 1)).toEqual({ hosting: true, label: "One", asn: 1, kind: "hosting" });
  });

  test("finds addresses inside a large range that a later, smaller range does not cover", () => {
    expect(classifier.classify("10.200.0.1")).toMatchObject({ hosting: true, label: "Big Range" });
    expect(classifier.classify("10.1.2.3").hosting).toBe(true);
    expect(classifier.classify("11.0.0.0").hosting).toBe(false);
    expect(classifier.classify("9.255.255.255").hosting).toBe(false);
  });

  test("garbage input is never hosting", () => {
    expect(classifier.classify("not an ip").hosting).toBe(false);
    expect(classifier.classify("").hosting).toBe(false);
  });

  test("agrees with a linear scan on many random addresses", () => {
    const ranges = Array.from({ length: 300 }, (_, i) => {
      const start = BigInt((i * 7_919_993) % 4_000_000_000);
      const size = BigInt(1 + ((i * 104_729) % 5_000_000));
      return { family: 4 as const, start, end: start + size, label: `r${i}` };
    });
    const c = new CidrClassifier(ranges);
    for (let k = 0; k < 3000; k++) {
      const v = BigInt((k * 2_654_435_761) % 4_294_967_296);
      const ip = [24n, 16n, 8n, 0n].map((s) => String((v >> s) & 255n)).join(".");
      const linear = ranges.some((r) => r.start <= v && v <= r.end);
      expect(c.classify(ip).hosting, ip).toBe(linear);
    }
  });
});

describe("loading", () => {
  test("the bundled sample list parses cleanly and covers the documentation ranges", () => {
    const { classifier, invalidLines } = loadNetworkList(SAMPLE_HOSTING_CIDRS_FILE);
    expect(invalidLines).toEqual([]);
    for (const ip of ["192.0.2.10", "198.51.100.10", "203.0.113.10", "2001:db8::10"]) {
      expect(classifier.classify(ip).hosting, ip).toBe(true);
    }
    expect(classifier.classify(null, 14061).hosting).toBe(true);
    expect(classifier.classify("3fff::10").kind).toBe("privacy_relay");
    // Hyperscaler ASNs that also carry consumer traffic are not listed wholesale.
    for (const asn of [16509, 15169, 8075]) expect(classifier.classify(null, asn).hosting, `AS${asn}`).toBe(false);
  });

  test("env: unset means a classifier that matches nothing; a missing file is an error", () => {
    expect(classifierFromEnv({}).classifier.classify("192.0.2.1").hosting).toBe(false);
    expect(
      classifierFromEnv({ INTEGRITY_DATACENTER_CIDRS_FILE: SAMPLE_HOSTING_CIDRS_FILE }).classifier.size,
    ).toBeGreaterThan(5);
    expect(() => classifierFromEnv({ INTEGRITY_DATACENTER_CIDRS_FILE: "/nonexistent/list.txt" })).toThrow(/ENOENT/);
  });
});
