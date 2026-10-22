// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Podman plumbing for the restore drill: find the stack's Postgres (image, network, volumes,
 * WAL-G prefix) without touching it, name the drill's own container and volume, refuse any
 * collision, and build the `podman run` arguments. Secrets never appear in arguments: they are
 * passed as bare `-e NAME` and inherited from the podman process's environment.
 */

export const COMPOSE_PROJECT = "commonair";
export const PGDATA = "/var/lib/postgresql/data";
export const DRILL_DB = "commonair";
export const DRILL_OWNER = "commonair";
export const APP_ROLE = "commonair_app";
/** Garage inside the compose network (the stack's WAL-G endpoint). */
export const GARAGE_IN_NETWORK = "http://garage:3900";
export const FALLBACK_IMAGE = "localhost/commonair/postgres:dev";

export interface DrillNames {
  container: string;
  volume: string;
}

export function drillNames(runId: string): DrillNames {
  if (!/^[a-z0-9]{4,40}$/.test(runId)) throw new RangeError(`run id ${runId} is not a safe container name part`);
  return { container: `commonair-drill-${runId}`, volume: `commonair-drill-${runId}-pgdata` };
}

/** `s3://<bucket>/drill/<runId>`: the drill's own WAL-G prefix in the backups bucket. */
export function drillPrefix(bucket: string, runId: string): { url: string; key: string } {
  const key = `drill/${runId}/`;
  return { url: `s3://${bucket}/drill/${runId}`, key };
}

export interface StackPostgres {
  id: string;
  name: string;
  image: string;
  networks: string[];
  volumes: string[];
  walgPrefix: string | null;
}

