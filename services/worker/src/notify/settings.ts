// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Settings the N1 units read (ADR 0028): the `notifications.goLive` governance setting and web push. */
import type { InstanceSite } from "@commonair/config/site";
import { GoLiveSetting } from "@commonair/contracts/shapes";
import { DEFAULT_GOVERNANCE_SETTINGS, schema, type Database } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import { eq } from "drizzle-orm";
import type { WorkerEnv } from "../env.ts";

export const GO_LIVE_SETTING_KEY = "notifications.goLive";
/** A decision takes effect within this long on every replica. */
export const GO_LIVE_SETTING_TTL_MS = 30_000;

/** The seeded value: the fallback when the stored one is missing or invalid. */
export const DEFAULT_GO_LIVE_SETTING: GoLiveSetting = GoLiveSetting.parse(
  DEFAULT_GOVERNANCE_SETTINGS.find((s) => s.key === GO_LIVE_SETTING_KEY)?.value,
);

let cached: { value: GoLiveSetting; at: number } | undefined;

/**
 * The `notifications.goLive` value, cached per process for `GO_LIVE_SETTING_TTL_MS`. The database
 * range-checks it (migration 0040), so the logged fallback is a belt-and-braces path.
 */
export async function goLiveSetting(
  db: Pick<Database, "select">,
  logger: Pick<Logger, "error">,
  nowMs: number = Date.now(),
): Promise<GoLiveSetting> {
  if (cached && nowMs - cached.at < GO_LIVE_SETTING_TTL_MS) return cached.value;
  const [row] = await db
    .select({ value: schema.governanceSettings.value })
    .from(schema.governanceSettings)
    .where(eq(schema.governanceSettings.key, GO_LIVE_SETTING_KEY));
  const parsed = GoLiveSetting.safeParse(row?.value);
  if (!parsed.success)
    logger.error("go-live setting missing or invalid; using the default", {
      key: GO_LIVE_SETTING_KEY,
      missing: row === undefined,
      issues: parsed.error.issues.map((i) => i.path.join(".")),
    });
  const value = parsed.success ? parsed.data : { ...DEFAULT_GO_LIVE_SETTING };
  cached = { value, at: nowMs };
  return value;
}

/** Tests: forget the cached value. */
export function clearGoLiveSettingCache(): void {
  cached = undefined;
}

/** What the push sender needs (ADR 0028 decision 1). */
export interface WebPushSettings {
  /** VAPID public key, base64url (the `k=` of the VAPID `Authorization`). */
  publicKey: string;
  /** VAPID private key, base64 PKCS#8 DER. */
  privateKeyPkcs8: string;
  /** VAPID `sub` claim: `mailto:` the instance's general contact (RFC 8292). */
  subject: string;
  /** WEB_PUSH_ALLOW_INSECURE_ENDPOINTS: http:// and private-network endpoints (harness only). */
  allowInsecure: boolean;
}

type WebPushEnv = Pick<
  WorkerEnv,
  "WEB_PUSH_ENABLED" | "VAPID_PUBLIC_KEY" | "VAPID_PRIVATE_KEY" | "WEB_PUSH_ALLOW_INSECURE_ENDPOINTS"
>;

/** Undefined when push is off. The env schema refuses push on without both keys. */
export function webPushSettings(env: WebPushEnv, site: Pick<InstanceSite, "contacts">): WebPushSettings | undefined {
  if (!env.WEB_PUSH_ENABLED) return undefined;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY)
    throw new Error("WEB_PUSH_ENABLED needs the VAPID key pair (bun scripts/init-env.ts --merge)");
  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKeyPkcs8: env.VAPID_PRIVATE_KEY,
    subject: `mailto:${site.contacts.general}`,
    allowInsecure: env.WEB_PUSH_ALLOW_INSECURE_ENDPOINTS,
  };
}
