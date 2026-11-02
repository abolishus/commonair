// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Local sinks seed-platform runs for the life of the unit: a Discord stand-in (records POSTs to
 * `/api/webhooks/<id>/<token>` and answers 204) and a closed port for the subscription that must
 * fail its verification. Both bind on this machine; the stack reaches them through
 * `HARNESS_WEBHOOK_HOST`. Never a real Discord host.
 */
import type { Server } from "bun";

export interface DiscordSink {
  port: number;
  /** `http://<HARNESS_WEBHOOK_HOST>:<port>`: what the stored webhook URLs start with. */
  origin: string;
  readonly posts: readonly { path: string; body: string }[];
  close(): Promise<void>;
}

export function startDiscordSink(opts: { webhookHost: string }): DiscordSink {
  const posts: { path: string; body: string }[] = [];
  const server: Server<undefined> = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method !== "POST" || !path.startsWith("/api/webhooks/")) return new Response(null, { status: 404 });
      posts.push({ path, body: await req.text() });
      return new Response(null, { status: 204 });
    },
  });
  const port = server.port ?? 0;
  return {
    port,
    origin: `http://${opts.webhookHost}:${port}`,
    posts,
    async close() {
      await server.stop(true);
    },
  };
}

/** A port that was free a moment ago and has nothing listening (bound, then released). */
export async function closedPort(): Promise<number> {
  const server = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: () => new Response(null) });
  const port = server.port ?? 0;
  await server.stop(true);
  return port;
}
