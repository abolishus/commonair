// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The harness player's start-up timeline: when each start-up milestone first happened (ms since the
 * page started, `performance.now()`) and the non-fatal hls.js errors on the way to the first frame.
 * An ingest TTFF failure otherwise says only how long it took, not where the time went (the
 * `ingest-whip` TTFF flake, docs/operators/flakes.md). Recording stops at the first frame, so the
 * timeline stays small and describes start-up only. Pure; runs in the page and in unit tests.
 */

export type StartupMilestone =
  | "session"
  | "manifest"
  | "level-video"
  | "level-audio"
  | "frag-video"
  | "frag-audio"
  | "first-frame";

export interface StartupEvent {
  event: StartupMilestone;
  /** ms since the page started, rounded. */
  at: number;
  /** Fragments: media sequence number (`"initSegment"` for an init segment). */
  sn?: number | string;
  /** Fragments: whether it was an `#EXT-X-GAP` segment. */
  gap?: boolean;
}

export interface StartupNonFatal {
  at: number;
  /** hls.js `ErrorDetails` value, e.g. `fragGap`, `levelLoadError`. */
  details: string;
  /** HTTP status of the failed request, when there was one. */
  code: number | null;
  /** The request's URL path, never its query (the playback token lives there). */
  path: string | null;
}

export interface StartupTimeline {
  events: StartupEvent[];
  nonFatal: StartupNonFatal[];
  /** Non-fatal errors past the cap, counted but not kept. */
  nonFatalDropped: number;
}

/** Non-fatal errors kept before the first frame; the earliest say most about a stuck start-up. */
export const MAX_STARTUP_NON_FATAL = 20;

export function emptyStartup(): StartupTimeline {
  return { events: [], nonFatal: [], nonFatalDropped: 0 };
}

function started(t: StartupTimeline): boolean {
  return t.events.some((e) => e.event === "first-frame");
}

/**
 * Record a milestone the first time it happens; later ones and anything after the first frame are
 * ignored. Returns whether it was recorded.
 */
export function recordMilestone(
  t: StartupTimeline,
  event: StartupMilestone,
  at: number,
  extra: { sn?: number | string; gap?: boolean } = {},
): boolean {
  if (started(t) || t.events.some((e) => e.event === event)) return false;
  const e: StartupEvent = { event, at: Math.round(at) };
  if (extra.sn !== undefined) e.sn = extra.sn;
  if (extra.gap !== undefined) e.gap = extra.gap;
  t.events.push(e);
  return true;
}

/** The path of a request URL without its query or fragment; null when it is not a URL. */
export function urlPath(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

/** Record a non-fatal hls.js error before the first frame, up to the cap. */
export function recordNonFatal(
  t: StartupTimeline,
  at: number,
  error: { details: string; code?: number | null; url?: string | null },
): void {
  if (started(t)) return;
  if (t.nonFatal.length >= MAX_STARTUP_NON_FATAL) {
    t.nonFatalDropped++;
    return;
  }
  t.nonFatal.push({
    at: Math.round(at),
    details: error.details,
    code: typeof error.code === "number" && error.code > 0 ? error.code : null,
    path: urlPath(error.url),
  });
}

/** A deep copy, for handing out of the page (the player keeps mutating its own). */
export function copyStartup(t: StartupTimeline): StartupTimeline {
  return {
    events: t.events.map((e) => ({ ...e })),
    nonFatal: t.nonFatal.map((e) => ({ ...e })),
    nonFatalDropped: t.nonFatalDropped,
  };
}

/**
 * One line for an assertion's details or a timeout message:
 * `session@120 manifest@480 frag-video@900(sn=12,gap) first-frame@1300; non-fatal: fragGap@700 /live/x/video.m3u8 ×2`.
 * Repeated non-fatal errors (same details, code and path) collapse into one entry with a count.
 */
export function formatStartup(t: StartupTimeline | null | undefined): string {
  if (!t) return "no start-up timeline";
  const events =
    t.events.length === 0
      ? "no start-up events"
      : t.events
          .map((e) => {
            const tags = [
              ...(e.sn === undefined ? [] : [`sn=${e.sn}`]),
              ...(e.gap === undefined ? [] : [e.gap ? "gap" : "media"]),
            ];
            return `${e.event}@${e.at}${tags.length > 0 ? `(${tags.join(",")})` : ""}`;
          })
          .join(" ");
  if (t.nonFatal.length === 0) return `${events}; no non-fatal errors`;
  const groups: { key: string; first: StartupNonFatal; count: number }[] = [];
  for (const e of t.nonFatal) {
    const key = `${e.details} ${e.code ?? ""} ${e.path ?? ""}`;
    const g = groups.find((x) => x.key === key);
    if (g) g.count++;
    else groups.push({ key, first: e, count: 1 });
  }
  const errors = groups
    .map(({ first, count }) =>
      [
        `${first.details}@${first.at}`,
        first.code === null ? null : String(first.code),
        first.path,
        count > 1 ? `×${count}` : null,
      ]
        .filter((s) => s !== null)
        .join(" "),
    )
    .join(", ");
  const dropped = t.nonFatalDropped > 0 ? ` (+${t.nonFatalDropped} more)` : "";
  return `${events}; non-fatal: ${errors}${dropped}`;
}
