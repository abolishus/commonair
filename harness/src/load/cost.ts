// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `load-cost` (S1-i): what one stream and one viewer cost, each measured alone. The scenario runs
 * fixed cells (no streams, streams without viewers, viewers below the ladder threshold, one
 * ladder) and turns their per-container CPU into cores per unit by subtraction. Nothing on the
 * instance is switched off to isolate a cost: the cells differ only in what the generator sends.
 *
 * | Cell           | Streams | Viewers           | Yields                                      |
 * | -------------- | ------- | ----------------- | ------------------------------------------- |
 * | `idle`         | 0       | 0                 | the baseline every other cell subtracts     |
 * | `viewers`      | 1       | V (< threshold)   | caddy + origin + api per viewer             |
 * | `viewers-many` | S       | V each            | the same over many paths (cache misses)     |
 * | `ingest`       | N       | 0                 | mediamtx + media + worker + valkey / stream |
 * | `ingest-2x`    | 2N      | 0                 | whether the per-stream cost is linear       |
 * | `ladder`       | 1       | L (≥ threshold)   | one ladder, by subtraction from `viewers`   |
 *
 * The cells run in that order: streams only grow until `ingest-2x`, and the ladder runs last, so
 * no ladder lingers (it stops only after 2 minutes below 80 % of the threshold) into a cell that
 * must have none. Parameters, planning, judging and the maths are pure.
 */
import {
  DEFAULT_GENERATOR_THRESHOLDS,
  type GeneratorThresholds,
  type GeneratorVerdict,
  describeLimit,
} from "./judge.ts";
import type { ContainerUsage } from "./counters.ts";
import { DEFAULT_HTTP_PER_PROCESS } from "./shard.ts";
import type { SourceShape } from "./sweep.ts";

export class CostParamError extends Error {
  override name = "CostParamError";
}

/** Every cell, in the order they run. */
export const COST_CELLS = ["idle", "viewers", "viewers-many", "ingest", "ingest-2x", "ladder"] as const;
export type CostCellName = (typeof COST_CELLS)[number];

/** The containers costs are attributed to (`commonair-<service>`). */
export const COST_SERVICES = ["mediamtx", "media", "worker", "origin", "caddy", "api", "postgres", "valkey"] as const;
export type CostService = (typeof COST_SERVICES)[number];

/** What a live stream costs without viewers (the brief's ingest group). */
export const INGEST_GROUP: readonly CostService[] = ["mediamtx", "media", "worker", "valkey"];
/** Ingest and HLS packaging without moderation: MediaMTX and the Valkey traffic around it. */
export const PACKAGING_GROUP: readonly CostService[] = ["mediamtx", "valkey"];
/**
 * Moderation spans two containers: the frame capture in `media`
 * (`services/media/src/moderation/sampler.ts`) and the classifier in `worker`
 * (`services/worker/src/jobs/moderation-scan.ts`).
 */
export const MODERATION_GROUP: readonly CostService[] = ["media", "worker"];
/** What ADR 0041 decision 5 calls "Origin + Caddy" per 100 viewers. */
export const EDGE_GROUP: readonly CostService[] = ["caddy", "origin"];

/** Playback tokens live 120 s (`PLAYBACK_TOKEN_TTL_SECONDS`); heartbeats refresh them. */
export const PLAYBACK_TOKEN_SECONDS = 120;
/** `podman stats` and the counter reads sample every 5 s: fewer than 12 intervals is refused. */
export const MIN_CELL_SECONDS = 60;
/** Slack between a heartbeat-less cell's end and its tokens' expiry. */
const TOKEN_MARGIN_SECONDS = 15;
/** `openViewers` staggers HTTP starts by 20–80 ms, so the first token is older than the last. */
const OPEN_SECONDS_PER_VIEWER = 0.08;
/** Steady viewers one generator address carries inside the `playback` rate-limit bucket (capacity.md). */
export const VIEWERS_PER_GENERATOR_ADDRESS = 430;

/** ADR 0041 decision 5. */
export const COST_TARGETS = {
  packagingCoresPerStream: 0.1,
  moderationCoresPerStream: 0.05,
  edgeCoresPer100Viewers: 0.15,
} as const;

/** Every cell sends the same source, so a subtraction never mixes two encodes. */
export const DEFAULT_COST_SOURCE: SourceShape = { protocol: "rtmp", width: 1920, height: 1080, bitrateKbps: 6000 };

