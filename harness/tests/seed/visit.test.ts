// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { SEED_ROUTES, type SeedRoute } from "../../src/seed/routes.ts";
import type { SeedStore } from "../../src/seed/types.ts";
import {
  CRAWL_CONCURRENCY,
  CRAWL_PACE,
  CrawlBuckets,
  SIGN_IN_PACE,
  type VisitObservation,
  crawlConcurrency,
  crawlQueue,
  crawlWaitMs,
  loginsOf,
  reportUrl,
  takeRoom,
  resolveSeedRoute,
  visitProblems,
} from "../../src/seed/visit.ts";

const store: SeedStore = {
  users: [],
  channels: [
    { id: "c1", ownerId: "u1", ownerHandle: "streamer1", slug: "demo_streamer1" },
    { id: "c3", ownerId: "u3", ownerHandle: "streamer3", slug: "demo_streamer3" },
  ],
  extra: {
    media: { vodId: "v-1", clipId: "c-1" },
    interact: { giveawayId: "g-1", overlayChatQuery: "token=a%2Bb" },
    coop: { proposalId: "p-1", draftProposalId: "" },
    platform: { activateQuery: "?user_code=ABCD-EFGH" },
  },
};

const clean: VisitObservation = { documentStatus: 200, errorResponses: [], emptyStates: [], errorBoundary: false };

describe("resolveSeedRoute", () => {
  test("fills channel and store params, URL-encoded", () => {
    const route = SEED_ROUTES["/$channel/vods/$vodId"] as SeedRoute;
    expect(resolveSeedRoute("/$channel/vods/$vodId", route, store)).toEqual({
      ok: true,
      url: "/demo_streamer1/vods/v-1",
    });
  });

  test("appends a published query, with or without its leading ?", () => {
    expect(resolveSeedRoute("/overlay/chat", SEED_ROUTES["/overlay/chat"] as SeedRoute, store)).toEqual({
      ok: true,
      url: "/overlay/chat?token=a%2Bb",
    });
    expect(resolveSeedRoute("/activate", SEED_ROUTES["/activate"] as SeedRoute, store)).toEqual({
      ok: true,
      url: "/activate?user_code=ABCD-EFGH",
    });
  });

  test("a fixed value and a single encoded query parameter (D1-web's routes)", () => {
    expect(resolveSeedRoute("/directory/$category", SEED_ROUTES["/directory/$category"] as SeedRoute, store)).toEqual({
      ok: true,
      url: "/directory/art",
    });
    expect(resolveSeedRoute("/search", SEED_ROUTES["/search"] as SeedRoute, store)).toEqual({
      ok: true,
      url: "/search?q=demo_streamer1",
    });
  });

  test("names what is missing: an unpublished or empty key, an unknown channel, an unmapped param", () => {
    expect(
      resolveSeedRoute("/coop/proposals/$id/edit", SEED_ROUTES["/coop/proposals/$id/edit"] as SeedRoute, store),
    ).toEqual({
      ok: false,
      missing: "store.extra.coop.draftProposalId",
    });
    expect(
      resolveSeedRoute("/developer/apps/$appId", SEED_ROUTES["/developer/apps/$appId"] as SeedRoute, store),
    ).toEqual({
      ok: false,
      missing: "store.extra.platform.appId",
    });
    expect(
      resolveSeedRoute(
        "/$channel",
        { as: "viewer1", expectData: true, params: { channel: { channelOf: "nobody" } } },
        store,
      ),
    ).toEqual({
      ok: false,
      missing: "nobody's channel",
    });
    expect(resolveSeedRoute("/$channel", { as: "viewer1", expectData: true }, store)).toEqual({
      ok: false,
      missing: "no value for $channel",
    });
  });

  test("a published query or query parameter that is missing names its key", () => {
    const empty: SeedStore = { ...store, extra: {} };
    expect(resolveSeedRoute("/overlay/chat", SEED_ROUTES["/overlay/chat"] as SeedRoute, empty)).toEqual({
      ok: false,
      missing: "store.extra.interact.overlayChatQuery",
    });
    expect(
      resolveSeedRoute(
        "/search",
        { as: "viewer1", expectData: true, queryParam: ["q", { extra: ["social", "q"] }] },
        empty,
      ),
    ).toEqual({ ok: false, missing: "store.extra.social.q" });
  });

  test("a route without params or query is its own path", () => {
    expect(resolveSeedRoute("/coop/", SEED_ROUTES["/coop/"] as SeedRoute, store)).toEqual({ ok: true, url: "/coop/" });
  });
});

