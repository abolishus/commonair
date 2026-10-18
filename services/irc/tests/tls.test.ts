// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { X509Certificate, createPrivateKey } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { generateSelfSignedCert, loadTls } from "../src/tls.ts";

describe("ephemeral self-signed certificate", () => {
  test("is a valid self-signed X.509 cert for localhost that matches its key", () => {
    const now = new Date("2026-10-18T12:00:00Z");
    const m = generateSelfSignedCert("localhost", 30, now);
    const x = new X509Certificate(m.cert);
    expect(x.subject).toBe("CN=localhost");
    expect(x.issuer).toBe("CN=localhost");
    expect(x.subjectAltName).toContain("DNS:localhost");
    expect(x.subjectAltName).toContain("IP Address:127.0.0.1");
    expect(x.ca).toBe(false);
    expect(x.verify(x.publicKey)).toBe(true);
    expect(x.checkPrivateKey(createPrivateKey(m.key))).toBe(true);
    expect(Date.parse(x.validTo) - now.getTime()).toBeGreaterThan(29 * 86_400_000);
    expect(Date.parse(x.validFrom)).toBeLessThanOrEqual(now.getTime());
    expect(m.ephemeral).toBe(true);
  });

  test("uses GeneralizedTime for dates from 2050", () => {
    const x = new X509Certificate(generateSelfSignedCert("localhost", 1, new Date("2051-01-01T00:00:00Z")).cert);
    expect(x.validTo).toContain("2051");
  });

  test("serials differ between certificates", () => {
    const a = new X509Certificate(generateSelfSignedCert().cert);
    const b = new X509Certificate(generateSelfSignedCert().cert);
    expect(a.serialNumber).not.toBe(b.serialNumber);
  });
});

describe("loadTls", () => {
  test("reads configured files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "irc-tls-"));
    try {
      const m = generateSelfSignedCert();
      await writeFile(join(dir, "c.pem"), m.cert);
      await writeFile(join(dir, "k.pem"), m.key);
      const loaded = await loadTls({ certFile: join(dir, "c.pem"), keyFile: join(dir, "k.pem"), production: true });
      expect(loaded).toEqual({ cert: m.cert, key: m.key, ephemeral: false });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("generates an ephemeral cert outside production, refuses in production or with half a config", async () => {
    expect((await loadTls({ production: false })).ephemeral).toBe(true);
    await expect(loadTls({ production: true })).rejects.toThrow(/required in production/);
    await expect(loadTls({ certFile: "/x", production: false })).rejects.toThrow(/set together/);
  });
});
