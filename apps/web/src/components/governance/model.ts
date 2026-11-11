// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure decisions for the readable governance pages (overhaul D6.2 and D6.3): the vote rule a
 * proposal is measured against, the next step and its deadline, the result bars with their
 * threshold ticks, a council seat's share of contribution and the council page's order. The API
 * and the database decide every rule; these only choose what the pages show.
 */
import type { CouncilDto, ElectionDto, ProposalDto, SettingDto } from "../../lib/coop.ts";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const at = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && key in value ? (value as Record<string, unknown>)[key] : undefined;

// ── The rule a vote is measured against ───────────────────────────────────────────────────────

export interface VoteRule {
  /** Minimum turnout, a fraction of the electorate. */
  quorum: number;
  /** Yes share of yes + no needed member-wide. */
  threshold: number;
  /** Protected decisions only: the streamer class's own quorum and majority. */
  streamerQuorum: number | null;
  streamerThreshold: number | null;
}

/**
 * The current rule for a proposal's kind from `coop.settings`: `governance.ordinary` or
 * `governance.protections`. The electorate's rule is frozen when voting opens, so for an open
 * vote this is the rule today (the same unless members changed it meanwhile); decided proposals
 * read theirs from the tally instead (`checkThreshold`). Null when the setting is unreadable.
 */
export function voteRule(
  kind: ProposalDto["kind"],
  settings: readonly Pick<SettingDto, "key" | "value">[] | null,
): VoteRule | null {
  if (!settings) return null;
  if (kind === "protected") {
    const v = settings.find((s) => s.key === "governance.protections")?.value;
    const quorum = num(at(v, "quorum"));
    const threshold = num(at(v, "memberWideThreshold"));
    if (quorum === null || threshold === null) return null;
    return {
      quorum,
      threshold,
      streamerQuorum: num(at(v, "streamerClassQuorum")),
      streamerThreshold: num(at(v, "streamerClassThreshold")),
    };
  }
  const v = settings.find((s) => s.key === "governance.ordinary")?.value;
  const quorum = num(at(v, "quorum"));
  const threshold = num(at(v, "threshold"));
  if (quorum === null || threshold === null) return null;
  return { quorum, threshold, streamerQuorum: null, streamerThreshold: null };
}

/**
 * The threshold a tally check was measured against, from its detail ("…, at least 20.00%
 * required"): the rule as it stood when voting opened. Null when the detail has no such clause.
 */
export function checkThreshold(detail: string): number | null {
  const m = /(?:at least|more than) (\d+(?:\.\d+)?)% required/.exec(detail);
  if (!m?.[1]) return null;
  const pct = Number(m[1]);
  // The detail has two decimals: round to them so 66.67% is 0.6667, not 0.6667000000000001.
  return Number.isFinite(pct) ? Math.round(pct * 100) / 10_000 : null;
}

// ── Participation and results ─────────────────────────────────────────────────────────────────

/** voted / eligible as a fraction (0 with nobody eligible). */
export const turnout = (voted: number, eligible: number): number => (eligible > 0 ? voted / eligible : 0);

export type TallyRule =
  | "member_wide_quorum"
  | "member_wide_threshold"
  | "streamer_class_quorum"
  | "streamer_class_majority";

export interface ResultBar {
  rule: string;
  /** "turnout" bars measure votes cast against the electorate; "yes" bars yes against yes + no. */
  measure: "turnout" | "yes";
  scope: "member_wide" | "streamer";
  value: number;
  /** The share needed (null when neither the check nor the settings say). */
  threshold: number | null;
  /** "more than" (the streamer majority) rather than "at least". */
  strict: boolean;
  passed: boolean;
  numerator: number;
  denominator: number;
}

type Tally = NonNullable<ProposalDto["tally"]>;

/**
 * One bar per rule the tally checked, in the tally's order: turnout against quorum, yes against
 * the threshold, and for protected decisions the same within the streamer class. Thresholds come
 * from the check (the rule when voting opened), else from `fallback`.
 */