/** Parse `podman inspect <container>` output (an array with one object). Pure. */
export function parseInspect(json: string): StackPostgres {
  const data = JSON.parse(json) as unknown;
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  if (!row || typeof row !== "object") throw new Error("podman inspect returned nothing");
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const config = (row.Config ?? {}) as { Image?: unknown; Env?: unknown };
  const settings = (row.NetworkSettings ?? {}) as { Networks?: Record<string, unknown> };
  const mounts = Array.isArray(row.Mounts) ? (row.Mounts as Record<string, unknown>[]) : [];
  const env = Array.isArray(config.Env) ? (config.Env as unknown[]).map(str) : [];
  const prefix = env.find((e) => e.startsWith("WALG_S3_PREFIX="));
  return {
    id: str(row.Id),
    name: str(row.Name).replace(/^\//, ""),
    image: str(row.ImageName) || str(config.Image),
    networks: Object.keys(settings.Networks ?? {}),
    volumes: mounts.filter((m) => m.Type === "volume").map((m) => str(m.Name)),
    walgPrefix: prefix ? prefix.slice("WALG_S3_PREFIX=".length) : null,
  };
}

/**
 * Why the drill must not run with these names (empty = safe). Pure. The drill only ever removes
 * what it created, so a name that already exists, or anything the stack's Postgres uses, is
 * refused before a single container starts.
 */
export function collisionProblems(
  names: DrillNames,
  prefixUrl: string,
  stack: StackPostgres,
  existing: { container: boolean; volume: boolean },
): string[] {
  const problems: string[] = [];
  if (names.container === stack.name || names.container === stack.id) {
    problems.push(`drill container ${names.container} is the stack's Postgres container`);
  }
  if (stack.volumes.includes(names.volume)) problems.push(`drill volume ${names.volume} is mounted by the stack`);
  if (existing.container) problems.push(`container ${names.container} already exists`);
  if (existing.volume) problems.push(`volume ${names.volume} already exists`);
  const norm = (u: string) => u.replace(/\/+$/, "");
  if (stack.walgPrefix !== null && norm(stack.walgPrefix) === norm(prefixUrl)) {
    problems.push(`drill WAL-G prefix ${prefixUrl} is the stack's`);
  }
  if (!prefixUrl.includes("/drill/")) problems.push(`drill WAL-G prefix ${prefixUrl} is not under drill/`);
  return problems;
}

/** Secret env vars the drill container inherits by name (`-e NAME`). */
export const SECRET_ENV = ["POSTGRES_PASSWORD", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;

/** Arguments after `podman run` for the drill's Postgres (or a one-shot command in it). Pure. */
export function runArgs(opts: {
  names: DrillNames;
  network: string;
  image: string;
  prefixUrl: string;
  runId: string;
  /** Long-running server: detached, named, a random loopback port. Else a one-shot `--rm`. */
  server: boolean;
  command?: string[];
}): string[] {
  const env: [string, string][] = [
    ["POSTGRES_USER", DRILL_OWNER],
    ["POSTGRES_DB", DRILL_DB],
    ["WALG_S3_PREFIX", opts.prefixUrl],
    ["WALG_S3_ENDPOINT", GARAGE_IN_NETWORK],
    ["S3_REGION", "garage"],
  ];
  return [
    ...(opts.server ? ["-d", "--name", opts.names.container, "-p", "127.0.0.1::5432"] : ["--rm"]),
    "--label",
    `commonair.drill=${opts.runId}`,
    "--network",
    opts.network,
    "-v",
    `${opts.names.volume}:${PGDATA}`,
    ...env.flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    ...SECRET_ENV.flatMap((k) => ["-e", k]),
    opts.image,
    ...(opts.command ?? []),
  ];
}

/** The host port from `podman port <c> 5432/tcp` output. Pure. */
export function parsePort(output: string): number {
  for (const line of output.split("\n")) {
    const m = /:(\d+)\s*$/.exec(line.trim());
    if (m?.[1]) return Number(m[1]);
  }
  throw new Error(`no published port in ${JSON.stringify(output.trim())}`);
}

/** Distinct WAL segments Postgres restored from the archive during recovery (its log lines). Pure. */
export function countReplayedSegments(logs: string): number {
  const seen = new Set<string>();
  for (const m of logs.matchAll(/restored log file "([0-9A-F]{24})" from archive/g)) if (m[1]) seen.add(m[1]);
  return seen.size;
}

/** Bytes of the base backup(s) and the number of WAL objects under the drill prefix. Pure. */
export function prefixStats(objects: readonly { key: string; size: number }[], prefixKey: string) {
  let backupBytes = 0;
  let walObjects = 0;
  for (const o of objects) {
    if (!o.key.startsWith(prefixKey)) continue;
    const rest = o.key.slice(prefixKey.length);
    if (rest.startsWith("basebackups_")) backupBytes += o.size;
    else if (rest.startsWith("wal_")) walObjects++;
  }
  return { backupBytes, walObjects };
}

export interface PodmanResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface PodmanOptions {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Kills the podman child when aborted (the drill's scenario signal). */
  signal?: AbortSignal;
}

/** Run podman; `env` adds to the inherited environment (where the secrets live). */
export async function podman(args: readonly string[], opts: PodmanOptions = {}): Promise<PodmanResult> {
  const proc = Bun.spawn(["podman", ...args], {
    env: { ...process.env, ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
    timeout: opts.timeoutMs ?? 120_000,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** Run podman and return stdout; throws with the subcommand and stderr tail on failure. */
export async function podmanOk(args: readonly string[], opts: PodmanOptions = {}): Promise<string> {
  const r = await podman(args, opts);
  if (r.code !== 0) {
    const tail = r.stderr.trim().split("\n").slice(-4).join(" | ");
    throw new Error(`podman ${args[0] ?? ""} failed (${r.code}): ${tail}`);
  }
  return r.stdout;
}

/** The stack's Postgres container, found by its compose labels. */
export async function findStackPostgres(): Promise<StackPostgres> {
  const ids = (
    await podmanOk([
      "ps",
      "-a",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${COMPOSE_PROJECT}`,
      "--filter",
      "label=com.docker.compose.service=postgres",
    ])
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  if (ids.length === 0)
    throw new Error("the stack's Postgres container was not found (bun scripts/infra.ts stack --harness)");
  return parseInspect(await podmanOk(["inspect", ids[0] as string]));
}

export async function exists(kind: "container" | "volume", name: string): Promise<boolean> {
  return (await podman([kind, "exists", name])).code === 0;
}
