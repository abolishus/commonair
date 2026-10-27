// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `dmca-disable` (§ 512(c)(1)(C); NOT REVIEWED BY A LAWYER): after a moderator actions a notice
 * the API has already hidden the material in the database; this job moves its public objects
 * under the private DMCA prefix so a known media URL stops working too, then sets each item's
 * `objects_hidden_at` (once, enforced by the 0025 guard). Idempotent: a retry finds the objects
 * already moved and the items already marked. Items already restored are left alone.
 */
import type { DmcaDisableJob } from "@commonair/contracts/internal";
import { schema } from "@commonair/db";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import { coveredBy, hideObjects, objectsOf } from "./objects.ts";

const { dmcaNoticeItems: items } = schema;

export async function disableNoticeObjects(
  ctx: WorkerContext,
  job: DmcaDisableJob,
): Promise<{ items: number; objects: number }> {
  const storage = ctx.storage;
  if (!storage) {
    ctx.logger.warn("dmca-disable: no object storage configured; objects stay where they are", {
      noticeId: job.noticeId,
    });
    return { items: 0, objects: 0 };
  }
  const rows = await ctx.db
    .select()
    .from(items)
    .where(
      and(
        eq(items.noticeId, job.noticeId),
        isNotNull(items.removedAt),
        isNull(items.objectsHiddenAt),
        isNull(items.restoredAt),
      ),
    );
  let objects = 0;
  let done = 0;
  for (const i of rows) {
    objects += await hideObjects(storage, ctx.mediaBucket, objectsOf(await coveredBy(ctx.db, i)));
    const marked = await ctx.db
      .update(items)
      .set({ objectsHiddenAt: ctx.now() })
      .where(and(eq(items.id, i.id), isNull(items.objectsHiddenAt), isNull(items.restoredAt)))
      .returning({ id: items.id });
    done += marked.length;
  }
  if (done > 0) ctx.logger.info("dmca objects hidden", { noticeId: job.noticeId, items: done, objects });
  return { items: done, objects };
}
