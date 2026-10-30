// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The verified-watch gate in `checkGates` (ADR 0015 decisions 4, 5 and 7). Pure. */
import { describe, expect, test } from "vite-plus/test";
import { canChatHint, checkGates, type GateInput, VERIFIED_WATCH_REFUSAL } from "../src/rules.ts";
import type { WatchGateState } from "../src/types.ts";
import { channel, NOW, standing, user } from "./fixtures.ts";

const BROADCAST = "00000000-0000-7000-8000-0000000000d1";
const DAY = 86_400_000;

const gate = (over: Partial<WatchGateState> = {}): WatchGateState => ({
  requiredSeconds: 60,
  verified: null,
  surgeExempt: false,
  fallbackAccountAgeDays: 7,
  unavailable: false,
  ...over,
});
const watched = (seconds: number, fallback = false) => ({ broadcastId: BROADCAST, seconds, fallback });

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    user: user(),
    scopes: ["chat:read", "chat:edit"],
    channel: channel({ minVerifiedWatchSeconds: 60 }, { liveBroadcastId: BROADCAST }),
    standing: standing({ verifiedWatch: gate() }),
    emoteOnly: false,
    now: NOW,
    ...over,
  };
}

describe("checkGates: verified watch", () => {
  test("no gate state (flag off, gate 0, joins): nothing changes", () => {
    expect(checkGates(input({ standing: standing() }))).toBeNull();
  });

  test("every cause of a denial gives the same code and text", () => {
    const causes: Record<string, WatchGateState> = {
      never: gate({ verified: null }),
      "not long enough": gate({ verified: watched(59) }),
      "zero after jitter": gate({ verified: watched(0) }),
      "fallback, account too new": gate({ verified: watched(600, true) }),
    };
    const young = user({ createdAt: new Date(NOW.getTime() - 2 * DAY) });
    for (const [cause, g] of Object.entries(causes)) {
      const r = checkGates(input({ user: young, standing: standing({ verifiedWatch: g }) }));
      expect(r, cause).toEqual(VERIFIED_WATCH_REFUSAL);
      expect(r?.text).not.toMatch(/\d/);
    }
  });

  test("enough watching passes; exactly the threshold passes", () => {
    expect(checkGates(input({ standing: standing({ verifiedWatch: gate({ verified: watched(60) }) }) }))).toBeNull();
    expect(checkGates(input({ standing: standing({ verifiedWatch: gate({ verified: watched(3600) }) }) }))).toBeNull();
  });

  test("the fallback (privacy relay) also needs the account age", () => {
    const g = gate({ verified: watched(120, true), fallbackAccountAgeDays: 7 });
    const at = (days: number) => user({ createdAt: new Date(NOW.getTime() - days * DAY) });
    expect(checkGates(input({ user: at(6), standing: standing({ verifiedWatch: g }) }))?.code).toBe(
      "msg_verified_watch",
    );
    expect(checkGates(input({ user: at(7), standing: standing({ verifiedWatch: g }) }))).toBeNull();
    // The fallback never stands in for watching.
    const short = gate({ verified: watched(30, true) });
    expect(checkGates(input({ user: at(400), standing: standing({ verifiedWatch: short }) }))?.code).toBe(
      "msg_verified_watch",
    );
    // A threshold of 0 days means any account.
    const any = gate({ verified: watched(120, true), fallbackAccountAgeDays: 0 });
    expect(checkGates(input({ user: at(0), standing: standing({ verifiedWatch: any }) }))).toBeNull();
  });

  test("Valkey unavailable fails open", () => {
    expect(checkGates(input({ standing: standing({ verifiedWatch: gate({ unavailable: true }) }) }))).toBeNull();
  });

  test("requiredSeconds 0 (surge-exempt earlier chatter on an ungated channel) passes", () => {
    const g = gate({ requiredSeconds: 0, surgeExempt: true });
    expect(checkGates(input({ standing: standing({ verifiedWatch: g }) }))).toBeNull();
  });

  test("a surge-exempt chatter still meets the channel's own gate", () => {
    const g = gate({ requiredSeconds: 300, surgeExempt: true, verified: watched(120) });
    expect(checkGates(input({ standing: standing({ verifiedWatch: g }) }))?.code).toBe("msg_verified_watch");
  });
});