describe("visitProblems", () => {
  const data = { expectData: true };
  const form = { expectData: false };

  test("an empty state the route allows is no problem; any other still is", () => {
    const dash = { expectData: true, okEmpty: ["No problems detected"] };
    expect(visitProblems(dash, { ...clean, emptyStates: ["No problems detected"] })).toEqual([]);
    expect(visitProblems(dash, { ...clean, emptyStates: ["You are offline"] })).toEqual([
      'empty state "You are offline"',
    ]);
  });

  test("a clean page passes either way", () => {
    expect(visitProblems(data, clean)).toEqual([]);
    expect(visitProblems(form, clean)).toEqual([]);
  });

  test("an error boundary or a 5xx fails every route", () => {
    for (const r of [data, form]) {
      expect(visitProblems(r, { ...clean, errorBoundary: true })).toEqual(["error boundary"]);
      expect(visitProblems(r, { ...clean, documentStatus: 502 })).toEqual(["document 502"]);
      expect(visitProblems(r, { ...clean, errorResponses: [{ url: "http://api/rpc/x", status: 500 }] })).toEqual([
        "500 http://api/rpc/x",
      ]);
    }
  });

  test("an empty state or a 4xx fails only a route that should show data", () => {
    const empty = { ...clean, emptyStates: ["No proposals yet", ""] };
    expect(visitProblems(data, empty)).toEqual(['empty state "No proposals yet"', "empty state"]);
    expect(visitProblems(form, empty)).toEqual([]);
    const notFound = { ...clean, documentStatus: 404, errorResponses: [{ url: "http://api/rpc/y", status: 403 }] };
    expect(visitProblems(data, notFound)).toEqual(["document 404", "403 http://api/rpc/y"]);
    expect(visitProblems(form, notFound)).toEqual([]);
  });

  test("a navigation with no response is judged on the rest", () => {
    expect(visitProblems(data, { ...clean, documentStatus: null })).toEqual([]);
  });
});

describe("loginsOf and reportUrl", () => {
  test("every route's login once, without anonymous, and the jury, federation and import logins", () => {
    const logins = loginsOf(SEED_ROUTES);
    expect(new Set(logins).size).toBe(logins.length);
    expect(logins).not.toContain("anonymous");
    for (const h of ["viewer1", "streamer1", "streamer3", "member1", "admin", "treasurer", "legal", "developer"])
      expect(logins).toContain(h);
  });

  test("the report never carries a query (overlay and unsubscribe tokens)", () => {
    expect(reportUrl("http://localhost:3000/overlay/chat?token=secret")).toBe("http://localhost:3000/overlay/chat");
    expect(reportUrl("/relative?x=1")).toBe("/relative");
  });
});

describe("milestone wiring", () => {
  test("the jury, federation and import routes now expect data, import as the importer", () => {
    expect(SEED_ROUTES["/coop/jury"]).toEqual({ as: "member1", expectData: true });
    expect(SEED_ROUTES["/admin/federation"]).toEqual({ as: "admin", expectData: true });
    expect(SEED_ROUTES["/import"]).toEqual({ as: "streamer3", expectData: true });
  });
});

describe("crawlWaitMs", () => {
  const allowed = CRAWL_PACE.max - CRAWL_PACE.pageCalls;
  const at = (n: number, t: number) => Array.from({ length: n }, () => t);

  test("no wait while a page's calls still fit", () => {
    expect(crawlWaitMs([], 0)).toBe(0);
    expect(crawlWaitMs(at(allowed - 1, 1_000), 2_000)).toBe(0);
  });

  test("full: waits until enough of the oldest calls leave the window", () => {
    const calls = [...at(10, 1_000), ...at(allowed - 10, 5_000)];
    // The 10 calls at 1 s must leave (61 s window): one of them is the blocking call.
    expect(crawlWaitMs(calls, 6_000)).toBe(1_000 + CRAWL_PACE.windowMs - 6_000);
  });

  test("calls older than the window do not count, and unsorted input is fine", () => {
    const old = at(allowed + 5, 0);
    expect(crawlWaitMs(old, CRAWL_PACE.windowMs + 1)).toBe(0);
    const mixed = [...at(allowed - 1, 9_000), 3_000].reverse();
    expect(crawlWaitMs(mixed, 10_000)).toBe(3_000 + CRAWL_PACE.windowMs - 10_000);
  });
});

