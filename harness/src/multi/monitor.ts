// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Watching what the replicas ask Valkey, through `MONITOR`: which origin took the relay
 * issuance lock (services/origin/src/issuance.ts). The winner of `SET issuance:lock <id> PX … NX`
 * computes and then releases the lock with an `EVAL … issuance:lock <id>`; losers only ever send
 * the SET. So each release is one computation, its id the replica that made it, and the client
 * addresses sending the SET are the replicas competing.
 *
 * MONITOR costs Valkey some throughput while it runs; the scenario keeps one open for its
 * duration and only keeps the lines that mention the issuance lock.
 */
import { KEYS } from "@commonair/contracts/internal";
import { errorMessage } from "../redact.ts";

export interface MonitorEntry {
  /** Epoch ms. */
  at: number;
  /** `ip:port` of the client, or `lua` for commands a script issued. */
  client: string;
  args: string[];
}

const LINE = /^(\d+)\.(\d+) \[\d+ ([^\]]+)\] (.*)$/;
const ARG = /"((?:[^"\\]|\\.)*)"/g;

function unescape(s: string): string {
  return s.replace(/\\(["\\nrt])/g, (_, c: string) => (c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c));
}

/** One MONITOR line (`1700000000.123456 [0 10.89.42.5:51234] "set" "k" "v"`), or null. */
export function parseMonitorLine(line: string): MonitorEntry | null {
  const m = LINE.exec(line.replace(/^\+/, "").trim());
  if (!m) return null;
  const [, sec = "0", frac = "0", client = "", rest = ""] = m;
  const at = Number(sec) * 1000 + Math.floor(Number(`0.${frac}`) * 1000);
  const args = [...rest.matchAll(ARG)].map((a) => unescape(a[1] ?? ""));
  return args.length === 0 ? null : { at, client, args };
}

export const ISSUANCE_LOCK_KEY = KEYS.issuanceLock;

/** Each origin ticks once a minute (services/origin/src/origin.ts `setInterval`). */
export const ISSUANCE_INTERVAL_MS = 60_000;
/**
 * The sliding window in which two distinct leaders mean a double computation. Origin timers
 * drift independently, so two origins that both compute every minute release `d` and `60 − d`
 * seconds apart; one of those gaps is at most 30 s, inside any window over 30 s. A window under
 * the interval leaves room for jitter when leadership legitimately passes from one tick to the
 * next (the other origin won the race a minute later).
 */
export const DOUBLE_LEADER_WINDOW_MS = 45_000;

export interface IssuanceRelease {
  at: number;
  /** The releasing replica's lock id. */
  id: string;
}

export interface IssuanceReport {
  /** Every release of the lock, oldest first: one per computation. */
  releases: IssuanceRelease[];
  /** Distinct lock ids released (replicas that computed at least once). */
  leaders: string[];
  /** Distinct client hosts that sent `SET issuance:lock … NX` (replicas competing). Data only. */
  contenders: string[];
  /** The most distinct ids released inside any `windowMs` window (1 when one leader at a time). */
  maxLeadersInWindow: number;
  /** Each window (starting at a release) holding more than one leader. */
  doubled: { at: number; ids: string[] }[];
  /** Releases per minute observed (≈1 with one leader, ≈2 when both origins compute), or null. */
  releasesPerMinute: number | null;
}

const hostOf = (client: string) => client.replace(/:\d+$/, "");

/**
 * Leaders measured directly from the lock traffic, with no clock bucketing: the winner of `SET
 * issuance:lock <id> NX` computes and releases with `EVAL … issuance:lock <id>`, so each release
 * is one computation. `observedMs` is how long the traffic was watched. Pure.
 */
export function issuanceReport(
  entries: readonly MonitorEntry[],
  opts: { observedMs: number; windowMs?: number; key?: string },
): IssuanceReport {
  const key = opts.key ?? ISSUANCE_LOCK_KEY;
  const windowMs = opts.windowMs ?? DOUBLE_LEADER_WINDOW_MS;
  const contenders = new Set<string>();
  const releases: IssuanceRelease[] = [];
  for (const e of entries) {
    const cmd = e.args[0]?.toLowerCase();
    if (cmd === "set" && e.args[1] === key && e.args.some((a) => a.toUpperCase() === "NX")) {
      contenders.add(hostOf(e.client));
    } else if ((cmd === "eval" || cmd === "evalsha") && e.client !== "lua") {
      // EVAL script numkeys key… arg…: the release passes the lock key, then the holder's id.
      const numKeys = Number(e.args[2]);
      const keys = e.args.slice(3, 3 + numKeys);
      if (!keys.includes(key)) continue;
      const id = e.args[3 + numKeys];
      if (id) releases.push({ at: e.at, id });
    }
  }
  releases.sort((a, b) => a.at - b.at);
  const doubled: { at: number; ids: string[] }[] = [];
  let maxLeadersInWindow = 0;
  for (let i = 0; i < releases.length; i++) {
    const first = releases[i] as IssuanceRelease;
    const ids = new Set<string>();
    for (let j = i; j < releases.length && (releases[j] as IssuanceRelease).at - first.at < windowMs; j++)
      ids.add((releases[j] as IssuanceRelease).id);
    maxLeadersInWindow = Math.max(maxLeadersInWindow, ids.size);
    if (ids.size > 1) doubled.push({ at: first.at, ids: [...ids].sort() });
  }
  return {
    releases,
    leaders: [...new Set(releases.map((r) => r.id))].sort(),
    contenders: [...contenders].sort(),
    maxLeadersInWindow,
    doubled,
    releasesPerMinute: opts.observedMs > 0 ? (releases.length * 60_000) / opts.observedMs : null,
  };
}

// ---------------------------------------------------------------- client

export interface MonitorHandle {
  readonly entries: MonitorEntry[];
  /** Set when the connection failed or Valkey refused MONITOR. */
  readonly error: string | null;
  stop(): void;
}

function resp(...args: string[]): string {
  return `*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join("")}`;
}

/**
 * Open a MONITOR connection and keep the parsed entries whose raw line contains one of
 * `needles`. Resolves once Valkey has acknowledged MONITOR.
 */
export async function startMonitor(url: string, needles: readonly string[], timeoutMs = 5_000): Promise<MonitorHandle> {
  const u = new URL(url);
  const entries: MonitorEntry[] = [];
  let error: string | null = null;
  let buffer = "";
  // Streaming decode: a chunk boundary may split a multi-byte character.
  const decoder = new TextDecoder();
  let acks = 0;
  const needAcks = u.password ? 2 : 1;
  let ready: () => void = () => undefined;
  let fail: (e: Error) => void = () => undefined;
  const readyP = new Promise<void>((resolve, reject) => {
    ready = resolve;
    fail = reject;
  });
  const socket = await Bun.connect({
    hostname: u.hostname,
    port: Number(u.port || 6379),
    socket: {
      data(_s, chunk) {
        buffer += decoder.decode(chunk, { stream: true });
        let start = 0;
        for (let nl = buffer.indexOf("\r\n"); nl !== -1; nl = buffer.indexOf("\r\n", start)) {
          const line = buffer.slice(start, nl);
          start = nl + 2;
          if (line.startsWith("-")) {
            error = line.slice(1);
            fail(new Error(`valkey refused MONITOR: ${error}`));
            continue;
          }
          if (acks < needAcks) {
            if (line === "+OK") acks++;
            if (acks === needAcks) ready();
            continue;
          }
          if (!needles.some((n) => line.includes(n))) continue;
          const e = parseMonitorLine(line);
          if (e) entries.push(e);
        }
        buffer = buffer.slice(start);
      },
      close() {
        error ??= "connection closed";
      },
      error(_s, err) {
        error = errorMessage(err);
        fail(err);
      },
    },
  });
  const user = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  if (password) socket.write(user ? resp("AUTH", user, password) : resp("AUTH", password));
  socket.write(resp("MONITOR"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      readyP,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("valkey MONITOR not acknowledged")), timeoutMs);
      }),
    ]);
  } catch (err) {
    socket.end();
    throw err;
  } finally {
    clearTimeout(timer);
  }
  return {
    entries,
    get error() {
      return error;
    },
    stop: () => socket.end(),
  };
}
