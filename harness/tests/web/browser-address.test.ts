// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Simulated client addresses for browser sessions: the fleet hands each session its own address
 * from the residential ranges, and the web origin's requests carry it as `x-forwarded-for`.
 * browser-address.int.test.ts drives real browsers through a web and API stand-in.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import { stackProfiles } from "../../../scripts/infra.ts";
import { BrowserFleet } from "../../src/browser-viewer.ts";
import {
  AddressPool,
  DATACENTER_CIDRS_FILE,
  RESIDENTIAL_CIDRS_FILE,
  anyContains,
  loadCidrList,
  parseCidrList,
  seededRandom,
} from "../../src/cidrs.ts";
import { withSimulatedAddress } from "../../src/web/session.ts";

const residential = loadCidrList(RESIDENTIAL_CIDRS_FILE);
const datacenter = loadCidrList(DATACENTER_CIDRS_FILE);

describe("BrowserFleet.nextAddress", () => {
  test("distinct for every session, all residential, never datacenter", () => {
    const fleet = new BrowserFleet();
    const addresses = Array.from({ length: 500 }, () => fleet.nextAddress());
    expect(new Set(addresses).size).toBe(addresses.length);
    for (const ip of addresses) {
      expect(anyContains(residential, ip)).toBe(true);
      expect(anyContains(datacenter, ip)).toBe(false);
    }
  });

  test("draws from the pool it is given, shared with the run's API clients", () => {
    const cidrs = parseCidrList("198.51.100.0/24\n");
    const pool = new AddressPool(cidrs, seededRandom(7));
    const fleet = new BrowserFleet({ addresses: pool });
    const fromFleet = Array.from({ length: 50 }, () => fleet.nextAddress());
    const fromClients = Array.from({ length: 50 }, () => pool.next());
    for (const ip of fromFleet) expect(anyContains(cidrs, ip)).toBe(true);
    // One pool: a browser never gets an address an API client already has, or the reverse.
    expect(new Set([...fromFleet, ...fromClients]).size).toBe(100);
  });

  test("reproducible from the run's seed", () => {
    const a = new BrowserFleet({ addresses: new AddressPool(residential, seededRandom(42)) });
    const b = new BrowserFleet({ addresses: new AddressPool(residential, seededRandom(42)) });
    expect([a.nextAddress(), a.nextAddress()]).toEqual([b.nextAddress(), b.nextAddress()]);
  });
});

describe("withSimulatedAddress", () => {
  test("adds x-forwarded-for and keeps every other header", () => {
    expect(withSimulatedAddress({ accept: "*/*", "content-type": "application/json" }, "73.1.2.3")).toEqual({
      accept: "*/*",
      "content-type": "application/json",
      "x-forwarded-for": "73.1.2.3",
    });
  });

  test("replaces any x-forwarded-for the page sent, in any spelling", () => {
    expect(
      withSimulatedAddress({ "X-Forwarded-For": "203.0.113.9", "x-forwarded-for": "1.1.1.1" }, "73.1.2.3"),
    ).toEqual({ "x-forwarded-for": "73.1.2.3" });
  });
});

describe("the harness stack", () => {
  // The design rests on browsers reaching the web server directly: Caddy (profile `tls`) never
  // runs in a harness stack, and no harness override teaches it to trust a forwarded address.
  test("never starts Caddy, and no harness override configures it", () => {
    const profiles = stackProfiles(["--harness", "--multi", "--captions", "--w3", "--seed"]);
    expect(profiles).not.toContain("tls");
    const dir = fileURLToPath(new URL("../../", import.meta.url));
    const overrides = readdirSync(dir).filter((f) => /^compose\..+\.yaml$/.test(f));
    expect(overrides.length).toBeGreaterThan(10);
    for (const name of overrides) {
      const body = readFileSync(join(dir, name), "utf8");
      expect(body, name).not.toMatch(/^ {2}caddy:|trusted_proxies/m);
    }
  });
});
