// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Routing and TLS invariants of infra/caddy/Caddyfile, checked on the text. caddy.int.test.ts
 * runs the pinned Caddy image's own validator against it in both TLS modes.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";

const caddy = readFileSync(new URL("../caddy/Caddyfile", import.meta.url), "utf8");
const lines = caddy.split("\n").map((l) => l.replace(/#.*$/, "").trim());
const site = caddy.slice(caddy.indexOf("{$PUBLIC_HOSTNAME:localhost} {"));

/** The handle blocks of the site, in order: matcher → upstream (or "respond"). */
function handles(): [string, string][] {
  const out: [string, string][] = [];
  const re = /^\t(handle(?:_path)?) ([^{\n]+?) \{\n([\s\S]*?)^\t\}/gm;
  for (const m of site.matchAll(re)) {
    const body = m[3]!;
    const upstream = /reverse_proxy (\S+)/.exec(body)?.[1] ?? (/respond (\d+)/.exec(body)?.[0] || "?");
    out.push([m[2]!.trim(), upstream]);
  }
  return out;
}

describe("routing", () => {
  test("each public path reaches the service that owns it", () => {
    expect(Object.fromEntries(handles())).toEqual({
      "@internal": "respond 404",
      "@s3-upload": "garage:3900",
      "@s3-export": "garage:3900",
      "/api/*": "api:3001",
      "/rpc/*": "api:3001",
      "/overlay/events": "api:3001",
      "/chat": "chat:3002",
      "/hls/*": "origin:3003",
      "/relay-pull/*": "origin:3003",
      "/cdn/*": "origin:3003",
      "/media/*": "origin:3003",
      "@whip": "mediamtx:8889",
      "/tracker*": "tracker:8000",
    });
  });

  test("/internal is answered 404 before any route can proxy it", () => {
    expect(site).toMatch(/@internal path \/internal \/internal\/\*/);
    expect(handles()[0]).toEqual(["@internal", "respond 404"]);
  });

  test("everything else goes to the web app, last", () => {
    expect(site).toMatch(/\thandle \{\n\t\treverse_proxy web:3000\n\t\}\n/);
    expect(site.lastIndexOf("reverse_proxy web:3000")).toBeGreaterThan(site.lastIndexOf("reverse_proxy tracker:8000"));
  });

  test("the chat WebSocket is rewritten to the service's /ws", () => {
    expect(site).toMatch(/handle \/chat \{\n\t\trewrite \* \/ws\n\t\treverse_proxy chat:3002\n\t\}/);
  });

  test("the overlay event stream is not buffered (SSE)", () => {
    expect(site).toMatch(/handle \/overlay\/events \{\n\t\treverse_proxy api:3001 \{\n\t\t\tflush_interval -1/);
  });

  test("only MediaMTX's WHIP endpoints are public, nothing else of its API", () => {
    expect(site).toContain("@whip path_regexp ^/live/[a-z0-9_]+/whip(/[^/]+)?$");
    expect(site.match(/mediamtx:/g)).toHaveLength(1);
  });

  test("only the public services are upstreams (no Postgres, Grafana, collector)", () => {
    const upstreams = new Set([...site.matchAll(/reverse_proxy (\S+)/g)].map((m) => m[1]!.split(":")[0]));
    expect(upstreams).toEqual(new Set(["api", "chat", "garage", "mediamtx", "origin", "tracker", "web"]));
  });

  test("Garage only for presigned uploads into incoming/ and presigned export reads (ADR 0024)", () => {
    expect(site.match(/garage:/g)).toHaveLength(2);
    expect(site).toMatch(
      /@s3-upload \{\n\t\tmethod PUT\n\t\tpath \/\{\$S3_BUCKET_MEDIA:commonair-media\}\/incoming\/\*\n(?:\t\t#[^\n]*\n)*\t\tnot path \/\{\$S3_BUCKET_MEDIA:commonair-media\}\/incoming\/\n\t\tquery X-Amz-Signature=\*\n\t\}/,
    );
    expect(site).toMatch(
      /@s3-export \{\n\t\tmethod GET HEAD\n\t\tpath \/\{\$S3_BUCKET_EXPORTS:commonair-exports\}\/\*\n(?:\t\t#[^\n]*\n)*\t\tnot path \/\{\$S3_BUCKET_EXPORTS:commonair-exports\}\/\n\t\tquery X-Amz-Signature=\*\n\t\}/,
    );
    expect(site).toMatch(/handle @s3-upload \{\n\t\trequest_body \{\n\t\t\tmax_size 10MB\n\t\t\}/);
    // Signed responses pass through unencoded (Content-Length and ETag as Garage sent them).
    expect(site).toMatch(/@compressible not query X-Amz-Signature=\*\n\tencode @compressible zstd gzip\n/);
  });
});

describe("headers and privacy", () => {
  test("security headers on every response", () => {
    for (const h of [
      'Strict-Transport-Security "max-age=63072000; includeSubDomains"',
      'X-Content-Type-Options "nosniff"',
      'Referrer-Policy "strict-origin-when-cross-origin"',
      "Permissions-Policy",
      'Cross-Origin-Opener-Policy "same-origin"',
      "-Server",
    ])
      expect(site).toContain(h);
  });

  test("only /embed may be framed, by anyone; a service's own CSP wins (?)", () => {
    expect(site).toMatch(/header @embed \?Content-Security-Policy "[^"]*frame-ancestors \*"/);
    expect(site).toMatch(/header @framed \{\n\t\t\?Content-Security-Policy "[^"]*frame-ancestors 'none'"/);
    expect(site).toContain('?X-Frame-Options "DENY"');
  });

  test("no access log (it would record viewers' addresses)", () => {
    expect(lines.filter((l) => /^log\b/.test(l))).toEqual([]);
  });

  test("client addresses are trusted only from private ranges", () => {
    expect(caddy).toContain("trusted_proxies static private_ranges");
  });
});

describe("TLS modes (ADR 0023 §11)", () => {
  test("the site imports the snippet named by TLS_MODE, acme when unset", () => {
    expect(site.split("\n")[1]).toBe("\timport tls-{$TLS_MODE:acme}");
  });

  test("acme, empty and internal snippets exist and precede the site", () => {
    for (const name of ["tls-acme", "tls-", "tls-internal"]) {
      const at = caddy.indexOf(`(${name}) {`);
      expect(at, name).toBeGreaterThan(0);
      expect(at, name).toBeLessThan(caddy.indexOf("{$PUBLIC_HOSTNAME:localhost} {"));
    }
    expect(caddy).toMatch(/\(tls-\) \{\n\timport tls-acme\n\}/);
    expect(caddy).toMatch(/\(tls-internal\) \{\n\ttls internal \{/);
  });

  test("ACME_EMAIL and ACME_CA sit where an empty value leaves a valid directive", () => {
    // `tls <email> { … }`: with the block, a missing email argument is valid.
    expect(caddy).toMatch(/\(tls-acme\) \{\n\ttls \{\$ACME_EMAIL\} \{\n/);
    // `cert_issuer acme [<directory>]`: no directory means Let's Encrypt.
    expect(caddy).toMatch(/^\tcert_issuer acme \{\$ACME_CA\}$/m);
    // A bare `{$ACME_EMAIL}`/`{$ACME_CA}` anywhere else would break on an empty value.
    expect(caddy.match(/\{\$ACME_EMAIL\}/g)).toHaveLength(1);
    expect(caddy.match(/\{\$ACME_CA\}/g)).toHaveLength(1);
  });

  test("the hostname comes only from the environment", () => {
    expect(caddy).toContain("{$PUBLIC_HOSTNAME:localhost} {");
    const hosts = lines.filter((l) => /^[a-z0-9.-]+\.[a-z]{2,}(:\d+)?\s*\{$/.test(l));
    expect(hosts).toEqual([]);
  });

  test("TLS 1.2 is the floor in both modes", () => {
    expect(caddy.match(/protocols tls1\.2/g)).toHaveLength(2);
  });
});
