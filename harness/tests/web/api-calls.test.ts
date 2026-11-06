// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { PendingCalls, apiPath } from "../../src/web/api-calls.ts";

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
