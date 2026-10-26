// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Watching what the replicas ask Valkey, through `MONITOR`: which origin took the relay
 * issuance lock on each tick (services/origin/src/issuance.ts). The winner of `SET
 * issuance:lock <id> PX … NX` computes and then releases the lock with an `EVAL … issuance:lock
 * <id>`; losers only ever send the SET. So the distinct ids released in a tick are the replicas
 * that computed it, and the distinct client addresses sending the SET are the replicas competing.
 *
 * MONITOR costs Valkey some throughput while it runs; the scenario keeps one open for its
 * duration and only keeps the lines that mention the issuance lock.
 */
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

/**
 * The issuance tick a timestamp belongs to. Each origin ticks once a minute: first 10 s past the
 * minute, then on a `setInterval` that drifts (seen 26 s late on a long-running stack), so a 60 s
 * bucket holds one tick of every origin wherever its timer has got to; buckets are centred on :10.
 */
export const issuanceTick = (at: number) => Math.floor((at + 20_000) / 60_000);

export const ISSUANCE_LOCK_KEY = "issuance:lock";

export interface IssuanceTick {
  tick: number;
  /** Distinct client hosts that sent `SET issuance:lock … NX` (the replicas competing). */
  contenders: string[];
  /** Distinct lock ids released (the replicas that computed this tick). */
  leaders: string[];
}

const hostOf = (client: string) => client.replace(/:\d+$/, "");

/** Group the lock traffic by tick. Pure. */
export function issuanceTicks(entries: readonly MonitorEntry[], key = ISSUANCE_LOCK_KEY): IssuanceTick[] {
  const by = new Map<number, { contenders: Set<string>; leaders: Set<string> }>();
  const slot = (t: number) => {
    let s = by.get(t);
    if (!s) by.set(t, (s = { contenders: new Set(), leaders: new Set() }));
    return s;
  };
  for (const e of entries) {
    const cmd = e.args[0]?.toLowerCase();
    if (cmd === "set" && e.args[1] === key && e.args.some((a) => a.toUpperCase() === "NX")) {
      slot(issuanceTick(e.at)).contenders.add(hostOf(e.client));
    } else if ((cmd === "eval" || cmd === "evalsha") && e.client !== "lua") {
      // EVAL script numkeys key… arg…: the release passes the lock key, then the holder's id.
      const numKeys = Number(e.args[2]);
      const keys = e.args.slice(3, 3 + numKeys);
      if (!keys.includes(key)) continue;
      const id = e.args[3 + numKeys];
      if (id) slot(issuanceTick(e.at)).leaders.add(id);
    }
  }
  return [...by.entries()]
    .sort(([a], [b]) => a - b)
    .map(([tick, s]) => ({ tick, contenders: [...s.contenders].sort(), leaders: [...s.leaders].sort() }));
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
