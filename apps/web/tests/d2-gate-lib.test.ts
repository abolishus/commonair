// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * d2-gate, the pure parts: gate intents and how they map to `?intent=`, the links' search, the
 * pending intent kept for the after-verification confirm, the auth search params, the
 * intent-aware sign-up copy and the sign-up request body.
 */
import { SITE } from "@commonair/config/site";
import { SIGNUP_INTENTS } from "@commonair/contracts/enums";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  CONFIRMABLE_INTENTS,
  GATE_INTENTS,
  channelSlugOf,
  gateSearch,
  intentLanding,
  signInLeads,
  signupIntentOf,
} from "../src/components/auth-gate/intents.ts";
import {
  PENDING_INTENT_KEY,
  PENDING_INTENT_TTL_MS,
  clearPendingIntent,
  parsePendingIntent,
  pendingIntentFor,
  pendingIntentSnapshot,
  pendingMatches,
  readPendingIntent,
  savePendingIntent,
} from "../src/components/auth-gate/pending-intent.ts";
import { signupAfterNote, signupPerks, signupTitle } from "../src/components/auth-gate/signup-copy.ts";
import { t } from "../src/i18n/index.ts";
import { signUp } from "../src/lib/auth.ts";
import { authSearch, carriedSearch } from "../src/lib/auth-return.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** An in-memory Storage, optionally one that throws on every call (blocked site data). */
function memoryStore(throwing = false) {
  const map = new Map<string, string>();
  const guard = () => {
    if (throwing) throw new Error("blocked");
  };
  return {
    map,
    getItem: (k: string) => {
      guard();
      return map.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      guard();
      map.set(k, v);
    },
    removeItem: (k: string) => {
      guard();
      map.delete(k);
    },
  };
}

describe("gate intents", () => {
  it("every sign-up intent but none has a gate, plus vote and report", () => {
    for (const i of SIGNUP_INTENTS.filter((x) => x !== "none")) expect(GATE_INTENTS).toContain(i);
    expect(GATE_INTENTS).toContain("vote");
    expect(GATE_INTENTS).toContain("report");
  });

  it("vote maps to join, report to none, unknown values to nothing", () => {
    expect(signupIntentOf("vote")).toBe("join");
    expect(signupIntentOf("report")).toBe("none");
    for (const i of SIGNUP_INTENTS) expect(signupIntentOf(i)).toBe(i);
    for (const bad of ["FOLLOW", "", "pay", 3, null, undefined, {}]) expect(signupIntentOf(bad)).toBeUndefined();
  });

  it("channel slugs follow the slug rule", () => {
    expect(channelSlugOf("rivertide")).toBe("rivertide");
    expect(channelSlugOf("River")).toBeUndefined();
    expect(channelSlugOf("a b")).toBeUndefined();
    expect(channelSlugOf(42)).toBeUndefined();
  });

  it("the links carry redirect, the mapped intent and the channel", () => {
    expect(gateSearch("follow", "/rivertide", "rivertide")).toEqual({
      redirect: "/rivertide",
      intent: "follow",
      channel: "rivertide",
    });
    expect(gateSearch("vote", "/coop/proposals/1")).toEqual({ redirect: "/coop/proposals/1", intent: "join" });
    // report records no intent; a bad channel is dropped; no redirect on the home page.
    expect(gateSearch("report", undefined, "Not A Slug")).toEqual({});
  });

  it("only report leads with Sign in", () => {
    for (const i of GATE_INTENTS) expect(signInLeads(i)).toBe(i === "report");
  });

  it("creator intents land on their own pages", () => {
    expect(intentLanding("stream")).toBe("/dashboard");
    expect(intentLanding("import")).toBe("/import");
    expect(intentLanding("join")).toBe("/coop/membership");
    expect(intentLanding("follow")).toBeUndefined();
    expect(intentLanding(undefined)).toBeUndefined();
  });
});

