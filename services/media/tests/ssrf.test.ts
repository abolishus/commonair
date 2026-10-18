// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  expandV6,
  isBlockedAddress,
  parseTargetUrl,
  resolveTarget,
  TargetNotAllowedError,
  type Resolver,
} from "../src/net/ssrf.ts";

const rejection = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err instanceof TargetNotAllowedError ? err.reason : "other";
  }
  return null;
};

describe("parseTargetUrl", () => {
  test("splits app, play-path prefix and tcUrl like ffmpeg, with protocol default ports", () => {
    expect(parseTargetUrl("rtmp://live.twitch.tv/app")).toEqual({
      protocol: "rtmp:",
      host: "live.twitch.tv",
      port: 1935,
      app: "app",
      playpathPrefix: "",
      tcUrl: "rtmp://live.twitch.tv/app",
    });
    expect(parseTargetUrl("rtmps://a.rtmp.youtube.com:443/live2/")).toMatchObject({
      protocol: "rtmps:",
      port: 443,
      app: "live2",
      playpathPrefix: "",
      tcUrl: "rtmps://a.rtmp.youtube.com:443/live2",
    });
    expect(parseTargetUrl("RTMP://Host.Example:1940/a/b/c")).toMatchObject({
      host: "host.example",
      port: 1940,
      app: "a",
      playpathPrefix: "b/c",
      tcUrl: "rtmp://host.example:1940/a",
    });
    expect(parseTargetUrl("rtmp://[2001:4860::1]/live").host).toBe("2001:4860::1");
    expect(parseTargetUrl("rtmp://[2001:4860::1]/live").tcUrl).toBe("rtmp://[2001:4860::1]/live");
  });

  test("whitelists rtmp and rtmps only", () => {
    for (const url of [
      "http://example.com/live",
      "https://example.com/live",
      "rtsp://example.com/live",
      "srt://example.com:9000",
      "file:///etc/passwd",
      "gopher://example.com/",
      "tcp://example.com:1935",
      "concat:rtmp://a|rtmp://b",
      "subfile:rtmp://example.com",
      "data:text/plain,hi",
    ])
      expect(
        rejection(() => parseTargetUrl(url)),
        url,
      ).not.toBeNull();
    expect(rejection(() => parseTargetUrl("http://example.com/live"))).toBe("protocol_not_allowed");
  });

  test("refuses credentials, missing hosts and junk", () => {
    expect(rejection(() => parseTargetUrl("rtmp://user:pw@example.com/live"))).toBe("credentials_in_url");
    expect(rejection(() => parseTargetUrl("rtmp://user@example.com/live"))).toBe("credentials_in_url");
    expect(rejection(() => parseTargetUrl("rtmp:///live"))).toBe("invalid_url");
    expect(rejection(() => parseTargetUrl("not a url"))).toBe("invalid_url");
  });
});

describe("isBlockedAddress", () => {
  test.each([
    "127.0.0.1",
    "127.255.255.254",
    "0.0.0.0",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "169.254.0.1",
    "100.64.0.1",
    "100.127.255.255",
    "100.100.100.200",
    "192.0.0.170",
    "192.0.2.1",
    "198.18.0.1",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
  ])("IPv4 %s is blocked", (ip) => expect(isBlockedAddress(ip)).toBe(true));

  test.each([
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:0:a9fe:a9fe",
    "::127.0.0.1",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b::10.0.0.1",
    "64:ff9b:1::1",
    "2002:7f00:1::1",
    "2002:c0a8:101::",
    "2001::1",
    "2001:db8::1",
    "fc00::1",
    "fd00:ec2::254",
    "fe80::1",
    "fe80::1%eth0",
    "febf:ffff::1",
    "fec0::1",
    "ff02::1",
    "100::1",
  ])("IPv6 %s is blocked", (ip) => expect(isBlockedAddress(ip)).toBe(true));

  test.each([
    "8.8.8.8",
    "1.1.1.1",
    "100.63.255.255",
    "100.128.0.0",
    "172.15.255.255",
    "172.32.0.0",
    "169.253.255.255",
    "192.169.0.1",
    "52.223.192.1",
    "2001:4860:4860::8888",
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "2002:808:808::1",
  ])("public %s is allowed", (ip) => expect(isBlockedAddress(ip)).toBe(false));

  test("non-literals and malformed addresses are refused", () => {
    for (const s of ["example.com", "", "1.2.3", "1.2.3.256", ":::", "1::2::3", "gggg::1"])
      expect(isBlockedAddress(s), s).toBe(true);
  });

  test("expandV6 handles compression and embedded IPv4", () => {
    expect(expandV6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandV6("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
    expect(expandV6("2001:db8::")).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]);
    expect(expandV6("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(expandV6("1:2:3:4:5:6:7")).toBeNull();
    expect(expandV6("1:2:3:4:5:6:7:8:9")).toBeNull();
  });
});

describe("resolveTarget", () => {
  const fake =
    (map: Record<string, string[]>): Resolver =>
    async (host) =>
      (map[host] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

  test("returns a vetted public address", async () => {
    const t = parseTargetUrl("rtmp://ingest.example.net/live");
    await expect(resolveTarget(t, { resolver: fake({ "ingest.example.net": ["203.0.114.5"] }) })).resolves.toEqual({
      address: "203.0.114.5",
      family: 4,
    });
  });

  test("refuses a name with any non-public address (rebinding-style mixed answers)", async () => {
    const t = parseTargetUrl("rtmp://evil.example/live");
    const resolver = fake({ "evil.example": ["8.8.8.8", "169.254.169.254"] });
    await expect(resolveTarget(t, { resolver })).rejects.toMatchObject({ reason: "address_not_allowed" });
  });

  test("refuses IP literals in blocked ranges and names that resolve to nothing", async () => {
    await expect(resolveTarget(parseTargetUrl("rtmp://127.0.0.1/live"))).rejects.toBeInstanceOf(TargetNotAllowedError);
    await expect(resolveTarget(parseTargetUrl("rtmp://[::ffff:127.0.0.1]/live"))).rejects.toBeInstanceOf(
      TargetNotAllowedError,
    );
    await expect(
      resolveTarget(parseTargetUrl("rtmp://nothing.example/live"), { resolver: fake({}) }),
    ).rejects.toMatchObject({ reason: "address_not_allowed" });
  });

  test("decimal-encoded hosts are judged by what they resolve to", async () => {
    const t = parseTargetUrl("rtmp://2130706433/live");
    await expect(resolveTarget(t, { resolver: fake({ "2130706433": ["127.0.0.1"] }) })).rejects.toMatchObject({
      reason: "address_not_allowed",
    });
  });

  test("allowPrivate (dev/test) permits loopback", async () => {
    await expect(resolveTarget(parseTargetUrl("rtmp://127.0.0.1:1936/live"), { allowPrivate: true })).resolves.toEqual({
      address: "127.0.0.1",
      family: 4,
    });
  });
});
