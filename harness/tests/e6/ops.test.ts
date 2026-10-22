// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The ops test-hook client (`POST /internal/ops/tick`) against a fake API. */
import { INTERNAL_ROUTES, INTERNAL_SECRET_HEADER } from "@commonair/contracts/internal";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import { OpsHooks, OpsHooksOff, isSkipped, sumCounter } from "../../src/e6/ops.ts";

describe("OpsHooks", () => {
  let server: ReturnType<typeof Bun.serve>;
  const seen: { job: string; secret: string | null }[] = [];
  let skipFirst = 0;
  let status = 200;
  let result: Record<string, number> = { deleted: 1 };

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== INTERNAL_ROUTES.opsTick || req.method !== "POST")
          return new Response(null, { status: 404 });
        if (status !== 200) return new Response(null, { status });
        const body = (await req.json()) as { job: string };
        seen.push({ job: body.job, secret: req.headers.get(INTERNAL_SECRET_HEADER) });
        if (skipFirst > 0) {
          skipFirst--;
          return Response.json({ skipped: 1 });
        }
        return Response.json(result);
      },
    });
  });
  afterAll(() => server.stop(true));
  beforeEach(() => {
    seen.length = 0;
    skipFirst = 0;
    status = 200;
    result = { deleted: 1 };
  });

  const hooks = () => new OpsHooks(`http://localhost:${server.port}`, "s3cret");

  test("tick posts the job with the internal secret and returns the counts", async () => {
    const h = hooks();
    expect(await h.tick("vod-retention")).toEqual({ deleted: 1 });
    expect(seen).toEqual([{ job: "vod-retention", secret: "s3cret" }]);
    expect(h.ticks).toHaveLength(1);
    expect(h.ticks[0]?.result).toEqual({ deleted: 1 });
  });

  test("tickRan retries skipped runs", async () => {
    skipFirst = 2;
    const h = hooks();
    expect(await h.tickRan("export-cleanup", 5, 1)).toEqual({ deleted: 1 });
    expect(seen.map((s) => s.job)).toEqual(["export-cleanup", "export-cleanup", "export-cleanup"]);
  });

  test("tickRan gives up when the lock stays busy", async () => {
    skipFirst = 10;
    await expect(hooks().tickRan("account-deletion", 2, 1)).rejects.toThrow(/run lock stayed busy/);
  });

  test("a 404 means the hooks are off", async () => {
    status = 404;
    const h = hooks();
    await expect(h.tick("vod-retention")).rejects.toBeInstanceOf(OpsHooksOff);
    expect(h.ticks[0]?.error).toBe("OpsHooksOff");
    await expect(h.tickUntil("vod-retention", "x", async () => null, { timeoutMs: 1000 })).rejects.toBeInstanceOf(
      OpsHooksOff,
    );
  });

  test("tickUntil keeps ticking through slow ticks until the state changes", async () => {
    status = 504;
    let n = 0;
    const h = hooks();
    const r = await h.tickUntil(
      "export-cleanup",
      "state",
      async () => {
        n++;
        if (n === 2) status = 200;
        return n >= 3 ? "done" : null;
      },
      { timeoutMs: 5_000, intervalMs: 1 },
    );
    expect(r.value).toBe("done");
    expect(r.results).toEqual([{ deleted: 1 }]);
  });

  test("tickUntil times out with the last tick error", async () => {
    status = 500;
    await expect(
      hooks().tickUntil("vod-retention", "never", async () => null, { timeoutMs: 50, intervalMs: 5 }),
    ).rejects.toThrow(/timed out .* waiting for never .*HTTP 500/);
  });

  test("skipped results are not collected", async () => {
    skipFirst = 1;
    result = { held: 2 };
    let n = 0;
    const r = await hooks().tickUntil("vod-retention", "s", async () => (++n >= 2 ? true : null), {
      timeoutMs: 5_000,
      intervalMs: 1,
    });
    expect(r.results).toEqual([{ held: 2 }]);
  });
});

describe("result helpers", () => {
  test("isSkipped", () => {
    expect(isSkipped({ skipped: 1 })).toBe(true);
    expect(isSkipped({ skipped: 0 })).toBe(false);
    expect(isSkipped({})).toBe(false);
  });

  test("sumCounter adds one counter and treats missing as 0", () => {
    expect(sumCounter([{ held: 1 }, { deleted: 3 }, { held: 2 }], "held")).toBe(3);
    expect(sumCounter([], "held")).toBe(0);
  });
});
