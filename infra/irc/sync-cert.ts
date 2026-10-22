// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Copies Caddy's certificate for IRC_PUBLIC_HOST to the directory the IRC unit mounts, and
 * restarts IRC when it changed. IRC reads its certificate once at start, and Caddy renews
 * every ~60 days, so commonair-irc-cert.timer runs this daily (infra/systemd).
 *
 *   IRC_PUBLIC_HOST=stream.example.org bun infra/irc/sync-cert.ts [--caddy-data <dir>] [--out <dir>]
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CertPaths {
  cert: string;
  key: string;
}

// A hostname only: it becomes a path segment, so nothing that could leave the directory.
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

/**
 * Caddy stores certificates under caddy/certificates/<issuer>/<host>/<host>.{crt,key}. The
 * issuer directory depends on which ACME CA issued it, so look in all of them and take the
 * newest certificate.
 */
export function findCaddyCert(dataDir: string, host: string): CertPaths | null {
  if (!HOST.test(host)) throw new Error(`not a hostname: ${host}`);
  const root = join(dataDir, "caddy", "certificates");
  if (!existsSync(root)) return null;
  let best: (CertPaths & { mtime: number }) | null = null;
  for (const issuer of readdirSync(root)) {
    const cert = join(root, issuer, host, `${host}.crt`);
    const key = join(root, issuer, host, `${host}.key`);
    if (!existsSync(cert) || !existsSync(key)) continue;
    const mtime = statSync(cert).mtimeMs;
    if (!best || mtime > best.mtime) best = { cert, key, mtime };
  }
  return best && { cert: best.cert, key: best.key };
}

/** Writes via a temporary file and rename, so IRC never reads a half-written file. */
function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, { mode: 0o644 });
  chmodSync(tmp, 0o644);
  renameSync(tmp, path);
}

/** Returns whether the copy in `outDir` changed. */
export function syncCert(opts: { dataDir: string; host: string; outDir: string }): { changed: boolean } {
  const src = findCaddyCert(opts.dataDir, opts.host);
  if (!src)
    throw new Error(`Caddy has no certificate for ${opts.host} yet (it must be PUBLIC_HOSTNAME or another Caddy site)`);
  const cert = readFileSync(src.cert, "utf8");
  const key = readFileSync(src.key, "utf8");
  const outCert = join(opts.outDir, "tls.crt");
  const outKey = join(opts.outDir, "tls.key");
  const same = (p: string, v: string) => existsSync(p) && readFileSync(p, "utf8") === v;
  if (same(outCert, cert) && same(outKey, key)) return { changed: false };

  // The IRC container runs as a user that maps to none of the host's, so it reads the files
  // through their "other" permission bits. The parent directory (0700) keeps other host users out.
  mkdirSync(opts.outDir, { recursive: true });
  chmodSync(dirname(opts.outDir), 0o700);
  chmodSync(opts.outDir, 0o755);
  writeAtomic(outKey, key);
  writeAtomic(outCert, cert);
  return { changed: true };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

if (import.meta.main) {
  const host = process.env.IRC_PUBLIC_HOST;
  if (!host) {
    console.error("IRC_PUBLIC_HOST is required");
    process.exit(1);
  }
  try {
    const dataDir =
      arg("--caddy-data") ??
      Bun.spawnSync(["podman", "volume", "inspect", "commonair-caddy-data", "--format", "{{.Mountpoint}}"], {
        stderr: "inherit",
      })
        .stdout.toString()
        .trim();
    if (!dataDir) throw new Error("could not find the commonair-caddy-data volume");
    const outDir = arg("--out") ?? join(homedir(), ".config", "commonair", "irc-tls");
    const { changed } = syncCert({ dataDir, host, outDir });
    if (changed) {
      const restart = Bun.spawnSync(["systemctl", "--user", "restart", "commonair-irc.service"], { stderr: "inherit" });
      if (restart.exitCode !== 0) throw new Error("restarting commonair-irc.service failed");
    }
    console.warn(changed ? "irc certificate updated; irc restarted" : "irc certificate unchanged");
  } catch (e) {
    console.error(`irc cert: ${(e as Error).message}`);
    process.exit(1);
  }
}
