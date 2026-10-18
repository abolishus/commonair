// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { CallbackRejected, classifyAddress, resolveCallback, type Resolver } from "../src/webhooks/ssrf.ts";

describe("classifyAddress: IPv4", () => {
  test.each([
    ["8.8.8.8", "public"],
    ["1.1.1.1", "public"],
    ["0.0.0.0", "unspecified"],
    ["0.1.2.3", "unspecified"],
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["10.0.0.1", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["172.32.0.1", "public"],
    ["172.15.255.255", "public"],
    ["192.168.1.1", "private"],
    ["100.64.0.1", "shared"],
    ["100.127.255.255", "shared"],
    ["100.128.0.1", "public"],
    ["169.254.169.254", "metadata"],
    ["169.254.1.1", "link-local"],
    ["192.0.0.8", "reserved"],
    ["192.0.2.1", "documentation"],
    ["198.51.100.7", "documentation"],
    ["203.0.113.9", "documentation"],
    ["198.18.0.1", "reserved"],
    ["224.0.0.1", "multicast"],
    ["239.255.255.250", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "reserved"],
  ])("%s → %s", (ip, cls) => {
    expect(classifyAddress(ip)).toBe(cls);
  });

  test.each(["256.1.1.1", "1.2.3", "1.2.3.4.5", "01x.1.1.1", "", "a.b.c.d"])("invalid: %s", (ip) => {
    expect(classifyAddress(ip)).toBe("invalid");
  });
});

describe("classifyAddress: IPv6", () => {
  test.each([
    ["2606:4700:4700::1111", "public"],
    ["2001:4860:4860::8888", "public"],
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["[::1]", "loopback"],
    ["0:0:0:0:0:0:0:1", "loopback"],
    ["fe80::1", "link-local"],
    ["fe80::1%en0", "link-local"],
    ["fc00::1", "private"],
    ["fd12:3456::1", "private"],
    ["fd00:ec2::254", "metadata"],
    ["fec0::1", "private"],
    ["ff02::1", "multicast"],
    ["2001:db8::1", "documentation"],
    ["2001:0:4136:e378::1", "reserved"],
    ["100::1", "reserved"],
    ["4000::1", "reserved"],
  ])("%s → %s", (ip, cls) => {
    expect(classifyAddress(ip)).toBe(cls);
  });

  test.each([
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:7f00:1", "loopback"],
    ["::ffff:10.1.2.3", "private"],
    ["::ffff:169.254.169.254", "metadata"],
    ["::ffff:8.8.8.8", "public"],
    ["::127.0.0.1", "loopback"],
    ["::ffff:0:127.0.0.1", "loopback"],
    ["64:ff9b::7f00:1", "loopback"],
    ["64:ff9b::808:808", "public"],
    ["64:ff9b:1::808:808", "reserved"],
    ["64:ff9b:1:abcd::1", "reserved"],
    ["64:ff9b:0:0:1::808:808", "reserved"],
    ["64:ff9b:ffff::1", "reserved"],
    ["2002:7f00:1::", "loopback"],
    ["2002:0808:0808::1", "public"],
  ])("embedded IPv4 %s → %s", (ip, cls) => {
    expect(classifyAddress(ip)).toBe(cls);
  });

  test.each(["1::2::3", "12345::1", "1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7", "::ffff:300.1.1.1", "g::1", ":"])(
    "invalid: %s",
    (ip) => {
      expect(classifyAddress(ip)).toBe("invalid");
    },
  );
});

const resolver =
  (answers: Record<string, string[]>): Resolver =>
  async (host) => {
    const a = answers[host];
    if (!a) throw new Error("ENOTFOUND");
    return a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };

async function reason(url: string, opts: { allowInsecure?: boolean; answers?: Record<string, string[]> } = {}) {
  try {
    await resolveCallback(url, { allowInsecure: opts.allowInsecure ?? false, resolve: resolver(opts.answers ?? {}) });
    return "accepted";
  } catch (err) {
    return err instanceof CallbackRejected ? err.reason : `unexpected error: ${String(err)}`;
  }
}

describe("resolveCallback", () => {
  test("accepts https with public answers and pins the first address", async () => {
    const t = await resolveCallback("https://hooks.example.com/cb?x=1", {
      allowInsecure: false,
      resolve: resolver({ "hooks.example.com": ["93.184.216.34", "2606:2800:220:1::1"] }),
    });
    expect(t.hostname).toBe("hooks.example.com");
    expect(t.address).toEqual({ address: "93.184.216.34", family: 4 });
  });

  test("refuses http unless insecure callbacks are allowed", async () => {
    expect(await reason("http://hooks.example.com/", { answers: { "hooks.example.com": ["8.8.8.8"] } })).toBe(
      "scheme must be https",
    );
    expect(
      await reason("http://hooks.example.com/", { allowInsecure: true, answers: { "hooks.example.com": ["8.8.8.8"] } }),
    ).toBe("accepted");
    expect(await reason("ftp://hooks.example.com/", { allowInsecure: true })).toBe("scheme must be http or https");
  });

  test("refuses private, loopback and metadata answers", async () => {
    expect(await reason("https://internal.example/", { answers: { "internal.example": ["10.0.0.5"] } })).toBe(
      "address is private",
    );
    expect(await reason("https://localhost/")).toBe("host does not resolve");
    expect(await reason("https://localhost/", { answers: { localhost: ["127.0.0.1", "::1"] } })).toBe(
      "address is loopback",
    );
    expect(await reason("https://169.254.169.254/latest/meta-data/")).toBe("address is metadata");
  });

  test("refuses a mixed answer set (rebinding setup)", async () => {
    expect(await reason("https://rebind.example/", { answers: { "rebind.example": ["8.8.8.8", "127.0.0.1"] } })).toBe(
      "address is loopback",
    );
  });

  test("decimal, octal, hex and short host forms normalize to the loopback address", async () => {
    for (const host of ["2130706433", "017700000001", "0x7f000001", "0x7f.1", "127.1", "0177.0.0.1"])
      expect(await reason(`https://${host}/`)).toBe("address is loopback");
    expect(await reason("https://0/")).toBe("address is unspecified");
  });

  test("IPv6 literals, including mapped IPv4, are classified", async () => {
    expect(await reason("https://[::1]/")).toBe("address is loopback");
    expect(await reason("https://[::ffff:127.0.0.1]/")).toBe("address is loopback");
    expect(await reason("https://[::ffff:a9fe:a9fe]/")).toBe("address is metadata");
    expect(await reason("https://[2606:4700:4700::1111]/")).toBe("accepted");
  });

  test("refuses credentials, garbage and unresolvable hosts", async () => {
    expect(
      await reason("https://user:pass@hooks.example.com/", { answers: { "hooks.example.com": ["8.8.8.8"] } }),
    ).toBe("credentials in URL");
    expect(await reason("not a url")).toBe("invalid URL");
    expect(await reason("https://nowhere.example/")).toBe("host does not resolve");
  });

  test("insecure mode still pins the address but allows private targets", async () => {
    const t = await resolveCallback("http://receiver.local:8080/x", {
      allowInsecure: true,
      resolve: resolver({ "receiver.local": ["192.168.1.20"] }),
    });
    expect(t.address.address).toBe("192.168.1.20");
  });
});