export interface CostParams {
  cells: CostCellName[];
  /** Measured window per cell, after the warm-up. */
  seconds: number;
  warmupSeconds: number;
  /** The ladder cell's warm-up (the ladder starts 30 s after the threshold is crossed). */
  ladderWarmupSeconds: number;
  /** Longest the ladder cell waits after its warm-up for a ladder to appear. */
  ladderWaitSeconds: number;
  /** Pause between cells (viewers gone, sessions ended). */
  cooldownSeconds: number;
  /** N: streams in `ingest` (2N in `ingest-2x`). */
  streams: number;
  /** V: viewers per stream in `viewers` and `viewers-many`. */
  viewers: number;
  /** S: streams in `viewers-many`. */
  manyStreams: number;
  /** The instance's `TRANSCODE_VIEWER_THRESHOLD` (the harness cannot read it). */
  ladderThreshold: number;
  /** L: viewers in the ladder cell. */
  ladderViewers: number;
  /** The `viewers` cell's HTTP viewers: heartbeats (playback API calls) and segment downloads. */
  heartbeats: boolean;
  fetchSegments: boolean;
  source: SourceShape;
  browserViewers: number;
  httpPerProcess: number;
  maxHeartbeatErrors: number;
  generator: GeneratorThresholds;
  /** `ingest-2x` per stream within this share of `ingest`'s counts as linear. */
  linearityTolerance: number;
  /** Bun services to CPU-profile on the target (`COMMONAIR_CPU_PROFILE`, capacity.md). */
  profiles: string[];
  /** Where the target's quadlet drop-ins mount the profile directories (relative to its home). */
  profileDir: string;
  /** Test only: allows cells under `MIN_CELL_SECONDS`; refused against a remote target. */
  testShortCells: boolean;
  /** Why the parameters differ from what was asked (a cap), for the report. */
  notes: string[];
}

export const COST_PARAM_KEYS = [
  "preset",
  "cells",
  "seconds",
  "warmupSeconds",
  "ladderWarmupSeconds",
  "ladderWaitSeconds",
  "cooldownSeconds",
  "streams",
  "viewers",
  "manyStreams",
  "ladderThreshold",
  "ladderViewers",
  "heartbeats",
  "fetchSegments",
  "protocol",
  "width",
  "height",
  "bitrateKbps",
  "browserViewers",
  "httpPerProcess",
  "maxHeartbeatErrors",
  "generatorCpuP95",
  "generatorNicHeadroom",
  "linearityTolerance",
  "profiles",
  "profileDir",
  "testShortCells",
] as const;

/** Bun services the entrypoint can start under the profiler (not web, not the non-Bun images). */
export const PROFILABLE_SERVICES = ["api", "chat", "media", "worker", "origin", "tracker", "irc"] as const;

/**
 * `--set preset=smoke`: tiny cells the local stack can run in a few minutes (2 streams, 5
 * viewers, 20 s). Its numbers are the developer machine's; it checks the plumbing, not the costs.
 */
export const COST_SMOKE_PRESET: Readonly<Record<string, string>> = {
  cells: "idle,viewers,viewers-many,ingest,ingest-2x",
  streams: "2",
  viewers: "5",
  manyStreams: "2",
  seconds: "20",
  warmupSeconds: "10",
  cooldownSeconds: "5",
  width: "640",
  height: "360",
  bitrateKbps: "1200",
  testShortCells: "true",
};

function num(
  params: Readonly<Record<string, string>>,
  key: string,
  fallback: number,
  check: { min: number; max?: number; integer?: boolean },
): number {
  const raw = params[key];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  const bad =
    raw.trim() === "" ||
    !Number.isFinite(n) ||
    n < check.min ||
    (check.max !== undefined && n > check.max) ||
    (check.integer !== false && !Number.isInteger(n));
  if (bad) {
    const range = check.max === undefined ? `≥ ${check.min}` : `in [${check.min}, ${check.max}]`;
    throw new CostParamError(
      `--set ${key}=${raw}: expected ${check.integer === false ? "a number" : "an integer"} ${range}`,
    );
  }
  return n;
}

function bool(params: Readonly<Record<string, string>>, key: string, fallback: boolean): boolean {
  const raw = params[key];
  if (raw === undefined) return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new CostParamError(`--set ${key}=${raw}: expected true or false`);
}

/** `idle,ingest`: known cells, no repeats, put in run order; `idle` is added when missing. Pure. */
export function parseCells(raw: string | undefined): { cells: CostCellName[]; addedIdle: boolean } {
  if (raw === undefined) return { cells: [...COST_CELLS], addedIdle: false };
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (parts.length === 0) throw new CostParamError("--set cells: no cells given");
  const seen = new Set<CostCellName>();
  for (const p of parts) {
    if (!(COST_CELLS as readonly string[]).includes(p)) {
      throw new CostParamError(`--set cells: unknown cell "${p}" (expected ${COST_CELLS.join(", ")})`);
    }
    if (seen.has(p as CostCellName)) throw new CostParamError(`--set cells: "${p}" given twice`);
    seen.add(p as CostCellName);
  }
  const addedIdle = !seen.has("idle");
  seen.add("idle");
  return { cells: COST_CELLS.filter((c) => seen.has(c)), addedIdle };
}

/**
 * The longest a heartbeat-less cell may measure: its first token must still be valid at the end
 * of the window (it is issued before the other viewers open and the warm-up runs). Pure.
 */
export function heartbeatlessSecondsCap(warmupSeconds: number, viewers: number): number {
  return Math.floor(
    PLAYBACK_TOKEN_SECONDS - TOKEN_MARGIN_SECONDS - warmupSeconds - Math.ceil(viewers * OPEN_SECONDS_PER_VIEWER),
  );
}

