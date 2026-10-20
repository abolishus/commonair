// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The web server's environment. Everything the browser needs (chat, ingest, playback URLs) is
 * read here on the server and handed to the client as `PublicConfig`, so no URL is baked into
 * the client bundle and one image serves any instance.
 */
import {
  ALL_ENV_SCHEMAS,
  instanceSite,
  internalEnv,
  loadEnv,
  mediaEnv,
  paymentsEnv,
  playbackEnv,
  servicePorts,
} from "@commonair/config";

export const webEnvSchema = ALL_ENV_SCHEMAS.coreEnv.extend({
  API_INTERNAL_URL: internalEnv.shape.API_INTERNAL_URL,
  INGEST_RTMP_PUBLIC_URL: mediaEnv.shape.INGEST_RTMP_PUBLIC_URL,
  PLAYBACK_PUBLIC_URL: playbackEnv.shape.PLAYBACK_PUBLIC_URL,
  WEB_PORT: servicePorts.shape.WEB_PORT,
  CURRENCY: paymentsEnv.shape.CURRENCY,
});

export type WebEnv = ReturnType<typeof loadWebEnv>;

export function loadWebEnv(source: Record<string, string | undefined> = process.env) {
  return loadEnv(webEnvSchema, source);
}

/** Serializable config the server hands to the browser. */
export interface PublicConfig {
  instanceName: string;
  publicUrl: string;
  chatUrl: string;
  ingestRtmpUrl: string;
  playbackUrl: string;
  /** Instance currency (ISO 4217, lowercase) for amount inputs before any money data loads. */
  currency: string;
}

const noSlash = (u: string) => u.replace(/\/+$/, "");

export function publicConfig(env: WebEnv): PublicConfig {
  const site = instanceSite(env);
  return {
    instanceName: site.name,
    publicUrl: site.publicUrl,
    chatUrl: env.CHAT_PUBLIC_URL,
    ingestRtmpUrl: noSlash(env.INGEST_RTMP_PUBLIC_URL),
    playbackUrl: noSlash(env.PLAYBACK_PUBLIC_URL),
    currency: env.CURRENCY,
  };
}
