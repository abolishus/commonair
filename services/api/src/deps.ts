// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Database } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import type { ValkeyClient } from "@commonair/service";
import type { ObjectStorage } from "@commonair/storage";
import type { SigningKey } from "@commonair/tokens";
import type { InstanceSite } from "@commonair/config/site";
import type { NetworkClassifier } from "@commonair/integrity";
import type { ApiEnv } from "./env.ts";
import type { Mailer } from "./mail.ts";
import type { PinnedGet, ResolveHost } from "./lib/outbound.ts";
import type { RateLimitBucket, RateLimitRule, RateLimitStore } from "./lib/ratelimit.ts";

/** Probes for components the API does not own, used by `instance.status`. */
export type StatusProbe = () => Promise<void>;

/** Everything a handler may touch. Built once in main.ts (or per test file). */
export interface Deps {
  env: ApiEnv;
  site: InstanceSite;
  version: string;
  db: Database;
  valkey: ValkeyClient;
  storage: ObjectStorage;
  mailer: Mailer;
  logger: Logger;
  signingKey: SigningKey;
  /** Outbound GET pinned to a vetted address (relay health checks); injectable for tests. */
  pinnedGet: PinnedGet;
  /** DNS for outbound URL checks (SSRF); injectable for tests. */
  resolveHost: ResolveHost;
  rateLimits: Record<RateLimitBucket, RateLimitRule>;
  rateLimitStore: RateLimitStore;
  probes: Record<string, StatusProbe>;
  /** Hosting-provider (datacenter) lookup for new playback sessions. */
  classifier: NetworkClassifier;
  now: () => Date;
}
