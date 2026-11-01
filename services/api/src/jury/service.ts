// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The advisory jury's reads and the juror's vote (ADR 0038, batch 7 decision (u)). The worker
 * draws and closes panels (`services/worker/src/jury/`); here a juror reads the cases of the open
 * panel they sit on (pseudonyms only, never a username, never the reporter; media as data URLs the
 * web blurs until revealed), votes once per case, and anyone reads the published results.
 *
 * Nothing here writes `moderation_cases`, `reports`, account actions or statements of reasons.
 */
import type { JuryCase, JuryResults } from "@commonair/contracts/dto";
import type { JuryReasonCode, JuryVote, ModerationTier } from "@commonair/contracts/enums";
import { schema, type Executor } from "@commonair/db";
import { parseRuleRef } from "@commonair/moderation";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Deps } from "../deps.ts";
import { clauseTitleIn } from "../transparency/enforcement.ts";
import {
  isConflicted,
  JURY_SETTING_KEYS,
  parseJurySettings,
  publishTally,
  tallyByClause,
  type CaseInvolvement,
  type JurySettings,
  type ResultVote,
} from "./rules.ts";

const {
  juryPanels,
  jurySeats,
  juryCases,
  juryVotes,
  moderationCases: mc,
  moderationFlags,
  reports,
  channels,
  channelRoles,
  legalHolds,
  chatMessages,
  governanceSettings,
} = schema;

/** At most this many evidence items per case (the contract's cap is 20). */
const MAX_TEXT_ITEMS = 10;
const MAX_TEXT_CHARS = 500;
/** One review frame per case keeps the case list light. */
const MAX_FRAMES = 1;

export async function readJurySettings(db: Executor): Promise<JurySettings> {
  const rows = await db
    .select({ key: governanceSettings.key, value: governanceSettings.value })
    .from(governanceSettings)
    .where(inArray(governanceSettings.key, [...JURY_SETTING_KEYS]));
  return parseJurySettings(rows);
}

export type PanelRow = typeof juryPanels.$inferSelect;

/** The open panel the user sits on, with their seat; null when none. */
export async function openSeat(db: Executor, userId: string): Promise<{ panel: PanelRow; seatId: string } | null> {
  const [row] = await db
    .select({ panel: juryPanels, seatId: jurySeats.id })
    .from(jurySeats)
    .innerJoin(juryPanels, eq(juryPanels.id, jurySeats.panelId))
    .where(and(eq(jurySeats.userId, userId), isNull(juryPanels.closedAt)))
    .orderBy(desc(juryPanels.openedAt))
    .limit(1);
  return row ?? null;
}

type CaseRow = typeof juryCases.$inferSelect;

interface CaseFacts {
  involvement: CaseInvolvement;
  tier: ModerationTier | null;
  outcome: string;
  automated: boolean;
  /** Users or the case itself under an active legal hold: hidden until the close withdraws it. */
  holdIds: string[];
  evidence: JuryCase["evidence"];
  frameKeys: string[];
}

function textItems(evidence: Record<string, unknown>): JuryCase["evidence"] {
  const out: string[] = [];
  const body = (evidence as { body?: unknown }).body;
  if (typeof body === "string") out.push(body);
  const messages = (evidence as { messages?: unknown }).messages;
  if (Array.isArray(messages))
    for (const m of messages) {
      const b = typeof m === "object" && m !== null ? (m as { body?: unknown }).body : undefined;
      if (typeof b === "string") out.push(b);
    }
  return out
    .slice(0, MAX_TEXT_ITEMS)
    .map((value) => ({ kind: "text" as const, value: value.slice(0, MAX_TEXT_CHARS), contentWarning: false }));
}

