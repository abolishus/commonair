// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { findCaddyCert, syncCert } from "../irc/sync-cert.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "irc-cert-"));
  dirs.push(d);
  return d;
}

/** Lays out a certificate the way Caddy stores it. */
function caddyCert(dataDir: string, issuer: string, host: string, body: string, mtime?: Date): void {
  const dir = join(dataDir, "caddy", "certificates", issuer, host);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${host}.crt`), `CERT ${body}`);
  writeFileSync(join(dir, `${host}.key`), `KEY ${body}`, { mode: 0o600 });
  if (mtime) utimesSync(join(dir, `${host}.crt`), mtime, mtime);
}

const LE = "acme-v02.api.letsencrypt.org-directory";
const ZEROSSL = "acme.zerossl.com-v2-dv90";

describe("findCaddyCert", () => {
  test("finds the host's certificate under any issuer", () => {
    const data = tmp();
    caddyCert(data, ZEROSSL, "irc.example.org", "z");
    expect(findCaddyCert(data, "irc.example.org")?.cert).toBe(
      join(data, "caddy/certificates", ZEROSSL, "irc.example.org", "irc.example.org.crt"),
    );
  });

  test("takes the newest when several issuers hold one", () => {
    const data = tmp();
    caddyCert(data, LE, "irc.example.org", "old", new Date("2026-01-01T00:00:00Z"));
    caddyCert(data, ZEROSSL, "irc.example.org", "new", new Date("2026-06-01T00:00:00Z"));
    expect(findCaddyCert(data, "irc.example.org")?.key).toContain(ZEROSSL);
  });

  test("null before Caddy has any certificate, or none for this host", () => {
    const data = tmp();
    expect(findCaddyCert(data, "irc.example.org")).toBeNull();
    caddyCert(data, LE, "other.example.org", "x");
    expect(findCaddyCert(data, "irc.example.org")).toBeNull();
  });

  test("ignores a certificate without its key", () => {
    const data = tmp();
    caddyCert(data, LE, "irc.example.org", "x");
    rmSync(join(data, "caddy/certificates", LE, "irc.example.org", "irc.example.org.key"));
    expect(findCaddyCert(data, "irc.example.org")).toBeNull();
  });

  test("refuses anything that is not a hostname", () => {
    for (const host of ["../etc", "a/b", "", "-a.example", "a..b", "irc.example.org/"])
      expect(() => findCaddyCert(tmp(), host), host).toThrow("not a hostname");
  });
});

describe("syncCert", () => {
  test("copies once, then reports unchanged until Caddy renews", () => {
    const data = tmp();
    const out = join(tmp(), "commonair", "irc-tls");
    caddyCert(data, LE, "irc.example.org", "v1");
    expect(syncCert({ dataDir: data, host: "irc.example.org", outDir: out })).toEqual({ changed: true });
    expect(readFileSync(join(out, "tls.crt"), "utf8")).toBe("CERT v1");
    expect(readFileSync(join(out, "tls.key"), "utf8")).toBe("KEY v1");
    expect(syncCert({ dataDir: data, host: "irc.example.org", outDir: out })).toEqual({ changed: false });

    caddyCert(data, LE, "irc.example.org", "v2");
    expect(syncCert({ dataDir: data, host: "irc.example.org", outDir: out })).toEqual({ changed: true });
    expect(readFileSync(join(out, "tls.crt"), "utf8")).toBe("CERT v2");
  });

  test("files are readable inside the container; the parent keeps other host users out", () => {
    const data = tmp();
    const out = join(tmp(), "commonair", "irc-tls");
    caddyCert(data, LE, "irc.example.org", "v1");
    syncCert({ dataDir: data, host: "irc.example.org", outDir: out });
    const mode = (p: string) => statSync(p).mode & 0o777;
    expect(mode(join(out, "tls.key"))).toBe(0o644);
    expect(mode(join(out, "tls.crt"))).toBe(0o644);
    expect(mode(out)).toBe(0o755);
    expect(mode(join(out, ".."))).toBe(0o700);
  });

  test("fails clearly when Caddy has no certificate for the host", () => {
    expect(() => syncCert({ dataDir: tmp(), host: "irc.example.org", outDir: join(tmp(), "x", "y") })).toThrow(
      "Caddy has no certificate for irc.example.org",
    );
  });
});
