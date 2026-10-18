// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Container health probe (the slim Bun image has no curl/wget). Exits 0 when the
 * service's health endpoint answers 2xx within the timeout.
 *
 *   bun /opt/commonair/healthcheck.ts [service]     (default: $SERVICE)
 *   HEALTHCHECK_PATH  default /readyz (dependencies included), /healthz for liveness only
 */

/** Health port env var and default per service, from `servicePorts` in @commonair/config. */
export const HEALTH_PORTS: Record<string, { env: string; port: number }> = {
  web: { env: "WEB_PORT", port: 3000 },
  api: { env: "API_PORT", port: 3001 },
  chat: { env: "CHAT_PORT", port: 3002 },
  origin: { env: "ORIGIN_PORT", port: 3003 },
  media: { env: "MEDIA_PORT", port: 3004 },
  worker: { env: "WORKER_PORT", port: 3005 },
  irc: { env: "IRC_HEALTH_PORT", port: 6681 },
  tracker: { env: "TRACKER_PORT", port: 8000 },
};

export function healthUrl(service: string, env: Record<string, string | undefined>): string {
  const entry = HEALTH_PORTS[service];
  if (!entry) throw new Error(`no health port known for service ${service}`);
  const port = Number(env[entry.env] || entry.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${entry.env} is not a port`);
  const path = env.HEALTHCHECK_PATH || "/readyz";
  if (!path.startsWith("/")) throw new Error("HEALTHCHECK_PATH must start with /");
  return `http://127.0.0.1:${port}${path}`;
}

export async function probe(url: string, timeoutMs: number, doFetch: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

if (import.meta.main) {
  const service = process.argv[2] ?? process.env.SERVICE ?? "";
  try {
    process.exit((await probe(healthUrl(service, process.env), 2500)) ? 0 : 1);
  } catch (e) {
    console.error(`healthcheck: ${(e as Error).message}`);
    process.exit(1);
  }
}