/** What each sampled case is about, read from the case or report it names. */
async function caseFacts(db: Executor, cases: readonly CaseRow[]): Promise<Map<string, CaseFacts>> {
  const out = new Map<string, CaseFacts>();
  const caseIds = cases.filter((c) => c.subjectKind === "moderation_case").map((c) => c.subjectId);
  const reportIds = cases.filter((c) => c.subjectKind === "report").map((c) => c.subjectId);
  if (caseIds.length) {
    const rows = await db
      .select({
        id: mc.id,
        tier: mc.tier,
        status: mc.status,
        userId: mc.userId,
        channelId: mc.channelId,
        resolvedById: mc.resolvedById,
        ownerId: channels.ownerId,
      })
      .from(mc)
      .leftJoin(channels, eq(channels.id, mc.channelId))
      .where(inArray(mc.id, caseIds));
    const frames = await db
      .select({ caseId: moderationFlags.caseId, frameKey: moderationFlags.frameKey, tier: moderationFlags.tier })
      .from(moderationFlags)
      .where(inArray(moderationFlags.caseId, caseIds));
    for (const r of rows)
      out.set(r.id, {
        involvement: { channelId: r.channelId, partyIds: [r.userId, r.ownerId, r.resolvedById] },
        tier: r.tier,
        outcome: r.status,
        automated: r.resolvedById === null,
        holdIds: [r.id, ...[r.userId, r.ownerId].filter((x): x is string => x !== null)],
        evidence: [],
        // T0 material never leaves, whatever the row says (as `moderation.frame`).
        frameKeys: frames
          .filter((f) => f.caseId === r.id && f.tier !== "t0" && r.tier !== "t0" && f.frameKey !== null)
          .map((f) => f.frameKey as string)
          .slice(0, MAX_FRAMES),
      });
  }
  if (reportIds.length) {
    const rows = await db
      .select({
        id: reports.id,
        status: reports.status,
        subjectType: reports.subjectType,
        subjectId: reports.subjectId,
        reporterId: reports.reporterId,
        assigneeId: reports.assigneeId,
        channelId: reports.channelId,
        evidence: reports.evidence,
        ownerId: channels.ownerId,
      })
      .from(reports)
      .leftJoin(channels, eq(channels.id, reports.channelId))
      .where(inArray(reports.id, reportIds));
    const messageIds = rows.filter((r) => r.subjectType === "chat_message").map((r) => r.subjectId);
    const authors = new Map(
      (messageIds.length
        ? await db
            .select({ id: chatMessages.id, userId: chatMessages.userId })
            .from(chatMessages)
            .where(inArray(chatMessages.id, messageIds))
        : []
      ).map((m) => [m.id, m.userId]),
    );
    for (const r of rows) {
      const subjectUser =
        r.subjectType === "user" ? r.subjectId : r.subjectType === "chat_message" ? authors.get(r.subjectId) : null;
      const senders = Array.isArray((r.evidence as { messages?: unknown }).messages)
        ? ((r.evidence as { messages: unknown[] }).messages.flatMap((m) =>
            typeof m === "object" && m !== null && typeof (m as { userId?: unknown }).userId === "string"
              ? [(m as { userId: string }).userId]
              : [],
          ) as string[])
        : [];
      out.set(r.id, {
        involvement: {
          channelId: r.channelId,
          partyIds: [subjectUser ?? null, r.ownerId, r.reporterId, r.assigneeId, ...senders],
        },
        tier: null,
        outcome: r.status,
        automated: false,
        holdIds: [subjectUser, r.ownerId, r.reporterId, ...senders].filter((x): x is string => typeof x === "string"),
        evidence: textItems(r.evidence),
        frameKeys: [],
      });
    }
  }
  return out;
}

/** The clause's title in `locale`, or null for a case that cites none. */
function clauseTitle(ruleRef: string | null, locale: string): string | null {
  const ref = ruleRef ? parseRuleRef(ruleRef) : null;
  return ref ? clauseTitleIn(locale, ref.id, ref.version) : null;
}

