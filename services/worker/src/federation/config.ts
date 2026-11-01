// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the federation jobs read from the environment (ADR 0030), once per process through
 * `loadEnv`, plus the per-call parts of the worker context. Tests build their own.
 *
 * - `FEDERATION_ENABLED` gates every job: with it off nothing is fetched or sent.
 * - `OUTBOUND_ALLOW_PRIVATE_NETWORKS` (harness only) lets key fetches and deliveries reach http and
 *   private addresses; otherwise `resolveCallback` allows https to public addresses only.
 * - `MEDIA_PUBLIC_URL` builds thumbnail and avatar URLs; `PUBLIC_URL` and `API_PUBLIC_URL` are the
 *   hosts a signed inbox request may have been addressed to.
 */
import { ALL_ENV_SCHEMAS, developerEnv, federationEnv, loadEnv, storageEnv } from "@commonair/config";
import type { InstanceSite } from "@commonair/config/site";
import { z } from "zod";
import type { WorkerContext } from "../context.ts";
import { DEFAULT_BACKOFF_MS } from "../webhooks/backoff.ts";
import type { Resolver } from "../webhooks/ssrf.ts";

/** `encryptSecret` purpose of `federation_actors.private_key_enc` (shared with the API's key writer). */
export const FEDERATION_KEY_PURPOSE = "federation-actor-key";
/** User agent of every federation request. */
export const FEDERATION_USER_AGENT = "CommonAir-Federation/1";

export interface FederationConfig {
  /** `FEDERATION_ENABLED`. */
  enabled: boolean;
  /** `OUTBOUND_ALLOW_PRIVATE_NETWORKS`: http and private addresses (harness only). */
  allowInsecure: boolean;
  /** AUTH_SECRET, to decrypt actor keys at use. */
  authSecret: string;
  site: Pick<InstanceSite, "publicUrl" | "defaultLocale">;
  /** `MEDIA_PUBLIC_URL` with a trailing slash. */
  mediaBase: string;
  /** Hosts (`host[:port]`, lower-case) a remote may have signed an inbox request for. */
  inboxHosts: ReadonlySet<string>;
  timeoutMs: number;
  /** Response bytes read from a remote (actor and key documents, delivery answers). */
  maxResponseBytes: number;
  /** Delays before retry n (index n-1): the webhook schedule. */
  backoffMs: readonly number[];
  maxAttempts: number;
  resolve?: Resolver;
  /** Extra trusted CA (PEM); tests only. */
  ca?: string;
}

const EnvSlice = z.object({
  ...federationEnv.shape,
  ...developerEnv.pick({ OUTBOUND_ALLOW_PRIVATE_NETWORKS: true }).shape,
  ...storageEnv.pick({ MEDIA_PUBLIC_URL: true }).shape,
  // The unrefined core shape (`coreEnv` carries a refine, which `pick` refuses).
  ...ALL_ENV_SCHEMAS.coreEnv.pick({ PUBLIC_URL: true, API_PUBLIC_URL: true, INSTANCE_DEFAULT_LOCALE: true }).shape,
});
type EnvSlice = z.output<typeof EnvSlice>;

let cached: EnvSlice | undefined;
/** The env slice, read once; tests pass a source to read their own. */
export function federationEnvSlice(source?: Record<string, string | undefined>): EnvSlice {
  if (source) return loadEnv(EnvSlice, source);
  cached ??= loadEnv(EnvSlice, process.env);
  return cached;
}

export const hostOf = (url: string): string => new URL(url).host.toLowerCase();

/** The config for a job run: the env slice plus the context's secret, site and resolver. */
export function federationConfig(
  ctx: Pick<WorkerContext, "webhooks" | "site">,
  env: EnvSlice = federationEnvSlice(),
): FederationConfig {
  // `main.ts` always sets `site`; the fallback is the same derivation as `instanceSite`.
  const site = ctx.site ?? {
    publicUrl: env.PUBLIC_URL.replace(/\/+$/, ""),
    defaultLocale: env.INSTANCE_DEFAULT_LOCALE,
  };
  return {
    enabled: env.FEDERATION_ENABLED,
    allowInsecure: env.OUTBOUND_ALLOW_PRIVATE_NETWORKS,
    authSecret: ctx.webhooks.authSecret,
    site: { publicUrl: site.publicUrl, defaultLocale: site.defaultLocale },
    mediaBase: `${env.MEDIA_PUBLIC_URL.replace(/\/+$/, "")}/`,
    inboxHosts: new Set([hostOf(site.publicUrl), hostOf(env.PUBLIC_URL), hostOf(env.API_PUBLIC_URL)]),
    timeoutMs: 10_000,
    maxResponseBytes: 256 * 1024,
    backoffMs: DEFAULT_BACKOFF_MS,
    maxAttempts: 5,
    ...(ctx.webhooks.resolve ? { resolve: ctx.webhooks.resolve } : {}),
  };
}

/** A public URL for a stored media key (as the API's `mediaUrl`); absolute URLs pass through. */
export function mediaUrl(cfg: Pick<FederationConfig, "mediaBase">, key: string | null | undefined): string | null {
  if (!key) return null;
  if (/^https?:\/\//.test(key)) return key;
  return `${cfg.mediaBase}${key.split("/").map(encodeURIComponent).join("/")}`;
}
