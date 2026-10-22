// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Runs the pinned Caddy image (the one commonair-caddy.container uses) against
 * infra/caddy/Caddyfile: `caddy validate` must accept it in every TLS mode, with the optional
 * values unset or empty (as the env file writes them), and `caddy adapt` must pick the issuer
 * the mode asks for. The presigned object routes (ADR 0024) are checked twice: in the adapted
 * JSON, and live, with the real Caddyfile in front of a stub that stands in for Garage and the
 * web app. Needs podman (and curl for the live part).
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createS3Storage } from "@commonair/storage";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

const CADDYFILE = new URL("../caddy/Caddyfile", import.meta.url).pathname;
const IMAGE = /^Image=(.*)$/m.exec(
  readFileSync(new URL("../quadlet/commonair-caddy.container", import.meta.url), "utf8"),
)![1]!;
const TIMEOUT = 180_000;

function caddy(command: "validate" | "adapt", env: Record<string, string>): { code: number; out: string } {
  const args = ["run", "--rm", "--network", "none"];
  for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
  args.push(
    "-v",
    `${CADDYFILE}:/etc/caddy/Caddyfile:ro,Z`,
    IMAGE,
    "caddy",
    command,
    "--config",
    "/etc/caddy/Caddyfile",
  );
  if (command === "adapt") args.push("--adapter", "caddyfile");
  const r = Bun.spawnSync(["podman", ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, out: `${r.stdout.toString()}${r.stderr.toString()}` };
}

interface Policy {
  subjects?: string[];
  issuers?: { module: string; email?: string; ca?: string }[];
}
function policies(env: Record<string, string>): Policy[] {
  const { code, out } = caddy("adapt", env);
  expect(code, out).toBe(0);
  const json = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)) as {
    apps: { tls: { automation: { policies: Policy[] } } };
  };
  return json.apps.tls.automation.policies;
}
/** The policy that applies to `host`: its own, or the catch-all Caddy merges identical ones into. */
function sitePolicy(env: Record<string, string>, host: string): Policy | undefined {
  const all = policies(env);
  return all.find((p) => p.subjects?.includes(host)) ?? all.find((p) => !p.subjects);
}

// Every case the env file or compose can produce: unset (compose passes only PUBLIC_HOSTNAME),
// empty (init-env writes ACME_EMAIL= and ACME_CA=), and set.
const CASES: [string, Record<string, string>][] = [
  ["nothing set (compose defaults)", {}],
  ["hostname only", { PUBLIC_HOSTNAME: "stream.example.org" }],
  ["acme, empty optionals", { PUBLIC_HOSTNAME: "stream.example.org", TLS_MODE: "acme", ACME_EMAIL: "", ACME_CA: "" }],
  ["empty TLS_MODE", { PUBLIC_HOSTNAME: "stream.example.org", TLS_MODE: "", ACME_EMAIL: "", ACME_CA: "" }],
  [
    "acme with email and CA",
    {
      PUBLIC_HOSTNAME: "stream.example.org",
      TLS_MODE: "acme",
      ACME_EMAIL: "ops@example.org",
      ACME_CA: "https://acme-staging-v02.api.letsencrypt.org/directory",
    },
  ],
  ["internal", { PUBLIC_HOSTNAME: "selfhost.test", TLS_MODE: "internal", ACME_EMAIL: "", ACME_CA: "" }],
];

describe("caddy validate (pinned image)", () => {
  test.each(CASES)(
    "%s: valid",
    (_, env) => {
      const { code, out } = caddy("validate", env);
      expect(code, out).toBe(0);
      expect(out).toContain("Valid configuration");
    },
    TIMEOUT,
  );

  test(
    "an unknown TLS_MODE refuses to load",
    () => {
      const { code, out } = caddy("validate", { PUBLIC_HOSTNAME: "stream.example.org", TLS_MODE: "selfsigned" });
      expect(code).not.toBe(0);
      expect(out).toContain("tls-selfsigned");
    },
    TIMEOUT,
  );
});

describe("caddy adapt: the mode picks the issuer", () => {
  test(
    "acme by default, no email, Let's Encrypt",
    () => {
      const p = sitePolicy(
        { PUBLIC_HOSTNAME: "stream.example.org", ACME_EMAIL: "", ACME_CA: "" },
        "stream.example.org",
      );
      expect(p?.issuers).toEqual([{ module: "acme" }]);
    },
    TIMEOUT,
  );

  test(
    "acme with ACME_EMAIL and ACME_CA",
    () => {
      const ca = "https://acme-staging-v02.api.letsencrypt.org/directory";
      const p = sitePolicy(
        { PUBLIC_HOSTNAME: "stream.example.org", TLS_MODE: "acme", ACME_EMAIL: "ops@example.org", ACME_CA: ca },
        "stream.example.org",
      );
      expect(p?.issuers).toEqual([{ module: "acme", email: "ops@example.org", ca }]);
    },
    TIMEOUT,
  );

  test(
    "internal uses Caddy's own CA for the host",
    () => {
      const p = sitePolicy({ PUBLIC_HOSTNAME: "selfhost.test", TLS_MODE: "internal", ACME_EMAIL: "" }, "selfhost.test");
      expect(p?.issuers).toEqual([{ module: "internal" }]);
    },
    TIMEOUT,
  );
});

