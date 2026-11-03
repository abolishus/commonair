// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Test-only `bun --preload` for a child running src/main.ts (see main-child.ts). The env schema
 * rejects port 0, and probing a free port then handing it to the child races other suites for it
 * (a parallel child took the port and this test read the other one's /healthz). So the child's
 * Bun.serve binds port 0 itself, and keeps it: it writes `{ pid, port }` to TEST_LISTEN_REPORT
 * and stamps every response with TEST_INSTANCE, so the test knows it is talking to its own child.
 */
import { renameSync, writeFileSync } from "node:fs";

const report = process.env.TEST_LISTEN_REPORT;
const instance = process.env.TEST_INSTANCE;
if (!report || !instance) throw new Error("listen-preload needs TEST_LISTEN_REPORT and TEST_INSTANCE");

const serve = Bun.serve.bind(Bun);
Bun.serve = ((options: Parameters<typeof Bun.serve>[0]) => {
  const inner = options.fetch as (this: unknown, ...args: unknown[]) => Response | Promise<Response> | undefined;
  const server = serve({
    ...options,
    port: 0,
    async fetch(this: unknown, ...args: unknown[]) {
      const res = await inner.apply(this, args);
      // A WebSocket upgrade returns nothing; there is no response to stamp.
      if (!res) return res;
      const stamped = new Response(res.body, res);
      stamped.headers.set("x-test-instance", instance);
      return stamped;
    },
  } as Parameters<typeof Bun.serve>[0]);
  // Rename into place, so the test never reads a half-written file.
  writeFileSync(`${report}.tmp`, JSON.stringify({ pid: process.pid, port: server.port }));
  renameSync(`${report}.tmp`, report);
  return server;
}) as typeof Bun.serve;