/** Parse `load-cost`'s `--set` keys. `remote` = a target over SSH (no test-only shortcuts). Pure. */
export function parseCostParams(input: Readonly<Record<string, string>>, opts: { remote: boolean }): CostParams {
  const preset = input.preset;
  if (preset !== undefined && preset !== "smoke") throw new CostParamError(`--set preset=${preset}: expected smoke`);
  if (preset === "smoke" && opts.remote) {
    throw new CostParamError("--set preset=smoke is for the local stack: its cells are too short to measure a target");
  }
  const params = preset === "smoke" ? { ...COST_SMOKE_PRESET, ...input } : input;
  const notes: string[] = [];
  const { cells, addedIdle } = parseCells(params.cells);
  if (addedIdle) notes.push("idle added: every cost subtracts it");
  const testShortCells = bool(params, "testShortCells", false);
  if (testShortCells && opts.remote) {
    throw new CostParamError("--set testShortCells is test-only and refused against a remote target");
  }
  const int = (key: string, fallback: number, min: number, max?: number) =>
    num(params, key, fallback, max === undefined ? { min } : { min, max });

  const warmupSeconds = int("warmupSeconds", 30, 0);
  let seconds = int("seconds", 180, 1);
  const viewers = int("viewers", 40, 1);
  const ladderThreshold = int("ladderThreshold", 50, 1);
  const ladderViewers = int("ladderViewers", ladderThreshold + 10, 1);
  if (viewers >= ladderThreshold) {
    throw new CostParamError(
      `--set viewers=${viewers}: must stay below the ladder threshold (${ladderThreshold}), or the cell measures a ladder`,
    );
  }
  if (ladderViewers < ladderThreshold) {
    throw new CostParamError(
      `--set ladderViewers=${ladderViewers}: must reach the ladder threshold (${ladderThreshold}) for a ladder to start`,
    );
  }
  const heartbeats = bool(params, "heartbeats", true);
  const fetchSegments = bool(params, "fetchSegments", true);
  if (!heartbeats && cells.includes("viewers")) {
    const cap = heartbeatlessSecondsCap(warmupSeconds, viewers);
    if (seconds > cap) {
      notes.push(
        `seconds capped from ${seconds} to ${cap}: without heartbeats nothing refreshes the ${PLAYBACK_TOKEN_SECONDS} s playback token`,
      );
      seconds = cap;
    }
  }
  if (seconds < MIN_CELL_SECONDS && !testShortCells) {
    throw new CostParamError(
      `a cell of ${seconds} s is refused: podman stats samples every 5 s, so a cell needs at least ${MIN_CELL_SECONDS} s after its warm-up`,
    );
  }
  if (seconds < 1) throw new CostParamError(`a cell of ${seconds} s measures nothing`);

  const protocol = params.protocol ?? DEFAULT_COST_SOURCE.protocol;
  if (protocol !== "rtmp" && protocol !== "whip")
    throw new CostParamError(`--set protocol=${protocol}: expected rtmp or whip`);
  const dim = (key: "width" | "height", fallback: number, max: number) => {
    const n = int(key, fallback, 2, max);
    if (n % 2 !== 0) throw new CostParamError(`--set ${key}=${n}: expected an even number`);
    return n;
  };
  const source: SourceShape = {
    protocol,
    width: dim("width", DEFAULT_COST_SOURCE.width, 7680),
    height: dim("height", DEFAULT_COST_SOURCE.height, 4320),
    bitrateKbps: int("bitrateKbps", DEFAULT_COST_SOURCE.bitrateKbps, 100, 100_000),
  };

  const profiles = (params.profiles ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  for (const s of profiles) {
    if (!(PROFILABLE_SERVICES as readonly string[]).includes(s)) {
      throw new CostParamError(
        `--set profiles: "${s}" is not a Bun service (${PROFILABLE_SERVICES.join(", ")}); profile MediaMTX, ffmpeg, Caddy, Postgres and Valkey with perf (capacity.md)`,
      );
    }
  }
  if (profiles.length > 0 && !opts.remote) {
    throw new CostParamError(
      "--set profiles needs a remote target (HARNESS_LOAD_TARGET_SSH) with the profiling drop-ins",
    );
  }
  const profileDir = params.profileDir ?? "commonair-profiles";
  if (!/^[A-Za-z0-9._/-]+$/.test(profileDir) || profileDir.split("/").includes("..")) {
    throw new CostParamError(`--set profileDir=${profileDir}: expected a plain path`);
  }
  const browserViewers = int("browserViewers", 0, 0);
  if (browserViewers > viewers) {
    throw new CostParamError(`--set browserViewers=${browserViewers} exceeds the ${viewers} viewers of a cell`);
  }
  const g = DEFAULT_GENERATOR_THRESHOLDS;
  return {
    cells,
    seconds,
    warmupSeconds,
    ladderWarmupSeconds: int("ladderWarmupSeconds", 90, 0),
    ladderWaitSeconds: int("ladderWaitSeconds", 60, 0),
    cooldownSeconds: int("cooldownSeconds", 20, 0),
    streams: int("streams", 10, 1),
    viewers,
    manyStreams: int("manyStreams", 10, 1),
    ladderThreshold,
    ladderViewers,
    heartbeats,
    fetchSegments,
    source,
    browserViewers,
    httpPerProcess: int("httpPerProcess", DEFAULT_HTTP_PER_PROCESS, 1),
    maxHeartbeatErrors: int("maxHeartbeatErrors", 0, 0),
    generator: {
      maxCpuP95: num(params, "generatorCpuP95", g.maxCpuP95, { min: 1, max: 100, integer: false }),
      nicHeadroom: num(params, "generatorNicHeadroom", g.nicHeadroom, { min: 0, max: 0.99, integer: false }),
    },
    linearityTolerance: num(params, "linearityTolerance", 0.2, { min: 0, max: 1, integer: false }),
    profiles,
    profileDir,
    testShortCells,
    notes,
  };
}

/** One cell as it will run. */
export interface CellPlan {
  name: CostCellName;
  streams: number;
  viewersPerStream: number;
  viewers: number;
  browserViewers: number;
  warmupSeconds: number;
  /** Extra time the ladder cell may wait for its ladder (0 elsewhere). */
  ladderWaitSeconds: number;
  seconds: number;
  /** The HTTP viewers' knobs (only the `viewers` cell takes `--set heartbeats/fetchSegments`). */
  heartbeats: boolean;
  fetchSegments: boolean;
  /** true: a ladder must run through the window; false: none may. */
  expectLadder: boolean;
}

/** The cells to run, in order. Pure. */
export function planCells(p: CostParams): CellPlan[] {
  return p.cells.map((name): CellPlan => {
    const shape: Record<CostCellName, { streams: number; perStream: number }> = {
      idle: { streams: 0, perStream: 0 },
      viewers: { streams: 1, perStream: p.viewers },
      "viewers-many": { streams: p.manyStreams, perStream: p.viewers },
      ingest: { streams: p.streams, perStream: 0 },
      "ingest-2x": { streams: 2 * p.streams, perStream: 0 },
      ladder: { streams: 1, perStream: p.ladderViewers },
    };
    const { streams, perStream } = shape[name];
    const viewers = streams * perStream;
    const ladder = name === "ladder";
    // The ladder cell needs heartbeats (they make the viewer count) and segments (real players).
    const knobs = name === "viewers";
    return {
      name,
      streams,
      viewersPerStream: perStream,
      viewers,
      browserViewers: Math.min(p.browserViewers, viewers),
      warmupSeconds: ladder ? p.ladderWarmupSeconds : p.warmupSeconds,
      ladderWaitSeconds: ladder ? p.ladderWaitSeconds : 0,
      seconds: p.seconds,
      heartbeats: knobs ? p.heartbeats : true,
      fetchSegments: knobs ? p.fetchSegments : true,
      expectLadder: ladder,
    };
  });
}

/**
 * Planning notes: a cell whose audience passes the generator addresses' share of the `playback`
 * bucket will measure the rate limiter (capacity.md, "one address, one rate-limit bucket"). Pure.
 */
export function planNotes(plan: readonly CellPlan[], generatorAddresses: number): string[] {
  const notes: string[] = [];
  const limit = VIEWERS_PER_GENERATOR_ADDRESS * Math.max(1, generatorAddresses);
  for (const c of plan) {
    if (c.viewers > limit) {
      notes.push(
        `${c.name}: ${c.viewers} viewers over ${generatorAddresses} generator address(es) passes about ${limit} (430 per address): expect failed heartbeats and an inconclusive cell`,
      );
    }
  }
  return notes;
}

/** `commonair-api`, `commonair-api-1`, `commonair_api_1` → `api` (null for anything else). Pure. */
export function serviceOf(container: string, prefix: string): CostService | null {
  if (!container.startsWith(prefix)) return null;
  const bare = container
    .slice(prefix.length)
    .replace(/^[-_]/, "")
    .replace(/[-_]\d+$/, "");
  return (COST_SERVICES as readonly string[]).includes(bare) ? (bare as CostService) : null;
}

/** Container usage keyed by service; a service seen twice (replicas) is summed. Pure. */
export function byService(
  containers: Readonly<Record<string, ContainerUsage>>,
  prefix: string,
): Partial<Record<CostService, ContainerUsage>> {
  const out: Partial<Record<CostService, ContainerUsage>> = {};
  const add = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : a + b);
  for (const [name, u] of Object.entries(containers)) {
    const s = serviceOf(name, prefix);
    if (!s) continue;
    const prev = out[s];
    out[s] = prev
      ? {
          cores: add(prev.cores, u.cores),
          coresP50: add(prev.coresP50, u.coresP50),
          coresP95: add(prev.coresP95, u.coresP95),
          rxBytesPerSecond: add(prev.rxBytesPerSecond, u.rxBytesPerSecond),
          txBytesPerSecond: add(prev.txBytesPerSecond, u.txBytesPerSecond),
          intervals: Math.min(prev.intervals, u.intervals),
          restarts: prev.restarts + u.restarts,
          missing: prev.missing + u.missing,
        }
      : { ...u };
  }
  return out;
}

