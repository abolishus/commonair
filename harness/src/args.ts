// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** CLI argument parsing (pure, unit-tested). */
import { parseDuration } from "./metrics.ts";
import { PROFILES, type Profile } from "./scenario.ts";
import { SEED_SCALE_NAMES, type SeedScaleName, isSeedScaleName } from "./seed/scale.ts";

export interface CommonFlags {
  profile: Profile;
  report?: string;
  player?: "harness" | "web";
  params: Record<string, string>;
}

export type Command =
  | ({ kind: "run"; scenarios: string[]; skipUnavailable: boolean } & CommonFlags)
  | { kind: "list"; json: boolean }
  | ({
      kind: "load";
      streamers: number;
      viewers: number;
      durationMs: number;
      browserViewers?: number;
      protocol: "rtmp" | "whip";
    } & CommonFlags)
  | { kind: "seed-full"; scale: SeedScaleName; seed: number; confirm?: string }
  | { kind: "seed-live"; channels: number; durationMs?: number }
  | { kind: "help" };

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export const USAGE = `Usage:
  bun harness/src/cli.ts run <scenario...> [--profile no-proprietary] [--report <path>]
                                           [--set key=value]... [--player harness|web] [--skip-unavailable]
  bun harness/src/cli.ts list [--json]
  bun harness/src/cli.ts seed full --confirm <host:port/db> [--scale small|medium|large] [--seed <n>]
  bun harness/src/cli.ts seed live [--channels <K>] [--duration <30m>]
  bun harness/src/cli.ts load --streamers <N> --viewers <M> --duration <120s>
                              [--browser-viewers <K>] [--protocol rtmp|whip] [--report <path>]

  run       run scenarios against the running stack ("full" runs every scenario)
  list      list available scenarios
  seed full fill a fresh local or staging database with demo data for every feature
            (needs DEMO_SEED_FULL=true and a database with no users; remove it by resetting)
  seed live keep K seeded channels streaming with chat until stopped (or for --duration)
  load      N streamers x M viewers for a duration; reports origin egress, CPU,
            p95 glass-to-glass latency and TTFF, and stall rate

Options:
  --profile <name>        default | no-proprietary (skip Stripe/OAuth/CDN, use FOSS adapters)
  --no-proprietary        same as --profile no-proprietary
  --report <path>         write the JSON report here (default harness/reports/<time>-<cmd>-<run>.json)
  --set key=value         scenario parameter (e.g. --set viewers=20)
  --player harness|web    browser viewers open the harness player page or the web app embed route
  --skip-unavailable      skip (instead of fail) scenarios whose needs are not reachable
`;

function positiveInt(flag: string, value: string | undefined): number {
  const n = Number(value);
  if (!value || !Number.isInteger(n) || n < 0) throw new UsageError(`${flag} needs a non-negative integer`);
  return n;
}

export function parseArgs(argv: readonly string[]): Command {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") return { kind: "help" };
  const positional: string[] = [];
  const flags = new Map<string, string>();
  const params: Record<string, string> = {};
  const booleans = new Set(["--json", "--skip-unavailable", "--no-proprietary"]);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (booleans.has(name)) {
      flags.set(name, "true");
      continue;
    }
    const value = eq > 0 ? arg.slice(eq + 1) : rest[++i];
    if (value === undefined) throw new UsageError(`${name} needs a value`);
    if (name === "--set") {
      const kv = value.indexOf("=");
      if (kv <= 0) throw new UsageError("--set needs key=value");
      params[value.slice(0, kv)] = value.slice(kv + 1);
    } else {
      flags.set(name, value);
    }
  }

  const profileFlag = flags.get("--no-proprietary") ? "no-proprietary" : (flags.get("--profile") ?? "default");
  if (!(PROFILES as readonly string[]).includes(profileFlag)) {
    throw new UsageError(`--profile must be one of ${PROFILES.join(", ")}`);
  }
  const player = flags.get("--player");
  if (player !== undefined && player !== "harness" && player !== "web")
    throw new UsageError("--player must be harness or web");
  const common: CommonFlags = {
    profile: profileFlag as Profile,
    report: flags.get("--report"),
    player,
    params,
  };
  const known = (allowed: string[]) => {
    for (const f of flags.keys()) if (!allowed.includes(f)) throw new UsageError(`unknown option ${f} for ${command}`);
  };

  switch (command) {
    case "run":
      known(["--profile", "--no-proprietary", "--report", "--player", "--skip-unavailable"]);
      if (positional.length === 0) throw new UsageError("run needs at least one scenario name");
      return { kind: "run", scenarios: positional, skipUnavailable: flags.has("--skip-unavailable"), ...common };
    case "list":
      known(["--json"]);
      return { kind: "list", json: flags.has("--json") };
    case "load": {
      known([
        "--profile",
        "--no-proprietary",
        "--report",
        "--player",
        "--streamers",
        "--viewers",
        "--duration",
        "--browser-viewers",
        "--protocol",
      ]);
      if (positional.length > 0) throw new UsageError(`unexpected argument ${positional[0]}`);
      const streamers = positiveInt("--streamers", flags.get("--streamers") ?? "1");
      if (streamers < 1) throw new UsageError("--streamers must be at least 1");
      const protocol = flags.get("--protocol") ?? "rtmp";
      if (protocol !== "rtmp" && protocol !== "whip") throw new UsageError("--protocol must be rtmp or whip");
      let durationMs: number;
      try {
        durationMs = parseDuration(flags.get("--duration") ?? "120s");
      } catch (err) {
        throw new UsageError((err as Error).message);
      }
      const bv = flags.get("--browser-viewers");
      return {
        kind: "load",
        streamers,
        viewers: positiveInt("--viewers", flags.get("--viewers") ?? "10"),
        durationMs,
        browserViewers: bv === undefined ? undefined : positiveInt("--browser-viewers", bv),
        protocol,
        ...common,
      };
    }
    case "seed": {
      const [sub, ...extra] = positional;
      if (extra.length > 0) throw new UsageError(`unexpected argument ${extra[0]}`);
      if (Object.keys(params).length > 0) throw new UsageError("--set is not an option for seed");
      if (sub === "full") {
        known(["--scale", "--seed", "--confirm"]);
        const scale = flags.get("--scale") ?? "small";
        if (!isSeedScaleName(scale)) throw new UsageError(`--scale must be one of ${SEED_SCALE_NAMES.join(", ")}`);
        const confirm = flags.get("--confirm");
        return {
          kind: "seed-full",
          scale,
          seed: positiveInt("--seed", flags.get("--seed") ?? "1"),
          ...(confirm ? { confirm } : {}),
        };
      }
      if (sub === "live") {
        known(["--channels", "--duration"]);
        const channels = positiveInt("--channels", flags.get("--channels") ?? "3");
        if (channels < 1) throw new UsageError("--channels must be at least 1");
        const d = flags.get("--duration");
        let durationMs: number | undefined;
        if (d !== undefined) {
          try {
            durationMs = parseDuration(d);
          } catch (err) {
            throw new UsageError((err as Error).message);
          }
        }
        return { kind: "seed-live", channels, ...(durationMs === undefined ? {} : { durationMs }) };
      }
      throw new UsageError("seed needs full or live");
    }
    default:
      throw new UsageError(`unknown command "${command}"`);
  }
}
