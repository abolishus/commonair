// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Whether the host's kernel clock is NTP-synchronized (ADR 0012 decision 2: the media clock is
 * the ingest host's wall clock, so an unsynced host shifts every PDT). `adjtimex(2)` with
 * `modes = 0` only reads, needs no capability, and is allowed by the default container seccomp
 * profiles; it is what `timedatectl`'s NTPSynchronized reports (`TIME_ERROR` = `STA_UNSYNC`).
 * Called through Bun's built-in FFI on Linux; anywhere else, or if the call is refused, the
 * status is unknown (null) and nothing is reported.
 */

/** `adjtimex` clock states (linux/timex.h). */
const TIME_ERROR = 5;
/** `struct timex` is 208 bytes on 64-bit Linux; extra room costs nothing. */
const TIMEX_BYTES = 512;

type Adjtimex = (buf: Uint8Array) => number;

let adjtimex: Adjtimex | null | undefined;

async function load(): Promise<Adjtimex | null> {
  if (process.platform !== "linux") return null;
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    const lib = dlopen("libc.so.6", { adjtimex: { args: [FFIType.ptr], returns: FFIType.i32 } });
    return (buf) => lib.symbols.adjtimex(buf);
  } catch {
    return null;
  }
}

/** Interpret an `adjtimex` return value: null on error (-1), else synchronized unless TIME_ERROR. */
export function syncedFromState(state: number): boolean | null {
  if (state < 0) return null;
  return state !== TIME_ERROR;
}

/** Load the FFI binding once (null when unavailable). Call before `hostSynchronized`. */
export async function initHostClock(): Promise<void> {
  if (adjtimex === undefined) adjtimex = await load();
}

/** True/false from the kernel, or null when unknown (not Linux, no libc, call refused, not loaded). */
export function hostSynchronized(): boolean | null {
  if (!adjtimex) return null;
  try {
    // modes = 0 (the first field): read only.
    return syncedFromState(adjtimex(new Uint8Array(TIMEX_BYTES)));
  } catch {
    return null;
  }
}
