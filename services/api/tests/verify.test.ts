// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from "vite-plus/test";
import {
  isConsistent,
  nextVerdict,
  type HeartbeatFacts,
  type Verdict,
  type VerifyState,
} from "../src/playback/verify.ts";

const hb = (over: Partial<HeartbeatFacts> = {}): HeartbeatFacts => ({
  playedSeconds: 10,
  wallSeconds: 10,
  visible: true,
  muted: false,
  ...over,
});

function run(beats: HeartbeatFacts[], start: Verdict = "pending") {
  let verdict = start;
  let state: VerifyState = { consistent: 0, engaged: false };
  const history: Verdict[] = [];
  for (const b of beats) {
    ({ verdict, state } = nextVerdict(verdict, state, b));
    history.push(verdict);
  }
  return history;
}

test("consistency is played ≈ wall clock ±50%", () => {
  expect(isConsistent({ playedSeconds: 10, wallSeconds: 10 })).toBe(true);
  expect(isConsistent({ playedSeconds: 5, wallSeconds: 10 })).toBe(true);
  expect(isConsistent({ playedSeconds: 15, wallSeconds: 10 })).toBe(true);
  expect(isConsistent({ playedSeconds: 4.9, wallSeconds: 10 })).toBe(false);
  expect(isConsistent({ playedSeconds: 15.1, wallSeconds: 10 })).toBe(false);
  expect(isConsistent({ playedSeconds: 0, wallSeconds: 0 })).toBe(false);
  expect(isConsistent({ playedSeconds: 1, wallSeconds: -1 })).toBe(false);
});

test("verified after 3 consistent heartbeats", () => {
  expect(run([hb(), hb(), hb()])).toEqual(["pending", "pending", "verified"]);
});

test("inconsistent heartbeats do not count (but do not reset)", () => {
  expect(run([hb(), hb({ playedSeconds: 60 }), hb(), hb({ playedSeconds: 0 }), hb()])).toEqual([
    "pending",
    "pending",
    "pending",
    "pending",
    "verified",
  ]);
});

test("must be visible or unmuted at least once", () => {
  const hidden = hb({ visible: false, muted: true });
  expect(run([hidden, hidden, hidden, hidden])).toEqual(["pending", "pending", "pending", "pending"]);
  // Engagement once is enough, even before the consistent beats.
  expect(run([hb({ visible: false, muted: false }), hidden, hidden])).toEqual(["pending", "pending", "verified"]);
  expect(run([hidden, hidden, hb({ visible: true, muted: true })])).toEqual(["pending", "pending", "verified"]);
});

test("excluded is never promoted; verified stays verified", () => {
  expect(run([hb(), hb(), hb(), hb()], "excluded")).toEqual(["excluded", "excluded", "excluded", "excluded"]);
  expect(run([hb({ playedSeconds: 0 })], "verified")).toEqual(["verified"]);
});

test("heartbeats closer than 5 s of server time never count: no sub-15 s verification", () => {
  expect(isConsistent({ playedSeconds: 1, wallSeconds: 1 })).toBe(false);
  expect(isConsistent({ playedSeconds: 4.9, wallSeconds: 4.99 })).toBe(false);
  expect(isConsistent({ playedSeconds: 5, wallSeconds: 5 })).toBe(true);
  const fast = hb({ playedSeconds: 0.3, wallSeconds: 0.3 });
  expect(run(Array.from({ length: 50 }, () => fast)).at(-1)).toBe("pending");
  const slow = hb({ playedSeconds: 5, wallSeconds: 5 });
  expect(run([slow, slow, slow]).at(-1)).toBe("verified");
});