export type CellStatus = "measured" | "failed" | "inconclusive";

/** What one cell observed, as the judge needs it. */
export interface CellObservation {
  plan: CellPlan;
  windowSeconds: number;
  /** Viewer reports: opened, with a playback session, with a first segment. */
  viewers: { reports: number; sessions: number; started: number; errors: number; heartbeatErrors: number };
  /** Streams of the cell that were not live at the end of the window. */
  offline: string[];
  /** Ladders at the start and end of the window (null = could not be checked). */
  laddersAtStart: number | null;
  laddersAtEnd: number | null;
  /** Null for a local run (the generator is the target too, so it is not judged). */
  generator: GeneratorVerdict | null;
  counters: { failures: number; source: "cgroup" | "podman" };
  services: Partial<Record<CostService, ContainerUsage>>;
  /** The whole target host over the window; null without a remote target. */
  host: { cores: number | null; coresP95: number | null; cpus: number | null } | null;
  /** Set when the cell threw (a stream never went live, a step failed). */
  error?: string;
}

export interface CellVerdict {
  status: CellStatus;
  /** Why it failed. */
  failures: string[];
  /** Why it is inconclusive (the generator, failed heartbeats, missing samples). */
  inconclusive: string[];
}

/**
 * Judge one cell. A failure wins over inconclusive, except that viewer shortfalls in a cell
 * whose generator was the limit are inconclusive. Pure.
 */
