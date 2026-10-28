// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pool warm-up. The pool opens connections lazily, so the first join after start-up (a handful
 * of parallel reads) connects several sockets at once, each with a name lookup. Opening them at
 * start-up, and retrying until all succeed, takes that off the first users' path: a lookup that
 * stalls (in-network DNS while containers join the network) then delays readiness, not a client.
 */
import { sql } from "drizzle-orm";
import type { Database } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import { errorFields } from "./errors.ts";

export interface PoolWarmer {
  /** True once `connections` statements have run side by side. */
  readonly warm: boolean;
  /** Resolves when warm, or when stopped. */
  readonly done: Promise<void>;
  stop(): void;
}

export function warmPool(
  db: Database,
  connections: number,
  logger: Logger,
  { retryMs = 1_000 }: { retryMs?: number } = {},
): PoolWarmer {
  let warm = connections <= 0;
  let stopped = false;
  let wake: (() => void) | null = null;
  const run = async () => {
    for (let attempt = 1; !warm && !stopped; attempt++) {
      // Concurrent statements each take an idle connection or open a new one.
      const results = await Promise.allSettled(Array.from({ length: connections }, () => db.execute(sql`select 1`)));
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed.length === 0) {
        warm = true;
        logger.info("postgres pool warm", { connections, attempts: attempt });
        return;
      }
      logger.warn("postgres pool warm-up failed", {
        ...errorFields(failed[0]?.reason),
        failed: failed.length,
        attempt,
      });
      await new Promise<void>((r) => {
        wake = r;
        setTimeout(r, retryMs).unref();
      });
    }
  };
  const done = run();
  return {
    get warm() {
      return warm;
    },
    done,
    stop() {
      stopped = true;
      wake?.();
    },
  };
}
