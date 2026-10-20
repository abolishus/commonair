// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  bootstrapGarage,
  optionsFromEnv,
  validateBucketName,
  validateKeyPair,
  type GarageBootstrapOptions,
} from "../garage/bootstrap.ts";

const KEY = `GK${"a1".repeat(12)}`;
const SECRET = "b2".repeat(32);
const NODE = "c3".repeat(32);
const EKEY = `GK${"e5".repeat(12)}`;
const ESECRET = "f6".repeat(32);
const EVIDENCE = {
  accessKeyId: EKEY,
  secretAccessKey: ESECRET,
  keyName: "commonair-evidence",
  bucket: "commonair-evidence",
};
type Perms = { read: boolean; write: boolean; owner: boolean };
const full = (): Perms => ({ read: true, write: true, owner: true });

interface FakeState {
  up: boolean;
  layoutVersion: number;
  roles: string[];
  staged: string[];
  healthy: boolean;
  keys: Map<string, string>;
  buckets: Map<string, { id: string; grants: Map<string, Perms> }>;
  calls: string[];
  token: string;
}

/** In-memory Garage admin API v2, matching the shapes Garage v2.4.1 returns. */
function fakeGarage(init: Partial<FakeState> = {}): { state: FakeState; fetch: typeof fetch } {
  const state: FakeState = {
    up: true,
    layoutVersion: 0,
    roles: [],
    staged: [],
    healthy: false,
    keys: new Map(),
    buckets: new Map(),
    calls: [],
    token: "admin-token",
    ...init,
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const err = (status: number, code: string) => json(status, { code, message: code });
  const fetchImpl = async (input: string | URL | Request, reqInit?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const op = url.pathname.replace("/v2/", "");
    state.calls.push(op);
    if (!state.up) throw new TypeError("connection refused");
    if (new Headers(reqInit?.headers).get("authorization") !== `Bearer ${state.token}`) return err(403, "AccessDenied");
    const body = typeof reqInit?.body === "string" ? JSON.parse(reqInit.body) : {};
    switch (op) {
      case "GetClusterStatus":
        return json(200, { layoutVersion: state.layoutVersion, nodes: [{ id: NODE, isUp: true, role: null }] });
      case "GetClusterHealth":
        return json(200, { status: state.healthy ? "healthy" : "unavailable" });
      case "GetClusterLayout":
        return json(200, {
          version: state.layoutVersion,
          roles: state.roles.map((id) => ({ id })),
          stagedRoleChanges: state.staged.map((id) => ({ id })),
        });
      case "UpdateClusterLayout":
        state.staged.push(...body.roles.map((r: { id: string }) => r.id));
        return json(200, {});
      case "ApplyClusterLayout":
        if (body.version !== state.layoutVersion + 1) return err(500, "InternalError");
        state.layoutVersion = body.version;
        state.roles = [...state.staged];
        state.staged = [];
        state.healthy = true;
        return json(200, {});
      case "GetKeyInfo": {
        const id = url.searchParams.get("id") ?? "";
        const secret = state.keys.get(id);
        if (secret === undefined) return err(404, "NoSuchAccessKey");
        return json(200, { accessKeyId: id, secretAccessKey: secret });
      }
      case "ImportKey":
        if (state.keys.has(body.accessKeyId)) return err(409, "KeyAlreadyExists");
        state.keys.set(body.accessKeyId, body.secretAccessKey);
        return json(200, { accessKeyId: body.accessKeyId });
      case "GetBucketInfo": {
        const b = state.buckets.get(url.searchParams.get("globalAlias") ?? "");
        if (!b) return err(404, "NoSuchBucket");
        return json(200, {
          id: b.id,
          keys: [...b.grants].map(([k, permissions]) => ({ accessKeyId: k, permissions })),
        });
      }
      case "CreateBucket": {
        if (state.buckets.has(body.globalAlias)) return err(409, "BucketAlreadyExists");
        const b = { id: crypto.randomUUID(), grants: new Map<string, Perms>() };
        state.buckets.set(body.globalAlias, b);
        return json(200, { id: b.id, keys: [] });
      }
      case "AllowBucketKey": {
        const b = [...state.buckets.values()].find((x) => x.id === body.bucketId);
        if (!b) return err(404, "NoSuchBucket");
        const cur = b.grants.get(body.accessKeyId) ?? { read: false, write: false, owner: false };
        const p = body.permissions as Perms;
        b.grants.set(body.accessKeyId, {
          read: cur.read || p.read,
          write: cur.write || p.write,
          owner: cur.owner || p.owner,
        });
        return json(200, { id: b.id, keys: [] });
      }
      case "DenyBucketKey": {
        const b = [...state.buckets.values()].find((x) => x.id === body.bucketId);
        if (!b) return err(404, "NoSuchBucket");
        const cur = b.grants.get(body.accessKeyId);
        const p = body.permissions as Perms;
        if (cur) {
          const next = { read: cur.read && !p.read, write: cur.write && !p.write, owner: cur.owner && !p.owner };
          if (next.read || next.write || next.owner) b.grants.set(body.accessKeyId, next);
          else b.grants.delete(body.accessKeyId);
        }
        return json(200, { id: b.id, keys: [] });
      }
      default:
        return err(400, "UnknownOp");
    }
  };
  return { state, fetch: fetchImpl as typeof fetch };
}

function opts(f: typeof fetch, extra: Partial<GarageBootstrapOptions> = {}): GarageBootstrapOptions {
  return {
    adminUrl: "http://garage:3903/",
    adminToken: "admin-token",
    accessKeyId: KEY,
    secretAccessKey: SECRET,
    keyName: "commonair",
    buckets: ["commonair-media", "commonair-exports", "commonair-backups"],
    evidence: EVIDENCE,
    zone: "dc1",
    capacityBytes: 1_000_000_000,
    timeoutMs: 5_000,
    fetch: f,
    sleep: async () => {},
    ...extra,
  };
}

describe("bootstrapGarage", () => {
  test("fresh cluster: applies the layout, imports the key, creates and grants every bucket", async () => {
    const g = fakeGarage();
    const r = await bootstrapGarage(opts(g.fetch));
    expect(r).toEqual({
      layoutApplied: true,
      keyImported: true,
      bucketsCreated: ["commonair-media", "commonair-exports", "commonair-backups", "commonair-evidence"],
      evidenceKeyImported: true,
      revoked: [],
    });
    expect(g.state.layoutVersion).toBe(1);
    expect(g.state.roles).toEqual([NODE]);
    expect(g.state.keys.get(KEY)).toBe(SECRET);
    expect(g.state.keys.get(EKEY)).toBe(ESECRET);
    const grants = Object.fromEntries([...g.state.buckets].map(([alias, b]) => [alias, [...b.grants]]));
    expect(grants).toEqual({
      "commonair-media": [[KEY, full()]],
      "commonair-exports": [[KEY, full()]],
      "commonair-backups": [[KEY, full()]],
      "commonair-evidence": [[EKEY, { read: true, write: true, owner: false }]],
    });
  });

  test("second run is a no-op (idempotent)", async () => {
    const g = fakeGarage();
    await bootstrapGarage(opts(g.fetch));
    g.state.calls = [];
    const r = await bootstrapGarage(opts(g.fetch));
    expect(r).toEqual({
      layoutApplied: false,
      keyImported: false,
      bucketsCreated: [],
      evidenceKeyImported: false,
      revoked: [],
    });
    expect(g.state.calls).not.toContain("UpdateClusterLayout");
    expect(g.state.calls).not.toContain("ApplyClusterLayout");
    expect(g.state.calls).not.toContain("ImportKey");
    expect(g.state.calls).not.toContain("CreateBucket");
    expect(g.state.calls).not.toContain("AllowBucketKey");
    expect(g.state.calls).not.toContain("DenyBucketKey");
  });

  test("the main key loses any access to the evidence bucket, and the evidence key to every other bucket", async () => {
    const g = fakeGarage({
      layoutVersion: 1,
      roles: [NODE],
      healthy: true,
      keys: new Map([
        [KEY, SECRET],
        [EKEY, ESECRET],
      ]),
      buckets: new Map([
        [
          "commonair-evidence",
          {
            id: "e",
            grants: new Map([
              [KEY, { read: true, write: false, owner: false }],
              [EKEY, full()],
            ]),
          },
        ],
        [
          "commonair-media",
          {
            id: "m",
            grants: new Map([
              [KEY, full()],
              [EKEY, { read: true, write: false, owner: false }],
            ]),
          },
        ],
      ]),
    });
    const r = await bootstrapGarage(opts(g.fetch));
    expect(r.revoked.toSorted()).toEqual([
      `${KEY}@commonair-evidence`,
      `${EKEY}@commonair-evidence:owner`,
      `${EKEY}@commonair-media`,
    ]);
    expect([...g.state.buckets.get("commonair-evidence")!.grants]).toEqual([
      [EKEY, { read: true, write: true, owner: false }],
    ]);
    expect([...g.state.buckets.get("commonair-media")!.grants]).toEqual([[KEY, full()]]);
    const again = await bootstrapGarage(opts(g.fetch));
    expect(again.revoked).toEqual([]);
  });

  test("refuses an evidence key equal to the main key or an evidence bucket shared with another", async () => {
    const g = fakeGarage();
    await expect(
      bootstrapGarage(opts(g.fetch, { evidence: { ...EVIDENCE, accessKeyId: KEY, secretAccessKey: SECRET } })),
    ).rejects.toThrow(/must differ/);
    await expect(
      bootstrapGarage(opts(g.fetch, { evidence: { ...EVIDENCE, bucket: "commonair-media" } })),
    ).rejects.toThrow(/its own bucket/);
    await expect(bootstrapGarage(opts(g.fetch, { evidence: { ...EVIDENCE, accessKeyId: "AKIA" } }))).rejects.toThrow(
      /GK/,
    );
    expect(g.state.calls).toEqual([]);
  });

  test("a role staged by an interrupted run is applied without restaging", async () => {
    const g = fakeGarage({ staged: [NODE] });
    await bootstrapGarage(opts(g.fetch));
    expect(g.state.calls.filter((c) => c === "UpdateClusterLayout")).toHaveLength(0);
    expect(g.state.layoutVersion).toBe(1);
  });

  test("grants an existing bucket that lacks the key", async () => {
    const g = fakeGarage({
      layoutVersion: 1,
      roles: [NODE],
      healthy: true,
      keys: new Map([[KEY, SECRET]]),
      buckets: new Map([["commonair-media", { id: "m", grants: new Map<string, Perms>() }]]),
    });
    const r = await bootstrapGarage(opts(g.fetch));
    expect(r.bucketsCreated).toEqual(["commonair-exports", "commonair-backups", "commonair-evidence"]);
    expect([...g.state.buckets.get("commonair-media")!.grants]).toEqual([[KEY, full()]]);
  });

  test("refuses a key id that exists with a different secret", async () => {
    const g = fakeGarage({ keys: new Map([[KEY, "d4".repeat(32)]]) });
    await expect(bootstrapGarage(opts(g.fetch))).rejects.toThrow(/different secret/);
    expect(g.state.buckets.size).toBe(0);
  });

  test("waits for the admin API to come up", async () => {
    const g = fakeGarage({ up: false });
    let sleeps = 0;
    const r = await bootstrapGarage(
      opts(g.fetch, {
        sleep: async () => {
          if (++sleeps === 3) g.state.up = true;
        },
      }),
    );
    expect(sleeps).toBe(3);
    expect(r.layoutApplied).toBe(true);
  });

  test("gives up after the timeout when the API never answers", async () => {
    const g = fakeGarage({ up: false });
    let now = 0;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      await expect(
        bootstrapGarage(opts(g.fetch, { timeoutMs: 1000, sleep: async (ms) => void (now += ms) })),
      ).rejects.toThrow(/admin API: gave up/);
    } finally {
      Date.now = realNow;
    }
  });

  test("a wrong admin token fails immediately instead of retrying", async () => {
    const g = fakeGarage();
    let sleeps = 0;
    await expect(
      bootstrapGarage(opts(g.fetch, { adminToken: "wrong", sleep: async () => void sleeps++ })),
    ).rejects.toThrow(/AccessDenied/);
    expect(sleeps).toBe(0);
  });

  test("validates the key pair before calling Garage", async () => {
    const g = fakeGarage();
    await expect(bootstrapGarage(opts(g.fetch, { accessKeyId: "AKIAXXXX" }))).rejects.toThrow(/GK/);
    expect(g.state.calls).toEqual([]);
  });
});

