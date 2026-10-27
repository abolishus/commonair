// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { desc, gt, isNull, or, sql } from "drizzle-orm";
import { sourceLink } from "@commonair/config/site";
import { schema } from "@commonair/db";
import type { Deps, StatusProbe } from "../deps.ts";
import { iso, isoOrNull } from "../lib/dto.ts";
import { os } from "../lib/orpc.ts";

type ComponentStatus = "operational" | "degraded" | "outage";
const SLOW_MS = 1000;
const PROBE_TIMEOUT_MS = 2500;
const CACHE_MS = 10_000;
const COMPONENT_NAMES: Record<string, string> = {
  postgres: "Database",
  valkey: "Cache and messaging",
  mediamtx: "Ingest",
  chat: "Chat",
  origin: "Video delivery",
};

async function probe(name: string, fn: StatusProbe, now: () => Date) {
  const started = performance.now();
  let status: ComponentStatus = "operational";
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), PROBE_TIMEOUT_MS)),
    ]);
    if (performance.now() - started > SLOW_MS) status = "degraded";
  } catch {
    status = "outage";
  }
  return {
    id: name,
    name: COMPONENT_NAMES[name] ?? name,
    status,
    latencyMs: status === "outage" ? null : Math.round(performance.now() - started),
    checkedAt: iso(now()),
  };
}

const RANK: Record<ComponentStatus, number> = { operational: 0, degraded: 1, outage: 2 };
export const worst = (s: ComponentStatus[]): ComponentStatus =>
  s.reduce<ComponentStatus>((a, b) => (RANK[b] > RANK[a] ? b : a), "operational");

const cache = new WeakMap<Deps, { at: number; value: Awaited<ReturnType<typeof computeStatus>> }>();

/**
 * Drop this process's cached status, so an incident write shows at once. Other API replicas keep
 * theirs until it expires (CACHE_MS).
 */
export function invalidateStatus(deps: Deps): void {
  cache.delete(deps);
}

async function computeStatus(deps: Deps) {
  const probes: Record<string, StatusProbe> = {
    postgres: async () => {
      await deps.db.execute(sql`select 1`);
    },
    valkey: async () => {
      await deps.valkey.ping();
    },
    ...deps.probes,
  };
  const components = await Promise.all(Object.entries(probes).map(([n, fn]) => probe(n, fn, deps.now)));
  const recent = new Date(deps.now().getTime() - 7 * 86_400_000);
  const incidents = await deps.db
    .select()
    .from(schema.incidents)
    .where(or(isNull(schema.incidents.resolvedAt), gt(schema.incidents.resolvedAt, recent)))
    .orderBy(desc(schema.incidents.startedAt))
    .limit(20);
  // An open incident marks its components degraded even when probes pass.
  for (const i of incidents)
    if (!i.resolvedAt)
      for (const c of components) if (i.components.includes(c.id) && c.status === "operational") c.status = "degraded";
  return {
    status: worst(components.map((c) => c.status)),
    components,
    incidents: incidents.map((i) => ({
      id: i.id,
      title: i.title,
      status: i.status,
      components: i.components,
      body: i.body,
      startedAt: iso(i.startedAt),
      resolvedAt: isoOrNull(i.resolvedAt),
    })),
  };
}

export const instance = {
  info: os.instance.info.handler(({ context: { deps } }) => {
    const { env, site } = deps;
    const oauthProviders = (
      [
        ["discord", env.OAUTH_DISCORD_CLIENT_ID, env.OAUTH_DISCORD_CLIENT_SECRET],
        ["twitch", env.OAUTH_TWITCH_CLIENT_ID, env.OAUTH_TWITCH_CLIENT_SECRET],
        ["github", env.OAUTH_GITHUB_CLIENT_ID, env.OAUTH_GITHUB_CLIENT_SECRET],
      ] as const
    )
      .filter(([, id, secret]) => id && secret)
      .map(([name]) => name);
    return {
      name: site.name,
      publicUrl: site.publicUrl,
      sourceUrl: sourceLink(site),
      sourceCommit: site.sourceCommit,
      version: deps.version,
      isFlagship: site.isFlagship,
      contacts: { ...site.contacts },
      features: {
        payments: env.PAYMENTS_PROVIDER,
        oauthProviders,
        p2p: env.P2P_ENABLED,
        p2pDefault: env.P2P_DEFAULT,
        cdn: env.CDN_PROVIDER !== "none" && Boolean(env.CDN_BASE_URL),
        vod: true,
      },
      minAge: env.AUTH_MIN_AGE,
    };
  }),
  // Cached briefly so a public endpoint cannot be used to amplify probes against internal services.
  status: os.instance.status.handler(async ({ context: { deps } }) => {
    const nowMs = deps.now().getTime();
    const hit = cache.get(deps);
    if (hit && nowMs - hit.at <= CACHE_MS) return hit.value;
    const value = await computeStatus(deps);
    cache.set(deps, { at: nowMs, value });
    return value;
  }),
};
