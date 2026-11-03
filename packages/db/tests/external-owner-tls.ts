// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Fixtures for the external-service integration tests (S1-d): podman, the images the stack pins,
 * and a throwaway CA with a server certificate for `localhost` and 127.0.0.1. The certificates are
 * made by the pinned Postgres image's own openssl, so the tests need no host tool but podman.
 * Also used by packages/service/tests/valkey-tls.int.test.ts.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testOwnerArgs } from "../../../scripts/test-owner.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;

/** The upstream Postgres image the stack's own image builds on (infra/postgres/Containerfile). */
export const POSTGRES_IMAGE = /^ARG POSTGRES_IMAGE=(\S+)$/m.exec(
  readFileSync(join(ROOT, "infra/postgres/Containerfile"), "utf8"),
)?.[1] as string;
/** The Valkey image compose.yaml pins. */
export const VALKEY_IMAGE = /^\s+image: (ghcr\.io\/valkey-io\/valkey:\S+)$/m.exec(
  readFileSync(join(ROOT, "compose.yaml"), "utf8"),
)?.[1] as string;

export interface Run {
  code: number;
  out: string;
}

/** `podman <args>`; spawnSync blocks the event loop, so every call carries its own timeout. */
export function podman(args: string[], opts: { timeoutMs?: number; stdin?: Uint8Array } = {}): Run {
  const p = Bun.spawnSync(["podman", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: opts.stdin ?? "ignore",
    timeout: opts.timeoutMs ?? 120_000,
  });
  return { code: p.exitCode ?? -1, out: `${p.stdout.toString()}${p.stderr.toString()}` };
}

export function podmanOk(args: string[], opts?: { timeoutMs?: number; stdin?: Uint8Array }): string {
  const r = podman(args, opts);
  if (r.code !== 0) throw new Error(`podman ${args.slice(0, 3).join(" ")} … failed (${r.code}):\n${r.out}`);
  return r.out;
}

/** True when podman can run containers here (CI's integration job and a developer's machine). */
export function podmanAvailable(): boolean {
  try {
    return podman(["info", "--format", "{{.Host.Arch}}"], { timeoutMs: 30_000 }).code === 0;
  } catch {
    return false;
  }
}

/** Host port podman published for a container port. */
export function hostPort(container: string, port: number): number {
  const out = podmanOk(["port", container, `${port}/tcp`]);
  const m = /:(\d+)\s*$/m.exec(out.trim());
  if (!m?.[1]) throw new Error(`no host port for ${container}:${port}: ${out}`);
  return Number(m[1]);
}

export interface TestCerts {
  /** Directory holding every file below (removed by `cleanup`). */
  dir: string;
  /** The CA that signed `cert`. */
  ca: string;
  /** Server certificate and key for DNS:localhost and IP:127.0.0.1. */
  cert: string;
  key: string;
  /** A second, unrelated CA: verifying against it must fail. */
  otherCa: string;
  cleanup(): void;
}

const MAKE_CERTS = [
  "set -eu",
  "cd /out",
  "ca() { openssl req -x509 -new -nodes -newkey ec -pkeyopt ec_paramgen_curve:P-256 -days 2" +
    ' -keyout "$1.key" -out "$1.crt" -subj "/CN=$1"' +
    " -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign; }",
  "ca commonair-test-ca",
  "ca commonair-other-ca",
  "openssl req -new -nodes -newkey ec -pkeyopt ec_paramgen_curve:P-256 -keyout server.key -out server.csr -subj /CN=localhost",
  "printf '%s\\n' 'subjectAltName=DNS:localhost,IP:127.0.0.1' 'basicConstraints=critical,CA:FALSE'" +
    " 'keyUsage=critical,digitalSignature' 'extendedKeyUsage=serverAuth' > server.ext",
  "openssl x509 -req -in server.csr -CA commonair-test-ca.crt -CAkey commonair-test-ca.key -CAcreateserial" +
    " -days 2 -extfile server.ext -out server.crt",
  // Only this throwaway directory: the containers copy the key and tighten it themselves.
  "chmod 0644 ./*",
].join("\n");

/** A fresh CA and server certificate, made inside the pinned Postgres image. */
export function makeTestCerts(): TestCerts {
  // Under podman machine (macOS) only $HOME, /private and /var/folders are shared with the VM;
  // tmpdir() is under one of them.
  const dir = mkdtempSync(join(tmpdir(), "commonair-tls-"));
  chmodSync(dir, 0o755);
  podmanOk(
    [
      "run",
      "--rm",
      ...testOwnerArgs(),
      "--network",
      "none",
      "-v",
      `${dir}:/out:Z`,
      "--entrypoint",
      "sh",
      POSTGRES_IMAGE,
      "-c",
      MAKE_CERTS,
    ],
    { timeoutMs: 300_000 },
  );
  return {
    dir,
    ca: join(dir, "commonair-test-ca.crt"),
    cert: join(dir, "server.crt"),
    key: join(dir, "server.key"),
    otherCa: join(dir, "commonair-other-ca.crt"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
