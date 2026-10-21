// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { and, eq, ne, sql } from "drizzle-orm";
import { schema } from "@commonair/db";
import { emit } from "../events/outbox.ts";
import { toHold } from "../moderation/cases.ts";
import { lockUser, scheduledDeletion, toDeletion } from "../moderation/deletion.ts";
import { audit } from "../events/audit.ts";
import { publishUserControl } from "../lib/control.ts";
import { userByUsername } from "../lib/dto.ts";
import { badRequest, forbidden, notFound, notImplemented } from "../lib/errors.ts";
import { os, requireCaller } from "../lib/orpc.ts";
import { toCategory } from "./directory.ts";

const { categories, users, channels } = schema;

export const admin = {
  egress: os.admin.egress.handler(notImplemented),

  categories: os.admin.categories.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const row = await deps.db.transaction(async (tx) => {
      const [c] = await tx
        .insert(categories)
        .values({ slug: input.slug, name: input.name, mature: input.mature })
        .onConflictDoUpdate({ target: categories.slug, set: { name: input.name, mature: input.mature } })
        .returning();
      if (!c) throw new Error("category upsert returned no row");
      await audit(tx, {
        actorType: "admin",
        actorId: caller.user.id,
        action: "category.upsert",
        subjectType: "category",
        subjectId: c.id,
        details: { slug: c.slug, mature: c.mature },
      });
      return c;
    });
    const [{ n } = { n: 0 }] = await deps.db
      .select({ n: sql<number>`count(*)::int` })
      .from(channels)
      .where(and(eq(channels.categoryId, row.id), sql`${channels.liveBroadcastId} is not null`));
    return toCategory(deps, row, Number(n));
  }),

  setRole: os.admin.setRole.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const target = await userByUsername(deps, input.username);
    if (!target) throw notFound("User not found");
    if (target.accountType === "bot" && input.role !== "user") throw badRequest("Bots cannot hold platform roles");
    await deps.db.transaction(async (tx) => {
      if (target.role === "admin" && input.role !== "admin") {
        // Never leave the instance without an administrator.
        const [{ n } = { n: 0 }] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(users)
          .where(and(eq(users.role, "admin"), ne(users.id, target.id)));
        if (Number(n) === 0) throw badRequest("Cannot remove the last administrator");
      }
      await tx.update(users).set({ role: input.role }).where(eq(users.id, target.id));
      await audit(tx, {
        actorType: "admin",
        actorId: caller.user.id,
        action: "user.set_role",
        subjectType: "user",
        subjectId: target.id,
        details: { from: target.role, to: input.role },
      });
    });
    await publishUserControl(deps, { op: "invalidate", userId: target.id, reason: "role_changed" });
    return { ok: true as const };
  }),

  incidents: os.admin.incidents.handler(notImplemented),
  /** A manual hold (legal role). It can only be placed here; release needs the operator CLI. */
  legalHold: os.admin.legalHold.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const target = await userByUsername(deps, input.username);
    if (!target) throw notFound("User not found");
    if (target.id === caller.user.id) throw forbidden("You cannot place a hold on yourself");
    const hold = await deps.db.transaction(async (tx) => {
      const [h] = await tx
        .insert(schema.legalHolds)
        .values({ userId: target.id, reasonCode: input.reasonCode, reason: input.reason, createdById: caller.user.id })
        .returning();
      if (!h) throw new Error("hold insert returned no row");
      await audit(tx, {
        actorType: "moderator",
        actorId: caller.user.id,
        action: "legal.hold.place",
        subjectType: "user",
        subjectId: target.id,
        reason: input.reason,
        details: { holdId: h.id, userId: target.id, reasonCode: input.reasonCode },
      });
      await emit(tx, "legal.hold.placed", null, {
        hold_id: h.id,
        user_id: target.id,
        reason_code: input.reasonCode,
        case_id: null,
      });
      return h;
    });
    return toHold(hold);
  }),

  /** Delete an account now: creates the request if there is none and makes it due (held data stays). */
  expediteDeletion: os.admin.expediteDeletion.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const target = await userByUsername(deps, input.username);
    if (!target) throw notFound("User not found");
    if (target.id === caller.user.id) throw forbidden("Delete your own account from your settings");
    const now = deps.now();
    const row = await deps.db.transaction(async (tx) => {
      await lockUser(tx, target.id);
      const existing = await scheduledDeletion(tx, target.id);
      const [d] = existing
        ? await tx
            .update(schema.accountDeletions)
            .set({ scheduledFor: now })
            .where(eq(schema.accountDeletions.id, existing.id))
            .returning()
        : await tx
            .insert(schema.accountDeletions)
            .values({ userId: target.id, requestedAt: now, scheduledFor: now })
            .returning();
      if (!d) throw new Error("deletion upsert returned no row");
      await audit(tx, {
        actorType: "admin",
        actorId: caller.user.id,
        action: "account.deletion.expedite",
        subjectType: "user",
        subjectId: target.id,
        reason: input.reason,
        details: { deletionId: d.id, created: existing === undefined },
      });
      return d;
    });
    return toDeletion(row);
  }),
};