async function frameData(deps: Deps, key: string): Promise<string | null> {
  try {
    const res = await deps.storage.get(deps.env.S3_BUCKET_MEDIA, key);
    if (!res) return null;
    return `data:image/jpeg;base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
  } catch {
    return null;
  }
}

export interface JurorView {
  panel: PanelRow;
  seatId: string;
  /** Cases the juror may see, in sampling order. */
  cases: { row: CaseRow; facts: CaseFacts }[];
}

/**
 * The juror's cases on their open panel: withdrawn cases, cases they are conflicted on, and cases
 * whose parties are now under a legal hold (the close withdraws those) are left out.
 */
export async function jurorView(db: Executor, userId: string): Promise<JurorView | null> {
  const seat = await openSeat(db, userId);
  if (!seat) return null;
  const rows = await db
    .select()
    .from(juryCases)
    .where(and(eq(juryCases.panelId, seat.panel.id), isNull(juryCases.withdrawnAt)))
    .orderBy(juryCases.createdAt, juryCases.id);
  const facts = await caseFacts(db, rows);
  const moderated = new Set(
    (
      await db
        .select({ channelId: channelRoles.channelId })
        .from(channelRoles)
        .where(and(eq(channelRoles.userId, userId), eq(channelRoles.role, "moderator")))
    ).map((r) => r.channelId),
  );
  const holds = await db
    .select({ userId: legalHolds.userId, caseId: legalHolds.caseId })
    .from(legalHolds)
    .where(isNull(legalHolds.releasedAt));
  const held = new Set(holds.flatMap((h) => (h.caseId ? [h.userId, h.caseId] : [h.userId])));
  const cases = rows.flatMap((row) => {
    const f = facts.get(row.subjectId);
    if (!f) return [];
    if (isConflicted(userId, f.involvement, moderated)) return [];
    if (f.holdIds.some((id) => held.has(id))) return [];
    return [{ row, facts: f }];
  });
  return { panel: seat.panel, seatId: seat.seatId, cases };
}

export async function toJuryCases(
  deps: Deps,
  view: JurorView,
  locale: string,
  only?: ReadonlySet<string>,
): Promise<JuryCase[]> {
  const list = only ? view.cases.filter((c) => only.has(c.row.id)) : view.cases;
  const ids = list.map((c) => c.row.id);
  const votes = ids.length
    ? await deps.db
        .select({ caseId: juryVotes.caseId, vote: juryVotes.vote, reasonCode: juryVotes.reasonCode })
        .from(juryVotes)
        .where(and(eq(juryVotes.seatId, view.seatId), inArray(juryVotes.caseId, ids)))
    : [];
  const mine = new Map(votes.map((v) => [v.caseId, { vote: v.vote, reasonCode: v.reasonCode }]));
  const out: JuryCase[] = [];
  for (const { row, facts } of list) {
    const frames: JuryCase["evidence"] = [];
    for (const key of facts.frameKeys) {
      const data = await frameData(deps, key);
      if (data) frames.push({ kind: "image", value: data, contentWarning: true });
    }
    out.push({
      id: row.id,
      subjectKind: row.subjectKind,
      ruleRef: row.ruleRef,
      clauseTitle: clauseTitle(row.ruleRef, locale),
      tier: facts.tier,
      outcome: facts.outcome,
      automated: facts.automated,
      subjectPseudonym: row.pseudonymMap.subject ?? "",
      evidence: [...facts.evidence, ...frames].slice(0, 20),
      myVote: mine.get(row.id) ?? null,
    });
  }
  return out;
}

export type VoteOutcome = "ok" | "not_seated" | "not_found" | "already_voted";

/** One vote, final: the 0046 trigger also refuses a non-seat, a closed panel and a withdrawn case. */
export async function castVote(
  db: Executor,
  view: JurorView,
  caseId: string,
  vote: JuryVote,
  reasonCode: JuryReasonCode,
): Promise<VoteOutcome> {
  if (!view.cases.some((c) => c.row.id === caseId)) return "not_found";
  const [row] = await db
    .insert(juryVotes)
    .values({ caseId, seatId: view.seatId, vote, reasonCode })
    .onConflictDoNothing()
    .returning({ id: juryVotes.id });
  return row ? "ok" : "already_voted";
}

/** `jury.results`: a closed panel's agreement per clause and tier, cells under k suppressed. */
export async function juryResults(db: Executor, period: string, locale: string): Promise<JuryResults> {
  const [panel] = await db.select().from(juryPanels).where(eq(juryPanels.period, period));
  if (!panel) return { period, panelSize: 0, seedCommitment: null, seed: null, rows: [] };
  const seats = await db.select({ id: jurySeats.id }).from(jurySeats).where(eq(jurySeats.panelId, panel.id));
  // Nothing is published while the panel sits: only its commitment.
  if (panel.closedAt === null)
    return { period, panelSize: seats.length, seedCommitment: panel.seedCommitment, seed: null, rows: [] };
  const votes = await db
    .select({
      vote: juryVotes.vote,
      ruleRef: juryCases.ruleRef,
      kind: juryCases.subjectKind,
      tier: mc.tier,
    })
    .from(juryVotes)
    .innerJoin(juryCases, eq(juryCases.id, juryVotes.caseId))
    .leftJoin(mc, and(eq(juryCases.subjectKind, "moderation_case"), eq(mc.id, juryCases.subjectId)))
    .where(and(eq(juryCases.panelId, panel.id), isNull(juryCases.withdrawnAt)));
  const grouped = tallyByClause(
    votes.flatMap((v): ResultVote[] => {
      const ref = v.ruleRef ? parseRuleRef(v.ruleRef) : null;
      if (!ref) return [];
      return [
        {
          clauseId: ref.id,
          clauseVersion: ref.version,
          tier: v.kind === "moderation_case" ? v.tier : null,
          vote: v.vote,
        },
      ];
    }),
  );
  return {
    period,
    panelSize: seats.length,
    seedCommitment: panel.seedCommitment,
    seed: panel.seed,
    rows: grouped.map((g) => ({
      clauseId: g.clauseId,
      clauseTitle: clauseTitleIn(locale, g.clauseId, g.clauseVersion),
      tier: g.tier,
      ...publishTally(g.tally),
    })),
  };
}
