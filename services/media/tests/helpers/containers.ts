// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Throwaway containers for integration tests: MediaMTX with the repository's config, a mock
 * RTMP simulcast target, and a single-node Garage. Every container gets a unique name and
 * random host ports on 127.0.0.1, and is removed in `stop()`.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MEDIAMTX_IMAGE = "docker.io/bluenviron/mediamtx:1.21.2-ffmpeg";
export const GARAGE_IMAGE = "docker.io/dxflrs/garage:v2.4.1";
const REPO_ROOT = new URL("../../../../", import.meta.url).pathname;
export const MEDIAMTX_CONFIG = join(REPO_ROOT, "infra/mediamtx/mediamtx.yml");
export const MOCK_TARGET_CONFIG = join(REPO_ROOT, "infra/mediamtx/mock-rtmp-target.yml");

function podman(args: string[]): string {
  const p = Bun.spawnSync(["podman", ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`podman ${args[0]} failed: ${p.stderr.toString().trim()}`);
  return p.stdout.toString().trim();
}

export function podmanAvailable(): boolean {
  try {
    podman(["info", "--format", "{{.Host.Arch}}"]);
    return true;
  } catch {
    return false;
  }
}

export interface Container {
  name: string;
  port(containerPort: string): number;
  logs(): string;
  stop(): void;
}

function run(name: string, args: string[]): Container {
  podman(["run", "-d", "--rm", "--name", name, ...args]);
  const ports = new Map<string, number>();
  return {
    name,
    port(cp) {
      const cached = ports.get(cp);
      if (cached) return cached;
      const out = podman(["port", name, cp]).split("\n")[0] ?? "";
      const n = Number(out.slice(out.lastIndexOf(":") + 1));
      if (!Number.isInteger(n) || n <= 0) throw new Error(`no host port for ${name} ${cp}: ${out}`);
      ports.set(cp, n);
      return n;
    },
    logs() {
      const p = Bun.spawnSync(["podman", "logs", name], { stdout: "pipe", stderr: "pipe" });
      return p.stdout.toString() + p.stderr.toString();
    },
    stop() {
      Bun.spawnSync(["podman", "rm", "-f", "-t", "1", name], { stdout: "ignore", stderr: "ignore" });
    },
  };
}

const unique = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
const scratchRoot = join(REPO_ROOT, ".cache");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, "media-int-"));

/**
 * MediaMTX with infra/mediamtx/mediamtx.yml, pointed at `apiBase` (a fake API on the test host):
 * the auth hook address is literal in the file, the online/offline hooks read API_INTERNAL_URL.
 */
export function startMediaMtx(opts: { apiBase: string; internalSecret: string }): Container {
  const config = readFileSync(MEDIAMTX_CONFIG, "utf8").replaceAll("http://api:3001", opts.apiBase);
  const file = join(scratch, `${unique("mediamtx")}.yml`);
  writeFileSync(file, config);
  return run(unique("media-int-mtx"), [
    "-p",
    "127.0.0.1::1935",
    "-p",
    "127.0.0.1::8554",
    "-p",
    "127.0.0.1::9997",
    "-e",
    `INTERNAL_API_SECRET=${opts.internalSecret}`,
    "-e",
    `API_INTERNAL_URL=${opts.apiBase}`,
    "-v",
    `${file}:/mediamtx.yml:ro`,
    MEDIAMTX_IMAGE,
  ]);
}

export function startMockTarget(): Container {
  return run(unique("media-int-target"), [
    "-p",
    "127.0.0.1::1936",
    "-p",
    "127.0.0.1::9997",
    "-v",
    `${MOCK_TARGET_CONFIG}:/mediamtx.yml:ro`,
    MEDIAMTX_IMAGE,
  ]);
}

export interface Garage extends Container {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Single-node Garage, bootstrapped through the v2 admin API (layout, key, bucket). */
export async function startGarage(bucket: string): Promise<Garage> {
  const adminToken = crypto.randomUUID();
  const rpcSecret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  const file = join(scratch, `${unique("garage")}.toml`);
  writeFileSync(
    file,
    [
      'metadata_dir = "/tmp/meta"',
      'data_dir = "/tmp/data"',
      'db_engine = "sqlite"',
      "replication_factor = 1",
      'rpc_bind_addr = "[::]:3901"',
      'rpc_public_addr = "127.0.0.1:3901"',
      `rpc_secret = "${rpcSecret}"`,
      "[s3_api]",
      's3_region = "garage"',
      'api_bind_addr = "[::]:3900"',
      'root_domain = ".s3.garage.localhost"',
      "[admin]",
      'api_bind_addr = "[::]:3903"',
      `admin_token = "${adminToken}"`,
      "",
    ].join("\n"),
  );
  const c = run(unique("media-int-garage"), [
    "-p",
    "127.0.0.1::3900",
    "-p",
    "127.0.0.1::3903",
    "-v",
    `${file}:/etc/garage.toml:ro`,
    GARAGE_IMAGE,
  ]);
  const admin = `http://127.0.0.1:${c.port("3903/tcp")}`;
  const call = async (path: string, body?: unknown) => {
    const res = await fetch(`${admin}/v2/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`garage ${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as Record<string, unknown>;
  };
  let status: Record<string, unknown> | null = null;
  for (let i = 0; i < 100 && !status; i++) {
    status = await call("GetClusterStatus").catch(async () => {
      await Bun.sleep(200);
      return null;
    });
  }
  if (!status) throw new Error(`garage did not start:\n${c.logs()}`);
  const node = (status.nodes as { id: string }[])[0];
  if (!node) throw new Error("garage reports no node");
  await call("UpdateClusterLayout", { roles: [{ id: node.id, zone: "dc1", capacity: 1_000_000_000, tags: [] }] });
  await call("ApplyClusterLayout", { version: 1 });
  const key = (await call("CreateKey", { name: "media-int" })) as { accessKeyId: string; secretAccessKey: string };
  const b = (await call("CreateBucket", { globalAlias: bucket })) as { id: string };
  await call("AllowBucketKey", {
    bucketId: b.id,
    accessKeyId: key.accessKeyId,
    permissions: { read: true, write: true, owner: true },
  });
  return {
    ...c,
    endpoint: `http://127.0.0.1:${c.port("3900/tcp")}`,
    accessKeyId: key.accessKeyId,
    secretAccessKey: key.secretAccessKey,
  };
}

export interface Publisher {
  stop(): Promise<void>;
  exited: Promise<number>;
}

/**
 * A 720p30 test pattern with a 440 Hz tone, 2 s GOP (what OBS sends with recommended settings).
 * `image`: loop a still image instead (the synthetic moderation fixtures; never anything else).
 */
export function publishTestPattern(url: string, opts: { image?: string } = {}): Publisher {
  const video = opts.image
    ? ["-loop", "1", "-framerate", "30", "-i", opts.image]
    : ["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30"];
  const scale = opts.image ? ["-vf", "scale=1280:720,format=yuv420p"] : [];
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-re",
      ...video,
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      ...scale,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-tune",
      "zerolatency",
      "-g",
      "60",
      "-keyint_min",
      "60",
      "-sc_threshold",
      "0",
      "-b:v",
      "2500k",
      "-maxrate",
      "2500k",
      "-bufsize",
      "5000k",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-t",
      "900",
      "-f",
      "flv",
      url,
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  return {
    exited: proc.exited,
    async stop() {
      proc.kill("SIGINT");
      const t = setTimeout(() => proc.kill("SIGKILL"), 3000);
      await proc.exited;
      clearTimeout(t);
    },
  };
}
