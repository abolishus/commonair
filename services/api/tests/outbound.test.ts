// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import type { Deps } from "../src/deps.ts";
import { outboundUrlProblem, type OutboundPolicy } from "../src/lib/outbound.ts";
import { relayTargetProblem } from "../src/routes/relays.ts";

const DNS: Record<string, string[]> = {
  "relay.example.test": ["93.184.216.250"],
  "rebind.example.test": ["10.0.0.5"],
  "metadata.example.test": ["169.254.169.254"],
  "mixed.example.test": ["93.184.216.34", "127.0.0.1"],
  "v6.example.test": ["2606:4700:4700::1111"],
  "v6local.example.test": ["fd00::1"],
  "mapped.example.test": ["::ffff:127.0.0.1"],
  "cgnat.example.test": ["100.64.1.1"],
  "live.twitch.example.test": ["93.184.216.35"],
};
const resolve = async (host: string) => {
  const a = DNS[host];
  if (!a) throw new Error("ENOTFOUND");
  return a;
};
const rtmp: OutboundPolicy = { protocols: ["rtmp:", "rtmps:"], allowPrivate: false, resolve };
const https: OutboundPolicy = { protocols: ["https:"], allowPrivate: false, resolve };

describe("outboundUrlProblem (production)", () => {
  test.each([
    "rtmp://live.twitch.example.test/app",
    "rtmps://live.twitch.example.test:443/app",
    "rtmp://93.184.216.34/live",
    "rtmp://[2606:4700:4700::1111]/live",
    "rtmp://v6.example.test/live",
  ])("allows %s", async (url) => {
    expect(await outboundUrlProblem(url, rtmp)).toBeNull();
  });

  test.each([
    ["rtmp://127.0.0.1/live", "non-public address"],
    ["rtmp://10.1.2.3/live", "non-public address"],
    ["rtmp://169.254.169.254/latest", "non-public address"],
    ["rtmp://100.64.0.1/live", "non-public address"],
    ["rtmp://224.0.0.1/live", "non-public address"],
    ["rtmp://[::1]/live", "non-public address"],
    ["rtmp://[::ffff:127.0.0.1]/live", "non-public address"],
    ["rtmp://[::ffff:a9fe:a9fe]/live", "non-public address"],
    ["rtmp://[fe80::1]/live", "non-public address"],
    ["rtmp://[fc00::1]/live", "non-public address"],
    ["rtmp://[64:ff9b::a00:1]/live", "non-public address"],
    ["rtmp://localhost/live", "non-public host"],
    ["rtmp://media.localhost/live", "non-public host"],
    ["rtmp://metadata.google.internal/live", "non-public host"],
    ["rtmp://garage/live", "non-public host"],
    ["rtmp://2130706433/live", "non-public host"], // decimal 127.0.0.1
    ["rtmp://rebind.example.test/live", "resolves to a non-public address"],
    ["rtmp://metadata.example.test/live", "resolves to a non-public address"],
    ["rtmp://mixed.example.test/live", "resolves to a non-public address"],
    ["rtmp://v6local.example.test/live", "resolves to a non-public address"],
    ["rtmp://mapped.example.test/live", "resolves to a non-public address"],
    ["rtmp://cgnat.example.test/live", "resolves to a non-public address"],
    ["rtmp://nxdomain.example.test/live", "unresolvable"],
    ["http://live.twitch.example.test/app", "protocol"],
    ["file:///etc/passwd", "protocol"],
    ["rtmp://user:pw@live.twitch.example.test/app", "credentials"],
    ["not a url", "unparseable"],
  ])("refuses %s (%s)", async (url, reason) => {
    expect(await outboundUrlProblem(url, rtmp)).toBe(reason);
  });

  test("special-scheme IPv4 spellings are normalized and refused", async () => {
    expect(await outboundUrlProblem("https://0x7f.0.0.1/", https)).toBe("non-public address");
    expect(await outboundUrlProblem("https://2130706433/", https)).toBe("non-public address");
    expect(await outboundUrlProblem("https://017700000001/", https)).toBe("non-public address");
  });

  test("development allows private targets but still checks the protocol", async () => {
    const dev = { ...rtmp, allowPrivate: true };
    expect(await outboundUrlProblem("rtmp://localhost/live", dev)).toBeNull();
    expect(await outboundUrlProblem("rtmp://10.0.0.1/live", dev)).toBeNull();
    expect(await outboundUrlProblem("http://localhost/live", dev)).toBe("protocol");
  });
});

describe("relayTargetProblem", () => {
  const deps = (NODE_ENV: string) => ({ env: { NODE_ENV }, resolveHost: resolve }) as unknown as Deps;

  test("production: https only, public hosts only", async () => {
    expect(await relayTargetProblem(deps("production"), "https://relay.example.test")).toBeNull();
    expect(await relayTargetProblem(deps("production"), "http://relay.example.test")).toBe("protocol");
    expect(await relayTargetProblem(deps("production"), "https://rebind.example.test")).not.toBeNull();
    expect(await relayTargetProblem(deps("production"), "https://127.0.0.1:8443")).not.toBeNull();
  });

  test("development: http allowed and private hosts allowed", async () => {
    expect(await relayTargetProblem(deps("development"), "http://127.0.0.1:8080")).toBeNull();
    expect(await relayTargetProblem(deps("test"), "http://localhost:8080")).toBeNull();
    expect(await relayTargetProblem(deps("test"), "ftp://localhost")).toBe("protocol");
  });
});
