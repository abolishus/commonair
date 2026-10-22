// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `--set` parameters of the load scenarios (`load-smoke`, `load-plan`): `streamers`,
 * `viewersPerStreamer` (or the total `viewers`), `seconds`, `browserViewers` and
 * `httpPerProcess` (HTTP viewers per harness process before the run shards). Pure.
 */
import { DEFAULT_HTTP_PER_PROCESS } from "./shard.ts";

export const LOAD_PARAM_KEYS = [
  "streamers",
  "viewersPerStreamer",
  "viewers",
  "seconds",
  "browserViewers",
  "httpPerProcess",
] as const;

export interface LoadParams {
  streamers: number;
  /** Total viewers (streamers × viewersPerStreamer unless `viewers` was given). */
  viewers: number;
  seconds: number;
  browserViewers: number;
  httpPerProcess: number;
}

export interface LoadDefaults {
  streamers: number;
  viewersPerStreamer: number;
  seconds: number;
  browserViewers: number;
  httpPerProcess?: number;
}

/** PLAN size (ADR 0021): 20 streamers × 200 viewers for 2 minutes, 20 of them real browsers. */
export const LOAD_PLAN_DEFAULTS: LoadDefaults = {
  streamers: 20,
  viewersPerStreamer: 200,
  seconds: 120,
  browserViewers: 20,
};

/** `full`'s small run: 2 streamers × 5 viewers (10 in all) for 30 s, 2 of them browsers. */
export const LOAD_SMOKE_DEFAULTS: LoadDefaults = {
  streamers: 2,
  viewersPerStreamer: 5,
  seconds: 30,
  browserViewers: 2,
};

export class LoadParamError extends Error {
  override name = "LoadParamError";
}

function int(params: Readonly<Record<string, string>>, key: string, fallback: number, min: number): number {
  const raw = params[key];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(n) || n < min) {
    throw new LoadParamError(`--set ${key}=${raw}: expected an integer ≥ ${min}`);
  }
  return n;
}

export function parseLoadParams(params: Readonly<Record<string, string>>, defaults: LoadDefaults): LoadParams {
  if (params.viewers !== undefined && params.viewersPerStreamer !== undefined) {
    throw new LoadParamError("--set viewers and --set viewersPerStreamer are exclusive (viewers is the total)");
  }
  const streamers = int(params, "streamers", defaults.streamers, 1);
  const perStreamer = int(params, "viewersPerStreamer", defaults.viewersPerStreamer, 0);
  const viewers = int(params, "viewers", streamers * perStreamer, 0);
  const browserViewers = int(params, "browserViewers", defaults.browserViewers, 0);
  if (browserViewers > viewers) {
    throw new LoadParamError(`--set browserViewers=${browserViewers} exceeds the ${viewers} viewers`);
  }
  return {
    streamers,
    viewers,
    seconds: int(params, "seconds", defaults.seconds, 1),
    browserViewers,
    httpPerProcess: int(params, "httpPerProcess", defaults.httpPerProcess ?? DEFAULT_HTTP_PER_PROCESS, 1),
  };
}
