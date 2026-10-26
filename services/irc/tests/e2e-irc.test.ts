// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The pure parts of the self-host e2e IRC check (scripts/selfhost/e2e-irc.ts). */
import { ircEnv } from "@commonair/config";
import { describe, expect, test } from "vite-plus/test";
import {
  IRC_DEFAULTS,
  IRC_IMAGE,
  IRC_SOURCES,
  PER_IP_REFUSAL,
  PROBE_SCRIPT,
  REGISTRATION_TIMEOUT_MS,
  checkIrcClientAddresses,
  connectDelays,
  judgeProbe,
  parseProbe,
  probeCommand,
  probePlan,
  type ProbeResult,
} from "../../../scripts/selfhost/e2e-irc.ts";
import { Admission, DEFAULT_CONNECTION_LIMITS, REFUSAL_TEXT } from "../src/admission.ts";
import { LIMITS } from "../src/constants.ts";

const pass: ProbeResult = {
  held: IRC_DEFAULTS.maxPerIp,
  overPlain: PER_IP_REFUSAL,
  overTls: PER_IP_REFUSAL,
  other: "PONG",
  tls: "PONG",
  tlsAuthorized: true,
  elapsedMs: 21_000,
};

describe("constants match the gateway", () => {
  test("defaults, refusal text and registration timeout", () => {
    const env = ircEnv.parse({});
    expect(IRC_DEFAULTS).toEqual({
      maxPerIp: env.IRC_MAX_CONNECTIONS_PER_IP,
      connectBurstPerIp: env.IRC_CONNECT_BURST_PER_IP,
      connectPerSecondPerIp: env.IRC_CONNECT_PER_SECOND_PER_IP,
    });
    expect(DEFAULT_CONNECTION_LIMITS).toMatchObject(IRC_DEFAULTS);
    expect(PER_IP_REFUSAL).toBe(`ERROR :Closing Link: ${REFUSAL_TEXT.too_many_from_ip}`);
    expect(REGISTRATION_TIMEOUT_MS).toBe(LIMITS.registrationTimeoutMs);
  });

  test("three distinct loopback sources, none the default 127.0.0.1", () => {
    expect(new Set(Object.values(IRC_SOURCES)).size).toBe(3);
    expect(Object.values(IRC_SOURCES)).not.toContain("127.0.0.1");
  });
});

describe("connectDelays", () => {
  /** Replays the delays (plus `jitterMs` of slack each) through the real admission rules. */
  function replay(delays: number[], extra: number[], jitterMs = 0) {
    let now = 0;
    const admission = new Admission(DEFAULT_CONNECTION_LIMITS, () => now);
    try {
      const results = [...delays, ...extra].map((d) => {
        now += d + (d > 0 ? jitterMs : 0);
        return admission.admit("127.0.0.2");
      });
      return { results, elapsed: now };
    } finally {
      admission.stop();
    }
  }

  test("the default plan fills the cap without a rate refusal; the next one is refused per address", () => {
    const plan = probePlan({ ca: "x" });
    expect(plan.delays.length).toBe(50);
    const { results, elapsed } = replay(plan.delays, [plan.laterDelayMs, plan.laterDelayMs]);
    expect(results.slice(0, 50)).toEqual(Array(50).fill(null));
    expect(results.slice(50)).toEqual(["too_many_from_ip", "too_many_from_ip"]);
    // Well inside the registration timeout, which drops unregistered connections.
    expect(elapsed).toBeLessThan(REGISTRATION_TIMEOUT_MS - 5000);
  });

  test("timer slack (early or late) does not cause a rate refusal", () => {
    const plan = probePlan({ ca: "x" });
    expect(replay(plan.delays, [], -100).results).toEqual(Array(50).fill(null));
    expect(replay(plan.delays, [], 300).results).toEqual(Array(50).fill(null));
  });

  test("edge cases", () => {
    expect(connectDelays(0, 20, 2)).toEqual([]);
    expect(connectDelays(3, 1, 1)).toEqual([1250, 1250, 1250]);
    expect(connectDelays(3, 2, 1)).toEqual([1250, 1250, 1250]);
    expect(connectDelays(3, 4, 1)).toEqual([0, 0, 1250]);
    expect(connectDelays(2, 20, 4)).toEqual([0, 0]);
  });
});

