// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The bootstrap trace in real Chromium and WebKit, through a WebSession against a stand-in web
 * server: a page whose bootstrap an earlier hydration already cleaned up, and one that never got a
 * bootstrap, each with a stand-in of the web app's hydration guard (reload once, logging its
 * line). The run passes after the reload, as CI's do, so the session's "web hydration guard fired"
 * log is the only record: it must carry the trace of the document that missed, telling the two
 * apart, and normal pages must still hydrate with the trace installed.
 */
import { createLogger } from "@commonair/observability";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { type BrowserEngine, BrowserFleet } from "../../src/browser-viewer.ts";
import { type BootTraceEntry, readBootTrace } from "../../src/web/boot-trace.ts";
import { WebSession } from "../../src/web/session.ts";

/** TanStack Start's inline bootstrap, as the server renders it. */
const BOOTSTRAP =
  "<script>self.$_TSR={h(){this.hydrated=!0,this.c()},e(){this.streamEnded=!0,this.c()},c(){this.hydrated&&this.streamEnded&&(delete self.$_TSR,delete self.$R.tsr)},p(e){this.initialized?e():this.buffer.push(e)},buffer:[]};(self.$R=self.$R||{}).tsr=[]</script>";
const STREAM_END = "<script>$_TSR.e()</script>";
/** Like apps/web/src/client.tsx's guard: reload once (remembered per tab), else hydrate. */
const GUARD = `<script src="/assets/entry.js"></script>`;
const ENTRY = `
if (typeof window.$_TSR !== "object" || window.$_TSR === null) {
  if (!sessionStorage.getItem("guard")) {
    sessionStorage.setItem("guard", "1");
    console.warn("hydration bootstrap missing; reloading once");
    location.reload();
  } else {
    document.documentElement.dataset.hydrated = "true";
  }
} else {
  window.$_TSR.h();
  document.documentElement.dataset.hydrated = "true";
}`;
/** A hydration that ran before this document's own entry and cleaned the bootstrap up. */
const EARLIER = "window.$_TSR.h();";

type Server = ReturnType<typeof Bun.serve>;
let web: Server;
let fleet: BrowserFleet;
/** Paths served from the reloaded (second) request on, per path: the miss happens only once. */
const served = new Map<string, number>();

function html(body: string): Response {
  return new Response(`<!doctype html><html><head></head><body>${body}</body></html>`, {
    headers: { "content-type": "text/html", "cache-control": "no-store" },
  });
}

beforeAll(async () => {
  web = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      const js = (body: string) => new Response(body, { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/assets/entry.js") return js(ENTRY);
      if (url.pathname === "/assets/earlier.js") return js(EARLIER);
      const n = (served.get(url.pathname) ?? 0) + 1;
      served.set(url.pathname, n);
      const first = n === 1;
      if (url.pathname === "/fine") return html(`${BOOTSTRAP}${STREAM_END}${GUARD}`);
      if (url.pathname === "/never") return html(first ? GUARD : `${BOOTSTRAP}${STREAM_END}${GUARD}`);
      if (url.pathname === "/cleaned")
        return html(
          first
            ? `${BOOTSTRAP}${STREAM_END}<script src="/assets/earlier.js"></script>${GUARD}`
            : `${BOOTSTRAP}${STREAM_END}${GUARD}`,
        );
      return new Response("not found", { status: 404 });
    },
  });
  fleet = new BrowserFleet();
}, 120_000);

afterAll(async () => {
  await fleet?.close();
  await web?.stop(true);
});

type Order = { bootstrapAt: number } | { error: string };

/**
 * Where the missed document put its bootstrap, or "unread". Chromium can drop the body of a
 * document it reloads within milliseconds before the session's read of it finishes; the line must
 * then say so (an error) rather than carry another document's order.
 */
function bootstrapAtOf(order: Order | undefined): number | "unread" | "absent" {
  if (!order) return "absent";
  return "error" in order ? (order.error ? "unread" : "absent") : order.bootstrapAt;
}

interface Line {
  msg: string;
  session?: string;
  path?: string;
  guard?: string;
  served?: { path: string; startedAt: number; order: Order }[];
  trace?: BootTraceEntry[];
}