export function judgeCell(o: CellObservation, maxHeartbeatErrors: number): CellVerdict {
  const failures: string[] = [];
  const inconclusive: string[] = [];
  const p = o.plan;
  if (o.error) failures.push(o.error);
  if (o.offline.length > 0)
    failures.push(`${o.offline.length} of ${p.streams} streams were not live: ${o.offline.join(", ")}`);
  const heartbeatLimited =
    p.heartbeats && p.viewers > 0 && o.generator !== null && o.viewers.heartbeatErrors > maxHeartbeatErrors;
  // When the generator was the limit, viewer shortfalls are its fault, not the target's (as in the sweep).
  const generatorLimited = Boolean(o.generator?.inconclusive) || heartbeatLimited;
  const viewerIssues = generatorLimited ? inconclusive : failures;
  if (p.viewers > 0) {
    if (o.viewers.reports < p.viewers) viewerIssues.push(`${o.viewers.reports} of ${p.viewers} viewers reported`);
    if (o.viewers.sessions < p.viewers)
      viewerIssues.push(`${o.viewers.sessions} of ${p.viewers} viewers got a playback session`);
    if (p.fetchSegments && o.viewers.started < p.viewers) {
      viewerIssues.push(`${o.viewers.started} of ${p.viewers} viewers played a segment`);
    }
    if (o.viewers.errors > 0) viewerIssues.push(`${o.viewers.errors} viewer errors`);
  }
  if (p.streams > 0) {
    if (p.expectLadder) {
      if (o.laddersAtStart === null || o.laddersAtEnd === null) inconclusive.push("the ladder could not be checked");
      else if (o.laddersAtStart < 1 || o.laddersAtEnd < 1) failures.push("no ladder ran through the window");
    } else if ((o.laddersAtStart ?? 0) > 0 || (o.laddersAtEnd ?? 0) > 0) {
      failures.push("a ladder ran in a cell that must have none");
    }
  }
  if (o.generator?.inconclusive) inconclusive.push(...o.generator.limits.map(describeLimit));
  if (heartbeatLimited) {
    inconclusive.push(
      `${o.viewers.heartbeatErrors} failed heartbeats > ${maxHeartbeatErrors}: the generator's address was rate-limited`,
    );
  }
  if (o.counters.failures > 0) inconclusive.push(`${o.counters.failures} container reads failed`);
  for (const s of COST_SERVICES) {
    const u = o.services[s];
    if (!u) continue;
    if (u.restarts > 0) inconclusive.push(`${s} restarted during the window`);
    if (u.missing > 0) inconclusive.push(`${s} was missing from ${u.missing} reads`);
  }
  if (!o.error && Object.keys(o.services).length === 0) inconclusive.push("no container was measured");
  const status: CellStatus = failures.length > 0 ? "failed" : inconclusive.length > 0 ? "inconclusive" : "measured";
  return { status, failures, inconclusive };
}

/** One row of the report's raw table. */
export interface CellRow extends CellVerdict {
  name: CostCellName;
  streams: number;
  viewers: number;
  windowSeconds: number;
  heartbeats: boolean;
  fetchSegments: boolean;
  laddersAtStart: number | null;
  laddersAtEnd: number | null;
  /** Cores per service (mean over the window), p95 per interval and network bytes. */
  services: Partial<Record<CostService, ContainerUsage>>;
  /** Sum of the attributed services' cores. */
  servicesTotalCores: number | null;
  host: CellObservation["host"];
  containerSource: "cgroup" | "podman";
  viewersReport: CellObservation["viewers"];
}

