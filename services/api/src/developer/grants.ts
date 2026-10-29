// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Revoking OAuth grants (ADR 0027): one place for the token and webhook-subscription updates and
 * the control messages that follow, shared by the token endpoint (rotation, reuse detection),
 * `developer.grants.revoke`, app deletion and app suspension. Orchestrator-owned; units import it.
 */
import { BUS, type UserControlMessage } from "@commonair/contracts/events";
import { schema, type Executor } from "@commonair/db";
import { and, eq, inArray, isNull, ne, type SQL } from "drizzle-orm";
import type { Deps } from "../deps.ts";
import { publishUserControl } from "../lib/control.ts";

const { oauthTokens, eventSubscriptions } = schema;

export interface RevokedToken {
  id: string;
  userId: string | null;
  appId: string | null;
  accessTokenHash: string;
}

export type TokenScope =
  | { tokenIds: string[] }
  | { familyId: string }
  | { appId: string; userId: string } // one grant
  | { appId: string }; // the whole app

function scopeWhere(scope: TokenScope): SQL | undefined {
  if ("tokenIds" in scope) return inArray(oauthTokens.id, scope.tokenIds);
  if ("familyId" in scope) return eq(oauthTokens.familyId, scope.familyId);
  if ("userId" in scope) return and(eq(oauthTokens.appId, scope.appId), eq(oauthTokens.userId, scope.userId));
  return eq(oauthTokens.appId, scope.appId);
}

/** Revoke every unrevoked token in scope (`revoked_at = now`); returns them for the control messages. */
export async function revokeTokensInTx(tx: Executor, scope: TokenScope, now: Date): Promise<RevokedToken[]> {
  if ("tokenIds" in scope && scope.tokenIds.length === 0) return [];
  return tx
    .update(oauthTokens)
    .set({ revokedAt: now })
    .where(and(scopeWhere(scope), isNull(oauthTokens.revokedAt)))
    .returning({
      id: oauthTokens.id,
      userId: oauthTokens.userId,
      appId: oauthTokens.appId,
      accessTokenHash: oauthTokens.accessTokenHash,
    });
}

/** Webhook subscriptions of a grant or a whole app → `revoked`; returns their ids (enqueue `revocation` after commit). */
export async function revokeWebhookSubscriptionsInTx(
  tx: Executor,
  scope: { appId: string; userId?: string },
): Promise<string[]> {
  const rows = await tx
    .update(eventSubscriptions)
    .set({ status: "revoked" })
    .where(
      and(
        eq(eventSubscriptions.appId, scope.appId),
        scope.userId === undefined ? undefined : eq(eventSubscriptions.userId, scope.userId),
        eq(eventSubscriptions.transport, "webhook"),
        ne(eventSubscriptions.status, "revoked"),
      ),
    )
    .returning({ id: eventSubscriptions.id });
  return rows.map((r) => r.id);
}

const APP_WIDE_REASONS: ReadonlySet<UserControlMessage["reason"]> = new Set(["app_suspended", "app_removed"]);

/**
 * After commit: one `disconnect` per token (`userId`, `appId`, `tokenHash`, reason) on
 * BUS.userControl, then, for an app-wide reason (`app_suspended`, `app_removed`), one
 * `{ op: "disconnect", appId, reason }` so chat-token sockets and EventSub sessions of the app close.
 * Publishes through `publishUserControl`, which parses each message. Refresh rotation passes
 * `token_rotated`. Best effort, like `tokens.revoke`: never throws; a failed publish is logged with
 * ids only. The committed revocation is authoritative (tokens stop resolving at once; chat
 * revalidates within 30 s, the EventSub fan-out re-authorizes within 30 s, webhooks authorize at
 * delivery). ADR 0027.
 */
export async function publishRevocations(
  deps: Deps,
  tokens: RevokedToken[],
  reason: UserControlMessage["reason"],
  appWide?: { appId: string },
): Promise<void> {
  const send = async (message: UserControlMessage, ids: Record<string, string | null>) => {
    try {
      await publishUserControl(deps, message);
    } catch (err) {
      deps.logger.warn("revocation publish failed", { ...ids, reason, channel: BUS.userControl, err });
    }
  };
  for (const t of tokens)
    await send(
      {
        op: "disconnect",
        userId: t.userId ?? undefined,
        appId: t.appId ?? undefined,
        tokenHash: t.accessTokenHash,
        reason,
      },
      { tokenId: t.id, appId: t.appId },
    );
  if (appWide && APP_WIDE_REASONS.has(reason))
    await send({ op: "disconnect", appId: appWide.appId, reason }, { appId: appWide.appId });
}
