// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `valkeyTls` and `VALKEY_CA_FILE` (S1-d, contract step §1.4); the live checks are in valkey-tls.int. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vite-plus/test";
import { valkeyCaFileFromEnv, valkeyTls } from "../src/valkey.ts";

const dir = mkdtempSync(join(tmpdir(), "commonair-valkeytls-"));
const CA = join(dir, "ca.crt");
writeFileSync(CA, "PEM");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("no CA: nothing added, whatever the scheme", () => {
  expect(valkeyTls("redis://localhost:6379", null)).toEqual({});
  expect(valkeyTls("rediss://:pw@cache.example.org:25061", null)).toEqual({});
});

test("a CA with rediss:// or valkeys://: verify against it", () => {
  for (const url of ["rediss://:pw@cache.example.org:25061", "valkeys://cache.example.org", "REDISS://x"]) {
    expect(valkeyTls(url, CA)).toEqual({ tls: { ca: "PEM", rejectUnauthorized: true } });
  }
});

test("a CA with a plaintext URL is refused, and the error hides the URL", () => {
  let message = "";
  try {
    valkeyTls("redis://:s3cret@cache.example.org:6379", CA);
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toMatch(/must use rediss:\/\//);
  expect(message).not.toContain("s3cret");
});

test("VALKEY_CA_FILE is read through the config schema; empty means unset", () => {
  expect(valkeyCaFileFromEnv({ VALKEY_CA_FILE: CA })).toBe(CA);
  expect(valkeyCaFileFromEnv({ VALKEY_CA_FILE: "" })).toBeUndefined();
  expect(valkeyCaFileFromEnv({})).toBeUndefined();
});
