// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Work-dir hygiene after a crash, and periodically.
 *
 * Startup (`recoverWorkDir`, before any session or job runs): every `broadcasts/<id>/` left by
 * a crashed process is either finished or discarded. If the broadcast's VOD is still
 * `recording`/`processing`, segments ffmpeg completed (listed in a run playlist) but the dead
 * process never uploaded are uploaded and appended to the published VOD playlist, so the VOD
 * keeps everything up to the crash. Partial segments (ffmpeg's `.tmp` files) are discarded.
 * The directory is then removed; a resumed session records into a fresh one.
 *
 * Periodic (`sweepWorkDir`): broadcast directories no session owns are recovered the same way
 * and deleted only once their segments are safe; clip/VOD scratch directories no running job
 * owns (`ActiveScratch`) are deleted. Age alone decides only at startup, when no job runs.
 */
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { eq, inArray, and } from "drizzle-orm";
import { schema, type Database } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import type { ObjectStorage } from "@commonair/storage";
import { parsePlaylist, renderPlaylist, type PlaylistSegment } from "./vod/playlist.ts";
import { VOD_PLAYLIST, vodPrefix } from "./vod/recorder.ts";

export const BROADCASTS_DIR = "broadcasts";
/** mkdtemp prefixes of per-job scratch directories (clips.ts, vod/finalize.ts). */
export const SCRATCH_PREFIXES = ["clip-", "vod-"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_PLAYLIST = /^r[0-9a-z]+\.m3u8$/;

export interface LocalRun {
  runId: string;
  segments: PlaylistSegment[];
}

/**
 * Pure: completed local segments not yet in the published playlist, in recording order
 * (wall-clock start, then run, then playlist order). URIs and maps are bare file names.
 */
export function segmentsToRecover(published: readonly PlaylistSegment[], runs: readonly LocalRun[]): PlaylistSegment[] {
  const have = new Set(published.map((s) => basename(s.uri)));
  const out: { seg: PlaylistSegment; run: number; idx: number }[] = [];
  const ordered = [...runs].sort((a, b) => a.runId.length - b.runId.length || a.runId.localeCompare(b.runId));
  ordered.forEach((r, run) =>
    r.segments.forEach((s, idx) => {
      const uri = basename(s.uri);
      if (have.has(uri)) return;
      have.add(uri);
      out.push({ seg: { ...s, uri, map: s.map ? basename(s.map) : null }, run, idx });
    }),
  );
  out.sort((a, b) => {
    const ta = a.seg.startedAt?.getTime();
    const tb = b.seg.startedAt?.getTime();
    if (ta !== undefined && tb !== undefined && ta !== tb) return ta - tb;
    return a.run - b.run || a.idx - b.idx;
  });
  return out.map((o) => o.seg);
}

export interface RecoveryDeps {
  db: Database;
  storage: ObjectStorage;
  bucket: string;
  workDir: string;
  logger: Logger;
}

export interface RecoveryResult {
  /** Broadcast directories examined. */
  directories: number;
  /** Segments uploaded into a VOD. */
  uploaded: number;
  /** Directories kept because recovery failed (retried on the next start). */
  kept: number;
}

async function readRuns(dir: string): Promise<LocalRun[]> {
  const runs: LocalRun[] = [];
  for (const name of await readdir(dir)) {
    if (!RUN_PLAYLIST.test(name)) continue;
    const text = await Bun.file(join(dir, name)).text();
    runs.push({ runId: name.slice(0, -".m3u8".length), segments: parsePlaylist(text).segments });
  }
  return runs;
}

/** Upload what the crashed recorder had not, then rewrite the (still open) VOD playlist. */
async function recoverRecording(deps: RecoveryDeps, dir: string, vodId: string): Promise<number> {
  const { storage, bucket } = deps;
  const prefix = vodPrefix(vodId);
  const res = await storage.get(bucket, prefix + VOD_PLAYLIST);
  const published = res ? parsePlaylist(await res.text()).segments : [];
  const pending = segmentsToRecover(published, await readRuns(dir));
  const maps = new Set(published.flatMap((s) => (s.map ? [s.map] : [])));
  const added: PlaylistSegment[] = [];
  for (const seg of pending) {
    const file = Bun.file(join(dir, seg.uri));
    // Pruned (uploaded long ago, or dropped under backpressure): nothing to recover.
    if (!(await file.exists())) continue;
    if (seg.map && !maps.has(seg.map)) {
      const init = Bun.file(join(dir, seg.map));
      if (!(await init.exists())) continue;
      await storage.put(bucket, prefix + seg.map, await init.bytes(), { contentType: "video/mp4" });
      maps.add(seg.map);
    }
    await storage.put(bucket, prefix + seg.uri, await file.bytes(), { contentType: "video/iso.segment" });
    added.push(seg);
  }
  if (added.length === 0) return 0;
  await storage.put(bucket, prefix + VOD_PLAYLIST, renderPlaylist([...published, ...added], { ended: false }), {
    contentType: "application/vnd.apple.mpegurl",
    cacheControl: "no-cache",
  });
  return added.length;
}

/** Run once at startup, before sessions start and before job workers consume. */
export async function recoverWorkDir(deps: RecoveryDeps): Promise<RecoveryResult> {
  const log = deps.logger.child({ component: "recovery" });
  const root = join(deps.workDir, BROADCASTS_DIR);
  const result: RecoveryResult = { directories: 0, uploaded: 0, kept: 0 };
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return result;
  }
  for (const name of names) {
    result.directories++;
    const outcome = await recoverBroadcastDir(deps, root, name, ["recording", "processing"], log);
    if (outcome.kept) result.kept++;
    result.uploaded += outcome.uploaded;
  }
  return result;
}

type OpenVodStatus = "recording" | "processing";

/**
 * Recover (upload what is missing) and remove one unowned broadcast directory. The directory
 * is deleted only once its segments are safe: recovery succeeded, or the broadcast has no VOD
 * in one of `recoverable` states. A VOD in another unfinished state (e.g. `processing` while a
 * finalize job may be running) keeps its directory until the VOD is ready, failed or gone.
 */
async function recoverBroadcastDir(
  deps: RecoveryDeps,
  root: string,
  name: string,
  recoverable: readonly OpenVodStatus[],
  log: Logger,
): Promise<{ kept: boolean; uploaded: number }> {
  const dir = join(root, name);
  if (!UUID.test(name)) {
    await rm(dir, { recursive: true, force: true });
    return { kept: false, uploaded: 0 };
  }
  try {
    const [vod] = await deps.db
      .select({ id: schema.vods.id, status: schema.vods.status })
      .from(schema.vods)
      .where(and(eq(schema.vods.broadcastId, name), inArray(schema.vods.status, ["recording", "processing"])))
      .limit(1);
    let uploaded = 0;
    if (vod) {
      if (!recoverable.includes(vod.status as OpenVodStatus)) return { kept: true, uploaded: 0 };
      uploaded = await recoverRecording(deps, dir, vod.id);
      if (uploaded > 0)
        log.info("recovered unuploaded segments of a recording", {
          broadcastId: name,
          vodId: vod.id,
          segments: uploaded,
        });
    }
    await rm(dir, { recursive: true, force: true });
    return { kept: false, uploaded };
  } catch (err) {
    // Keep the files; the next startup or sweep tries again.
    log.warn("could not recover a recording; keeping its files", { broadcastId: name, err });
    return { kept: true, uploaded: 0 };
  }
}

/** Scratch directories of running clip/finalize jobs; the periodic sweep never touches them. */
export class ActiveScratch {
  private readonly paths = new Set<string>();

  has(path: string): boolean {
    return this.paths.has(path);
  }

  /** Create and register a scratch dir under `workDir`. Pair with `release`. */
  async create(workDir: string, prefix: (typeof SCRATCH_PREFIXES)[number]): Promise<string> {
    const dir = await mkdtemp(join(workDir, prefix));
    this.paths.add(dir);
    return dir;
  }

  /** Delete a scratch dir and forget it. */
  async release(dir: string): Promise<void> {
    try {
      await rm(dir, { recursive: true, force: true });
    } finally {
      this.paths.delete(dir);
    }
  }
}

/** Unregistered scratch dirs younger than this may be between mkdtemp and registration. */
const SCRATCH_REGISTRATION_GRACE_MS = 60_000;

export interface SweepOptions extends RecoveryDeps {
  /** Broadcast ids with a running session (their directories are in use). */
  owned: ReadonlySet<string>;
  /** Scratch dirs of running jobs. */
  activeScratch: ActiveScratch;
  broadcastDirMaxAgeMs: number;
  now?: number;
}

export interface StartupSweepOptions {
  workDir: string;
  logger: Logger;
}

export interface SweepResult {
  removed: string[];
}

async function ageMs(path: string, now: number): Promise<number | null> {
  try {
    return now - (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

async function scratchDirs(workDir: string): Promise<string[]> {
  const top = await readdir(workDir, { withFileTypes: true }).catch(() => []);
  return top
    .filter((e) => e.isDirectory() && SCRATCH_PREFIXES.some((p) => e.name.startsWith(p)))
    .map((e) => join(workDir, e.name));
}

/** Startup only (no job runs yet): every scratch directory is a leftover of a crashed job. */
export async function sweepScratchAtStartup(opts: StartupSweepOptions): Promise<SweepResult> {
  const removed = await scratchDirs(opts.workDir);
  for (const path of removed) await rm(path, { recursive: true, force: true });
  if (removed.length > 0) opts.logger.info("removed scratch dirs left by a crash", { count: removed.length });
  return { removed };
}

/**
 * Periodic: delete scratch dirs no running job owns, and recover-then-delete broadcast dirs no
 * session owns once they are older than `broadcastDirMaxAgeMs`. Only `recording` VODs are
 * recovered here; a `processing` VOD's finalize job may be reading its playlist right now.
 */
export async function sweepWorkDir(opts: SweepOptions): Promise<SweepResult> {
  const now = opts.now ?? Date.now();
  const log = opts.logger.child({ component: "sweep" });
  const removed: string[] = [];
  for (const path of await scratchDirs(opts.workDir)) {
    if (opts.activeScratch.has(path)) continue;
    const age = await ageMs(path, now);
    if (age === null || age < SCRATCH_REGISTRATION_GRACE_MS) continue;
    await rm(path, { recursive: true, force: true });
    removed.push(path);
  }
  const root = join(opts.workDir, BROADCASTS_DIR);
  for (const name of await readdir(root).catch(() => [])) {
    if (opts.owned.has(name)) continue;
    const age = await ageMs(join(root, name), now);
    if (age === null || age < opts.broadcastDirMaxAgeMs) continue;
    const outcome = await recoverBroadcastDir(opts, root, name, ["recording"], log);
    if (!outcome.kept) removed.push(join(root, name));
  }
  if (removed.length > 0) log.info("swept orphaned work directories", { count: removed.length });
  return { removed };
}
