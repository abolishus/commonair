// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * infra/garage/storage-init.ts: the mode switch, the external store's settings, and the bucket
 * check, first with injected clients, then with Bun's real S3 client against a local server that
 * answers like an S3 store (signed requests, XML errors), so the signing and URL style are real.
 */
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  type BucketClient,
  type ClientFor,
  type ExternalStore,
  PROBE_PREFIX,
  bucketEndpoint,
  bunClients,
  checkExternalStore,
  explain,
  formatReport,
  main,
  storageMode,
  storeFromEnv,
} from "../garage/storage-init.ts";

const ENV = {
  S3_MODE: "external",
  S3_ENDPOINT: "https://nyc3.digitaloceanspaces.com/",
  S3_REGION: "nyc3",
  S3_FORCE_PATH_STYLE: "false",
  S3_BUCKET_MEDIA: "ca-media",
  S3_BUCKET_EXPORTS: "ca-exports",
  S3_BUCKET_BACKUPS: "ca-backups",
  S3_BUCKET_EVIDENCE: "ca-evidence",
  S3_ACCESS_KEY_ID: "MAINKEY",
  S3_SECRET_ACCESS_KEY: "main-secret",
  S3_EVIDENCE_ACCESS_KEY_ID: "EVIDENCEKEY",
  S3_EVIDENCE_SECRET_ACCESS_KEY: "evidence-secret",
};

describe("storageMode", () => {
  test.each([
    [undefined, "garage"],
    ["", "garage"],
    ["garage", "garage"],
    ["external", "external"],
  ])("S3_MODE=%s is %s", (mode, want) => {
    expect(storageMode({ S3_MODE: mode })).toBe(want);
  });

  test("anything else is an error, never a silent Garage", () => {
    expect(() => storageMode({ S3_MODE: "minio" })).toThrow("S3_MODE must be garage or external, not minio");
  });
});

describe("storeFromEnv", () => {
  test("reads the store, trimming the endpoint's slash", () => {
    expect(storeFromEnv(ENV)).toEqual({
      endpoint: "https://nyc3.digitaloceanspaces.com",
      region: "nyc3",
      pathStyle: false,
      buckets: { media: "ca-media", exports: "ca-exports", backups: "ca-backups", evidence: "ca-evidence" },
      main: { accessKeyId: "MAINKEY", secretAccessKey: "main-secret" },
      evidence: { accessKeyId: "EVIDENCEKEY", secretAccessKey: "evidence-secret" },
      checkBackups: true,
    });
  });

  test("defaults: path style and today's bucket names", () => {
    const s = storeFromEnv({
      ...ENV,
      S3_FORCE_PATH_STYLE: "",
      S3_BUCKET_MEDIA: "",
      S3_BUCKET_EXPORTS: undefined,
      S3_BUCKET_BACKUPS: undefined,
      S3_BUCKET_EVIDENCE: undefined,
    } as Record<string, string | undefined>);
    expect(s.pathStyle).toBe(true);
    expect(s.buckets).toEqual({
      media: "commonair-media",
      exports: "commonair-exports",
      backups: "commonair-backups",
      evidence: "commonair-evidence",
    });
  });

  test.each([["AWS_ENDPOINT"], ["WALG_S3_PREFIX"]])("%s set: the backups bucket here is not WAL-G's", (k) => {
    expect(storeFromEnv({ ...ENV, [k]: "x" }).checkBackups).toBe(false);
  });

  test.each([
    [{ S3_ENDPOINT: "" }, "S3_ENDPOINT is required"],
    [{ S3_ENDPOINT: "nyc3.digitaloceanspaces.com" }, "S3_ENDPOINT is not a URL"],
    [{ S3_ENDPOINT: "ftp://store" }, "must be an http(s) URL"],
    [{ S3_REGION: "" }, "S3_REGION is required"],
    [{ S3_FORCE_PATH_STYLE: "yes" }, "S3_FORCE_PATH_STYLE must be true or false"],
    [{ S3_ACCESS_KEY_ID: "" }, "S3_ACCESS_KEY_ID is required"],
    [{ S3_EVIDENCE_SECRET_ACCESS_KEY: "" }, "S3_EVIDENCE_SECRET_ACCESS_KEY is required"],
    [{ S3_EVIDENCE_ACCESS_KEY_ID: "MAINKEY" }, "the evidence key must differ"],
    [{ S3_BUCKET_MEDIA: "Bad_Name" }, "invalid bucket name"],
    [{ S3_BUCKET_EXPORTS: "ca-media" }, "four different buckets"],
  ] as [Record<string, string>, string][])("%j is refused", (patch, message) => {
    expect(() => storeFromEnv({ ...ENV, ...patch })).toThrow(message);
  });
});