describe("pending intent", () => {
  const NOW = 1_800_000_000_000;

  it("saves a confirmable intent for the target's path and reads it back", () => {
    const store = memoryStore();
    expect(savePendingIntent({ intent: "follow", target: "/rivertide?x=1#y", channel: "rivertide" }, NOW, store)).toBe(
      true,
    );
    expect(readPendingIntent(NOW + 1000, store)).toEqual({
      intent: "follow",
      path: "/rivertide",
      channel: "rivertide",
      at: NOW,
    });
    expect(pendingIntentFor("follow", "/rivertide", NOW, store)).not.toBeNull();
    expect(pendingIntentFor("chat", "/rivertide", NOW, store)).toBeNull();
    expect(pendingIntentFor("follow", "/other", NOW, store)).toBeNull();
  });

  it("keeps nothing for creator intents, no intent, or an unsafe target", () => {
    const store = memoryStore();
    for (const intent of ["stream", "import", "join", "none", undefined] as const)
      expect(savePendingIntent({ intent, target: "/rivertide" }, NOW, store)).toBe(false);
    for (const target of ["https://evil.example/x", "//evil.example", undefined])
      expect(savePendingIntent({ intent: "follow", target }, NOW, store)).toBe(false);
    expect(store.map.size).toBe(0);
    for (const i of CONFIRMABLE_INTENTS)
      expect(savePendingIntent({ intent: i, target: "/a" }, NOW, memoryStore())).toBe(true);
  });

  it("drops a bad channel but keeps the intent", () => {
    const store = memoryStore();
    savePendingIntent({ intent: "chat", target: "/a", channel: "Bad Slug" }, NOW, store);
    expect(readPendingIntent(NOW, store)).toEqual({ intent: "chat", path: "/a", at: NOW });
  });

  it("expires after the TTL and clears stale, future or broken values", () => {
    const store = memoryStore();
    savePendingIntent({ intent: "follow", target: "/a" }, NOW, store);
    expect(readPendingIntent(NOW + PENDING_INTENT_TTL_MS, store)).toBeNull();
    expect(store.map.has(PENDING_INTENT_KEY)).toBe(false);
    for (const raw of [
      "not json",
      "null",
      JSON.stringify({ intent: "follow", path: "/a", at: NOW + 10 }),
      JSON.stringify({ intent: "pay", path: "/a", at: NOW }),
      JSON.stringify({ intent: "stream", path: "/a", at: NOW }),
      JSON.stringify({ intent: "follow", path: "https://x.example", at: NOW }),
      JSON.stringify({ intent: "follow", path: "/a", at: "yesterday" }),
    ]) {
      store.map.set(PENDING_INTENT_KEY, raw);
      expect(readPendingIntent(NOW, store), raw).toBeNull();
      expect(store.map.has(PENDING_INTENT_KEY), raw).toBe(false);
    }
  });

  it("parses without touching storage, and matches by intent and path", () => {
    const store = memoryStore();
    savePendingIntent({ intent: "clip", target: "/a" }, NOW, store);
    const raw = pendingIntentSnapshot(store);
    expect(parsePendingIntent(raw, NOW)).toEqual({ intent: "clip", path: "/a", at: NOW });
    expect(parsePendingIntent(raw, NOW + PENDING_INTENT_TTL_MS)).toBeNull();
    // Still stored: parsing is pure.
    expect(pendingIntentSnapshot(store)).toBe(raw);
    expect(parsePendingIntent(null)).toBeNull();
    const p = parsePendingIntent(raw, NOW);
    expect(pendingMatches(p, "clip", "/a")).toBe(true);
    expect(pendingMatches(p, "clip", "/b")).toBe(false);
    expect(pendingMatches(p, "chat", "/a")).toBe(false);
    expect(pendingMatches(null, "clip", "/a")).toBe(false);
    expect(pendingIntentSnapshot(memoryStore(true))).toBeNull();
    expect(pendingIntentSnapshot(null)).toBeNull();
  });

  it("clears on demand, and never throws when storage is blocked or missing", () => {
    const store = memoryStore();
    savePendingIntent({ intent: "follow", target: "/a" }, NOW, store);
    clearPendingIntent(store);
    expect(readPendingIntent(NOW, store)).toBeNull();
    const blocked = memoryStore(true);
    expect(savePendingIntent({ intent: "follow", target: "/a" }, NOW, blocked)).toBe(false);
    expect(readPendingIntent(NOW, blocked)).toBeNull();
    expect(() => clearPendingIntent(blocked)).not.toThrow();
    expect(savePendingIntent({ intent: "follow", target: "/a" }, NOW, null)).toBe(false);
    expect(readPendingIntent(NOW, null)).toBeNull();
    expect(() => clearPendingIntent(null)).not.toThrow();
  });
});

