// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Browser sessions in real Chromium and WebKit, against stand-ins for the harness stack's path:
 * a web server that proxies `/rpc` and appends the address it accepted the connection from (as
 * apps/web/src/server/proxy.ts does), and an API that walks `x-forwarded-for` right to left past
 * its trusted proxies (as packages/service `clientIp` does) and answers with the address it would
 * rate-limit. Two sessions must land on two subjects, each its own simulated address on every
 * call, and an origin the page reads cross-origin must see no forwarded header at all.
 */
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { type BrowserEngine, BrowserFleet } from "../../src/browser-viewer.ts";
import { RESIDENTIAL_CIDRS_FILE, anyContains, loadCidrList } from "../../src/cidrs.ts";
import { WebSession } from "../../src/web/session.ts";

/** The stand-in API trusts loopback, as the harness API trusts its compose network. */
const TRUSTED = /^(127\.|::1$|::ffff:127\.)/;

/** Right to left past trusted hops; the socket's own address when it is not a trusted proxy. */
function subjectOf(socketIp: string, xff: string | null): string {
  if (!xff || !TRUSTED.test(socketIp)) return socketIp;
  const hops = xff
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) if (!TRUSTED.test(hops[i] as string)) return hops[i] as string;
  return hops[0] ?? socketIp;
}

type Server = ReturnType<typeof Bun.serve>;
let api: Server;
let web: Server;
let other: Server;
let fleet: BrowserFleet;
const otherForwarded: (string | null)[] = [];

const page = (otherUrl: string) => `<!doctype html><html data-hydrated="true"><body><script>
(async () => {
  const subjects = [];
  for (let i = 0; i < 3; i++) subjects.push((await (await fetch("/rpc/whoami", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()).subject);
  const cross = await fetch(${JSON.stringify(otherUrl)}).then((r) => r.status, (e) => String(e));
  document.body.dataset.result = JSON.stringify({ subjects, cross });
})();
</script></body></html>`;

beforeAll(async () => {
  api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req, srv) =>
      Response.json({ subject: subjectOf(srv.requestIP(req)?.address ?? "", req.headers.get("x-forwarded-for")) }),
  });
  other = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      // Like the origin's CORS: any origin, but no request header beyond `range`.
      const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "range" };
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      otherForwarded.push(req.headers.get("x-forwarded-for"));
      return new Response("ok", { headers: cors });
    },
  });
  const otherUrl = `http://localhost:${other.port}/segment.ts`;
  web = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req, srv) => {
      const url = new URL(req.url);
      if (!url.pathname.startsWith("/rpc/"))
        return new Response(page(otherUrl), { headers: { "content-type": "text/html" } });
      const chain = [req.headers.get("x-forwarded-for"), srv.requestIP(req)?.address]
        .filter((s): s is string => !!s)
        .join(", ");
      return fetch(`http://127.0.0.1:${api.port}${url.pathname}`, {
        method: req.method,
        headers: { "x-forwarded-for": chain, "content-type": "application/json" },
        body: await req.text(),
      });
    },
  });
  fleet = new BrowserFleet();
}, 120_000);

afterAll(async () => {
  await fleet?.close();
  await Promise.all([api?.stop(true), web?.stop(true), other?.stop(true)]);
});

async function subjects(session: WebSession, name: string): Promise<{ subjects: string[]; cross: unknown }> {
  const p = await session.goto("/", name);
  const handle = await p.waitForSelector("body[data-result]", { state: "attached", timeout: 30_000 });
  return JSON.parse((await handle.getAttribute("data-result")) ?? "{}") as { subjects: string[]; cross: unknown };
}

const residential = loadCidrList(RESIDENTIAL_CIDRS_FILE);

describe.each(["chromium", "webkit"] satisfies BrowserEngine[])("in %s", (engine) => {
  test("two sessions are two rate-limit subjects, each its own simulated address on every call", async () => {
    const webUrl = `http://localhost:${web.port}`;
    const open = (label: string) => WebSession.open({ fleet, engine, webUrl, probeScript: "", label, humanize: false });
    const [a, b] = await Promise.all([open("a"), open("b")]);
    try {
      expect(a.clientIp).not.toBe(b.clientIp);
      for (const s of [a, b]) {
        expect(anyContains(residential, s.clientIp as string)).toBe(true);
        // Two pages of one session: one person, one address.
        for (const name of ["main", "second"]) {
          const r = await subjects(s, name);
          expect(r.subjects).toEqual([s.clientIp, s.clientIp, s.clientIp]);
          // The cross-origin read worked (no failed preflight) and carried no forwarded header.
          expect(r.cross).toBe(200);
        }
      }
      expect(otherForwarded.length).toBeGreaterThan(0);
      expect(otherForwarded.every((h) => h === null)).toBe(true);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  }, 120_000);

  test("a session opened without an address is the runner's own address, as before", async () => {
    const s = await WebSession.open({
      fleet,
      engine,
      webUrl: `http://localhost:${web.port}`,
      probeScript: "",
      label: "none",
      humanize: false,
      clientIp: null,
    });
    try {
      expect(s.clientIp).toBeNull();
      const r = await subjects(s, "main");
      for (const subject of r.subjects) expect(subject).toMatch(TRUSTED);
    } finally {
      await s.close();
    }
  }, 120_000);
});
