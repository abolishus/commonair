// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Global disk budget for MEDIA_WORK_DIR. Recordings and clip cuts are refused (never crash)
 * when the work directory has grown past `maxBytes` or the filesystem has less than
 * `minFreeBytes` left. Measuring walks the directory, so results are cached briefly.
 */
import { readdir, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "@commonair/observability";

const GIB = 1024 ** 3;

export interface DiskBudgetConfig {
  /** Upper bound for everything under the work dir. */
  maxBytes: number;
  /** Refuse new work when the filesystem has less than this free. */
  minFreeBytes: number;
}

/** Defaults until an env var exists (contract request: MEDIA_WORK_DIR_MAX_BYTES / _MIN_FREE_BYTES). */
export const DEFAULT_DISK_BUDGET: DiskBudgetConfig = { maxBytes: 20 * GIB, minFreeBytes: 2 * GIB };

export interface DiskUsage {
  usedBytes: number;
  /** null when the filesystem cannot report free space. */
  freeBytes: number | null;
}

export type BudgetVerdict =
  | { ok: true }
  | { ok: false; reason: "work_dir_full" | "filesystem_low"; usedBytes: number; freeBytes: number | null };

/** Pure: does `need` more bytes fit? */
export function evaluateBudget(usage: DiskUsage, cfg: DiskBudgetConfig, need = 0): BudgetVerdict {
  if (usage.usedBytes + need > cfg.maxBytes) return { ok: false, reason: "work_dir_full", ...usage };
  if (usage.freeBytes !== null && usage.freeBytes - need < cfg.minFreeBytes)
    return { ok: false, reason: "filesystem_low", ...usage };
  return { ok: true };
}

/** Total size of regular files under `dir` (missing entries, e.g. deleted mid-walk, count as 0). */
export async function directorySize(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await directorySize(p);
    else if (e.isFile())
      total += await stat(p).then(
        (s) => s.size,
        () => 0,
      );
  }
  return total;
}

async function freeBytes(dir: string): Promise<number | null> {
  try {
    const s = await statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

export interface DiskBudgetOptions {
  dir: string;
  config?: Partial<DiskBudgetConfig>;
  logger: Logger;
  /** How long a measurement is reused. */
  cacheMs?: number;
  measure?: (dir: string) => Promise<DiskUsage>;
}

export class DiskBudget {
  readonly config: DiskBudgetConfig;
  private cached: { at: number; usage: DiskUsage } | null = null;
  private inflight: Promise<DiskUsage> | null = null;
  private lastRefusalLogAt = 0;

  constructor(private readonly opts: DiskBudgetOptions) {
    this.config = { ...DEFAULT_DISK_BUDGET, ...opts.config };
  }

  async usage(): Promise<DiskUsage> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < (this.opts.cacheMs ?? 5_000)) return this.cached.usage;
    this.inflight ??= (
      this.opts.measure ?? (async (dir) => ({ usedBytes: await directorySize(dir), freeBytes: await freeBytes(dir) }))
    )(this.opts.dir).finally(() => {
      this.inflight = null;
    });
    const usage = await this.inflight;
    this.cached = { at: Date.now(), usage };
    return usage;
  }

  /**
   * Check before starting new work. Never throws: a measurement failure allows the work (the
   * budget protects the disk, it must not take the service down). Refusals are logged as the
   * structured `media.disk_budget_exceeded` event, at most once a minute.
   */
  async check(what: string, need = 0): Promise<BudgetVerdict> {
    let verdict: BudgetVerdict;
    try {
      verdict = evaluateBudget(await this.usage(), this.config, need);
    } catch (err) {
      this.opts.logger.warn("disk budget measurement failed; allowing work", { err });
      return { ok: true };
    }
    if (!verdict.ok && Date.now() - this.lastRefusalLogAt > 60_000) {
      this.lastRefusalLogAt = Date.now();
      this.opts.logger.error("media work dir over budget; refusing new work", {
        event: "media.disk_budget_exceeded",
        what,
        reason: verdict.reason,
        usedBytes: verdict.usedBytes,
        freeBytes: verdict.freeBytes,
        maxBytes: this.config.maxBytes,
        minFreeBytes: this.config.minFreeBytes,
      });
    }
    return verdict;
  }

  /** Forget the cached measurement (after a sweep freed space). */
  invalidate(): void {
    this.cached = null;
  }
}