export function resultBars(tally: Tally, fallback: VoteRule | null = null): ResultBar[] {
  const { memberWide: m, byClass } = tally.breakdown;
  const s = byClass.streamer ?? { yes: 0, no: 0, abstain: 0, eligible: 0 };
  return tally.breakdown.checks.flatMap((check): ResultBar[] => {
    const parsed = checkThreshold(check.detail);
    switch (check.rule) {
      case "member_wide_quorum": {
        const cast = m.yes + m.no + m.abstain;
        return [
          {
            rule: check.rule,
            measure: "turnout",
            scope: "member_wide",
            value: turnout(cast, m.eligible),
            threshold: parsed ?? fallback?.quorum ?? null,
            strict: false,
            passed: check.passed,
            numerator: cast,
            denominator: m.eligible,
          },
        ];
      }
      case "member_wide_threshold":
        return [
          {
            rule: check.rule,
            measure: "yes",
            scope: "member_wide",
            value: turnout(m.yes, m.yes + m.no),
            threshold: parsed ?? fallback?.threshold ?? null,
            strict: false,
            passed: check.passed,
            numerator: m.yes,
            denominator: m.yes + m.no,
          },
        ];
      case "streamer_class_quorum": {
        const cast = s.yes + s.no + s.abstain;
        return [
          {
            rule: check.rule,
            measure: "turnout",
            scope: "streamer",
            value: turnout(cast, s.eligible),
            threshold: parsed ?? fallback?.streamerQuorum ?? null,
            strict: false,
            passed: check.passed,
            numerator: cast,
            denominator: s.eligible,
          },
        ];
      }
      case "streamer_class_majority":
        return [
          {
            rule: check.rule,
            measure: "yes",
            scope: "streamer",
            value: turnout(s.yes, s.yes + s.no),
            threshold: parsed ?? fallback?.streamerThreshold ?? null,
            strict: true,
            passed: check.passed,
            numerator: s.yes,
            denominator: s.yes + s.no,
          },
        ];
      default:
        return [];
    }
  });
}

/** The rule that decided a proposal: the first failed check when rejected, else the yes threshold. */
export function decidingBar(bars: readonly ResultBar[], passed: boolean): ResultBar | null {
  if (!passed) return bars.find((b) => !b.passed) ?? null;
  return bars.find((b) => b.rule === "member_wide_threshold") ?? bars[0] ?? null;
}

// ── The next step ─────────────────────────────────────────────────────────────────────────────

export type NextStep =
  | { kind: "draft" }
  | { kind: "discussionEnds"; at: string | null }
  | { kind: "councilResponds"; at: string | null }
  | { kind: "votingCloses"; at: string | null }
  | { kind: "counting" }
  | { kind: "applying" }
  | { kind: "applied"; at: string | null }
  | { kind: "rejected"; at: string | null }
  | { kind: "withdrawn" };

/**
 * What happens next and when ("Voting closes in 6 days"). A voting proposal past its close reads
 * "counting" until the worker decides it.
 */
export function nextStep(p: Pick<ProposalDto, "status" | "timeline">, now: number): NextStep {
  const tl = p.timeline;
  switch (p.status) {
    case "draft":
      return { kind: "draft" };
    case "discussion":
      return { kind: "discussionEnds", at: tl.discussionEndsAt };
    case "council_review":
      return { kind: "councilResponds", at: tl.councilReviewEndsAt };
    case "voting":
      return tl.votingEndsAt !== null && Date.parse(tl.votingEndsAt) <= now
        ? { kind: "counting" }
        : { kind: "votingCloses", at: tl.votingEndsAt };
    case "passed":
      return { kind: "applying" };
    case "applied":
      return { kind: "applied", at: tl.appliedAt ?? tl.decidedAt };
    case "rejected":
      return { kind: "rejected", at: tl.decidedAt };
    case "withdrawn":
      return { kind: "withdrawn" };
  }
}