export function cellRow(o: CellObservation, v: CellVerdict): CellRow {
  const cores = COST_SERVICES.flatMap((s) => {
    const c = o.services[s]?.cores;
    return c === null || c === undefined ? [] : [c];
  });
  return {
    ...v,
    name: o.plan.name,
    streams: o.plan.streams,
    viewers: o.plan.viewers,
    windowSeconds: Math.round(o.windowSeconds * 10) / 10,
    heartbeats: o.plan.heartbeats,
    fetchSegments: o.plan.fetchSegments,
    laddersAtStart: o.laddersAtStart,
    laddersAtEnd: o.laddersAtEnd,
    services: o.services,
    servicesTotalCores: cores.length ? cores.reduce((s, c) => s + c, 0) : null,
    host: o.host,
    containerSource: o.counters.source,
    viewersReport: o.viewers,
  };
}

/** Cores (or bytes/s) per service; null where a term was not measured. */
export type PerService = Partial<Record<CostService, number | null>>;

/** One derived cost: per unit, per service, with the sums and the noise flags. */
export interface CostLine {
  unit: "stream" | "viewer" | "ladder";
  /** How it was computed, in words (`(ingest − idle) / 10 streams`). */
  basis: string;
  perService: PerService;
  /** The services the line's headline sums. */
  group: readonly CostService[];
  total: number | null;
  /** Every attributed service. */
  allServices: number | null;
  /** The whole target host's cores per unit (includes what no container owns). */
  host: number | null;
  /** Services whose difference (before dividing) is within the idle cell's p95 spread. */
  belowNoise: CostService[];
  /** The group's difference is within the idle cell's spread: the headline is noise. */
  totalBelowNoise: boolean;
  negative: CostService[];
  /** Why the line is null. */
  unavailable: string | null;
}

/** A term in a subtraction: a measured cell's cores, or a derived line's per-unit cores. */
type Term = { weight: number; values: PerService; host: number | null };

/** The idle cell's per-interval spread (p95 − p50) per service: the noise floor of a difference. */
export function noiseFloor(idle: Partial<Record<CostService, ContainerUsage>>): PerService {
  const out: PerService = {};
  for (const s of COST_SERVICES) {
    const u = idle[s];
    out[s] = u && u.coresP95 !== null && u.coresP50 !== null ? Math.max(0, u.coresP95 - u.coresP50) : null;
  }
  return out;
}

const coresOf = (row: CellRow): PerService =>
  Object.fromEntries(COST_SERVICES.map((s) => [s, row.services[s]?.cores ?? null])) as PerService;

const sumOf = (values: PerService, group: readonly CostService[]): number | null => {
  let total = 0;
  for (const s of group) {
    const v = values[s];
    if (v === null || v === undefined) return null;
    total += v;
  }
  return total;
};

/**
 * `(a − Σ weight × term) / units` per service, with the noise check on the difference before it
 * is divided. A service missing from any term is null for the line. Pure.
 */
export function subtract(
  a: CellRow,
  terms: readonly Term[],
  units: number,
  noise: PerService,
  meta: { unit: CostLine["unit"]; basis: string; group: readonly CostService[] },
): CostLine {
  const perService: PerService = {};
  const diffs: PerService = {};
  const belowNoise: CostService[] = [];
  const negative: CostService[] = [];
  const raw = coresOf(a);
  for (const s of COST_SERVICES) {
    let d = raw[s] ?? null;
    for (const t of terms) {
      const v = t.values[s];
      d = d === null || v === null || v === undefined ? null : d - t.weight * v;
    }
    diffs[s] = d;
    perService[s] = d === null ? null : d / units;
    if (d === null) continue;
    if (d < 0) negative.push(s);
    const n = noise[s];
    if (n !== null && n !== undefined && Math.abs(d) < n) belowNoise.push(s);
  }
  let host: number | null = a.host?.cores ?? null;
  for (const t of terms) host = host === null || t.host === null ? null : host - t.weight * t.host;
  const groupDiff = sumOf(diffs, meta.group);
  const groupNoise = meta.group.reduce((s, x) => s + (noise[x] ?? 0), 0);
  return {
    unit: meta.unit,
    basis: meta.basis,
    perService,
    group: meta.group,
    total: sumOf(perService, meta.group),
    allServices: sumOf(perService, COST_SERVICES),
    host: host === null ? null : host / units,
    belowNoise,
    totalBelowNoise: groupDiff !== null && Math.abs(groupDiff) < groupNoise,
    negative,
    unavailable: null,
  };
}

const unavailableLine = (unit: CostLine["unit"], group: readonly CostService[], why: string): CostLine => ({
  unit,
  basis: "",
  perService: {},
  group,
  total: null,
  allServices: null,
  host: null,
  belowNoise: [],
  totalBelowNoise: false,
  negative: [],
  unavailable: why,
});

const lineTerm = (l: CostLine, weight: number): Term => ({ weight, values: l.perService, host: l.host });
const cellTerm = (r: CellRow, weight = 1): Term => ({ weight, values: coresOf(r), host: r.host?.cores ?? null });

