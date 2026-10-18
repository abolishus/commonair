// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { DEFAULT_BACKOFF_MS } from "./backoff.ts";
import type { Resolver } from "./ssrf.ts";

export interface WebhookSettings {
  /** AUTH_SECRET: webhook secrets are stored encrypted with purpose "webhook". */
  authSecret: string;
  /** EVENTSUB_ALLOW_INSECURE_CALLBACKS: allow http:// and private-network callbacks (dev/harness). */
  allowInsecure: boolean;
  timeoutMs: number;
  /** Response bytes read before the connection is dropped. */
  maxResponseBytes: number;
  /** Bytes of the response body kept in the delivery log. */
  logBodyBytes: number;
  /** Delay before retry n (index n-1). */
  backoffMs: readonly number[];
  maxAttempts: number;
  /** Consecutive events that exhausted every attempt before the subscription is marked failed. */
  failureThreshold: number;
  /** DNS resolver (injectable for tests). */
  resolve?: Resolver;
}

export function defaultWebhookSettings(authSecret: string, allowInsecure: boolean): WebhookSettings {
  return {
    authSecret,
    allowInsecure,
    timeoutMs: 10_000,
    maxResponseBytes: 64 * 1024,
    logBodyBytes: 2048,
    backoffMs: DEFAULT_BACKOFF_MS,
    maxAttempts: 5,
    failureThreshold: 3,
  };
}
