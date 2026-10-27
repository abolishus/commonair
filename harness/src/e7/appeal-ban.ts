// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `trust-safety` step 9: an overturned appeal lifts the ban (docs/testing/e7-selectors.md,
 * "Scenarios"). Streamer H bans viewer V in chat; V appeals the `mod_actions` row (over the API in
 * both modes: the web has no appeal button for a chat ban); a platform moderator who is not H
 * overturns it on `/admin/appeals` (`--set via=api`: `appeals.resolve`); V can send again and the
 * audit log has `chat.unban` by that moderator with `details.appealId`. API only: an admin suspends
 * user W, W appeals the suspension, the overturn unsuspends W.
 */
import type * as D from "@commonair/contracts/dto";
import { createDb } from "@commonair/db";
import type { z } from "zod";
import type { ChatClient } from "../chat-client.ts";
import { apiError } from "../safety.ts";
import { userBanned } from "../safety-db.ts";
import { type Run, API_SETTLE_MS, NOTE, UI_TIMEOUT_MS, newStreamer, title } from "../safety-run.ts";
import * as web from "../safety-web.ts";
import type { SignedInUser } from "../users.ts";
import { waitFor } from "../wait.ts";

export type ModActionView = z.infer<typeof D.ModActionView>;
export type AuditEntry = z.infer<typeof D.AuditEntry>;

/** The newest `ban` in a channel mod log that targeted `targetId`, or null. */
export function findBanAction(entries: readonly ModActionView[], targetId: string): ModActionView | null {
  const bans = entries.filter((e) => e.action === "ban" && e.target?.id === targetId);
  bans.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return bans[0] ?? null;
}

/** The `chat.unban` audit row the overturn wrote: by `moderatorId`, naming `appealId`. */
export function findAppealUnban(
  entries: readonly AuditEntry[],
  want: { moderatorId: string; appealId: string },
): AuditEntry | null {
  return (
    entries.find(
      (e) => e.action === "chat.unban" && e.actorId === want.moderatorId && e.details.appealId === want.appealId,
    ) ?? null
  );
}

/** A chat send was accepted (a message id) rather than refused (null id, not held). */
export const sendAccepted = (ack: { id: string | null; held: boolean }): boolean => ack.id !== null;

/** The API refused a write because the account is suspended (`decideAccess`). */
export function isSuspendedRefusal(err: unknown): boolean {
  return apiError(err).code === "FORBIDDEN";
}

/** The appeal text V and W send: run-unique, no personal data. */
export const appealBody = (runId: string, who: string): string => `harness appeal of the ${who} decision, run ${runId}`;

/** One send on a fresh connection: chat re-reads bans per connection after an invalidation. */
async function trySend(run: Run, user: SignedInUser, channel: string, body: string): Promise<boolean> {
  let chat: ChatClient | null = null;
  try {
    chat = await run.ctx.platform.chat(user);
    await chat.join(channel);
    return sendAccepted(await chat.send(channel, body));
  } finally {
    chat?.close();
  }
}

async function latestSuspendAction(databaseUrl: string, userId: string): Promise<string | null> {
  const handle = createDb({ url: databaseUrl, max: 1, applicationName: "commonair-harness" });
  try {
    const [row] = await handle.sql<{ id: string }[]>`
      select id from mod_actions where target_user_id = ${userId} and action = 'suspend_user'
       order by created_at desc, id desc limit 1`;
    return row?.id ?? null;
  } finally {
    await handle.close();
  }
}

