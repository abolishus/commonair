// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { PendingCalls, RATE_WINDOW_MS, RecentCalls, apiPath, rateLimitHeaders } from "../../src/web/api-calls.ts";

const WEB = "http://localhost:3000";

describe("apiPath", () => {
  test("an RPC call keeps its procedure path and drops the query", () => {
    expect(apiPath(`${WEB}/rpc/coop/feeSchedule`, WEB)).toBe("/rpc/coop/feeSchedule");
    expect(apiPath(`${WEB}/rpc/money/paymentBreakdowns?x=1`, WEB)).toBe("/rpc/money/paymentBreakdowns");
    expect(apiPath(`${WEB}/rpc`, WEB)).toBe("/rpc");
  });

  test("an /api path stops after the flow name, where a token could follow", () => {
    expect(apiPath(`${WEB}/api/auth/reset-password/secret-token`, WEB)).toBe("/api/auth/reset-password");
    expect(apiPath(`${WEB}/api/auth/get-session`, WEB)).toBe("/api/auth/get-session");
  });

  test("pages, assets, other origins and junk are not API calls", () => {
    expect(apiPath(`${WEB}/transparency`, WEB)).toBeNull();
    expect(apiPath(`${WEB}/assets/main.js`, WEB)).toBeNull();
    expect(apiPath(`${WEB}/rpcx/a`, WEB)).toBeNull();
    expect(apiPath("http://media.local:8888/rpc/a", WEB)).toBeNull();
    expect(apiPath("not a url", WEB)).toBeNull();
  });

  test("the web origin may be given with a path", () => {
    expect(apiPath(`${WEB}/rpc/a`, `${WEB}/settings`)).toBe("/rpc/a");
  });
});

describe("PendingCalls", () => {
  test("lists unfinished calls at least minAge old, oldest first", () => {
    const p = new PendingCalls<string>();
    p.start("a", "/rpc/a", 1_000);
    p.start("b", "/rpc/b", 2_000);
    p.start("c", "/rpc/c", 9_000);
    p.finish("b");
    expect(p.olderThan(10_000, 5_000)).toEqual([{ path: "/rpc/a", ageMs: 9_000 }]);
    expect(p.olderThan(10_000, 1_000)).toEqual([
      { path: "/rpc/a", ageMs: 9_000 },
      { path: "/rpc/c", ageMs: 1_000 },
    ]);
  });

  test("finishing an unknown call and an empty tracker are harmless", () => {
    const p = new PendingCalls<object>();
    p.finish({});
    expect(p.olderThan(0, 0)).toEqual([]);
  });
});

describe("RecentCalls", () => {
  test("counts calls and documents inside the window, busiest path first", () => {
    const r = new RecentCalls(60_000);
    r.document(1_000);
    r.call("/rpc/b", 2_000);
    r.call("/rpc/a", 3_000);
    r.call("/rpc/a", 4_000);
    r.document(5_000);
    expect(r.counts(10_000)).toEqual({
      windowMs: 60_000,
      apiCalls: 3,
      documents: 2,
      byPath: [
        { path: "/rpc/a", count: 2 },
        { path: "/rpc/b", count: 1 },
      ],
    });
  });

  test("drops what fell out of the window, the boundary included", () => {
    const r = new RecentCalls(60_000);
    r.call("/rpc/old", 0);
    r.document(0);
    r.call("/rpc/edge", 1_000);
    r.call("/rpc/new", 30_000);
    expect(r.counts(61_000)).toEqual({
      windowMs: 60_000,
      apiCalls: 1,
      documents: 0,
      byPath: [{ path: "/rpc/new", count: 1 }],
    });
  });

  test("ties sort by path, and an empty window counts nothing", () => {
    const r = new RecentCalls();
    expect(r.counts(0)).toEqual({ windowMs: RATE_WINDOW_MS, apiCalls: 0, documents: 0, byPath: [] });
    r.call("/rpc/z", 1);
    r.call("/rpc/m", 2);
    expect(r.counts(3).byPath.map((p) => p.path)).toEqual(["/rpc/m", "/rpc/z"]);
  });
});

describe("rateLimitHeaders", () => {
  test("keeps retry-after and rate-limit headers, lower-cased, and nothing else", () => {
    expect(
      rateLimitHeaders({
        "Retry-After": "12",
        "x-ratelimit-remaining": "0",
        "RateLimit-Limit": "120",
        "content-type": "application/json",
        "set-cookie": "secret",
      }),
    ).toEqual({ "retry-after": "12", "x-ratelimit-remaining": "0", "ratelimit-limit": "120" });
  });

  test("a response with none gives an empty record", () => {
    expect(rateLimitHeaders({ "content-type": "text/plain" })).toEqual({});
  });
});