// --- presigned object routes (ADR 0024) -----------------------------------------------------

interface Route {
  match?: Record<string, unknown>[];
  handle?: { handler: string; routes?: Route[]; upstreams?: { dial: string }[]; max_size?: number }[];
}
interface Proxy {
  dial: string;
  match: Record<string, unknown>[];
  maxSize?: number;
}
/** Every reverse_proxy in the config, with the matchers of the route that holds it. */
function proxies(env: Record<string, string>): Proxy[] {
  const { code, out } = caddy("adapt", env);
  expect(code, out).toBe(0);
  const json = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)) as {
    apps: { http: { servers: Record<string, { routes: Route[] }> } };
  };
  const found: Proxy[] = [];
  const walk = (routes: Route[], outer: Record<string, unknown>[]) => {
    for (const r of routes) {
      const match = r.match ?? outer;
      const maxSize = r.handle?.find((h) => h.handler === "request_body")?.max_size;
      for (const h of r.handle ?? []) {
        if (h.handler === "reverse_proxy")
          for (const u of h.upstreams ?? []) found.push({ dial: u.dial, match, ...(maxSize ? { maxSize } : {}) });
        if (h.routes) walk(h.routes, match);
      }
    }
  };
  for (const server of Object.values(json.apps.http.servers)) walk(server.routes, []);
  return found;
}

describe("caddy adapt: only presigned object URLs reach Garage", () => {
  const SITE_ENV = { PUBLIC_HOSTNAME: "selfhost.test", TLS_MODE: "internal" };

  test(
    "the two shapes, with the default bucket names",
    () => {
      expect(proxies(SITE_ENV).filter((p) => p.dial.startsWith("garage"))).toEqual([
        {
          dial: "garage:3900",
          match: [
            {
              method: ["PUT"],
              not: [{ path: ["/commonair-media/incoming/"] }],
              path: ["/commonair-media/incoming/*"],
              query: { "X-Amz-Signature": ["*"] },
            },
          ],
          maxSize: 10_000_000,
        },
        {
          dial: "garage:3900",
          match: [
            {
              method: ["GET", "HEAD"],
              not: [{ path: ["/commonair-exports/"] }],
              path: ["/commonair-exports/*"],
              query: { "X-Amz-Signature": ["*"] },
            },
          ],
        },
      ]);
    },
    TIMEOUT,
  );

  test(
    "the bucket names come from the instance env",
    () => {
      const garage = proxies({ ...SITE_ENV, S3_BUCKET_MEDIA: "m-bucket", S3_BUCKET_EXPORTS: "x-bucket" }).filter((p) =>
        p.dial.startsWith("garage"),
      );
      expect(garage.map((p) => (p.match[0] as { path: string[] }).path)).toEqual([
        ["/m-bucket/incoming/*"],
        ["/x-bucket/*"],
      ]);
    },
    TIMEOUT,
  );

  test(
    "no other upstream is added",
    () => {
      expect(new Set(proxies(SITE_ENV).map((p) => p.dial))).toEqual(
        new Set(["garage:3900", "api:3001", "chat:3002", "origin:3003", "mediamtx:8889", "tracker:8000", "web:3000"]),
      );
    },
    TIMEOUT,
  );
});

/**
 * The real Caddyfile (internal TLS for selfhost.test) in front of one stub Caddy that answers as
 * both `garage` and `web`. The stub says what it received in an X-Stub header (method, Host, raw
 * URI, Content-Length) and reads the whole request body, as Garage does, so the front's body cap
 * is what refuses an oversized upload. Its bodies are long enough for `encode` to compress. curl
 * reaches the front through a published port, with --resolve so SNI and Host are the site's.
 */
