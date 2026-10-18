// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Viewbot behaviours must produce exactly the signals integrity is supposed to catch. */
import { describe, expect, test } from "vite-plus/test";
import type { ChatClient } from "../src/chat-client.ts";
import {
  AddressPool,
  DATACENTER_CIDRS_FILE,
  RESIDENTIAL_CIDRS_FILE,
  anyContains,
  cidrContains,
  intToIp,
  ipToInt,
  loadCidrList,
  parseCidr,
  parseCidrList,
  randomAddressIn,
  seededRandom,
} from "../src/cidrs.ts";
import {
  BOT_TIMING,
  HUMAN_TIMING,
  headlessFingerprint,
  looksHeadless,
  newDeviceId,
  nextHeartbeatDelay,
  realisticFingerprint,
} from "../src/fingerprint.ts";
import { summarize } from "../src/metrics.ts";
import type { SignedInUser } from "../src/users.ts";
import { HEADLESS_USER_AGENT, chatSpam, followBurst, planViewbots } from "../src/viewbot.ts";

const datacenter = loadCidrList(DATACENTER_CIDRS_FILE);
const residential = loadCidrList(RESIDENTIAL_CIDRS_FILE);

describe("CIDR lists", () => {
  test("parse, normalise and test membership", () => {
    const c = parseCidr("10.1.2.3/8");
    expect(c.text).toBe("10.0.0.0/8");
    expect(cidrContains(c, "10.255.255.255")).toBe(true);
    expect(cidrContains(c, "11.0.0.0")).toBe(false);
    expect(parseCidrList("# comment\n\n1.2.3.0/24 # trailing\n")).toHaveLength(1);
    expect(intToIp(ipToInt("203.0.113.9"))).toBe("203.0.113.9");
    expect(() => parseCidr("1.2.3.4/33")).toThrow(/invalid CIDR/);
    expect(() => ipToInt("1.2.3")).toThrow(/not an IPv4/);
    expect(() => ipToInt("1.2.3.256")).toThrow(/not an IPv4/);
  });

  test("random addresses stay inside the range and avoid network/broadcast", () => {
    const c = parseCidr("192.0.2.0/30");
    const rand = seededRandom(7);
    for (let i = 0; i < 50; i++) {
      const ip = randomAddressIn(c, rand);
      expect(["192.0.2.1", "192.0.2.2"]).toContain(ip);
    }
    expect(randomAddressIn(parseCidr("192.0.2.7/32"))).toBe("192.0.2.7");
  });

  test("bundled samples do not overlap", () => {
    expect(datacenter.length).toBeGreaterThan(5);
    const pool = new AddressPool(residential, seededRandom(1));
    for (let i = 0; i < 500; i++) expect(anyContains(datacenter, pool.next())).toBe(false);
  });

  test("pools hand out distinct addresses", () => {
    const pool = new AddressPool(datacenter, seededRandom(3));
    const ips = Array.from({ length: 300 }, () => pool.next());
    expect(new Set(ips).size).toBe(300);
    expect(() => new AddressPool([])).toThrow(/at least one CIDR/);
  });
});

