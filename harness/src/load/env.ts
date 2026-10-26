// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The load test's remote-run variables. They belong in `harness/src/env.ts` (contract request
 * S1-a); until they are there, this parser reads them with the same names and meanings, so the
 * move is a cut and paste. Every one is optional: unset, the load test runs exactly as before
 * (local `podman stats`, local child processes, sign-ups without pacing).
 */
import { z } from "zod";

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v?.trim() ? v.trim() : undefined));

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

const optionalPositive = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (!v?.trim()) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) {
      ctx.addIssue({ code: "custom", message: `expected a positive number, got ${v}` });
      return z.NEVER;
    }
    return n;
  });

export const loadEnvSchema = z.object({
  /**
   * SSH destination of the instance under test (`commonair@10.110.0.5`), the user that owns the
   * rootless containers. Set = sample `podman stats` and `/proc` there; unset = local podman.
   */
  HARNESS_LOAD_TARGET_SSH: optionalString,
  /** The target's NIC ceiling in Mbit/s (measured with iperf3); unset = no target-NIC stop rule. */
  HARNESS_LOAD_TARGET_NIC_MBPS: optionalPositive,
  /** This generator's NIC ceiling in Mbit/s (measured); unset = no generator-NIC judgment. */
  HARNESS_LOAD_GENERATOR_NIC_MBPS: optionalPositive,
  /**
   * Where HTTP viewer shards run: comma-separated SSH destinations, `local` for a child process
   * here. Shards are dealt round-robin. Unset = every shard is a local child process.
   */
  HARNESS_LOAD_GENERATOR_HOSTS: csv,
  /** The repository checkout on the generator hosts (default: this checkout's path). */
  HARNESS_LOAD_GENERATOR_REPO: optionalString,
  /**
   * Pace auth writes (sign-up, sign-in) to this many per minute from this machine, to stay under
   * the instance's per-address `auth` limit (10 a minute). Unset = no pacing (the local stack
   * gives each simulated user its own address).
   */
  HARNESS_LOAD_AUTH_PER_MINUTE: optionalPositive,
  /**
   * JSON file of streamer accounts to reuse across runs on one instance (created with mode 0600).
   * Unset = fresh accounts every run.
   */
  HARNESS_LOAD_ACCOUNTS_FILE: optionalString,
});

export type LoadEnv = z.output<typeof loadEnvSchema>;

export function loadLoadEnv(source: Record<string, string | undefined> = process.env): LoadEnv {
  return loadEnvSchema.parse(source);
}

/** Mbit/s → bytes/s. */
export const mbpsToBytesPerSecond = (mbps: number | undefined): number | null =>
  mbps === undefined ? null : (mbps * 1_000_000) / 8;
