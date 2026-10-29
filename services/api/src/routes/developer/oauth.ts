// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `developer.oauth.*` (consent, device activation) and `developer.grants.*` (E9-oauth; ADR 0027 §1-2). */
import { and, eq } from "drizzle-orm";
import { WEBHOOK_JOBS } from "@commonair/contracts/internal";
import { schema } from "@commonair/db";
import { publishRevocations, revokeTokensInTx, revokeWebhookSubscriptionsInTx } from "../../developer/grants.ts";
import { webhookQueue } from "../../developer/webhook-queue.ts";
import { os, requireCaller } from "../../lib/orpc.ts";
import {
  checkAuthorizationRequest,
  decideDevice,
  grantCovers,
  issueCode,
  listGrants,
  lookupDevice,
  pendingCodesOf,
} from "../../oauth/consent.ts";
import { buildRedirect } from "../../oauth/protocol.ts";

export const oauth = {
  request: os.developer.oauth.request.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const checked = await checkAuthorizationRequest(deps, input);
    if (checked.kind === "redirect") return checked;
    const alreadyGranted =
      !input.forceVerify && (await grantCovers(deps, checked.app.id, caller.user.id, checked.scopes));
    return { kind: "consent" as const, app: checked.summary, scopes: checked.scopes, alreadyGranted };
  }),

  decide: os.developer.oauth.decide.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    // Every check of `request` again: the page calling it first proves nothing.
    const checked = await checkAuthorizationRequest(deps, { ...input, responseType: "code" });
    if (checked.kind === "redirect") return { redirectTo: checked.redirectTo };
    if (!input.approve) {
      deps.logger.info("oauth consent decided", { appId: checked.app.id, approve: false });
      return {
        redirectTo: buildRedirect(input.redirectUri, {
          error: "access_denied",
          error_description: "The user denied the request",
          state: input.state,
        }),
      };
    }
    const code = await issueCode(deps, {
      appId: checked.app.id,
      userId: caller.user.id,
      scopes: checked.scopes,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
    });
    deps.logger.info("oauth consent decided", { appId: checked.app.id, approve: true });
    return { redirectTo: buildRedirect(input.redirectUri, { code, state: input.state }) };
  }),

  activation: os.developer.oauth.activation.handler(async ({ context, input }) => {
    requireCaller(context);
    return lookupDevice(context.deps, input.userCode);
  }),

  activate: os.developer.oauth.activate.handler(async ({ context, input }) => {
    const caller = requireCaller(context);
    await decideDevice(context.deps, input.userCode, caller.user.id, input.approve);
    return { ok: true as const };
  }),
};

export const grants = {
  list: os.developer.grants.list.handler(async ({ context }) => {
    const caller = requireCaller(context);
    return listGrants(context.deps, caller.user.id);
  }),

  /**
   * Revoke one app's access to the caller: its tokens, its webhook subscriptions, its unexchanged
   * codes and approved device codes, in one transaction. The notices after commit are best effort
   * (ADR 0027 consequences): the committed revocation is authoritative.
   */
  revoke: os.developer.grants.revoke.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const scope = { appId: input.appId, userId: caller.user.id };
    const now = deps.now();
    const { tokens, subscriptions } = await deps.db.transaction(async (tx) => {
      // Codes first: these statements wait on any exchange or device redemption holding the code
      // row, so the token revocation below (a fresh snapshot under read committed) sees its token.
      await tx.delete(schema.oauthCodes).where(pendingCodesOf(scope.appId, scope.userId));
      await tx
        .update(schema.oauthDeviceCodes)
        .set({ status: "denied", decidedAt: now })
        .where(
          and(
            eq(schema.oauthDeviceCodes.appId, scope.appId),
            eq(schema.oauthDeviceCodes.userId, scope.userId),
            eq(schema.oauthDeviceCodes.status, "approved"),
          ),
        );
      const tokens = await revokeTokensInTx(tx, scope, now);
      const subscriptions = await revokeWebhookSubscriptionsInTx(tx, scope);
      return { tokens, subscriptions };
    });
    deps.logger.info("oauth grant revoked", {
      appId: scope.appId,
      tokens: tokens.length,
      subscriptions: subscriptions.length,
    });
    await publishRevocations(deps, tokens, "grant_revoked", scope);
    for (const subscriptionId of subscriptions)
      try {
        await webhookQueue(deps).enqueue(WEBHOOK_JOBS.revocation, { subscriptionId }, `revocation-${subscriptionId}`);
      } catch (err) {
        deps.logger.warn("revocation notice enqueue failed", { appId: scope.appId, subscriptionId, err });
      }
    return { ok: true as const };
  }),
};
