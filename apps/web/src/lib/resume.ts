// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Continue watching (overhaul wave 2, D3.6): resume points for videos, kept in this browser only
 * (`commonair.resume.v1`, at most 20, newest first). Nothing goes to the server. The watch page
 * writes; discovery reads. Storage can be missing or throw (private windows), so every access is
 * guarded and a bad value reads as empty.
 */
export const RESUME_KEY = "commonair.resume.v1";
export const RESUME_MAX = 20;
/** Shorter than this into a video, or this close to its end, is not worth resuming. */
export const RESUME_MIN_SECONDS = 30;
export const RESUME_END_MARGIN_SECONDS = 30;

export interface ResumePoint {
  vodId: string;
  channelSlug: string;
  title: string;
  thumbnailUrl: string | null;
  positionSeconds: number;
  durationSeconds: number;
  /** ISO 8601 with offset. */
  updatedAt: string;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function storage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function valid(p: unknown): p is ResumePoint {
  if (typeof p !== "object" || p === null) return false;
  const r = p as Record<string, unknown>;
  return (
    typeof r.vodId === "string" &&
    typeof r.channelSlug === "string" &&
    typeof r.title === "string" &&
    (r.thumbnailUrl === null || typeof r.thumbnailUrl === "string") &&
    typeof r.positionSeconds === "number" &&
    Number.isFinite(r.positionSeconds) &&
    typeof r.durationSeconds === "number" &&
    Number.isFinite(r.durationSeconds) &&
    typeof r.updatedAt === "string"
  );
}

/** Every stored point, newest first. */
export function readResumePoints(store: StorageLike | null = storage()): ResumePoint[] {
  if (!store) return [];
  try {
    const raw = store.getItem(RESUME_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(valid).slice(0, RESUME_MAX) : [];
  } catch {
    return [];
  }
}

/** The position to resume one video at, or null. */
export function resumePositionFor(vodId: string, store: StorageLike | null = storage()): number | null {
  return readResumePoints(store).find((p) => p.vodId === vodId)?.positionSeconds ?? null;
}

function write(points: ResumePoint[], store: StorageLike | null): void {
  if (!store) return;
  try {
    store.setItem(RESUME_KEY, JSON.stringify(points.slice(0, RESUME_MAX)));
  } catch {
    // Quota or blocked storage: resuming is a convenience.
  }
}

/**
 * Record where a video was left. Near the start or the end clears the point instead (finished
 * videos leave the shelf).
 */
export function saveResumePoint(point: ResumePoint, store: StorageLike | null = storage()): void {
  const rest = readResumePoints(store).filter((p) => p.vodId !== point.vodId);
  const done =
    point.positionSeconds < RESUME_MIN_SECONDS ||
    (point.durationSeconds > 0 && point.positionSeconds > point.durationSeconds - RESUME_END_MARGIN_SECONDS);
  write(done ? rest : [point, ...rest], store);
}

/** Drop one video's point ("Remove from Continue watching"). */
export function clearResumePoint(vodId: string, store: StorageLike | null = storage()): void {
  write(
    readResumePoints(store).filter((p) => p.vodId !== vodId),
    store,
  );
}