describe("checkGates: verified-watch exemptions", () => {
  const denied = standing({ verifiedWatch: gate() });
  test("broadcaster, moderator, VIP", () => {
    for (const role of ["isBroadcaster", "isModerator", "isVip"] as const)
      expect(checkGates(input({ standing: { ...denied, [role]: true } })), role).toBeNull();
  });

  test("a verified bot is exempt; an unverified bot is not", () => {
    expect(checkGates(input({ user: user({ accountType: "bot", botVerified: true }) }))).toBeNull();
    expect(checkGates(input({ user: user({ accountType: "bot", botVerified: false }) }))?.code).toBe(
      "msg_verified_watch",
    );
  });

  test("subscribers are exempt only with the setting on", () => {
    const sub = { ...denied, subscriberTier: 1 };
    const on = channel({ minVerifiedWatchSeconds: 60, verifiedWatchExemptSubscribers: true });
    const off = channel({ minVerifiedWatchSeconds: 60, verifiedWatchExemptSubscribers: false });
    expect(checkGates(input({ channel: on, standing: sub }))).toBeNull();
    expect(checkGates(input({ channel: off, standing: sub }))?.code).toBe("msg_verified_watch");
    // A non-subscriber is never exempt by the setting.
    expect(checkGates(input({ channel: on, standing: denied }))?.code).toBe("msg_verified_watch");
  });
});

describe("checkGates: verified-watch order", () => {
  test("after login, bans, email, account age and followers-only", () => {
    const g = standing({ verifiedWatch: gate() });
    expect(checkGates(input({ user: null, standing: g }))?.code).toBe("msg_requires_login");
    expect(checkGates(input({ user: user({ banned: true }), standing: g }))?.code).toBe("msg_banned");
    expect(
      checkGates(input({ standing: { ...g, ban: { expiresAt: new Date(NOW.getTime() + 60_000), reason: "" } } }))?.code,
    ).toBe("msg_timedout");
    const email = channel({ minVerifiedWatchSeconds: 60, requireVerifiedEmail: true });
    expect(checkGates(input({ channel: email, user: user({ emailVerified: false }), standing: g }))?.code).toBe(
      "msg_verified_email",
    );
    const age = channel({ minVerifiedWatchSeconds: 60, minAccountAgeDays: 30 });
    expect(
      checkGates(input({ channel: age, user: user({ createdAt: new Date(NOW.getTime() - DAY) }), standing: g }))?.code,
    ).toBe("msg_account_too_new");
    const followers = channel({ minVerifiedWatchSeconds: 60, followersOnlyMinutes: 0 });
    expect(checkGates(input({ channel: followers, standing: g }))?.code).toBe("msg_followersonly");
  });

  test("before subscribers-only and emote-only", () => {
    const g = standing({ verifiedWatch: gate() });
    const subs = channel({ minVerifiedWatchSeconds: 60, subscribersOnly: true });
    expect(checkGates(input({ channel: subs, standing: g }))?.code).toBe("msg_verified_watch");
    const emotes = channel({ minVerifiedWatchSeconds: 60, emoteOnly: true });
    expect(checkGates(input({ channel: emotes, standing: g }))?.code).toBe("msg_verified_watch");
    // Once the gate passes, the later modes still apply.
    const ok = standing({ verifiedWatch: gate({ verified: watched(60) }) });
    expect(checkGates(input({ channel: subs, standing: ok }))?.code).toBe("msg_subsonly");
  });

  test("canChatHint ignores the gate (no oracle in `joined`, decision 4)", () => {
    const i = input();
    expect(checkGates(i)?.code).toBe("msg_verified_watch");
    expect(canChatHint(i.user, i.scopes, i.channel, i.standing, NOW)).toBe(true);
  });
});
