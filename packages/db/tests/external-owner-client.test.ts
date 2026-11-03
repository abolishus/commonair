// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `postgresTls` and `DATABASE_CA_FILE` (S1-d, contract step §1.4); the live checks are in external-owner.int. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vite-plus/test";
import { createDb, databaseCaFileFromEnv, postgresTls } from "../src/client.ts";

const dir = mkdtempSync(join(tmpdir(), "commonair-pgtls-"));
const CA = join(dir, "ca.crt");
const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
writeFileSync(CA, PEM);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const BASE = "postgres://owner:s3cret@db.example.org:25060/commonair";

describe("postgresTls", () => {
  test("no CA and no sslrootcert: the URL is returned untouched, without an ssl option", () => {
    for (const url of [BASE, `${BASE}?sslmode=require`, `${BASE}?sslmode=disable`]) {
      expect(postgresTls(url)).toEqual({ url });
    }
  });

  test("a CA file with verify-full: verified TLS against that CA", () => {
    const tls = postgresTls(`${BASE}?sslmode=verify-full`, CA);
    expect(tls.ssl).toEqual({ ca: PEM, rejectUnauthorized: true });
    expect(new URL(tls.url).searchParams.get("sslmode")).toBe("verify-full");
  });

  test("a CA file with anything weaker than verify-full is refused, and the error hides the URL", () => {
    for (const q of [
      "",
      "?sslmode=disable",
      "?sslmode=allow",
      "?sslmode=prefer",
      "?sslmode=require",
      "?sslmode=verify-ca",
    ]) {
      let message = "";
      try {
        postgresTls(`${BASE}${q}`, CA);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, q).toMatch(/must say sslmode=verify-full/);
      expect(message).not.toContain("s3cret");
      expect(message).not.toContain("db.example.org");
    }
  });

  test("sslrootcert is never sent to the server: a path becomes the CA", () => {
    const tls = postgresTls(`${BASE}?sslmode=verify-full&sslrootcert=${encodeURIComponent(CA)}`);
    expect(tls.url).not.toContain("sslrootcert");
    expect(tls.ssl?.ca).toBe(PEM);
  });

  test("an explicit CA file wins over sslrootcert", () => {
    const other = join(dir, "other.crt");
    writeFileSync(other, "other");
    const tls = postgresTls(`${BASE}?sslmode=verify-full&sslrootcert=${encodeURIComponent(other)}`, CA);
    expect(tls.ssl?.ca).toBe(PEM);
  });

  test("sslrootcert=system: the system store, verify-full implied, nothing weaker accepted", () => {
    const tls = postgresTls(`${BASE}?sslrootcert=system`);
    expect(tls.ssl).toBeUndefined();
    expect(tls.url).not.toContain("sslrootcert");
    expect(new URL(tls.url).searchParams.get("sslmode")).toBe("verify-full");
    expect(() => postgresTls(`${BASE}?sslmode=require&sslrootcert=system`)).toThrow(/verify-full/);
  });

  test("a missing CA file fails loudly", () => {
    expect(() => postgresTls(`${BASE}?sslmode=verify-full`, join(dir, "absent.crt"))).toThrow(/ENOENT|no such file/);
  });
});

describe("DATABASE_CA_FILE", () => {
  test("is read through the config schema; empty means unset", () => {
    expect(databaseCaFileFromEnv({ DATABASE_CA_FILE: CA })).toBe(CA);
    expect(databaseCaFileFromEnv({ DATABASE_CA_FILE: "" })).toBeUndefined();
    expect(databaseCaFileFromEnv({})).toBeUndefined();
  });

  test("createDb refuses a weak URL when the CA is set, before connecting", () => {
    expect(() => createDb({ url: `${BASE}?sslmode=require`, caFile: CA })).toThrow(/verify-full/);
  });

  test("caFile null ignores the environment", async () => {
    const before = process.env.DATABASE_CA_FILE;
    process.env.DATABASE_CA_FILE = CA;
    try {
      expect(() => createDb({ url: `${BASE}?sslmode=require` })).toThrow(/verify-full/);
      const h = createDb({ url: `${BASE}?sslmode=require`, caFile: null });
      await h.close();
    } finally {
      if (before === undefined) delete process.env.DATABASE_CA_FILE;
      else process.env.DATABASE_CA_FILE = before;
    }
  });
});
