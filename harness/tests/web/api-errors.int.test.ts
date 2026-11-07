// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A rate-limited API call's log line in real Chromium and WebKit, through a WebSession against a
 * stand-in web server. e4b-money's breakdown failure logged only "status 429", so which bucket
 * ran out had to be guessed; the line must now carry the response's retry-after and what the
 * session sent the API (calls per path, document loads) in the last minute, across its pages.
 */
import { createLogger } from "@commonair/observability";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { type BrowserEngine, BrowserFleet } from "../../src/browser-viewer.ts";
import type { RecentCallCounts } from "../../src/web/api-calls.ts";
import { WebSession } from "../../src/web/session.ts";

/** A page that hydrates the way `goto` waits for (TanStack's bootstrap, then the entry's h()). */
const BOOT =
  "<script>self.$_TSR={h(){this.hydrated=!0,this.c()},e(){this.streamEnded=!0,this.c()},c(){this.hydrated&&this.streamEnded&&(delete self.$_TSR,delete self.$R.tsr)},p(e){this.initialized?e():this.buffer.push(e)},buffer:[]};(self.$R=self.$R||{}).tsr=[]</script><script>$_TSR.e()</script>";
const ENTRY = `<script>window.$_TSR.h();document.documentElement.dataset.hydrated="true";</script>`;

type Server = ReturnType<typeof Bun.serve>;
let web: Server;
let fleet: BrowserFleet;

function html(body: string): Response {
  return new Response(`<!doctype html><html><head></head><body>${body}${BOOT}${ENTRY}</body></html>`, {
    headers: { "content-type": "text/html", "cache-control": "no-store" },
  });
}

beforeAll(async () => {
  web = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/rpc/fine") return Response.json({ json: {} });
      if (url.pathname === "/rpc/money/paymentBreakdowns")
        return Response.json(
          { json: { code: "RATE_LIMITED", data: { retryAfterSeconds: 17 } } },
          { status: 429, headers: { "retry-after": "17" } },
        );
      if (url.pathname === "/rpc/broken") return Response.json({ json: {} }, { status: 500 });
      if (url.pathname === "/other") return html("<p>other</p>");
      if (url.pathname === "/limited") return html("<p>limited</p>");
      return new Response("not found", { status: 404 });
    },
  });
  fleet = new BrowserFleet();
}, 120_000);

afterAll(async () => {
  await fleet?.close();
  await web?.stop(true);
});

interface Line {
  msg: string;
  page?: string;
  path?: string;
  status?: number;
  rateLimit?: Record<string, string>;
  sessionRecent?: RecentCallCounts;
}

async function errorLine(lines: Line[], path: string): Promise<Line> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const line = lines.find((l) => l.msg === "web api error" && l.path === path);
    if (line) return line;
    if (Date.now() > deadline) throw new Error(`no api error line for ${path}: ${JSON.stringify(lines)}`);
    await Bun.sleep(50);
  }
}

describe.each(["chromium", "webkit"] satisfies BrowserEngine[])("in %s", (engine) => {
  test("a 429 logs its retry-after and the session's last minute across pages; a 500 logs just its status", async () => {
    const lines: Line[] = [];
    const log = createLogger({ service: "test", level: "warn", write: (l) => lines.push(JSON.parse(l) as Line) });
    const s = await WebSession.open({
      fleet,
      engine,
      webUrl: `http://localhost:${web.port}`,
      probeScript: "",
      label: `api-errors-${engine}`,
      humanize: false,
      clientIp: null,
      log,
    });
    try {
      const other = await s.goto("/other", "other");
      await other.evaluate(async () => {
        for (let i = 0; i < 3; i++) await fetch("/rpc/fine", { method: "POST" });
        await fetch("/rpc/broken", { method: "POST" });
      });
      const broken = await errorLine(lines, "/rpc/broken");
      expect(broken).toMatchObject({ page: "other", status: 500 });
      expect(broken).not.toHaveProperty("rateLimit");
      expect(broken).not.toHaveProperty("sessionRecent");

      const limited = await s.goto("/limited", "limited");
      await limited.evaluate(() => fetch("/rpc/money/paymentBreakdowns", { method: "POST" }));
      const line = await errorLine(lines, "/rpc/money/paymentBreakdowns");
      expect(line).toMatchObject({ page: "limited", status: 429, rateLimit: { "retry-after": "17" } });
      // Both pages count: the API's default bucket is per user, not per page.
      expect(line.sessionRecent).toEqual({
        windowMs: 60_000,
        apiCalls: 5,
        documents: 2,
        byPath: [
          { path: "/rpc/fine", count: 3 },
          { path: "/rpc/broken", count: 1 },
          { path: "/rpc/money/paymentBreakdowns", count: 1 },
        ],
      });
    } finally {
      await s.close();
    }
  }, 120_000);
});
