// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Surge raids, pure (batch 7 decision (w), ADR 0039 §4): opening versus extending a surge, a
 * moderator's suppression winning, a lapsed key recorded first, and who carries (the carry window's
 * edges, unverified raiders, the per-address cap, stale values).
 */
import { describe, expect, test } from "vite-plus/test";
import { RAID_RULES } from "@commonair/contracts/enums";
import { SurgeOverride, type VerifiedWatchValue } from "@commonair/contracts/internal";
import { surgeRaidOf } from "@commonair/interact";
import { carriedSources, decideRaidSurge, raidSurgeResult, type SourceWatch } from "../src/chat-gate/raid.ts";

const NOW = new Date("2026-11-01T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const RAID = { fromChannel: "src", verifiedCount: 3 };
const RAID_UNTIL = at(RAID_RULES.surgeMinutes * 60_000);
const MOD = "0190f0aa-0000-7000-8000-00000000000d";

const on = (until: string, over: Partial<SurgeOverride> = {}): SurgeOverride => ({
  state: "on",
  since: at(-120_000),
  until,
  by: null,
  ...over,
});
const suppressed = (until: string): SurgeOverride => ({ state: "suppressed", since: at(-60_000), until, by: MOD });

describe("decideRaidSurge", () => {
  test("no surge: begins one for surgeMinutes, naming the raid", () => {
    const a = decideRaidSurge({ now: NOW, current: null, open: false, raid: RAID });
    expect(a).toEqual([
      { kind: "begin", next: { state: "on", since: NOW.toISOString(), until: RAID_UNTIL, by: null, raid: RAID } },
    ]);
    const next = raidSurgeResult(a);
    // The stored value is still a SurgeOverride (chat and the API parse it) and carries the raid.
    expect(SurgeOverride.parse(next)).toEqual({ state: "on", since: NOW.toISOString(), until: RAID_UNTIL, by: null });
    expect(surgeRaidOf(JSON.stringify(next))).toEqual(RAID);
  });

  test("a lapsed key with the begin marker still set: the end is recorded first, then the begin", () => {
    const a = decideRaidSurge({ now: NOW, current: null, open: true, raid: RAID });
    expect(a.map((x) => x.kind)).toEqual(["expired", "begin"]);
    expect(raidSurgeResult(a)?.until).toBe(RAID_UNTIL);
  });

  test("an open surge ending sooner is extended to the raid's length; since and by stay", () => {
    const current = on(at(60_000), { by: MOD });
    const a = decideRaidSurge({ now: NOW, current, open: true, raid: RAID });
    expect(a).toEqual([{ kind: "extend", next: { ...current, until: RAID_UNTIL, raid: RAID } }]);
  });

  test("an open surge ending later is never shortened, but the banner names the raid", () => {
    const current = on(at(45 * 60_000));
    const a = decideRaidSurge({ now: NOW, current, open: true, raid: RAID });
    expect(a).toEqual([{ kind: "extend", next: { ...current, raid: RAID } }]);
    expect(raidSurgeResult(a)?.until).toBe(current.until);
  });

  test("an open surge whose until just passed (the guard has not ended it yet) is extended", () => {
    const a = decideRaidSurge({ now: NOW, current: on(at(-1_000)), open: true, raid: RAID });
    expect(raidSurgeResult(a)?.until).toBe(RAID_UNTIL);
  });

  test("a raid replaces an earlier raid on the banner", () => {
    const current = on(at(300_000));
    const second = { fromChannel: "other", verifiedCount: 40 };
    const next = raidSurgeResult(decideRaidSurge({ now: NOW, current, open: true, raid: second }));
    expect(next?.raid).toEqual(second);
  });

  test("a moderator's suppression wins until it runs out", () => {
    expect(decideRaidSurge({ now: NOW, current: suppressed(at(1_000)), open: false, raid: RAID })).toEqual([]);
    expect(raidSurgeResult([])).toBeNull();
  });

  test("a suppression that ran out no longer blocks: the raid begins a surge", () => {
    for (const until of [at(0), at(-1_000)]) {
      const a = decideRaidSurge({ now: NOW, current: suppressed(until), open: false, raid: RAID });
      expect(a.map((x) => x.kind)).toEqual(["begin"]);
    }
  });
});

const SRC = "0190f0aa-0000-7000-8000-0000000000a1";
const SRC_B = "0190f0aa-0000-7000-8000-0000000000b1";
const OTHER_B = "0190f0aa-0000-7000-8000-0000000000b9";
const SECRET = "surge-raid-test-secret-0123456789abcdef";
const user = (n: number) => `0190f0aa-0000-7000-8000-${String(n).padStart(12, "0")}`;

function watch(n: number, over: Partial<SourceWatch> = {}): SourceWatch {
  const base: SourceWatch = {
    channelId: SRC,
    broadcastId: SRC_B,
    userId: user(n),
    ipHash: `ip-${n}`,
    privacyRelay: false,
    seconds: 600,
    firstAt: new Date(NOW.getTime() - 900_000 + n * 1_000),
    eligible: true,
    lastSeenAt: new Date(NOW.getTime() - 5_000),
    lastEligibleAt: null,
    ...over,
  };
  // By default the eligible sessions are the ones last seen.
  if (!("lastEligibleAt" in over)) base.lastEligibleAt = base.eligible ? base.lastSeenAt : null;
  return base;
}
const carried = (rows: SourceWatch[], stored = new Map<string, VerifiedWatchValue>(), perAddress = 5) =>
  carriedSources(rows, stored, SRC_B, NOW, perAddress, SECRET);

describe("carriedSources", () => {
  const edge = RAID_RULES.carryMinutes * 60_000;

  test("verified watchers seen within carryMinutes carry; unverified ones do not", () => {
    const out = carried([watch(1), watch(2), watch(3, { eligible: false, seconds: 0 })]);
    expect([...out.keys()].sort()).toEqual([user(1), user(2)]);
    expect(out.get(user(1))).toMatchObject({ b: SRC_B, f: 0 });
  });

  test("the carryMinutes edge: exactly at it carries, a millisecond past it does not", () => {
    const out = carried([
      watch(1, { lastSeenAt: new Date(NOW.getTime() - edge) }),
      watch(2, { lastSeenAt: new Date(NOW.getTime() - edge - 1) }),
    ]);
    expect([...out.keys()]).toEqual([user(1)]);
  });

  test("verified on another address within the window counts for the user", () => {
    const out = carried([
      watch(1, { ipHash: "a", eligible: false, seconds: 0, lastSeenAt: new Date(NOW.getTime() - 1_000) }),
      watch(1, { ipHash: "b", lastSeenAt: new Date(NOW.getTime() - 60_000) }),
    ]);
    expect(out.has(user(1))).toBe(true);
  });

  test("verified hours ago and only an unverified session now: no carry", () => {
    const out = carried([
      watch(1, { ipHash: "a", lastSeenAt: new Date(NOW.getTime() - 2 * 3_600_000) }),
      watch(1, { ipHash: "b", eligible: false, seconds: 0, lastSeenAt: new Date(NOW.getTime() - 1_000) }),
    ]);
    expect(out.has(user(1))).toBe(false);
  });

  test("an address with old verified watching and a recent unverified heartbeat: only the eligible time counts", () => {
    const out = carried([
      watch(1, {
        lastSeenAt: new Date(NOW.getTime() - 1_000),
        lastEligibleAt: new Date(NOW.getTime() - edge - 1),
      }),
      watch(2, { lastSeenAt: new Date(NOW.getTime() - 1_000), lastEligibleAt: new Date(NOW.getTime() - edge) }),
    ]);
    expect([...out.keys()]).toEqual([user(2)]);
  });

  test("the source seconds are carried as they are (minus the jitter), not raised", () => {
    const out = carried([watch(1, { seconds: 20 })]);
    expect(out.get(user(1))?.s).toBeLessThanOrEqual(20);
  });

  test("the per-address cap applies: a farm behind one address carries only its first accounts", () => {
    const rows = [1, 2, 3, 4].map((n) => watch(n, { ipHash: "farm" }));
    expect([...carried(rows, undefined, 2).keys()].sort()).toEqual([user(1), user(2)]);
  });

  test("a privacy-relay watcher carries with the fallback flag", () => {
    const out = carried([watch(1, { privacyRelay: true, ipHash: "relay" })]);
    expect(out.get(user(1))?.f).toBe(1);
  });

  test("a stored source value carries too (a key the scoring pass wrote), if seen in the window", () => {
    const stored = new Map<string, VerifiedWatchValue>([
      [user(1), { b: SRC_B, s: 90, f: 1 }],
      [user(2), { b: SRC_B, s: 90, f: 0 }],
    ]);
    // user 1's sessions are not eligible now (re-scored), but the scoring pass's key still stands.
    const out = carried(
      [
        watch(1, { eligible: false, seconds: 0 }),
        watch(2, { eligible: false, seconds: 0, lastSeenAt: new Date(NOW.getTime() - edge - 1) }),
      ],
      stored,
    );
    expect([...out.entries()]).toEqual([[user(1), { b: SRC_B, s: 90, f: 1 }]]);
  });

  test("a stored value for another broadcast is stale", () => {
    const stored = new Map<string, VerifiedWatchValue>([[user(1), { b: OTHER_B, s: 900, f: 0 }]]);
    expect(carried([watch(1, { eligible: false, seconds: 0 })], stored).size).toBe(0);
  });

  test("nobody watching, nobody carries", () => {
    expect(carried([]).size).toBe(0);
  });
});