export interface Linearity {
  /** `ingest` and `ingest-2x`, cores per stream over the ingest group. */
  perStreamAtN: number | null;
  perStreamAt2N: number | null;
  /** What the second N streams added, per stream. */
  marginalPerStream: number | null;
  /** perStreamAt2N / perStreamAtN. */
  ratio: number | null;
  /** Null when either line is noise or missing. */
  linear: boolean | null;
}

export interface TargetCheck {
  metric: string;
  value: number | null;
  target: number;
  /** Null when not measured or within the noise. */
  met: boolean | null;
}

export interface CostSummary {
  outcome: "measured" | "inconclusive" | "failed";
  /** The numbers are the developer machine's (no remote target). */
  local: boolean;
  cells: CellRow[];
  costs: {
    ingestPerStream: CostLine;
    ingest2xPerStream: CostLine;
    linearity: Linearity;
    /** `media` (capture) + `worker` (classifier) per stream from `ingest`; an upper bound. */
    moderationPerStream: {
      capture: number | null;
      classifier: number | null;
      total: number | null;
      /** The same sum from the ingest-2x cell, for the linearity check. */
      totalAt2x: number | null;
      belowNoise: boolean;
    };
    packagingPerStream: number | null;
    viewersPerViewer: CostLine;
    viewersManyPerViewer: CostLine;
    /** caddy + origin per 100 viewers, from `viewers` and from `viewers-many`. */
    edgePer100Viewers: { onePath: number | null; manyPaths: number | null };
    ladder: CostLine;
    /** Valkey network bytes per second per live stream (moderation frames go through it). */
    valkeyBytesPerStream: { rx: number | null; tx: number | null };
  };
  targets: TargetCheck[];
  notes: string[];
}

const unavailableBecause = (rows: Map<CostCellName, CellRow>, need: readonly CostCellName[]): string | null => {
  for (const n of need) {
    const r = rows.get(n);
    if (!r) return `the ${n} cell did not run`;
    if (r.status !== "measured") return `the ${n} cell is ${r.status}`;
  }
  return null;
};