describe("viewbot plans", () => {
  const plans = planViewbots({ channel: "c", sessions: 40, devices: 4 }, new AddressPool(datacenter, seededRandom(9)));

  test("every bot comes from a datacenter range", () => {
    expect(plans).toHaveLength(40);
    for (const p of plans) expect(anyContains(datacenter, p.clientIp)).toBe(true);
  });

  test("many sessions share a few devices", () => {
    const devices = new Set(plans.map((p) => p.deviceId));
    expect(devices.size).toBe(4);
    for (const d of devices) expect(plans.filter((p) => p.deviceId === d)).toHaveLength(10);
    for (const d of devices) expect(d.length).toBeGreaterThanOrEqual(16);
  });

  test("headless fingerprints and user agent", () => {
    for (const p of plans) {
      expect(looksHeadless(p.fingerprint)).toBe(true);
      expect(p.fingerprint.webdriver).toBe(true);
      expect(p.userAgent).toBe(HEADLESS_USER_AGENT);
    }
  });

  test("playlist-only by default, segments on request", () => {
    expect(plans.every((p) => !p.fetchSegments)).toBe(true);
    const fetching = planViewbots({ channel: "c", sessions: 2, playlistOnly: false }, new AddressPool(datacenter));
    expect(fetching.every((p) => p.fetchSegments)).toBe(true);
  });

  test("perfectly periodic heartbeats", () => {
    const delays = Array.from({ length: 50 }, () => nextHeartbeatDelay(10_000, plans[0]?.timing ?? BOT_TIMING));
    expect(new Set(delays)).toEqual(new Set([10_000]));
  });

  test("edge cases: no sessions, more devices than sessions", () => {
    expect(planViewbots({ channel: "c", sessions: 0 }, new AddressPool(datacenter))).toEqual([]);
    const few = planViewbots({ channel: "c", sessions: 3, devices: 10 }, new AddressPool(datacenter));
    expect(new Set(few.map((p) => p.deviceId)).size).toBe(3);
  });
});

describe("well-behaved viewers look human", () => {
  test("realistic fingerprints are not headless", () => {
    const rand = seededRandom(11);
    for (let i = 0; i < 100; i++) expect(looksHeadless(realisticFingerprint(rand))).toBe(false);
    expect(looksHeadless(headlessFingerprint())).toBe(true);
  });

  test("human heartbeat timing has jitter around the interval", () => {
    const rand = seededRandom(5);
    const delays = Array.from({ length: 400 }, () => nextHeartbeatDelay(10_000, HUMAN_TIMING, rand));
    const s = summarize(delays);
    expect(new Set(delays).size).toBeGreaterThan(300);
    expect(s.min ?? 0).toBeGreaterThanOrEqual(8_500);
    expect(Math.abs((s.p50 ?? 0) - 10_000)).toBeLessThan(500);
    // A few late beats (throttled tabs) exist, but they are rare.
    const late = delays.filter((d) => d > 11_500).length;
    expect(late).toBeGreaterThan(0);
    expect(late).toBeLessThan(40);
  });

  test("device ids are unique and contract-sized", () => {
    const ids = new Set(Array.from({ length: 100 }, newDeviceId));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id.length >= 16 && id.length <= 64).toBe(true);
  });
});

describe("follow bursts and chat spam", () => {
  test("fresh accounts from datacenter addresses all follow within the burst", async () => {
    const follows: string[] = [];
    const seenIps: string[] = [];
    const signUp = async (opts: { clientIp?: string }) => {
      seenIps.push(opts.clientIp ?? "");
      const id = crypto.randomUUID();
      return {
        id,
        api: {
          client: {
            channels: {
              follow: async ({ channel }: { channel: string }) => {
                follows.push(`${id}->${channel}`);
                return { following: true, followerCount: follows.length };
              },
            },
          },
        },
      } as unknown as SignedInUser;
    };
    const res = await followBurst({
      channel: "target",
      accounts: 12,
      signUp,
      addresses: new AddressPool(datacenter, seededRandom(2)),
    });
    expect(res.users).toHaveLength(12);
    expect(follows).toHaveLength(12);
    expect(follows.every((f) => f.endsWith("->target"))).toBe(true);
    expect(res.followedWithinMs).toBeLessThan(5_000);
    for (const ip of seenIps) expect(anyContains(datacenter, ip)).toBe(true);
  });

  test("spam sends identical messages at machine rate", async () => {
    const sent: string[] = [];
    const client = { isOpen: true, sendNoWait: (_c: string, body: string) => sent.push(body) } as unknown as ChatClient;
    const closed = { isOpen: false, sendNoWait: () => sent.push("never") } as unknown as ChatClient;
    const count = await chatSpam({ clients: [client, closed], channel: "c", ratePerSecond: 50, durationMs: 300 });
    expect(count).toBe(sent.length);
    expect(count).toBeGreaterThan(5);
    expect(new Set(sent).size).toBe(1);
    expect(sent).not.toContain("never");
  });
});