/** The served document a trace entry belongs to: the request that started nearest its time origin. */
function servedFor(line: Line, entry: BootTraceEntry | undefined): Order | undefined {
  if (!entry) return undefined;
  const near = [...(line.served ?? [])].sort(
    (a, b) => Math.abs(a.startedAt - entry.origin) - Math.abs(b.startedAt - entry.origin),
  )[0];
  return near?.order;
}

function collector() {
  const lines: Line[] = [];
  const log = createLogger({ service: "test", level: "warn", write: (l) => lines.push(JSON.parse(l) as Line) });
  return { lines, log };
}

async function guardLine(lines: Line[], path: string): Promise<Line> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const line = lines.find((l) => l.msg === "web hydration guard fired" && l.path === path);
    if (line) return line;
    if (Date.now() > deadline) throw new Error(`no guard line for ${path}: ${JSON.stringify(lines)}`);
    await Bun.sleep(100);
  }
}

describe.each(["chromium", "webkit"] satisfies BrowserEngine[])("in %s", (engine) => {
  const open = (label: string, log: ReturnType<typeof collector>["log"]) =>
    WebSession.open({
      fleet,
      engine,
      webUrl: `http://localhost:${web.port}`,
      probeScript: "",
      label,
      humanize: false,
      clientIp: null,
      log,
    });

  test("a normal start-up hydrates with the trace installed and logs nothing", async () => {
    const { lines, log } = collector();
    const s = await open(`fine-${engine}`, log);
    try {
      const p = await s.goto("/fine");
      expect(await p.evaluate(() => "$_TSR" in window)).toBe(false);
      const trace = await p.evaluate(() => JSON.parse(sessionStorage.getItem("harness-boot-trace") ?? "[]") as unknown);
      expect(trace).toEqual([
        expect.objectContaining({ path: "/fine", sets: 1, setReadyState: "loading", deletedMs: expect.any(Number) }),
      ]);
      const [e] = trace as BootTraceEntry[];
      expect(e?.hydratedBy).toContain("/assets/entry.js");
      expect(lines.filter((l) => l.msg.startsWith("web hydration"))).toEqual([]);
    } finally {
      await s.close();
    }
  }, 120_000);

  test("a document that never got its bootstrap: the guard's line carries a trace with nothing set", async () => {
    const { lines, log } = collector();
    const s = await open(`never-${engine}`, log);
    try {
      served.delete("/never");
      // `goto` returns once a document hydrated: the reloaded one.
      const p = await s.goto("/never");
      const line = await guardLine(lines, "/never");
      expect(line.guard).toBe("hydration bootstrap missing; reloading once");
      const missed = line.trace?.find((e) => e.path === "/never" && e.nav === "navigate");
      expect(missed).toMatchObject({ setMs: null, hydratedMs: null, deletedMs: null });
      expect([-1, "unread"]).toContain(bootstrapAtOf(servedFor(line, missed)));
      // The tab's trace keeps both documents: the miss, then the reload that hydrated normally.
      const all = await p.evaluate(readBootTrace);
      expect(all?.map((e) => [e.path, e.nav, e.setMs === null, e.deletedMs === null])).toEqual([
        ["/never", "navigate", true, true],
        ["/never", "reload", false, false],
      ]);
    } finally {
      await s.close();
    }
  }, 120_000);

  test("a bootstrap an earlier hydration cleaned up: deleted before the guard, by that script", async () => {
    const { lines, log } = collector();
    const s = await open(`cleaned-${engine}`, log);
    try {
      served.delete("/cleaned");
      await s.goto("/cleaned");
      const line = await guardLine(lines, "/cleaned");
      const missed = line.trace?.find((e) => e.path === "/cleaned" && e.nav === "navigate");
      expect(missed).toMatchObject({ sets: 1, streamEndMs: expect.any(Number), deletedMs: expect.any(Number) });
      const at = bootstrapAtOf(servedFor(line, missed));
      expect(at === "unread" || (typeof at === "number" && at >= 0)).toBe(true);
      expect(missed?.hydratedBy).toContain("/assets/earlier.js");
      expect(missed?.hydratedBy).not.toContain("/assets/entry.js");
    } finally {
      await s.close();
    }
  }, 120_000);
});