/** The first line of the body, cut at a word near `max` characters, for a card's excerpt. */
export function excerpt(body: string, max = 140): string {
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "";
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// ── Council ───────────────────────────────────────────────────────────────────────────────────

/** How many council seats the page shows before "Show all". */
export const COUNCIL_GRID = 12;
/** How many the `/coop` overview shows. */
export const COUNCIL_PREVIEW = 5;

/** Each score component in the term's `totals`, with the weight that blends it (`seatCouncil`). */
const SHARE_COMPONENTS = [
  ["revenueCents", "revenue"],
  ["eligibleHours", "streamingHours"],
  ["relayBytes", "relayBandwidth"],
  ["viewerHours", "viewerHours"],
] as const;

/**
 * A seat's share of contribution. The council score blends each component (revenue, streaming
 * hours, relay bandwidth, viewer hours) as that streamer's share of the eligible total, by the
 * term's weights; a component whose eligible total is 0 adds nothing (`seatCouncil`). So the
 * eligible scores sum to the weights of the components with a total above 0, and dividing by that
 * sum gives the share of all eligible streamers' contribution: with no relay traffic and a 0.2
 * relay weight, a lone streamer's 0.8 is 100%. Null when the term's weights or totals cannot be
 * read, or nothing was contributed: a share of the seated members alone would be a different
 * number under the same label.
 */
export function contributionShare(score: number, council: Pick<CouncilDto, "method"> | null): number | null {
  if (!Number.isFinite(score) || score < 0) return null;
  const weights = at(council?.method, "weights");
  const totals = at(council?.method, "totals");
  let sum = 0;
  for (const [component, weight] of SHARE_COMPONENTS) {
    const total = num(at(totals, component));
    if (total === null) return null;
    if (total <= 0) continue;
    const w = num(at(weights, weight));
    if (w === null || w < 0) return null;
    sum += w;
  }
  if (sum <= 0) return null;
  const share = score / sum;
  // Floating-point sums can land a hair past 1; anything clearly past is not this method's score.
  return share <= 1 + 1e-9 ? Math.min(share, 1) : null;
}

export interface SeatingFacts {
  size: number | null;
  windowDays: number | null;
  minHours: number | null;
  weights: { revenue: number; streamingHours: number; relayBandwidth: number; viewerHours: number } | null;
  eligible: number | null;
  candidates: number | null;
}

/** The parts of a term's method the "How seating works" explainer reads (each null when unreadable). */
export function seatingFacts(method: CouncilDto["method"] | null | undefined): SeatingFacts {
  const w = at(method, "weights");
  const weights = {
    revenue: num(at(w, "revenue")),
    streamingHours: num(at(w, "streamingHours")),
    relayBandwidth: num(at(w, "relayBandwidth")),
    viewerHours: num(at(w, "viewerHours")),
  };
  const allWeights = Object.values(weights).every((x) => x !== null);
  return {
    size: num(at(method, "size")),
    windowDays: num(at(method, "eligibilityWindowDays")) ?? num(at(method, "windowDays")),
    minHours: num(at(method, "minStreamingHours")),
    weights: allWeights ? (weights as SeatingFacts["weights"]) : null,
    eligible: num(at(method, "eligible")),
    candidates: num(at(method, "candidates")),
  };
}

/** Open elections (nominating or voting) first, the soonest deadline first; closed ones after, newest first. */
export function electionsInOrder(elections: readonly ElectionDto[]): ElectionDto[] {
  const deadline = (e: ElectionDto) => Date.parse(e.status === "nominating" ? e.nominationsCloseAt : e.votingEndsAt);
  const open = elections.filter((e) => e.status !== "closed").toSorted((a, b) => deadline(a) - deadline(b));
  const closed = elections.filter((e) => e.status === "closed");
  return [...open, ...closed];
}

export const hasOpenElection = (elections: readonly ElectionDto[] | null): boolean =>
  (elections ?? []).some((e) => e.status === "nominating" || e.status === "voting");
