// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { and, eq, ne, sql } from "drizzle-orm";
import { schema } from "@commonair/db";
import { audit } from "../events/audit.ts";
import { publishUserControl } from "../lib/control.ts";
import { userByUsername } from "../lib/dto.ts";
import { badRequest, notFound, notImplemented } from "../lib/errors.ts";
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
  legalHold: os.admin.legalHold.handler(notImplemented),
  expediteDeletion: os.admin.expediteDeletion.handler(notImplemented),
};