describe("caddy live: presigned object routes", () => {
  const HOST = "selfhost.test";
  const MEDIA = "media-bucket";
  const EXPORTS = "exports-bucket";
  const FILLER = "x".repeat(2048);
  const id = `${process.pid}-${Date.now()}`;
  const network = `commonair-caddy-int-${id}`;
  const stub = `commonair-caddy-int-stub-${id}`;
  const front = `commonair-caddy-int-front-${id}`;
  let port = "";

  const pm = (args: string[]) => {
    const r = Bun.spawnSync(["podman", ...args], { stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  const must = (r: { code: number; err: string }) => {
    if (r.code !== 0) throw new Error(`podman exited ${r.code}: ${r.err}`);
  };

  interface Reply {
    status: number;
    /** The stub's X-Stub header: who answered and what it saw. Empty when the front answered. */
    stub: string;
    encoding: string;
    headers: string;
    body: string;
  }
  function curl(
    method: string,
    path: string,
    opts: { body?: Uint8Array; headers?: Record<string, string> } = {},
  ): Reply {
    const dir = mkdtempSync(join(tmpdir(), "commonair-caddy-curl-"));
    const args = ["-sS", "-k", "--path-as-is", "--resolve", `${HOST}:${port}:127.0.0.1`];
    args.push(...(method === "HEAD" ? ["-I"] : ["-X", method]));
    args.push("-D", join(dir, "headers"), "-o", join(dir, "body"), "-w", "%{http_code}");
    for (const [k, v] of Object.entries(opts.headers ?? {})) args.push("-H", `${k}: ${v}`);
    if (opts.body) {
      writeFileSync(join(dir, "upload"), opts.body);
      args.push("--data-binary", `@${join(dir, "upload")}`);
    }
    args.push(`https://${HOST}:${port}${path}`);
    const r = Bun.spawnSync(["curl", ...args], { stdout: "pipe", stderr: "pipe" });
    const read = (f: string) => {
      try {
        return readFileSync(join(dir, f), "latin1");
      } catch {
        return "";
      }
    };
    const headers = read("headers");
    const header = (name: string) => new RegExp(`^${name}: (.*?)\\r?$`, "im").exec(headers)?.[1] ?? "";
    return {
      status: Number(r.stdout.toString()),
      stub: header("x-stub"),
      encoding: header("content-encoding"),
      headers,
      body: read("body"),
    };
  }

  // Presigned URLs exactly as the API builds them (fake keys: the stub verifies nothing).
  const s3 = createS3Storage({
    endpoint: "http://garage:3900",
    publicEndpoint: `https://${HOST}`,
    region: "garage",
    accessKeyId: "GKtest",
    secretAccessKey: "secret",
    forcePathStyle: true,
  });
  const pathOf = (url: string) => {
    const u = new URL(url);
    expect(u.origin).toBe(`https://${HOST}`);
    return u.pathname + u.search;
  };
  const upload = async (key: string, body: Uint8Array) =>
    pathOf(
      await s3.presignPut(MEDIA, key, { expiresSeconds: 600, contentType: "image/png", contentLength: body.length }),
    );
  const png = { "content-type": "image/png" };

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "commonair-caddy-stub-"));
    // {uri} is the raw request URI. {http.request.body} makes the stub read the whole body.
    writeFileSync(
      join(dir, "Caddyfile"),
      [
        "{",
        "\tauto_https off",
        "\tadmin off",
        "}",
        ":3900 {",
        '\theader X-Stub "garage {method} {host} {uri} {header.Content-Length}"',
        `\trespond "{http.request.body}${FILLER}" 200`,
        "}",
        ":3000 {",
        '\theader X-Stub "web {method} {uri}"',
        `\trespond "${FILLER}" 404`,
        "}",
        "",
      ].join("\n"),
    );
    const n = pm(["network", "create", network]);
    must(n);
    const s = pm([
      "run",
      "-d",
      "--name",
      stub,
      "--network",
      network,
      "--network-alias",
      "garage",
      "--network-alias",
      "web",
      "-v",
      `${dir}/Caddyfile:/etc/caddy/Caddyfile:ro,Z`,
      IMAGE,
    ]);
    must(s);
    const f = pm([
      "run",
      "-d",
      "--name",
      front,
      "--network",
      network,
      "-p",
      "127.0.0.1::443",
      "-e",
      `PUBLIC_HOSTNAME=${HOST}`,
      "-e",
      "TLS_MODE=internal",
      "-e",
      `S3_BUCKET_MEDIA=${MEDIA}`,
      "-e",
      `S3_BUCKET_EXPORTS=${EXPORTS}`,
      "-v",
      `${CADDYFILE}:/etc/caddy/Caddyfile:ro,Z`,
      IMAGE,
    ]);
    must(f);
    port = pm(["port", front, "443/tcp"]).out.trim().split("\n")[0]!.split(":").at(-1)!;
    for (let i = 0; i < 60; i++) {
      if (curl("GET", "/ready").stub === "web GET /ready") return;
      await Bun.sleep(500);
    }
    throw new Error(`the front Caddy did not answer: ${pm(["logs", front]).err.slice(-2000)}`);
  }, TIMEOUT);

  afterAll(() => {
    for (const c of [front, stub]) pm(["rm", "-f", "-t", "0", c]);
    pm(["network", "rm", "-f", network]);
  });

  test("a presigned upload reaches Garage with Host, raw path, query and body unchanged", async () => {
    const body = new TextEncoder().encode("avatar bytes");
    const raw = await upload("incoming/0190a1b2-c3d4/avatar file~.png", body);
    expect(raw).toContain("%20");
    const r = curl("PUT", raw, { body, headers: png });
    expect(r.status).toBe(200);
    expect(r.stub).toBe(`garage PUT ${HOST} ${raw} ${body.length}`);
    expect(r.body).toBe(`avatar bytes${FILLER}`);
  });

  test("a presigned export download reaches Garage and is passed through uncompressed", async () => {
    const raw = pathOf(
      await s3.presignGet(EXPORTS, "user/0190a1b2/export.zip", { expiresSeconds: 600, filename: "export.zip" }),
    );
    expect(raw).toContain("response-content-disposition=");
    const r = curl("GET", raw, { headers: { "accept-encoding": "gzip, zstd" } });
    expect(r.status).toBe(200);
    expect(r.stub).toBe(`garage GET ${HOST} ${raw}`);
    expect(r.encoding).toBe("");
    expect(r.body).toBe(FILLER);
    // The site's security headers still apply.
    expect(r.headers).toMatch(/^strict-transport-security: /im);
    const head = curl("HEAD", raw);
    expect(head.status).toBe(200);
    expect(head.stub).toBe(`garage HEAD ${HOST} ${raw}`);
  });

  test("the web app's responses are still compressed", () => {
    const r = curl("GET", "/ready", { headers: { "accept-encoding": "gzip" } });
    expect(r.stub).toBe("web GET /ready");
    expect(r.encoding).toBe("gzip");
  });

  test("a body over the 10 MB contract limit is refused at Caddy", async () => {
    const big = new Uint8Array(10_000_001);
    const r = curl("PUT", await upload("incoming/c/big.png", big), { body: big, headers: png });
    expect(r.status).toBe(413);
  });

  test("exactly 10 MB still passes", async () => {
    const max = new Uint8Array(10_000_000);
    const raw = await upload("incoming/c/max.png", max);
    const r = curl("PUT", raw, { body: max, headers: png });
    expect(r.status).toBe(200);
    expect(r.stub).toBe(`garage PUT ${HOST} ${raw} 10000000`);
  });

  const SIG = "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc";
  const REFUSED: [string, string, string][] = [
    ["an unsigned upload", "PUT", `/${MEDIA}/incoming/c/a.png`],
    ["an upload with an empty query", "PUT", `/${MEDIA}/incoming/c/a.png?`],
    ["an upload outside incoming/", "PUT", `/${MEDIA}/public/c/a.png?${SIG}`],
    ["an upload to the exports bucket", "PUT", `/${EXPORTS}/a.zip?${SIG}`],
    ["a bucket create", "PUT", `/${MEDIA}?${SIG}`],
    ["a signed-looking read of incoming/", "GET", `/${MEDIA}/incoming/c/a.png?${SIG}`],
    ["a read of the moderation prefix", "GET", `/${MEDIA}/moderation/a.png?${SIG}`],
    ["a read of the evidence bucket", "GET", `/commonair-evidence/a?${SIG}`],
    ["a read of the backups bucket", "GET", `/commonair-backups/a?${SIG}`],
    ["an unsigned export read", "GET", `/${EXPORTS}/a.zip`],
    ["an export read with the signature name only in the path", "GET", `/${EXPORTS}/X-Amz-Signature=abc`],
    ["a bucket listing", "GET", `/${EXPORTS}?list-type=2`],
    ["a signed-looking bucket listing", "GET", `/${EXPORTS}?list-type=2&${SIG}`],
    ["a signed-looking bucket listing with a trailing slash", "GET", `/${EXPORTS}/?list-type=2&${SIG}`],
    ["a signed-looking upload to the incoming/ prefix itself", "PUT", `/${MEDIA}/incoming/?${SIG}`],
    ["a delete", "DELETE", `/${EXPORTS}/a.zip?${SIG}`],
    ["a delete in incoming/", "DELETE", `/${MEDIA}/incoming/c/a.png?${SIG}`],
    ["a multipart upload start", "POST", `/${MEDIA}/incoming/c/a.png?uploads&${SIG}`],
  ];
  test.each(REFUSED)("%s falls through to the web app", (_, method, path) => {
    const r = curl(method, path);
    expect(r.status).toBe(404);
    expect(r.stub).toBe(`web ${method} ${path}`);
  });
});
