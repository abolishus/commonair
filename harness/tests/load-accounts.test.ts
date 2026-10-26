// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vite-plus/test";
import {
  AUTH_PACE_WINDOW_MS,
  AccountStore,
  AuthPacer,
  pacedAuth,
  paceDelayMs,
  parseAccountsFile,
  retryAfterSeconds,
  withAccount,
  withoutAccount,
} from "../src/load/accounts.ts";
import { AuthError, type UserCredentials } from "../src/users.ts";

const creds = (username: string): UserCredentials => ({
  username,
  displayName: username,
  email: `${username}@harness.test`,
  password: "Hx9!secret",
  birthDate: "1990-06-15",
});

describe("pacing auth writes", () => {
  const rule = { max: 3, windowMs: 60_000 };

  test("free while under the limit", () => {
    expect(paceDelayMs([], rule, 0)).toBe(0);
    expect(paceDelayMs([1_000, 2_000], rule, 3_000)).toBe(0);
  });

  test("at the limit: wait until the oldest hit leaves the window", () => {
    expect(paceDelayMs([1_000, 2_000, 3_000], rule, 4_000)).toBe(57_000);
    // Hits older than the window do not count.
    expect(paceDelayMs([0, 50_000, 55_000, 59_000], rule, 61_000)).toBe(49_000);
    expect(paceDelayMs([1_000, 2_000, 3_000], rule, 61_000)).toBe(0);
  });

  test("the instance's auth bucket is 10 a minute; the pacer keeps a second of margin", () => {
    expect(AUTH_PACE_WINDOW_MS).toBe(61_000);
    expect(AuthPacer.perMinute(10).rule).toEqual({ max: 10, windowMs: 61_000 });
    expect(AuthPacer.perMinute(0.5).rule.max).toBe(1);
  });

  test("the pacer serves callers in order and never exceeds the rule", async () => {
    let now = 0;
    const slept: number[] = [];
    const pacer = new AuthPacer(
      rule,
      () => now,
      async (ms) => {
        slept.push(ms);
        now += ms;
      },
    );
    const at: number[] = [];
    await Promise.all(Array.from({ length: 7 }, () => pacer.take().then(() => at.push(now))));
    expect(at).toEqual([0, 0, 0, 60_000, 60_000, 60_000, 120_000]);
    expect(slept).toEqual([60_000, 60_000]);
  });
});

describe("429 handling", () => {
  test("retry-after from the auth route's body, 60 s when absent; other errors are not retried", () => {
    const body = JSON.stringify({ code: "RATE_LIMITED", data: { retryAfterSeconds: 17 } });
    expect(retryAfterSeconds(new AuthError("sign-up", 429, body))).toBe(17);
    expect(retryAfterSeconds(new AuthError("sign-up", 429, ""))).toBe(60);
    expect(retryAfterSeconds(new AuthError("sign-up", 400, body))).toBeNull();
    expect(retryAfterSeconds(new Error("boom"))).toBeNull();
  });

  test("pacedAuth waits as told and tries again, up to the attempt limit", async () => {
    const slept: number[] = [];
    let calls = 0;
    const result = await pacedAuth(
      null,
      async () => {
        calls++;
        if (calls < 3) throw new AuthError("sign-in", 429, '{"data":{"retryAfterSeconds":2}}');
        return "ok";
      },
      { sleep: async (ms) => void slept.push(ms) },
    );
    expect(result).toBe("ok");
    expect(slept).toEqual([2_500, 2_500]);

    const always429 = () => Promise.reject(new AuthError("sign-up", 429, ""));
    await expect(pacedAuth(null, always429, { attempts: 2, sleep: async () => undefined })).rejects.toThrow(/HTTP 429/);
    await expect(pacedAuth(null, () => Promise.reject(new AuthError("sign-up", 400, "")))).rejects.toThrow(/HTTP 400/);
  });
});

describe("the accounts file", () => {
  test("unreadable or foreign content is an empty file", () => {
    const empty = { version: 1, instances: {} };
    expect(parseAccountsFile(null)).toEqual(empty);
    expect(parseAccountsFile("{nope")).toEqual(empty);
    expect(parseAccountsFile('{"version":2,"instances":{}}')).toEqual(empty);
  });

  test("malformed entries are dropped, good ones kept per instance", () => {
    const f = parseAccountsFile(
      JSON.stringify({ version: 1, instances: { "https://a": [creds("x"), { username: "half" }], "https://b": "no" } }),
    );
    expect(f.instances).toEqual({ "https://a": [creds("x")] });
  });

  test("add replaces by username; remove forgets one; other instances untouched", () => {
    let f = withAccount(parseAccountsFile(null), "https://a", creds("x"));
    f = withAccount(f, "https://a", { ...creds("x"), password: "new" });
    f = withAccount(f, "https://b", creds("y"));
    expect(f.instances["https://a"]).toEqual([{ ...creds("x"), password: "new" }]);
    f = withoutAccount(f, "https://a", "x");
    expect(f.instances).toEqual({ "https://a": [], "https://b": [creds("y")] });
  });

  const dir = mkdtempSync(join(tmpdir(), "load-accounts-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("the store writes mode 0600 and reads back per instance", async () => {
    const path = join(dir, "accounts.json");
    const a = new AccountStore(path, "https://a");
    expect(await a.load()).toEqual([]);
    await Promise.all([a.add(creds("one")), a.add(creds("two"))]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await new AccountStore(path, "https://a").load()).toEqual([creds("one"), creds("two")]);
    expect(await new AccountStore(path, "https://b").load()).toEqual([]);
    await a.remove("one");
    expect(JSON.parse(readFileSync(path, "utf8")).instances["https://a"]).toEqual([creds("two")]);
  });
});