/** Every derived cost from the cells that were measured. Pure. */
export function summarizeCost(
  p: Pick<CostParams, "streams" | "viewers" | "manyStreams" | "ladderViewers" | "linearityTolerance">,
  cells: readonly CellRow[],
  opts: { local: boolean; notes?: readonly string[]; profiled?: readonly string[] },
): CostSummary {
  const rows = new Map(cells.map((c) => [c.name, c] as const));
  const idle = rows.get("idle");
  const noise = idle ? noiseFloor(idle.services) : {};
  const at = (n: CostCellName) => rows.get(n) as CellRow;

  const line = (
    need: readonly CostCellName[],
    unit: CostLine["unit"],
    group: readonly CostService[],
    build: () => CostLine,
  ): CostLine => {
    const why = unavailableBecause(rows, need);
    return why ? unavailableLine(unit, group, why) : build();
  };

  const ingest = line(["idle", "ingest"], "stream", INGEST_GROUP, () =>
    subtract(at("ingest"), [cellTerm(at("idle"))], p.streams, noise, {
      unit: "stream",
      basis: `(ingest − idle) / ${p.streams} streams`,
      group: INGEST_GROUP,
    }),
  );
  const ingest2x = line(["idle", "ingest-2x"], "stream", INGEST_GROUP, () =>
    subtract(at("ingest-2x"), [cellTerm(at("idle"))], 2 * p.streams, noise, {
      unit: "stream",
      basis: `(ingest-2x − idle) / ${2 * p.streams} streams`,
      group: INGEST_GROUP,
    }),
  );
  const marginal = line(["ingest", "ingest-2x"], "stream", INGEST_GROUP, () =>
    subtract(at("ingest-2x"), [cellTerm(at("ingest"))], p.streams, noise, {
      unit: "stream",
      basis: `(ingest-2x − ingest) / ${p.streams} streams`,
      group: INGEST_GROUP,
    }),
  );
  const noisy = (l: CostLine) => l.total === null || l.totalBelowNoise;
  const ratio =
    ingest.total !== null && ingest2x.total !== null && ingest.total > 0 ? ingest2x.total / ingest.total : null;
  const linearity: Linearity = {
    perStreamAtN: ingest.total,
    perStreamAt2N: ingest2x.total,
    marginalPerStream: marginal.total,
    ratio,
    linear: ratio === null || noisy(ingest) || noisy(ingest2x) ? null : Math.abs(ratio - 1) <= p.linearityTolerance,
  };

  // A viewer cell's streams cost what `ingest` measured per stream; without it, they stay in.
  const viewerTerms = (streams: number): { terms: Term[]; basis: string } =>
    ingest.unavailable === null
      ? { terms: [cellTerm(at("idle")), lineTerm(ingest, streams)], basis: ` − ${streams} × ingest per stream` }
      : { terms: [cellTerm(at("idle"))], basis: " (the stream's own cost included: no ingest cell)" };
  const viewers = line(["idle", "viewers"], "viewer", EDGE_GROUP, () => {
    const t = viewerTerms(1);
    return subtract(at("viewers"), t.terms, p.viewers, noise, {
      unit: "viewer",
      basis: `(viewers − idle${t.basis}) / ${p.viewers} viewers`,
      group: EDGE_GROUP,
    });
  });
  const manyViewers = p.manyStreams * p.viewers;
  const viewersMany = line(["idle", "viewers-many"], "viewer", EDGE_GROUP, () => {
    const t = viewerTerms(p.manyStreams);
    return subtract(at("viewers-many"), t.terms, manyViewers, noise, {
      unit: "viewer",
      basis: `(viewers-many − idle${t.basis}) / ${manyViewers} viewers`,
      group: EDGE_GROUP,
    });
  });
  // A viewers cell run without segments or heartbeats is only part of a real viewer's cost.
  const vr = rows.get("viewers");
  const partialViewers = vr !== undefined && (!vr.heartbeats || !vr.fetchSegments);
  const ladder = line(["idle", "viewers", "ladder"], "ladder", COST_SERVICES, () =>
    viewers.unavailable !== null || partialViewers
      ? unavailableLine(
          "ladder",
          COST_SERVICES,
          viewers.unavailable ?? "the viewers cell ran without segments or heartbeats (a partial viewer)",
        )
      : subtract(at("ladder"), [cellTerm(at("viewers")), lineTerm(viewers, p.ladderViewers - p.viewers)], 1, noise, {
          unit: "ladder",
          basis: `ladder − viewers − ${p.ladderViewers - p.viewers} × viewer cost`,
          group: COST_SERVICES,
        }),
  );

  const capture = ingest.perService.media ?? null;
  const classifier = ingest.perService.worker ?? null;
  const moderation = sumOf(ingest.perService, MODERATION_GROUP);
  const moderation2x = sumOf(ingest2x.perService, MODERATION_GROUP);
  const packaging = sumOf(ingest.perService, PACKAGING_GROUP);
  const per100 = (l: CostLine) => (l.total === null ? null : l.total * 100);
  const bytes = (key: "rxBytesPerSecond" | "txBytesPerSecond"): number | null => {
    if (ingest.unavailable !== null || !idle) return null;
    const a = at("ingest").services.valkey?.[key] ?? null;
    const b = idle.services.valkey?.[key] ?? null;
    return a === null || b === null ? null : (a - b) / p.streams;
  };
  const moderationBelowNoise = MODERATION_GROUP.some((s) => ingest.belowNoise.includes(s));
  const packagingBelowNoise = PACKAGING_GROUP.some((s) => ingest.belowNoise.includes(s));
  // A profiled run carries the profiler's overhead, so no target is judged from it.
  const profiled = (opts.profiled ?? []).length > 0;
  const check = (metric: string, value: number | null, target: number, belowNoise: boolean): TargetCheck => ({
    metric,
    value,
    target,
    // A difference inside the idle cell's noise cannot be judged either way.
    met: value === null || belowNoise || profiled ? null : value <= target,
  });
  const notes = [...(opts.notes ?? [])];
  if (profiled)
    notes.push(
      `profiled run (${(opts.profiled ?? []).join(", ")}): costs include the CPU profiler's overhead, so no target is judged`,
    );

  const outcome: CostSummary["outcome"] = cells.some((c) => c.status === "failed")
    ? "failed"
    : cells.some((c) => c.status === "inconclusive")
      ? "inconclusive"
      : "measured";
  return {
    outcome,
    local: opts.local,
    cells: [...cells],
    costs: {
      ingestPerStream: ingest,
      ingest2xPerStream: ingest2x,
      linearity,
      moderationPerStream: {
        capture,
        classifier,
        total: moderation,
        totalAt2x: moderation2x,
        belowNoise: moderationBelowNoise,
      },
      packagingPerStream: packaging,
      viewersPerViewer: viewers,
      viewersManyPerViewer: viewersMany,
      // A partial viewer is not a viewer's edge cost: the raw line stays in viewersPerViewer.
      edgePer100Viewers: { onePath: partialViewers ? null : per100(viewers), manyPaths: per100(viewersMany) },
      ladder,
      valkeyBytesPerStream: { rx: bytes("rxBytesPerSecond"), tx: bytes("txBytesPerSecond") },
    },
    targets: [
      check(
        "packaging cores per stream (mediamtx + valkey)",
        packaging,
        COST_TARGETS.packagingCoresPerStream,
        packagingBelowNoise,
      ),
      check(
        "moderation cores per stream (media + worker, upper bound)",
        moderation,
        COST_TARGETS.moderationCoresPerStream,
        moderationBelowNoise,
      ),
      check(
        "caddy + origin cores per 100 viewers",
        per100(viewers),
        COST_TARGETS.edgeCoresPer100Viewers,
        viewers.totalBelowNoise || partialViewers,
      ),
    ],
    notes,
  };
}

/** One line per reason the run is inconclusive, for the scenario status. Pure. */
export function costInconclusiveReasons(s: Pick<CostSummary, "cells">): string[] {
  return s.cells.flatMap((c) => (c.status === "inconclusive" ? c.inconclusive.map((r) => `${c.name}: ${r}`) : []));
}
