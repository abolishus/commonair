// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * systemd socket activation (sd_listen_fds(3)): the listening sockets for 6667 and 6697 are
 * held by `commonair-irc.socket` and `commonair-ircs.socket` in the host's network
 * namespace, so the gateway sees each client's own address instead of rootlessport's one.
 */
import { fstatSync } from "node:fs";

/** The first passed descriptor (SD_LISTEN_FDS_START). */
export const LISTEN_FDS_START = 3;
/** `FileDescriptorName=` of the plain and the TLS socket unit. */
export const FD_NAMES = { tcp: "irc", tls: "ircs" } as const;

export type Activation =
  /** Not socket-activated (or the variables were meant for another process): bind the ports. */
  | { kind: "none"; ignored?: string }
  /** `fdNames`: LISTEN_FDNAMES as received, or null when absent (the fd-order fallback). */
  | { kind: "fds"; tcp: number; tls: number; fdNames: string | null }
  /** Socket-activated, but the descriptors cannot be used: the gateway must not start. */
  | { kind: "error"; reason: string };

const VARS = ["LISTEN_PID", "LISTEN_FDS", "LISTEN_FDNAMES"] as const;
const isCount = (s: string) => /^\d{1,4}$/.test(s);

/**
 * Reads LISTEN_PID, LISTEN_FDS and LISTEN_FDNAMES and unsets them, as `sd_listen_fds(1)` does,
 * so a child process never mistakes them for its own.
 *
 * Under Podman the variables are rewritten for the container, with LISTEN_PID=1. The IRC unit
 * runs catatonit as pid 1 (`RunInit=true`) and the entrypoint execs Bun as its child, so the
 * gateway is not pid 1: LISTEN_PID=1 is therefore accepted when the parent is pid 1 (the
 * container init that received the descriptors and passed them down).
 */
export function systemdListeners(env: Record<string, string | undefined>, pid: number, ppid?: number): Activation {
  const listenPid = env.LISTEN_PID;
  const listenFds = env.LISTEN_FDS;
  const names = env.LISTEN_FDNAMES;
  for (const v of VARS) delete env[v];

  if (listenFds === undefined) return { kind: "none" };
  if (!isCount(listenFds)) return { kind: "error", reason: `LISTEN_FDS is not a count: ${JSON.stringify(listenFds)}` };
  if (listenPid === undefined) return { kind: "error", reason: "LISTEN_FDS is set without LISTEN_PID" };
  if (!/^\d+$/.test(listenPid))
    return { kind: "error", reason: `LISTEN_PID is not a process id: ${JSON.stringify(listenPid)}` };
  const forUs = Number(listenPid) === pid || (listenPid === "1" && ppid === 1);
  if (!forUs) return { kind: "none", ignored: `LISTEN_PID=${listenPid} is not this process (${pid})` };
  const count = Number(listenFds);
  if (count === 0) return { kind: "none", ignored: "LISTEN_FDS=0" };

  const fds = Array.from({ length: count }, (_, i) => LISTEN_FDS_START + i);
  if (names === undefined || names === "") {
    // No names: the order of the ListenStream= lines, plain first.
    if (count !== 2) return { kind: "error", reason: `expected 2 unnamed sockets (6667, 6697), got ${count}` };
    return { kind: "fds", tcp: fds[0] ?? 0, tls: fds[1] ?? 0, fdNames: null };
  }
  const list = names.split(":");
  if (list.length !== count)
    return { kind: "error", reason: `LISTEN_FDNAMES has ${list.length} names for ${count} sockets` };
  const unknown = list.filter((n) => n !== FD_NAMES.tcp && n !== FD_NAMES.tls);
  if (unknown.length > 0) return { kind: "error", reason: `unknown socket names: ${unknown.join(", ")}` };
  const at = (name: string) => {
    const i = list.indexOf(name);
    return i === -1 || list.lastIndexOf(name) !== i ? null : (fds[i] ?? null);
  };
  const tcp = at(FD_NAMES.tcp);
  const tls = at(FD_NAMES.tls);
  if (tcp === null || tls === null)
    return {
      kind: "error",
      reason: `expected exactly one socket named ${FD_NAMES.tcp} and one named ${FD_NAMES.tls}, got ${list.join(", ")}`,
    };
  return { kind: "fds", tcp, tls, fdNames: names };
}

/** How the descriptors were found, for the startup log: the names received, or the fallback. */
export function describeFdNames(fdNames: string | null | undefined): string {
  return fdNames ? fdNames : "unnamed, fd-order fallback";
}

/** Null when `fd` is an open socket, else why it cannot be listened on. */
export function socketProblem(fd: number): string | null {
  try {
    return fstatSync(fd).isSocket() ? null : `fd ${fd} is not a socket`;
  } catch (e) {
    return `fd ${fd} is not open (${(e as NodeJS.ErrnoException).code ?? "error"})`;
  }
}
