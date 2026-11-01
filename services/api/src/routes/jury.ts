// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `jury.*` (ADR 0038, batch 7 decision (u)): opting in and out, a seated juror's panel, cases and
 * votes, the public results and the staff list of re-review flags. The jury is advisory: no
 * handler here changes a moderation outcome. Every write is audited with ids only.
 */
import type { JuryFlag, JuryStatus } from "@commonair/contracts/dto";
import type { z } from "zod";
import { schema, type Executor } from "@commonair/db";
import { and, count, desc, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import { isAdult } from "../auth/identity.ts";
import { audit } from "../events/audit.ts";
import { castVote, juryResults, jurorView, openSeat, readJurySettings, toJuryCases } from "../jury/service.ts";
import { ineligibility } from "../jury/rules.ts";
import { decodeCursor, encodeCursor, isKeyCursor, pageOf } from "../lib/cursor.ts";
import { iso, isoOrNull } from "../lib/dto.ts";
import { apiError, conflict, notFound, pgCode, precondition } from "../lib/errors.ts";
import { os, requireCaller, type Ctx } from "../lib/orpc.ts";
import { requestLocale } from "../transparency/locale.ts";

const { juryOptins, juryPanels, jurySeats, juryCases, juryVotes, juryFlags, memberships, users } = schema;

/** The signed-in caller's chosen language, if any (as `transparency.enforcement`). */
async function localeOf(context: Ctx): Promise<string> {
  const id = context.caller?.user.id;
  let userLocale: string | null = null;
  if (id) {
    const [u] = await context.deps.db.select({ locale: users.locale }).from(users).where(eq(users.id, id));
    userLocale = u?.locale ?? null;
  }
  return requestLocale({ userLocale, headers: context.req.headers });
}

interface CallerFacts {
  id: string;
  role: Parameters<typeof ineligibility>[0]["role"];
  accountType: "human" | "bot";
  suspended: boolean;
}

async function eligibleNow(db: Executor, u: CallerFacts, now: Date): Promise<boolean> {
  const [row] = await db
    .select({ birthDate: users.birthDate, deletedAt: users.deletedAt, banned: users.banned })
    .from(users)
    .where(eq(users.id, u.id));
  const [m] = await db
    .select({ n: count() })
    .from(memberships)
    .where(and(eq(memberships.userId, u.id), eq(memberships.status, "active")));
  return (
    ineligibility({
      role: u.role,
      accountType: u.accountType,
      suspended: u.suspended || (row?.banned ?? true) || (row?.deletedAt ?? null) !== null,
      activeMember: (m?.n ?? 0) > 0,
      adult: isAdult(row?.birthDate ?? null, now),
    }) === null
  );
}

async function statusOf(db: Executor, u: CallerFacts, now: Date): Promise<z.infer<typeof JuryStatus>> {
  const settings = await readJurySettings(db);
  const [optin] = await db
    .select()
    .from(juryOptins)
    .where(and(eq(juryOptins.userId, u.id), isNull(juryOptins.optedOutAt)));
  const seat = await openSeat(db, u.id);
  return {
    enabled: settings.enabled,
    eligible: await eligibleNow(db, u, now),
    optedIn: optin !== undefined,
    optedInAt: isoOrNull(optin?.optedInAt),
    seat: seat ? { panelId: seat.panel.id, period: seat.panel.period } : null,
  };
}

export const jury = {
  status: os.jury.status.handler(async ({ context }) => {
    const caller = requireCaller(context);
    return statusOf(context.deps.db, caller.user, context.deps.now());
  }),

  optIn: os.jury.optIn.handler(async ({ context }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const now = deps.now();
    if (!(await readJurySettings(deps.db)).enabled)
      throw precondition("jury_disabled", "The co-op has not turned the jury on");
    if (!(await eligibleNow(deps.db, caller.user, now)))
      throw precondition("jury_ineligible", "Only active adult members who are not staff can serve");
    await deps.db.transaction(async (tx) => {
      const [live] = await tx
        .select({ userId: juryOptins.userId })
        .from(juryOptins)
        .where(and(eq(juryOptins.userId, caller.user.id), isNull(juryOptins.optedOutAt)));
      if (live) return;
      await tx
        .insert(juryOptins)
        .values({ userId: caller.user.id, optedInAt: now })
        .onConflictDoUpdate({ target: juryOptins.userId, set: { optedInAt: now, optedOutAt: null } });
      await audit(tx, {
        actorType: "user",
        actorId: caller.user.id,
        action: "jury.opt_in",
        subjectType: "user",
        subjectId: caller.user.id,
      });
    });
    return statusOf(deps.db, caller.user, now);
  }),

  optOut: os.jury.optOut.handler(async ({ context }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const now = deps.now();
    await deps.db.transaction(async (tx) => {
      // From the next panel: a current seat stays (the draw reads opt-ins only when it seats).
      const [row] = await tx
        .update(juryOptins)
        .set({ optedOutAt: now })
        .where(and(eq(juryOptins.userId, caller.user.id), isNull(juryOptins.optedOutAt)))
        .returning({ userId: juryOptins.userId });
      if (!row) return;
      await audit(tx, {
        actorType: "user",
        actorId: caller.user.id,
        action: "jury.opt_out",
        subjectType: "user",
        subjectId: caller.user.id,
      });
    });
    return statusOf(deps.db, caller.user, now);
  }),

  panel: os.jury.panel.handler(async ({ context }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const seat = await openSeat(deps.db, caller.user.id);
    if (!seat) return null;
    const [seats] = await deps.db.select({ n: count() }).from(jurySeats).where(eq(jurySeats.panelId, seat.panel.id));
    const view = await jurorView(deps.db, caller.user.id);
    return {
      id: seat.panel.id,
      period: seat.panel.period,
      seedCommitment: seat.panel.seedCommitment,
      seed: seat.panel.seed,
      openedAt: iso(seat.panel.openedAt),
      closedAt: isoOrNull(seat.panel.closedAt),
      seats: seats?.n ?? 0,
      cases: view?.cases.length ?? 0,
    };
  }),

  cases: os.jury.cases.handler(async ({ context }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const view = await jurorView(deps.db, caller.user.id);
    if (!view) return [];
    return toJuryCases(deps, view, await localeOf(context));
  }),

  vote: os.jury.vote.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const view = await jurorView(deps.db, caller.user.id);
    if (!view) throw precondition("jury_not_seated", "You do not sit on an open jury panel");
    const outcome = await deps.db
      .transaction(async (tx) => {
        const r = await castVote(tx, view, input.id, input.vote, input.reasonCode);
        if (r === "ok")
          await audit(tx, {
            actorType: "user",
            actorId: caller.user.id,
            action: "jury.vote",
            subjectType: "jury_case",
            subjectId: input.id,
            details: { panelId: view.panel.id },
          });
        return r;
      })
      .catch((err: unknown) => {
        // The trigger: the panel closed or the case was withdrawn meanwhile.
        if (pgCode(err) === "23514") return "closed" as const;
        throw err;
      });
    if (outcome === "not_found") throw notFound("Case not found");
    if (outcome === "already_voted") throw conflict("You already voted on this case");
    if (outcome === "closed") throw conflict("This case no longer takes votes");
    const [dto] = await toJuryCases(deps, view, await localeOf(context), new Set([input.id]));
    if (!dto) throw apiError("NOT_FOUND", "Case not found");
    return dto;
  }),

  results: os.jury.results.handler(async ({ context, input }) =>
    juryResults(context.deps.db, input.period, await localeOf(context)),
  ),

  flags: {
    list: os.jury.flags.list.handler(async ({ context, input }) => {
      const { deps } = context;
      const cur = decodeCursor(input.cursor, isKeyCursor);
      const rows = await deps.db
        .select({
          id: juryFlags.id,
          caseId: juryFlags.caseId,
          createdAt: juryFlags.createdAt,
          resolvedAt: juryFlags.resolvedAt,
          panelId: juryCases.panelId,
          subjectKind: juryCases.subjectKind,
          subjectId: juryCases.subjectId,
        })
        .from(juryFlags)
        .innerJoin(juryCases, eq(juryCases.id, juryFlags.caseId))
        .innerJoin(juryPanels, eq(juryPanels.id, juryCases.panelId))
        .where(
          and(
            input.open ? isNull(juryFlags.resolvedAt) : isNotNull(juryFlags.resolvedAt),
            cur
              ? or(
                  lt(juryFlags.createdAt, new Date(cur.t)),
                  and(eq(juryFlags.createdAt, new Date(cur.t)), lt(juryFlags.id, cur.id)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(juryFlags.createdAt), desc(juryFlags.id))
        .limit(input.limit + 1);
      const caseIds = rows.map((r) => r.caseId);
      const votes = caseIds.length
        ? await deps.db
            .select({ caseId: juryVotes.caseId, vote: juryVotes.vote })
            .from(juryVotes)
            .where(inArray(juryVotes.caseId, caseIds))
        : [];
      return pageOf(
        rows,
        input.limit,
        (r): z.infer<typeof JuryFlag> => {
          const mine = votes.filter((v) => v.caseId === r.caseId);
          return {
            id: r.id,
            caseId: r.caseId,
            panelId: r.panelId,
            subjectKind: r.subjectKind,
            subjectId: r.subjectId,
            disagree: mine.filter((v) => v.vote === "disagree").length,
            votes: mine.length,
            createdAt: iso(r.createdAt),
            resolvedAt: isoOrNull(r.resolvedAt),
          };
        },
        (last) => encodeCursor({ t: last.createdAt.toISOString(), id: last.id }),
      );
    }),
  },
};
