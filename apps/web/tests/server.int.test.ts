// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Build smoke test: `vp build` succeeds and `bun run start` serves `/healthz`, server-rendered
 * pages, hashed assets, and the same-origin API proxy (against a stand-in API on a random port).
 */
import { readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

const APP_DIR = new URL("..", import.meta.url).pathname;
const DEADLINE_MS = 60_000;

let upstream: ReturnType<typeof Bun.serve> | null = null;
let web: ReturnType<typeof Bun.spawn> | null = null;
let base = "";
const seen: { path: string; xff: string | null; cookie: string | null; host: string | null; body: string }[] = [];

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;
  void probe.stop(true);
  if (port === undefined) throw new Error("no free port");
  return port;
}

async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    const res = await fetch(url).catch(() => null);
    if (res?.ok) return;
    await Bun.sleep(200);
  }
  throw new Error(`${url} never became healthy`);
}

beforeAll(async () => {
  const build = Bun.spawn(["bun", "--bun", "vp", "build"], { cwd: APP_DIR, stdout: "pipe", stderr: "pipe" });
  const code = await build.exited;
  if (code !== 0) throw new Error(`vp build failed (${code}): ${await new Response(build.stderr).text()}`);

  upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      seen.push({
        path: url.pathname,
        xff: req.headers.get("x-forwarded-for"),
        cookie: req.headers.get("cookie"),
        host: req.headers.get("x-forwarded-host"),
        body: await req.text(),
      });
      if (url.pathname === "/api/auth/sign-in/email") {
        const headers = new Headers({ "content-type": "application/json" });
        headers.append("set-cookie", "commonair.session_token=abc; Path=/; HttpOnly; SameSite=Lax");
        headers.append("set-cookie", "commonair.session_data=xyz; Path=/; HttpOnly; SameSite=Lax");
        return new Response('{"ok":true}', { headers });
      }
      if (url.pathname === "/api/auth/verify-email")
        return new Response(null, { status: 302, headers: { location: "/dashboard" } });
      return Response.json({ code: "NOT_FOUND" }, { status: 404 });
    },
  });

  const port = freePort();
  base = `http://127.0.0.1:${port}`;
  web = Bun.spawn(["bun", "run", "start"], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      WEB_PORT: String(port),
      API_INTERNAL_URL: `http://127.0.0.1:${upstream.port}`,
      LOG_LEVEL: "warn",
      PUBLIC_URL: "https://stream.example.org",
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  await waitForHealth(`${base}/healthz`);
}, 180_000);

afterAll(async () => {
  web?.kill();
  await web?.exited;
  await upstream?.stop(true);
});

describe("production server", () => {
  it("answers /healthz", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("server-renders pages even while the API is unavailable for them", async () => {
    const res = await fetch(`${base}/signin`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="signin-email"');
    expect(html).toContain('data-theme="dark"');
  });

  it("serves hashed client assets as immutable", async () => {
    const asset = readdirSync(`${APP_DIR}/dist/client/assets`).find((f) => f.endsWith(".js"));
    expect(asset).toBeDefined();
    const res = await fetch(`${base}/assets/${asset}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  it("proxies auth to the API with cookies, x-forwarded-for and redirects intact", async () => {
    const res = await fetch(`${base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "a=1", "x-forwarded-for": "203.0.113.5" },
      body: '{"email":"x"}',
    });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toHaveLength(2);
    const req = seen.find((s) => s.path === "/api/auth/sign-in/email");
    expect(req?.body).toBe('{"email":"x"}');
    expect(req?.cookie).toBe("a=1");
    expect(req?.xff).toBe("203.0.113.5, 127.0.0.1");
    expect(req?.host).toBe("stream.example.org");

    const redirect = await fetch(`${base}/api/auth/verify-email?token=t`, { redirect: "manual" });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/dashboard");
  });

  it("sends framing, sniffing and referrer protections and keeps pages out of shared caches", async () => {
    const page = await fetch(`${base}/signin`);
    expect(page.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(page.headers.get("cache-control")).toBe("private, no-store");
    const embed = await fetch(`${base}/embed/nobody_here`);
    expect(embed.headers.get("content-security-policy")).toBe("frame-ancestors *");
  });

  it("redirects /dashboard to /signin on the server when signed out", async () => {
    const res = await fetch(`${base}/dashboard`, { redirect: "manual" });
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(new URL(res.headers.get("location") ?? "", base).pathname).toBe("/signin");
  });

  it("refuses request bodies over 1 MB", async () => {
    const res = await fetch(`${base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(1024 * 1024 + 1),
    });
    expect(res.status).toBe(413);
  });
});