export async function stepAppealLiftsBan(run: Run): Promise<void> {
  const { ctx, staff } = run;
  const t = (w: string) => title(9, w);
  const settle = { timeoutMs: API_SETTLE_MS, intervalMs: 1_000, signal: ctx.signal };
  const h = await ctx.step(t("sign up streamer H"), () => newStreamer(run, "ts_h"));
  const v = await ctx.step(t("sign up viewer V"), async () => {
    const u = await ctx.platform.signUp({ prefix: "ts_v" });
    run.emails.push(u.email);
    return u;
  });
  const before = await ctx.step(t("V chats in H's channel"), () =>
    trySend(run, v, h.channel, `hello from V, run ${ctx.runId}`),
  );
  ctx.assert("appeal: V can chat before the ban", before);

  await ctx.step(t("H bans V in chat"), () =>
    h.user.api.client.chat.bans.ban({ channel: h.channel, username: v.username, reason: NOTE }),
  );
  await ctx.step(t("V's messages are refused while banned"), () =>
    waitFor("V refused", async () => !(await trySend(run, v, h.channel, "still here?")), settle),
  );
  const ban = await ctx.step(t("H's mod log has the ban"), () =>
    waitFor(
      "ban in the mod log",
      async () => findBanAction((await h.user.api.client.safety.modLog({ channel: h.channel, limit: 50 })).items, v.id),
      settle,
    ),
  );
  const appeal = await ctx.step(t("V appeals the ban (API)"), () =>
    v.api.client.appeals.create({
      kind: "moderation",
      subjectType: "moderation_action",
      subjectId: ban.id,
      body: appealBody(ctx.runId, "chat ban"),
    }),
  );
  if (run.via === "web") {
    const ms = await run.webSession("moderator-appeal-ban", staff.mod);
    await ctx.step(t("web: a platform moderator overturns on /admin/appeals"), () =>
      web.resolveAppeal(ms, appeal.id, "overturned", NOTE, { timeoutMs: UI_TIMEOUT_MS, signal: ctx.signal }),
    );
  } else {
    await ctx.step(t("a platform moderator overturns (API)"), () =>
      staff.mod.api.client.appeals.resolve({ id: appeal.id, status: "overturned", resolution: NOTE }),
    );
  }
  await ctx.step(t("V can send again"), () =>
    waitFor("V accepted", () => trySend(run, v, h.channel, `back again, run ${ctx.runId}`), settle),
  );
  const unban = await ctx.step(t("audit: chat.unban by the moderator with the appeal id"), () =>
    waitFor(
      "chat.unban audit row",
      async () =>
        findAppealUnban(
          (await staff.admin.api.client.safety.auditLog({ subjectType: "user", subjectId: v.id, limit: 50 })).items,
          { moderatorId: staff.mod.id, appealId: appeal.id },
        ),
      settle,
    ),
  );
  ctx.assert("appeal: the unban is the moderator's, not the streamer's", unban.actorId !== h.user.id, {
    actorType: unban.actorType,
  });

  if (run.via === "api") {
    const w = await ctx.step(t("sign up user W"), async () => {
      const u = await ctx.platform.signUp({ prefix: "ts_w" });
      run.emails.push(u.email);
      return u;
    });
    await ctx.step(t("an admin suspends W"), () =>
      staff.admin.api.client.safety.suspend({ username: w.username, target: "user", suspended: true, reason: NOTE }),
    );
    const suspendId = await ctx.step(t("W's suspension mod action"), () =>
      waitFor("suspend_user mod action", () => latestSuspendAction(run.databaseUrl, w.id), settle),
    );
    const filed = await ctx.step(t("W appeals the suspension (API)"), async () => {
      try {
        const a = await w.api.client.appeals.create({
          kind: "moderation",
          subjectType: "moderation_action",
          subjectId: suspendId,
          body: appealBody(ctx.runId, "suspension"),
        });
        return { id: a.id, err: null };
      } catch (err) {
        return { id: null, err: err ?? new Error("rejected without a reason") };
      }
    });
    ctx.assert(
      "appeal: a suspended account can appeal its suspension",
      filed.id !== null,
      filed.err === null ? {} : { ...apiError(filed.err), suspendedRefusal: isSuspendedRefusal(filed.err) },
    );
    const id = filed.id;
    if (id !== null) {
      await ctx.step(t("a platform moderator overturns W's appeal (API)"), () =>
        staff.mod.api.client.appeals.resolve({ id, status: "overturned", resolution: NOTE }),
      );
      const after = await ctx.step(t("W is unsuspended"), () => userBanned(run.databaseUrl, w.id));
      ctx.assert("appeal: the overturn unsuspended W", !after.banned, { banReason: after.banReason });
    }
  }
  ctx.data("step9", { banActionId: ban.id, appealId: appeal.id });
}