describe("parseProbe and judgeProbe", () => {
  const plan = probePlan({ ca: "pem" });

  test("the last JSON line wins; noise and garbage are tolerated", () => {
    expect(parseProbe(`pulling image\n${JSON.stringify(pass)}\n`)).toEqual(pass);
    expect(parseProbe("")).toBeNull();
    expect(parseProbe("{not json")).toBeNull();
  });

  test("a passing result passes every check", () => {
    const checks = judgeProbe(pass, plan);
    expect(checks.length).toBe(6);
    expect(checks.filter(([ok]) => !ok)).toEqual([]);
  });

  test.each<[string, Partial<ProbeResult>, RegExp]>([
    [
      "one shared address (rootlessport): the other source is refused",
      { other: PER_IP_REFUSAL },
      /different IRC client/,
    ],
    ["too few held", { held: 49 }, /49 answered/],
    ["over-cap admitted", { overPlain: "PONG" }, /refused per address/],
    ["rate refusal instead", { overTls: "ERROR :Closing Link: Reconnecting too fast" }, /\(TLS\) is refused/],
    ["TLS unverified", { tlsAuthorized: false }, /internal CA/],
    ["TLS failed", { tls: "fail: ECONNREFUSED" }, /internal CA/],
    ["too slow", { elapsedMs: 31_000 }, /time out/],
  ])("%s fails", (_, change, what) => {
    const failed = judgeProbe({ ...pass, ...change }, plan).filter(([ok]) => !ok);
    expect(failed.length).toBe(1);
    expect(failed[0]?.[1]).toMatch(what);
  });

  test("no result is one failure", () => {
    expect(judgeProbe(null, plan)).toEqual([[false, "the IRC probe printed a result"]]);
  });
});

describe("checkIrcClientAddresses", () => {
  test("reads the CA, runs the probe in the IRC image on the host network, reports every check", () => {
    const calls: { script: string; env?: Record<string, string> }[] = [];
    const reported: [boolean, string][] = [];
    const inHost = (script: string, opts?: { user?: boolean; env?: Record<string, string> }) => {
      calls.push({ script, ...(opts?.env ? { env: opts.env } : {}) });
      expect(opts?.user).toBe(true);
      return script.startsWith("cat ")
        ? "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n"
        : `${JSON.stringify(pass)}\n`;
    };
    checkIrcClientAddresses(inHost, (ok, what) => reported.push([ok, what]));
    expect(calls.length).toBe(2);
    expect(calls[0]?.script).toContain("commonair-caddy-data");
    expect(calls[1]?.script).toBe(probeCommand());
    expect(probeCommand()).toContain("--network host");
    expect(probeCommand()).toContain(IRC_IMAGE);
    expect(calls[1]?.env?.IRC_PROBE_SCRIPT).toBe(PROBE_SCRIPT);
    const sent = JSON.parse(calls[1]?.env?.IRC_PROBE ?? "{}") as ReturnType<typeof probePlan>;
    expect(sent.tls).toEqual({
      ca: "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n",
      servername: "selfhost.test",
    });
    expect(sent.sources).toEqual(IRC_SOURCES);
    expect(reported.length).toBe(7);
    expect(reported.every(([ok]) => ok)).toBe(true);
  });

  test("a failing check is reported as failing", () => {
    const reported: [boolean, string][] = [];
    checkIrcClientAddresses(
      (script) =>
        script.startsWith("cat ") ? "-----BEGIN CERTIFICATE-----" : JSON.stringify({ ...pass, other: PER_IP_REFUSAL }),
      (ok, what) => reported.push([ok, what]),
    );
    expect(reported.filter(([ok]) => !ok).map(([, w]) => w)).toEqual([expect.stringContaining("different IRC client")]);
  });
});