describe("validation and env", () => {
  test("key formats", () => {
    expect(() => validateKeyPair(KEY, SECRET)).not.toThrow();
    expect(() => validateKeyPair(`GK${"A1".repeat(12)}`, SECRET)).toThrow(/S3_ACCESS_KEY_ID/);
    expect(() => validateKeyPair(`GK${"a1".repeat(11)}`, SECRET)).toThrow(/S3_ACCESS_KEY_ID/);
    expect(() => validateKeyPair(KEY, "b2".repeat(31))).toThrow(/S3_SECRET_ACCESS_KEY/);
    expect(() => validateKeyPair(KEY, `${"b2".repeat(31)}zz`)).toThrow(/S3_SECRET_ACCESS_KEY/);
  });

  test("bucket names", () => {
    for (const ok of ["commonair-media", "abc", "a.b-c"]) expect(() => validateBucketName(ok)).not.toThrow();
    for (const bad of ["", "ab", "-abc", "ABC", "a..b", "a_b", "x".repeat(64)])
      expect(() => validateBucketName(bad), bad).toThrow(/invalid bucket name/);
  });

  test("optionsFromEnv applies defaults and requires secrets", () => {
    const ev = { S3_EVIDENCE_ACCESS_KEY_ID: EKEY, S3_EVIDENCE_SECRET_ACCESS_KEY: ESECRET };
    const o = optionsFromEnv({ GARAGE_ADMIN_TOKEN: "t", S3_ACCESS_KEY_ID: KEY, S3_SECRET_ACCESS_KEY: SECRET, ...ev });
    expect(o.evidence).toEqual(EVIDENCE);
    expect(() =>
      optionsFromEnv({ GARAGE_ADMIN_TOKEN: "t", S3_ACCESS_KEY_ID: KEY, S3_SECRET_ACCESS_KEY: SECRET }),
    ).toThrow(/S3_EVIDENCE_ACCESS_KEY_ID/);
    expect(o.adminUrl).toBe("http://garage:3903");
    expect(o.buckets).toEqual(["commonair-media", "commonair-exports", "commonair-backups"]);
    expect(o.capacityBytes).toBe(100_000_000_000);
    expect(() => optionsFromEnv({ S3_ACCESS_KEY_ID: KEY, S3_SECRET_ACCESS_KEY: SECRET, ...ev })).toThrow(
      /GARAGE_ADMIN_TOKEN/,
    );
    expect(() =>
      optionsFromEnv({
        ...ev,
        GARAGE_ADMIN_TOKEN: "t",
        S3_ACCESS_KEY_ID: KEY,
        S3_SECRET_ACCESS_KEY: SECRET,
        GARAGE_CAPACITY_BYTES: "lots",
      }),
    ).toThrow(/GARAGE_CAPACITY_BYTES/);
  });
});
