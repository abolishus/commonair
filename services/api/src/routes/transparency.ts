// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `transparency.*` (public): the open enforcement report (W2-enforcement-report, ADR 0019). */
import { schema } from "@commonair/db";
import { eq } from "drizzle-orm";
import { os, type Ctx } from "../lib/orpc.ts";
import { enforcementReport } from "../transparency/enforcement.ts";
import { requestLocale } from "../transparency/locale.ts";

/** The signed-in caller's chosen language, if any (the web's own negotiation puts it first too). */
async function userLocale(context: Ctx): Promise<string | null> {
  const id = context.caller?.user.id;
  if (!id) return null;
  const [u] = await context.deps.db
    .select({ locale: schema.users.locale })
    .from(schema.users)
    .where(eq(schema.users.id, id));
  return u?.locale ?? null;
}

export const transparency = {
  // Input validated by the contract: `30d` or a `YYYY-MM` month (01–12).
  enforcement: os.transparency.enforcement.handler(async ({ context, input }) =>
    enforcementReport(context.deps, input.window, {
      locale: requestLocale({ userLocale: await userLocale(context), headers: context.req.headers }),
    }),
  ),
};