describe("auth search: intent, channel and username", () => {
  it("parses and maps them, dropping bad values", () => {
    expect(authSearch({ intent: "follow", channel: "rivertide", username: "Neo_1" })).toEqual({
      intent: "follow",
      channel: "rivertide",
      username: "neo_1",
    });
    expect(authSearch({ intent: "vote" })).toEqual({ intent: "join" });
    expect(authSearch({ intent: "report" })).toEqual({});
    expect(authSearch({ intent: "none" })).toEqual({});
    expect(authSearch({ intent: "pay", channel: "Bad Slug", username: "has space" })).toEqual({});
    expect(authSearch({ username: "a".repeat(26) })).toEqual({});
    expect(authSearch({ username: 12 })).toEqual({});
  });

  it("carries them between sign-in and sign-up with the target", () => {
    expect(carriedSearch({ redirect: "/rivertide", intent: "chat", channel: "rivertide", username: "neo" })).toEqual({
      redirect: "/rivertide",
      intent: "chat",
      channel: "rivertide",
      username: "neo",
    });
    expect(carriedSearch({ redirect: "//evil.example", intent: "none", channel: "X Y" })).toEqual({});
  });
});

describe("intent-aware sign-up copy", () => {
  it("names the action and the channel, and falls back without a channel", () => {
    expect(signupTitle("follow", "rivertide")).toBe("Create a free account to follow rivertide");
    expect(signupTitle("chat", "rivertide")).toBe("Create a free account to chat with rivertide");
    expect(signupTitle("follow", undefined)).toBe(t("signup.title"));
    expect(signupTitle(undefined, undefined)).toBe("Create your free account");
    expect(signupTitle("predict", undefined)).toBe("Create a free account to join the prediction");
    expect(signupTitle("stream", undefined)).toBe(`Start streaming on ${SITE.name}`);
    expect(signupTitle("join", undefined)).toBe("Create your account, then join the co-op");
  });

  it("lists what the account gives for the intent", () => {
    expect(signupPerks(undefined)).toEqual([
      "d2Gate.signup.perk.follow",
      "d2Gate.signup.perk.chat",
      "d2Gate.signup.perk.vote",
    ]);
    expect(signupPerks("stream")).toContain("d2Gate.signup.perk.channelAddress");
    expect(signupPerks("import")).toContain("d2Gate.signup.perk.importReadOnly");
    expect(signupPerks("join")).toContain("d2Gate.signup.perk.share");
  });

  it("says where verification brings them", () => {
    expect(signupAfterNote("follow", "rivertide", "/rivertide")).toContain("back to rivertide to finish following");
    expect(signupAfterNote("chat", "rivertide", "/rivertide")).toContain("rivertide's chat");
    expect(signupAfterNote("support", "rivertide", "/rivertide")).toContain("choose how to support");
    expect(signupAfterNote("stream", undefined, "/dashboard")).toContain("studio");
    expect(signupAfterNote("import", undefined, "/import")).toContain("Twitch import");
    expect(signupAfterNote("join", undefined, "/coop/membership")).toContain("membership page");
    expect(signupAfterNote("follow", undefined, "/x")).toBe(t("d2Gate.signup.after.page"));
    expect(signupAfterNote(undefined, undefined, undefined)).toBeNull();
  });
});

describe("signUp request body", () => {
  type FetchFn = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  const body = async (intent: Parameters<typeof signUp>[0]["signupIntent"]) => {
    const fetch = vi.fn<FetchFn>(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    await signUp({
      email: "a@example.test",
      username: "alice",
      password: "correct horse battery",
      birthDate: "1990-01-01",
      altcha: "x",
      acceptedDocumentIds: [],
      signupIntent: intent,
    });
    return JSON.parse(fetch.mock.calls[0]?.[1]?.body as string) as Record<string, unknown>;
  };

  it("sends the intent, and none when there was none", async () => {
    expect((await body("follow")).signupIntent).toBe("follow");
    expect((await body(undefined)).signupIntent).toBe("none");
    expect((await body("follow")).name).toBe("alice");
  });
});
