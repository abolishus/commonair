// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Design-overhaul fix-first items F9–F12: the pure rules (the routes are in fix-api.int.test.ts). */
import { describe, expect, test } from "vite-plus/test";
import { VoteOpenNotificationPayload } from "@commonair/contracts/notify";
import { verificationCallbackPath, withVerificationCallback } from "../src/auth/callback.ts";
import { usernameProblem } from "../src/auth/identity.ts";
import { searchTags } from "../src/discovery/tags.ts";
import { checkoutReturnUrl, checkoutReturnUrls } from "../src/money/return-urls.ts";

const PUBLIC = "https://air.example.invalid";
const PAYMENT = "0190f5a2-7b3c-7d4e-8f00-112233445566";

describe("F10: marketing and route names are reserved", () => {
  const MARKETING = [
    "creators",
    "fees",
    "faq",
    "join",
    "pricing",
    "about",
    "coop",
    "membership",
    "transparency",
    "help",
    "support",
    "blog",
    "press",
    "legal",
    "terms",
    "privacy",
    "guidelines",
    "import",
    "move",
    "following",
    "inbox",
    "settings",
    "studio",
    "dashboard",
    "admin",
  ];
  test.each(MARKETING)("%s is reserved", (name) => {
    expect(usernameProblem(name)).toBe("reserved");
  });

  test("case does not matter", () => {
    for (const name of ["Creators", "FEES", "FaQ", "Pricing", "JOIN", "Studio"])
      expect(usernameProblem(name), name).toBe("reserved");
  });

  test("the web app's other top-level routes are reserved", () => {
    for (const name of ["activate", "revenue", "treasury", "signin", "signup", "search", "directory"])
      expect(usernameProblem(name), name).toBe("reserved");
  });

  test("neighbours of reserved names stay available", () => {
    for (const name of ["creators_hub", "faq_bot", "joiner", "pricingfan", "my_studio", "feesy"])
      expect(usernameProblem(name), name).toBeNull();
  });
});

describe("F11: the verification link's callback", () => {
  test("a relative path is kept, query and fragment included", () => {
    expect(verificationCallbackPath("/streamer1", PUBLIC)).toBe("/streamer1");
    expect(verificationCallbackPath("/coop/membership?tab=share#buy", PUBLIC)).toBe("/coop/membership?tab=share#buy");
  });

  test("missing or empty is the front page, never the studio", () => {
    expect(verificationCallbackPath(undefined, PUBLIC)).toBe("/");
    expect(verificationCallbackPath(null, PUBLIC)).toBe("/");
    expect(verificationCallbackPath("", PUBLIC)).toBe("/");
  });

  test("an absolute URL on this instance becomes its path", () => {
    expect(verificationCallbackPath(`${PUBLIC}/c/x?y=1`, PUBLIC)).toBe("/c/x?y=1");
    expect(verificationCallbackPath(`${PUBLIC}/`, PUBLIC)).toBe("/");
  });

  test("anything off this instance or malformed is the front page", () => {
    for (const raw of [
      "https://evil.example/x",
      "http://air.example.invalid/x", // another scheme is another origin
      "//evil.example/x",
      "/\\evil.example",
      "/a b",
      "javascript:alert(1)",
      "not a url",
      `/${"a".repeat(5000)}`,
    ])
      expect(verificationCallbackPath(raw, PUBLIC), raw).toBe("/");
  });

  test("the link keeps its token and gets the checked callback", () => {
    const link = "http://localhost:3001/api/auth/verify-email?token=abc&callbackURL=%2Fdashboard";
    const out = new URL(withVerificationCallback(link, PUBLIC));
    expect(out.searchParams.get("token")).toBe("abc");
    expect(out.searchParams.get("callbackURL")).toBe("/dashboard");
    const off = new URL(
      withVerificationCallback(
        "http://localhost:3001/api/auth/verify-email?token=t&callbackURL=https%3A%2F%2Fevil.example",
        PUBLIC,
      ),
    );
    expect(off.searchParams.get("callbackURL")).toBe("/");
    const none = new URL(withVerificationCallback("http://localhost:3001/api/auth/verify-email?token=t", PUBLIC));
    expect(none.searchParams.get("callbackURL")).toBe("/");
  });
});

describe("F12: checkout return URLs", () => {
  test("success and cancel differ and both name the payment", () => {
    expect(checkoutReturnUrls(PUBLIC, "/streamer1", PAYMENT)).toEqual({
      successUrl: `${PUBLIC}/streamer1?checkout=success&payment=${PAYMENT}`,
      cancelUrl: `${PUBLIC}/streamer1?checkout=canceled&payment=${PAYMENT}`,
    });
  });

  test("an existing query is kept, and stale checkout parameters are replaced", () => {
    expect(checkoutReturnUrl(PUBLIC, "/s?tab=subs", "success", PAYMENT)).toBe(
      `${PUBLIC}/s?tab=subs&checkout=success&payment=${PAYMENT}`,
    );
    expect(checkoutReturnUrl(PUBLIC, "/s?checkout=canceled&payment=old", "success", PAYMENT)).toBe(
      `${PUBLIC}/s?checkout=success&payment=${PAYMENT}`,
    );
  });

  test("a fragment is dropped and a trailing slash on PUBLIC_URL is ignored", () => {
    expect(checkoutReturnUrl(`${PUBLIC}/`, "/s#chat", "canceled", PAYMENT)).toBe(
      `${PUBLIC}/s?checkout=canceled&payment=${PAYMENT}`,
    );
  });

  test("a PUBLIC_URL path prefix is kept", () => {
    expect(checkoutReturnUrl(`${PUBLIC}/air`, "/s", "success", PAYMENT)).toBe(
      `${PUBLIC}/air/s?checkout=success&payment=${PAYMENT}`,
    );
  });
});

describe("F9: search words as tags", () => {
  test("lowercased, split on spaces and commas, # dropped, each once", () => {
    expect(searchTags("LoFi")).toEqual(["lofi"]);
    expect(searchTags("  #lofi  beats,lofi ")).toEqual(["lofi", "beats"]);
    expect(searchTags("##")).toEqual([]);
    expect(searchTags("   ")).toEqual([]);
  });
});

describe("F8: the vote_open payload the inbox reads", () => {
  test("proposal id, kind and deadline as stored; the title is optional (joined at read time)", () => {
    const stored = { proposalId: PAYMENT, kind: "ordinary", votingEndsAt: "2026-11-06T12:00:00.000Z" };
    expect(VoteOpenNotificationPayload.parse(stored)).toEqual(stored);
    expect(VoteOpenNotificationPayload.parse({ ...stored, title: "Lower the fee" }).title).toBe("Lower the fee");
    expect(VoteOpenNotificationPayload.safeParse({ ...stored, votingEndsAt: null }).success).toBe(true);
    expect(VoteOpenNotificationPayload.safeParse({ ...stored, proposalId: "nope" }).success).toBe(false);
  });
});