test("bucketEndpoint: path style keeps the endpoint; virtual-hosted puts the bucket in the host", () => {
  expect(bucketEndpoint("https://s3.example.net:8443", "b", true)).toBe("https://s3.example.net:8443");
  expect(bucketEndpoint("https://nyc3.digitaloceanspaces.com", "ca-media", false)).toBe(
    "https://ca-media.nyc3.digitaloceanspaces.com",
  );
});

describe("explain", () => {
  const ctx = { bucket: "ca-media", keyName: "S3_ACCESS_KEY_ID", endpoint: "https://s3.example.net" };
  test.each([
    ["NoSuchBucket", "bucket ca-media does not exist on https://s3.example.net: create it"],
    ["AccessDenied", "S3_ACCESS_KEY_ID may not read, write and delete in ca-media"],
    ["InvalidAccessKeyId", "the store does not know S3_ACCESS_KEY_ID"],
    ["SignatureDoesNotMatch", "check its secret and S3_REGION"],
    ["AuthorizationHeaderMalformed", "is not in region S3_REGION"],
    ["PermanentRedirect", "is not in region S3_REGION"],
    ["TimeoutError", "did not answer in time"],
  ])("%s", (code, message) => {
    expect(explain(Object.assign(new Error("x"), { code }), ctx)).toContain(message);
  });

  test("a connection failure names the endpoint", () => {
    expect(explain(Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" }), ctx)).toContain(
      "cannot reach https://s3.example.net",
    );
  });

  test("anything else is passed on with its code", () => {
    expect(explain(Object.assign(new Error("slow down"), { code: "SlowDown" }), ctx)).toBe(
      "ca-media: SlowDown: slow down",
    );
  });
});

/** An in-memory store: buckets, which key may use which, and the calls made. */
function fakeStore(opts: { buckets: string[]; grants: Record<string, string[]>; corrupt?: string; hang?: string }): {
  clientFor: ClientFor;
  calls: string[];
  objects: Map<string, string>;
} {
  const calls: string[] = [];
  const objects = new Map<string, string>();
  const fail = (code: string) => Promise.reject(Object.assign(new Error(code), { code }));
  const clientFor: ClientFor = (bucket, key): BucketClient => {
    const gate = (op: string): Promise<void> | null => {
      calls.push(`${key.accessKeyId} ${op} ${bucket}`);
      if (bucket === opts.hang) return new Promise(() => {});
      if (!opts.buckets.includes(bucket)) return fail("NoSuchBucket");
      if (!(opts.grants[key.accessKeyId] ?? []).includes(bucket)) return fail("AccessDenied");
      return null;
    };
    return {
      write: (k, body) => gate("write") ?? (objects.set(`${bucket}/${k}`, body), Promise.resolve()),
      text: (k) =>
        (gate("text") as Promise<string> | null) ??
        Promise.resolve(bucket === opts.corrupt ? "other" : (objects.get(`${bucket}/${k}`) ?? "")),
      delete: (k) => gate("delete") ?? (objects.delete(`${bucket}/${k}`), Promise.resolve()),
      list: () => gate("list") ?? Promise.resolve({}),
    };
  };
  return { clientFor, calls, objects };
}

const STORE: ExternalStore = storeFromEnv(ENV);
const ALL = ["ca-media", "ca-exports", "ca-backups", "ca-evidence"];
const GOOD = { MAINKEY: ["ca-media", "ca-exports", "ca-backups"], EVIDENCEKEY: ["ca-evidence"] };

describe("checkExternalStore", () => {
  test("a ready store: each bucket with its own key, the probe written, read back and deleted", async () => {
    const f = fakeStore({ buckets: ALL, grants: GOOD });
    const r = await checkExternalStore(STORE, f.clientFor, { write: true, probeKey: `${PROBE_PREFIX}t` });
    expect(r).toEqual({
      ok: true,
      warnings: [],
      buckets: [
        { role: "media", bucket: "ca-media", ok: true },
        { role: "exports", bucket: "ca-exports", ok: true },
        { role: "backups", bucket: "ca-backups", ok: true },
        { role: "evidence", bucket: "ca-evidence", ok: true },
      ],
    });
    expect(f.calls.slice(0, 3)).toEqual(["MAINKEY write ca-media", "MAINKEY text ca-media", "MAINKEY delete ca-media"]);
    expect(f.calls).toContain("EVIDENCEKEY write ca-evidence");
    expect(f.calls).not.toContain("MAINKEY write ca-evidence");
    // The isolation probe: the main key tries to list the evidence bucket, and is refused.
    expect(f.calls.at(-1)).toBe("MAINKEY list ca-evidence");
    expect(f.objects.size).toBe(0);
  });

  test("read only (status): one listing per bucket, nothing written", async () => {
    const f = fakeStore({ buckets: ALL, grants: GOOD });
    const r = await checkExternalStore(STORE, f.clientFor, { write: false });
    expect(r.ok).toBe(true);
    expect(f.calls.filter((c) => !c.includes(" list "))).toEqual([]);
  });

  test("a missing bucket and a key without access are named, and the check fails", async () => {
    const f = fakeStore({
      buckets: ["ca-media", "ca-backups", "ca-evidence"],
      grants: { MAINKEY: ["ca-media"], EVIDENCEKEY: ["ca-evidence"] },
    });
    const r = await checkExternalStore(STORE, f.clientFor, { write: true });
    expect(r.ok).toBe(false);
    const byRole = Object.fromEntries(r.buckets.map((b) => [b.role, b]));
    expect(byRole.media!.ok).toBe(true);
    expect(byRole.exports!.problem).toContain("bucket ca-exports does not exist");
    expect(byRole.backups!.problem).toContain("S3_ACCESS_KEY_ID may not read, write and delete in ca-backups");
    expect(byRole.evidence!.ok).toBe(true);
    const lines = formatReport(r);
    expect(lines.some((l) => l.startsWith("exports   ca-exports") && l.includes("FAILED"))).toBe(true);
    for (const l of lines) for (const secret of ["main-secret", "evidence-secret"]) expect(l).not.toContain(secret);
  });

  test("the evidence bucket is checked with the evidence key alone", async () => {
    const f = fakeStore({ buckets: ALL, grants: { MAINKEY: ALL, EVIDENCEKEY: [] } });
    const r = await checkExternalStore(STORE, f.clientFor, { write: true });
    expect(r.buckets.find((b) => b.role === "evidence")!.problem).toContain(
      "S3_EVIDENCE_ACCESS_KEY_ID may not read, write and delete in ca-evidence",
    );
  });

  test("a main key that can reach the evidence bucket is a warning (ADR 0006 Q4), not a failure", async () => {
    const f = fakeStore({ buckets: ALL, grants: { MAINKEY: ALL, EVIDENCEKEY: ["ca-evidence"] } });
    const r = await checkExternalStore(STORE, f.clientFor, { write: true });
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([
      "S3_ACCESS_KEY_ID can list the evidence bucket ca-evidence: give the services a key limited to ca-media, ca-exports and ca-backups (ADR 0006 Q4)",
    ]);
    expect(formatReport(r).at(-1)).toMatch(/^WARNING: S3_ACCESS_KEY_ID can list/);
  });

  test("a store that returns other bytes fails", async () => {
    const f = fakeStore({ buckets: ALL, grants: GOOD, corrupt: "ca-exports" });
    const r = await checkExternalStore(STORE, f.clientFor, { write: true });
    expect(r.buckets.find((b) => b.role === "exports")!.problem).toContain("returned other bytes");
  });

  test("a store that never answers times out per call", async () => {
    const f = fakeStore({ buckets: ALL, grants: GOOD, hang: "ca-media" });
    const r = await checkExternalStore(STORE, f.clientFor, { write: true, timeoutMs: 20 });
    expect(r.buckets[0]!.problem).toContain("did not answer in time");
    expect(r.buckets.slice(1).every((b) => b.ok)).toBe(true);
  });

  test("backups elsewhere (AWS_ENDPOINT): that bucket is skipped, not failed", async () => {
    const f = fakeStore({ buckets: ["ca-media", "ca-exports", "ca-evidence"], grants: GOOD });
    const r = await checkExternalStore(storeFromEnv({ ...ENV, AWS_ENDPOINT: "https://ams3.example" }), f.clientFor, {
      write: true,
    });
    expect(r.ok).toBe(true);
    expect(r.buckets.find((b) => b.role === "backups")!.skipped).toContain("AWS_ENDPOINT");
    expect(f.calls.some((c) => c.includes("ca-backups"))).toBe(false);
  });
});

// --- Bun's S3 client against a local stand-in --------------------------------------------

interface Seen {
  method: string;
  host: string;
  path: string;
  auth: string;
}
const seen: Seen[] = [];
const objects = new Map<string, string>();
let server: ReturnType<typeof Bun.serve>;
const xmlError = (status: number, code: string) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`, {
    status,
    headers: { "content-type": "application/xml" },
  });

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const host = req.headers.get("host") ?? "";
      const auth = req.headers.get("authorization") ?? "";
      seen.push({ method: req.method, host, path: url.pathname + url.search, auth });
      // Path style only here: /<bucket>/<key>.
      const [, bucket = "", ...rest] = url.pathname.split("/");
      const key = rest.join("/");
      if (!auth.startsWith("AWS4-HMAC-SHA256 Credential=")) return xmlError(403, "AccessDenied");
      if (bucket === "missing") return xmlError(404, "NoSuchBucket");
      const keyId = /Credential=([^/]+)\//.exec(auth)?.[1];
      if (bucket === "ca-evidence" && keyId !== "EVIDENCEKEY") return xmlError(403, "AccessDenied");
      if (bucket !== "ca-evidence" && keyId !== "MAINKEY") return xmlError(403, "AccessDenied");
      if (req.method === "GET" && url.searchParams.has("list-type"))
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><KeyCount>0</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>`,
          { headers: { "content-type": "application/xml" } },
        );
      const id = `${bucket}/${key}`;
      if (req.method === "PUT") {
        objects.set(id, await req.text());
        return new Response(null, { status: 200, headers: { etag: '"1"' } });
      }
      if (req.method === "GET") {
        const body = objects.get(id);
        return body === undefined ? xmlError(404, "NoSuchKey") : new Response(body);
      }
      if (req.method === "DELETE") {
        objects.delete(id);
        return new Response(null, { status: 204 });
      }
      return xmlError(405, "MethodNotAllowed");
    },
  });
});
afterAll(() => {
  void server.stop(true);
});