describe("crawling logins side by side", () => {
  const r = (as: string): SeedRoute => ({ as, expectData: false });

  test("grouped by login, most routes first, ties in first-seen order", () => {
    const q = crawlQueue({ "/a": r("x"), "/b": r("y"), "/c": r("y"), "/d": r("z"), "/e": r("w") });
    expect(q.map(([as, routes]) => [as, routes.map(([p]) => p)])).toEqual([
      ["y", ["/b", "/c"]],
      ["x", ["/a"]],
      ["z", ["/d"]],
      ["w", ["/e"]],
    ]);
    expect(crawlQueue({})).toEqual([]);
  });

  test("the real routes: every route exactly once, under its own login, longest logins first", () => {
    const q = crawlQueue(SEED_ROUTES);
    const paths = q.flatMap(([, routes]) => routes.map(([p]) => p));
    expect(paths.sort()).toEqual(Object.keys(SEED_ROUTES).sort());
    for (const [as, routes] of q) for (const [, route] of routes) expect(route.as).toBe(as);
    const sizes = q.map(([, routes]) => routes.length);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    expect(q.map(([as]) => as).sort()).toEqual([...loginsOf(SEED_ROUTES), "anonymous"].sort());
  });

  test("concurrency: the default, capped at the logins, refused when not a positive integer", () => {
    expect(crawlConcurrency(CRAWL_CONCURRENCY, 11)).toBe(3);
    expect(crawlConcurrency(20, 11)).toBe(11);
    expect(crawlConcurrency(1, 11)).toBe(1);
    expect(crawlConcurrency(3, 0)).toBe(1);
    expect(() => crawlConcurrency(0, 11)).toThrow(/positive integer/);
    expect(() => crawlConcurrency(-2, 11)).toThrow(/positive integer/);
  });

  test("sign-ins: six in a window, the seventh waits for the oldest to leave it", () => {
    const allowed = SIGN_IN_PACE.max - SIGN_IN_PACE.pageCalls;
    expect(allowed).toBe(6);
    const five = [1_000, 1_100, 1_200, 1_300, 1_400];
    expect(crawlWaitMs(five, 2_000, SIGN_IN_PACE)).toBe(0);
    const six = [...five, 1_500];
    expect(crawlWaitMs(six, 2_000, SIGN_IN_PACE)).toBe(1_000 + SIGN_IN_PACE.windowMs - 2_000);
    expect(crawlWaitMs(six, 1_000 + SIGN_IN_PACE.windowMs, SIGN_IN_PACE)).toBe(0);
  });
});

describe("the crawl's API buckets", () => {
  test("anonymous calls and every sign-in page share the address bucket; signed in, each user has its own", () => {
    const b = new CrawlBuckets();
    expect(b.of("anonymous", false)).toBe(b.address);
    expect(b.of("anonymous", true)).toBe(b.address);
    expect(b.of("viewer1", false)).toBe(b.address);
    const v1 = b.of("viewer1", true);
    expect(v1).not.toBe(b.address);
    expect(b.of("viewer1", true)).toBe(v1);
    expect(b.of("member1", true)).not.toBe(v1);
  });

  test("takeRoom: no wait with room, then records the hits at once", async () => {
    const bucket: number[] = [];
    const sleeps: number[] = [];
    await takeRoom(
      bucket,
      CRAWL_PACE,
      6,
      async (ms) => void sleeps.push(ms),
      () => 1_000,
    );
    expect(sleeps).toEqual([]);
    expect(bucket).toEqual(Array.from({ length: 6 }, () => 1_000));
  });

  test("takeRoom: two workers race for the last slot; the second waits for the oldest hit to leave", async () => {
    let now = 2_000;
    const bucket = [1_000, 1_100, 1_200, 1_300, 1_400];
    const waits: number[] = [];
    const advance = async (ms: number) => {
      now += ms;
    };
    const clock = () => now;
    // Started together: the first takes the sixth slot with no await, so the second must wait.
    await Promise.all([
      takeRoom(bucket, SIGN_IN_PACE, 1, advance, clock, (ms) => waits.push(ms)),
      takeRoom(bucket, SIGN_IN_PACE, 1, advance, clock, (ms) => waits.push(ms)),
    ]);
    expect(waits).toEqual([1_000 + SIGN_IN_PACE.windowMs - 2_000]);
    expect(bucket).toEqual([1_000, 1_100, 1_200, 1_300, 1_400, 2_000, 1_000 + SIGN_IN_PACE.windowMs]);
  });

  test("takeRoom: a sleep that rejects (the scenario aborted) records nothing", async () => {
    const bucket = Array.from({ length: 6 }, () => 1_000);
    await expect(
      takeRoom(
        bucket,
        SIGN_IN_PACE,
        1,
        () => Promise.reject(new Error("aborted")),
        () => 2_000,
      ),
    ).rejects.toThrow("aborted");
    expect(bucket).toHaveLength(6);
  });
});
