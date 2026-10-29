// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * RFC 8628 device authorization: minting device and user codes (§3.1-3.2) and the
 * `device_code` grant's polling (§3.4-3.5). Both codes are stored as sha256 only; the user code
 * normalized (upper case, no dash), so `bcdf-ghjk` and `BCDFGHJK` find the same row.
 */
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { OAUTH_LIMITS, OAUTH_PATHS, type TokenResponse } from "@commonair/contracts/oauth";
import type { Scope } from "@commonair/contracts/scopes";
import { schema, uuidv7 } from "@commonair/db";
import { randomTokenSecret, sha256Hex } from "@commonair/tokens";
import type { Deps } from "../deps.ts";
import { isUniqueViolation } from "../lib/errors.ts";
import type { OAuthAppRow } from "./clients.ts";
import { formatUserCode, generateUserCode, OAuthError } from "./protocol.ts";
import { issueToken, userUsable } from "./tokens.ts";

const { oauthDeviceCodes } = schema;

const MINT_ATTEMPTS = 5;

export interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export async function startDeviceAuthorization(
  deps: Deps,
  app: OAuthAppRow,
  scopes: Scope[],
): Promise<DeviceAuthorization> {
  const now = deps.now();
  const deviceCode = randomTokenSecret("cad_");
  const deviceCodeHash = await sha256Hex(deviceCode);
  for (let attempt = 1; ; attempt++) {
    const userCode = generateUserCode();
    try {
      await deps.db.insert(oauthDeviceCodes).values({
        id: uuidv7(),
        appId: app.id,
        deviceCodeHash,
        userCodeHash: await sha256Hex(userCode),
        scopes,
        intervalSeconds: OAUTH_LIMITS.devicePollIntervalSeconds,
        expiresAt: new Date(now.getTime() + OAUTH_LIMITS.deviceCodeTtlSeconds * 1000),
        createdAt: now,
      });
      const shown = formatUserCode(userCode);
      const verification = `${deps.site.publicUrl}${OAUTH_PATHS.activatePage}`;
      const complete = new URL(verification);
      complete.searchParams.set("code", shown);
      deps.logger.info("oauth device authorization started", { appId: app.id });
      return {
        device_code: deviceCode,
        user_code: shown,
        verification_uri: verification,
        verification_uri_complete: complete.href,
        expires_in: OAUTH_LIMITS.deviceCodeTtlSeconds,
        interval: OAUTH_LIMITS.devicePollIntervalSeconds,
      };
    } catch (err) {
      // 20^8 codes: a collision with a live one is rare, but the unique index decides.
      if (!isUniqueViolation(err) || attempt >= MINT_ATTEMPTS) throw err;
    }
  }
}

/**
 * The `device_code` grant. Throttled per RFC 8628 §3.5 instead of the per-IP bucket: a poll
 * within `intervalSeconds` of the previous one answers `slow_down` and adds
 * `deviceSlowDownSeconds` to the interval. The CAS on `last_polled_at` means two concurrent polls
 * cannot both pass.
 */
export async function deviceCodeGrant(deps: Deps, app: OAuthAppRow, deviceCode: string): Promise<TokenResponse> {
  const now = deps.now();
  const hash = await sha256Hex(deviceCode);
  const [row] = await deps.db
    .select()
    .from(oauthDeviceCodes)
    .where(and(eq(oauthDeviceCodes.deviceCodeHash, hash), eq(oauthDeviceCodes.appId, app.id)))
    .limit(1);
  if (!row) throw new OAuthError("invalid_grant", "The device code is invalid");
  if (row.status === "redeemed") throw new OAuthError("invalid_grant", "The device code was already used");
  if (row.expiresAt <= now) throw new OAuthError("expired_token", "The device code expired");

  const nowIso = now.toISOString();
  const [polled] = await deps.db
    .update(oauthDeviceCodes)
    .set({ lastPolledAt: now })
    .where(
      and(
        eq(oauthDeviceCodes.id, row.id),
        or(
          isNull(oauthDeviceCodes.lastPolledAt),
          lte(
            oauthDeviceCodes.lastPolledAt,
            sql`${nowIso}::timestamptz - make_interval(secs => ${oauthDeviceCodes.intervalSeconds})`,
          ),
        ),
      ),
    )
    .returning({ status: oauthDeviceCodes.status });
  if (!polled) {
    await deps.db
      .update(oauthDeviceCodes)
      .set({
        lastPolledAt: now,
        intervalSeconds: sql`${oauthDeviceCodes.intervalSeconds} + ${OAUTH_LIMITS.deviceSlowDownSeconds}`,
      })
      .where(eq(oauthDeviceCodes.id, row.id));
    throw new OAuthError("slow_down", "Polling too fast: wait the interval plus five seconds");
  }
  if (polled.status === "pending") throw new OAuthError("authorization_pending", "The user has not decided yet");
  if (polled.status === "denied") throw new OAuthError("access_denied", "The user denied the request");
  if (polled.status === "redeemed") throw new OAuthError("invalid_grant", "The device code was already used");

  const token = await deps.db.transaction(async (tx) => {
    const [approved] = await tx
      .update(oauthDeviceCodes)
      .set({ status: "redeemed" })
      .where(and(eq(oauthDeviceCodes.id, row.id), eq(oauthDeviceCodes.status, "approved")))
      .returning({ userId: oauthDeviceCodes.userId, scopes: oauthDeviceCodes.scopes });
    if (!approved?.userId) return null;
    if (!(await userUsable(tx, approved.userId))) return null;
    return issueToken(tx, now, {
      appId: app.id,
      userId: approved.userId,
      kind: "device_code",
      scopes: approved.scopes,
      familyId: uuidv7(),
    });
  });
  if (!token) throw new OAuthError("invalid_grant", "The device code is no longer valid");
  deps.logger.info("oauth token issued", { appId: app.id, grant: "device_code" });
  return token;
}