const endpoint = () => `http://127.0.0.1:${server.port}`;
const localEnv = (patch: Record<string, string> = {}) => ({
  ...ENV,
  S3_ENDPOINT: endpoint(),
  S3_FORCE_PATH_STYLE: "true",
  ...patch,
});

describe("with Bun's S3 client (signed requests, XML errors)", () => {
  test("a ready store passes, and the probe object is gone afterwards", async () => {
    seen.length = 0;
    const store = storeFromEnv(localEnv());
    const r = await checkExternalStore(store, bunClients(store), { write: true });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.warnings).toEqual([]);
    expect(objects.size).toBe(0);
    const puts = seen.filter((s) => s.method === "PUT");
    expect(puts.map((s) => s.path.split("/")[1])).toEqual(["ca-media", "ca-exports", "ca-backups", "ca-evidence"]);
    for (const p of puts) expect(p.path).toContain(`/${PROBE_PREFIX}`);
    // SigV4 for the configured region, with each bucket's own key.
    expect(puts[0]!.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=MAINKEY\/\d{8}\/nyc3\/s3\/aws4_request/);
    expect(puts[3]!.auth).toContain("Credential=EVIDENCEKEY/");
    // No secret travels.
    for (const s of seen) expect(JSON.stringify(s)).not.toMatch(/main-secret|evidence-secret/);
  });

  test("a missing bucket is reported by name from the store's XML error", async () => {
    const store = storeFromEnv(localEnv({ S3_BUCKET_EXPORTS: "missing" }));
    const r = await checkExternalStore(store, bunClients(store), { write: true });
    expect(r.ok).toBe(false);
    expect(r.buckets.find((b) => b.role === "exports")!.problem).toContain("bucket missing does not exist");
  });

  test("a refused key is reported as such", async () => {
    const store = storeFromEnv(localEnv({ S3_ACCESS_KEY_ID: "OTHERKEY" }));
    const r = await checkExternalStore(store, bunClients(store), { write: false });
    expect(r.buckets.find((b) => b.role === "media")!.problem).toContain("S3_ACCESS_KEY_ID may not read");
  });

  test("an unreachable store is reported, quickly", async () => {
    const store = storeFromEnv(localEnv({ S3_ENDPOINT: "http://127.0.0.1:9" }));
    const r = await checkExternalStore(store, bunClients(store), { write: false, timeoutMs: 5000 });
    expect(r.ok).toBe(false);
    expect(r.buckets[0]!.problem).toMatch(/cannot reach http:\/\/127\.0\.0\.1:9|did not answer/);
  });

  // Subdomains of localhost resolve to loopback where the resolver follows RFC 6761 (macOS,
  // systemd-resolved); a bare glibc resolver may not, and there bucketEndpoint's test covers the
  // URL style alone.
  const subdomainResolves =
    Bun.spawnSync([process.execPath, "-e", "await Bun.dns.lookup('ca-media.localhost')"]).exitCode === 0;
  test.skipIf(!subdomainResolves)("virtual-hosted style sends the bucket in the Host header", async () => {
    seen.length = 0;
    const store = storeFromEnv(
      localEnv({ S3_ENDPOINT: `http://localhost:${server.port}`, S3_FORCE_PATH_STYLE: "false" }),
    );
    await checkExternalStore(store, bunClients(store), { write: false, timeoutMs: 3000 }).catch(() => undefined);
    expect(seen.map((s) => s.host)[0]).toBe(`ca-media.localhost:${server.port}`);
  });
});

