// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `oauth_apps` rows → `OAuthApp` / `AdminOAuthApp`. The client secret hash never leaves the API. */
import type { z } from "zod";
import type { dto } from "@commonair/contracts";
import type { schema } from "@commonair/db";
import { iso, isoOrNull } from "../../lib/dto.ts";

export type OAuthAppRow = typeof schema.oauthApps.$inferSelect;
export type OAuthApp = z.infer<typeof dto.OAuthApp>;
export type AdminOAuthApp = z.infer<typeof dto.AdminOAuthApp>;
export interface AppCounts {
  /** Users with a live grant. */
  grants: number;
  /** Enabled webhook subscriptions. */
  subscriptions: number;
}

export function toOAuthApp(row: OAuthAppRow): OAuthApp {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    clientId: row.clientId,
    redirectUris: [...row.redirectUris],
    confidential: row.confidential,
    createdAt: iso(row.createdAt),
    secretRotatedAt: isoOrNull(row.secretRotatedAt),
    // oauth_apps_suspension_ck keeps the time and the reason together.
    suspended:
      row.suspendedAt && row.suspendedReason ? { at: iso(row.suspendedAt), reason: row.suspendedReason } : null,
  };
}

export function toAdminOAuthApp(
  row: OAuthAppRow,
  owner: { id: string; username: string },
  counts: AppCounts,
): AdminOAuthApp {
  return {
    ...toOAuthApp(row),
    owner: { id: owner.id, username: owner.username },
    grants: counts.grants,
    subscriptions: counts.subscriptions,
  };
}
