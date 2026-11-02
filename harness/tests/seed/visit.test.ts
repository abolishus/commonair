// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { SEED_ROUTES, type SeedRoute } from "../../src/seed/routes.ts";
import type { SeedStore } from "../../src/seed/types.ts";
import { type VisitObservation, loginsOf, reportUrl, resolveSeedRoute, visitProblems } from "../../src/seed/visit.ts";

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