describe("main (the unit's entry point)", () => {
  const capture = async (argv: string[], env: Record<string, string | undefined>) => {
    const out: string[] = [];
    const err: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    const warn = console.warn;
    const error = console.error;
    process.stdout.write = ((s: string) => (out.push(String(s)), true)) as typeof process.stdout.write;
    console.warn = (...a: unknown[]) => err.push(a.join(" "));
    console.error = (...a: unknown[]) => err.push(a.join(" "));
    try {
      const code = await main(argv, env);
      return { code, out: out.join(""), err: err.join("\n") };
    } finally {
      process.stdout.write = write;
      console.warn = warn;
      console.error = error;
    }
  };

  test("--check in Garage mode only names Garage (status shows no store check for it)", async () => {
    const r = await capture(["--check"], {});
    expect(r).toMatchObject({ code: 0, out: "object storage: Garage on this host (commonair-garage)\n" });
  });

  test("external --check: one line per bucket on stdout, exit 0", async () => {
    const r = await capture(["--check"], localEnv());
    expect(r.code, r.err).toBe(0);
    expect(
      r.out
        .trim()
        .split("\n")
        .map((l) => l.split(/\s+/)[0]),
    ).toEqual(["media", "exports", "backups", "evidence"]);
    expect(r.out).not.toMatch(/MAINKEY|main-secret|evidence-secret/);
  });

  test("external, not ready: exit 1 with what to fix and how to retry", async () => {
    const r = await capture([], localEnv({ S3_BUCKET_MEDIA: "missing" }));
    expect(r.code).toBe(1);
    expect(r.err).toContain("bucket missing does not exist");
    expect(r.err).toContain("systemctl --user restart commonair-storage-init");
  });

  test("external, ready: exit 0 and says so", async () => {
    const r = await capture([], localEnv());
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain("is ready");
  });
});
