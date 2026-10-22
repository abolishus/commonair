// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure parts of the `e5-coop` scenario (docs/testing/e5-selectors.md, "Scenario `e5-coop`"):
 * step prefixes, the stack's bootstrap settings, the proposal changes the run sends, the expected
 * tally per class, the patronage period, the audit/outbox expectations, the ballot-secrecy and
 * personal-data scans, and the compose override layering. Everything here is unit-tested; the
 * scenario and the drivers do the I/O.
 */

// ---------------------------------------------------------------- steps

export const COOP_STEPS = {
  1: "membership",
  2: "council",
  3: "revenue",
  4: "governance vote",
  5: "protected decision",
  6: "patronage",
  7: "transparency",
  8: "audit and outbox",
  9: "exit and refund",
} as const;
export type CoopStep = keyof typeof COOP_STEPS;
export const ALL_COOP_STEPS: readonly CoopStep[] = [1, 2, 3, 4, 5, 6, 7, 8, 9];
export const LAST_COOP_STEP: CoopStep = 9;

/**
 * `--set steps=`: `all`, or a prefix `1-N` (or `1`). Each step builds on the previous one, so a
 * step can only be selected together with every step before it.
 */
export function parseCoopSteps(value: string): CoopStep[] {
  const v = value.trim();
  if (v === "" || v === "all") return [...ALL_COOP_STEPS];
  const m = /^1(?:-(\d+))?$/.exec(v);
  const last = m ? Number(m[1] ?? "1") : Number.NaN;
  if (!m || !Number.isInteger(last) || last < 1 || last > LAST_COOP_STEP) {
    throw new Error(
      `steps must be "all" or a prefix 1-N with N in 1..${LAST_COOP_STEP} (each step builds on the previous one), got "${value}"`,
    );
  }
  return ALL_COOP_STEPS.filter((s) => s <= last);
}

// ---------------------------------------------------------------- stack bootstrap

/** The seeded `membership.classes` defaults (`packages/db/src/seed.ts`); the override carries the whole object per class. */
export const MEMBERSHIP_CLASSES_DEFAULTS = {
  streamer: { minStreamingHours: 10, windowDays: 90, minVerifiedViewers: 2, lapseGraceDays: 14 },
  viewer: {
    shareCents: 500,
    shareRefundableOnExit: true,
    activeSubscriptionQualifies: true,
    minSubscriptionCents: 300,
  },
  worker: { appointedBy: "board" },
} as const;

/**
 * `GOVERNANCE_BOOTSTRAP_JSON` for the e5-coop stack, exactly as the spec's "Stack and test hooks"
 * lists it. The seed shallow-merges each key into its default, so `membership.classes` carries
 * every class whole (the streamer threshold is 0.01 h = 36 s; everything else is the default).
 */
export const E5_GOVERNANCE_BOOTSTRAP = {
  "governance.protections": { councilReviewSeconds: 30, minVotingSeconds: 45, quorum: 0.01, streamerClassQuorum: 0.01 },
  "governance.ordinary": { discussionSeconds: 30, minVotingSeconds: 45, votingSeconds: 45, quorum: 0.01 },
  "membership.classes": {
    streamer: { ...MEMBERSHIP_CLASSES_DEFAULTS.streamer, minStreamingHours: 0.01 },
    viewer: { ...MEMBERSHIP_CLASSES_DEFAULTS.viewer },
    worker: { ...MEMBERSHIP_CLASSES_DEFAULTS.worker },
  },
  "council.config": { minStreamingHours: 0.01 },
} as const;

/** The seed's rule: each override key is shallow-merged into that key's default value. */
export function shallowMergeSettings(
  defaults: Readonly<Record<string, unknown>>,
  overrides: Readonly<Record<string, Record<string, unknown>>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(defaults)) {
    const o = overrides[key];
    out[key] =
      o && typeof value === "object" && value !== null ? { ...(value as Record<string, unknown>), ...o } : value;
  }
  return out;
}

/** Longest discussion period the scenario accepts (else the stack was not bootstrapped for it). */
export const MAX_DISCUSSION_SECONDS = 60;

export const RESET_HINT =
  "the e5-coop stack needs short governance periods, which are fixed at the database's first migration (ADR 0020): " +
  "recreate the Postgres volume once and start the stack with harness/compose.e5-coop.yaml " +
  "(podman compose down && podman volume rm commonair_postgres-data && " +
  "podman compose -f compose.yaml -f harness/compose.e5-coop.yaml up -d)";

export interface Preflight {
  ok: boolean;
  problem: string | null;
}

/** Check the stack's `governance.ordinary.discussionSeconds` before anything else runs. */
export function preflightGovernance(settings: readonly { key: string; value: unknown }[]): Preflight {
  const ordinary = settings.find((s) => s.key === "governance.ordinary")?.value as
    | { discussionSeconds?: unknown }
    | undefined;
  const seconds = ordinary?.discussionSeconds;
  if (typeof seconds !== "number") {
    return { ok: false, problem: `governance.ordinary.discussionSeconds is missing; ${RESET_HINT}` };
  }
  if (seconds > MAX_DISCUSSION_SECONDS) {
    return {
      ok: false,
      problem: `governance.ordinary.discussionSeconds is ${seconds} (> ${MAX_DISCUSSION_SECONDS}); ${RESET_HINT}`,
    };
  }
  return { ok: true, problem: null };
}

/** Periods of the stack (seconds) the waits are sized from. */
export interface GovernancePeriods {
  discussionSeconds: number;
  councilReviewSeconds: number;
  votingSeconds: number;
  protectedVotingSeconds: number;
}

export function governancePeriods(settings: readonly { key: string; value: unknown }[]): GovernancePeriods {
  const get = (key: string) => (settings.find((s) => s.key === key)?.value ?? {}) as Record<string, unknown>;
  const n = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const ordinary = get("governance.ordinary");
  const protections = get("governance.protections");
  const voting = n(ordinary.votingSeconds, 45);
  return {
    discussionSeconds: n(ordinary.discussionSeconds, 30),
    councilReviewSeconds: n(protections.councilReviewSeconds, 30),
    votingSeconds: voting,
    protectedVotingSeconds: Math.max(voting, n(protections.minVotingSeconds, 45)),
  };
}

// ---------------------------------------------------------------- council seating

/** The seed's `council.config.size`, used when the stack's setting carries none. */
export const DEFAULT_COUNCIL_SIZE = 7;

/** `council.config.size` from `coop.settings`. */
export function councilSize(settings: readonly { key: string; value: unknown }[]): number {
  const config = settings.find((s) => s.key === "council.config")?.value as { size?: unknown } | undefined;
  const size = config?.size;
  return typeof size === "number" && Number.isInteger(size) && size > 0 ? size : DEFAULT_COUNCIL_SIZE;
}

export const COUNCIL_HINT =
  "streamers from earlier runs (e5-coop, e4b-money, trust-safety) stay active streamer members on a long-lived " +
  "stack; reset the stack (recreate the Postgres volume) or raise council.config.size in the bootstrap";

export interface CouncilOutlookInput {
  /** `council.config.size`. */
  size: number;
  /** Every active streamer member (the council candidates), S1 and S2 included. */
  activeStreamers: readonly string[];
  /** Seats of the current term (empty when there is none). */
  seated: readonly string[];
  /** The run's streamers who must be seated. */
  wanted: readonly string[];
}

/**
 * Whether the next `council-recompute` is certain to seat `wanted`, mirroring `reseatReason` and
 * `seatCouncil`: with at most `size` candidates every eligible one is seated as soon as a reseat
 * is due, and a missing candidate in a full term means a seat holder is no longer a streamer
 * member (a vacancy, so a reseat). With more candidates than seats, a full term without a vacancy
 * stands for the month, and a reseat ranks the run's streamers (seconds of streaming, no revenue
 * yet) below established ones. Returns null when seating is certain, else why it is not.
 */
export function councilSeatingProblem(input: CouncilOutlookInput): string | null {
  const active = new Set(input.activeStreamers);
  const seated = new Set(input.seated);
  if (input.wanted.every((id) => seated.has(id))) return null;
  const inactive = input.wanted.filter((id) => !active.has(id));
  if (inactive.length > 0) {
    return `${inactive.length} of the run's streamers are not active streamer members, so no recompute can seat them`;
  }
  if (active.size <= input.size) return null;
  const vacancy = input.seated.some((id) => !active.has(id));
  if (input.seated.length >= input.size && !vacancy) {
    return (
      `the current council term is full (${input.seated.length}/${input.size} seats, no vacancy) and ` +
      `${active.size} active streamer members compete, so no reseat is due this month; ${COUNCIL_HINT}`
    );
  }
  return (
    `${active.size} active streamer members compete for ${input.size} council seats, so the run's streamers ` +
    `(seconds of streaming, no revenue yet) are likely outranked; ${COUNCIL_HINT}`
  );
}

// ---------------------------------------------------------------- proposal changes

/** The run's `spotlightSlots`: alternate 4/5 so each run really changes the setting. */
export function nextSpotlightSlots(current: unknown): 4 | 5 {
  return current === 4 ? 5 : 4;
}

/**
 * The `discovery.ranking` change: the **whole** current value with `spotlightSlots` replaced
 * (the API validates a change against the setting's full shape and applies it wholesale).
 */
export function rankingChange(current: unknown): { key: "discovery.ranking"; value: Record<string, unknown> } {
  if (typeof current !== "object" || current === null || Array.isArray(current)) {
    throw new Error("coop.settings has no discovery.ranking object");
  }
  const value = { ...(current as Record<string, unknown>) };
  value.spotlightSlots = nextSpotlightSlots(value.spotlightSlots);
  return { key: "discovery.ranking", value };
}

export const PROTECTED_STREAMER_SHARE = 0.85;

/** The `platform.cut` change of the protected proposal: streamer 0.85, the co-op the rest (exact to 1e-6). */
export function cutChange(
  current: unknown,
  streamerShare = PROTECTED_STREAMER_SHARE,
): { key: "platform.cut"; value: Record<string, unknown> } {
  if (typeof current !== "object" || current === null || Array.isArray(current)) {
    throw new Error("coop.settings has no platform.cut object");
  }
  const coopShare = Math.round((1 - streamerShare) * 1_000_000) / 1_000_000;
  return { key: "platform.cut", value: { ...(current as Record<string, unknown>), streamerShare, coopShare } };
}

/** Structural equality for setting values (JSON-shaped data, key order ignored). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  return (
    ka.length === kb.length &&
    ka.every((k, i) => k === kb[i] && sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
}

// ---------------------------------------------------------------- proposals and tallies

export const PROPOSAL_ORDER = {
  draft: 0,
  discussion: 1,
  council_review: 2,
  voting: 3,
  passed: 4,
  rejected: 4,
  applied: 5,
  withdrawn: -1,
} as const;
export type ProposalStatus = keyof typeof PROPOSAL_ORDER;

/**
 * True once a proposal has reached `target` or moved past it. Decided proposals branch:
 * `passed` covers `applied`, `rejected` is only itself, and both are past every open status.
 */
export function reached(status: string, target: ProposalStatus): boolean {
  if (status === target) return true;
  if (target === "passed") return status === "applied";
  if (target === "rejected" || target === "applied" || target === "withdrawn") return false;
  const s = PROPOSAL_ORDER[status as ProposalStatus];
  return s !== undefined && s >= PROPOSAL_ORDER[target];
}

/** True when a proposal moved past `status` without stopping where the scenario must act. */
export function missed(status: string, mustSee: ProposalStatus): boolean {
  return status !== mustSee && reached(status, mustSee);
}

export type MemberClass = "streamer" | "viewer" | "worker";
export const MEMBER_CLASSES: readonly MemberClass[] = ["streamer", "viewer", "worker"];
export type Choice = "yes" | "no" | "abstain";
export const VOTE_CHOICES: readonly Choice[] = ["yes", "no", "abstain"];

export interface Count {
  yes: number;
  no: number;
  abstain: number;
}
export interface ObservedCount extends Count {
  eligible: number;
}

export interface CastVote {
  /** The voter's active classes when the vote opened (the frozen electorate's classes). */
  classes: readonly MemberClass[];
  choice: Choice;
}

const zero = (): Count => ({ yes: 0, no: 0, abstain: 0 });

/** The counts the votes this run casts add, member-wide and per class (a member counts once per class). */
export function expectedTally(votes: readonly CastVote[]): { memberWide: Count; byClass: Record<MemberClass, Count> } {
  const memberWide = zero();
  const byClass: Record<MemberClass, Count> = { streamer: zero(), viewer: zero(), worker: zero() };
  for (const v of votes) {
    memberWide[v.choice]++;
    for (const c of new Set(v.classes)) byClass[c][v.choice]++;
  }
  return { memberWide, byClass };
}

export interface TallyMismatch {
  scope: "member_wide" | MemberClass;
  field: keyof ObservedCount;
  expected: number;
  observed: number | null;
}

/**
 * Compare the observed tally with the votes cast. Every vote was cast by this run, so yes/no/
 * abstain must match exactly; the electorate may hold members of earlier runs or other scenarios,
 * so `eligible` only has to cover the voters.
 */
export function tallyMismatches(
  expected: { memberWide: Count; byClass: Record<MemberClass, Count> },
  observed: { memberWide: ObservedCount; byClass: Partial<Record<string, ObservedCount>> },
): TallyMismatch[] {
  const out: TallyMismatch[] = [];
  const compare = (scope: TallyMismatch["scope"], want: Count, got: ObservedCount | undefined) => {
    for (const field of ["yes", "no", "abstain"] as const) {
      if (got?.[field] !== want[field])
        out.push({ scope, field, expected: want[field], observed: got?.[field] ?? null });
    }
    const voters = want.yes + want.no + want.abstain;
    if (got === undefined || got.eligible < voters)
      out.push({ scope, field: "eligible", expected: voters, observed: got?.eligible ?? null });
  };
  compare("member_wide", expected.memberWide, observed.memberWide);
  for (const c of MEMBER_CLASSES) compare(c, expected.byClass[c], observed.byClass[c]);
  return out;
}

export const STREAMER_MAJORITY_NOT_MET = "streamer-class majority not met";

// ---------------------------------------------------------------- patronage

/** Rounded up to a whole `unitMs` (a period must start at or after the instant given). */
export function ceilTo(d: Date, unitMs = 1_000): Date {
  return new Date(Math.ceil(d.getTime() / unitMs) * unitMs);
}

/** Rounded down to a whole `unitMs`. */
export function floorTo(d: Date, unitMs = 1_000): Date {
  return new Date(Math.floor(d.getTime() / unitMs) * unitMs);
}

/** Period boundaries through the API: whole seconds. */
export const API_PERIOD_UNIT_MS = 1_000;
/**
 * Through the web form: whole minutes, which every `datetime-local` input accepts whatever its
 * `step` (a seconds value can fail native step validation). The tip is minutes inside the period.
 */
export const WEB_PERIOD_UNIT_MS = 60_000;

/**
 * The run's patronage period: `[scenario start, now − 1 s)` rounded inward to whole `unitMs`,
 * starting after any period already on the instance (closed periods may not overlap), or null
 * when nothing is left.
 */
export function choosePatronagePeriod(
  runStart: Date,
  now: Date,
  existing: readonly { periodEnd: string }[],
  unitMs = API_PERIOD_UNIT_MS,
): { start: Date; end: Date } | null {
  let start = ceilTo(runStart, unitMs);
  for (const p of existing) {
    const end = new Date(p.periodEnd);
    if (!Number.isNaN(end.getTime()) && end > start) start = ceilTo(end, unitMs);
  }
  const end = floorTo(new Date(now.getTime() - 1_000), unitMs);
  return start < end ? { start, end } : null;
}

/**
 * `<input type="datetime-local">` value in UTC: `2026-10-21T09:05` on a whole minute, else with
 * seconds (`2026-10-21T09:05:03`).
 */
export function datetimeLocalUtc(d: Date): string {
  const iso = d.toISOString();
  return d.getTime() % 60_000 === 0 ? iso.slice(0, 16) : iso.slice(0, 19);
}

/** `YYYY-MM` of an instant in UTC. */
export function utcMonthOf(d: Date | string): string {
  return new Date(d).toISOString().slice(0, 7);
}

// ---------------------------------------------------------------- audit and outbox

export interface AuditRow {
  action: string;
  actorType: string;
  actorId: string | null;
  subjectType: string;
  subjectId: string;
  details: unknown;
}

export interface EventRow {
  type: string;
  payload: unknown;
}

export interface AuditExpectation {
  action: string;
  actorType: string;
  /** The acting user (null: any, e.g. the system). */
  actorId: string | null;
  /** An id the row must reference, as its subject or inside its details. */
  mentions: string;
  /** What the report calls it (ids and names of roles only). */
  label: string;
}

export interface EventExpectation {
  type: string;
  /** An id the payload must contain. */
  mentions: string;
  /** Payload fields that must equal these values (e.g. `{ status: "discussion" }`). */
  where?: Record<string, string | number | boolean>;
  label: string;
}

function mentionsId(value: unknown, id: string): boolean {
  if (value === null || value === undefined) return false;
  return JSON.stringify(value).includes(id);
}

export function auditMatches(row: AuditRow, e: AuditExpectation): boolean {
  return (
    row.action === e.action &&
    row.actorType === e.actorType &&
    (e.actorId === null || row.actorId === e.actorId) &&
    (row.subjectId === e.mentions || mentionsId(row.details, e.mentions))
  );
}

export function eventMatches(row: EventRow, e: EventExpectation): boolean {
  if (row.type !== e.type || !mentionsId(row.payload, e.mentions)) return false;
  if (!e.where) return true;
  const p = (row.payload ?? {}) as Record<string, unknown>;
  return Object.entries(e.where).every(([k, v]) => p[k] === v);
}

export function missingAudit(expected: readonly AuditExpectation[], rows: readonly AuditRow[]): AuditExpectation[] {
  return expected.filter((e) => !rows.some((r) => auditMatches(r, e)));
}

export function missingEvents(expected: readonly EventExpectation[], rows: readonly EventRow[]): EventExpectation[] {
  return expected.filter((e) => !rows.some((r) => eventMatches(r, e)));
}

/** Actions and event types whose rows concern a ballot: any vote-choice value there is a leak. */
export const BALLOT_ACTIONS = new Set(["proposal.vote", "election.vote"]);
export const BALLOT_EVENTS = new Set(["coop.vote.cast"]);
/** Keys that would carry a choice wherever they appear. */
export const CHOICE_KEYS = new Set(["choice", "vote", "myVote", "my_vote"]);

export type LeakKind = "vote-choice" | "comment-body" | "email";

export interface Leak {
  /** `audit:<action>` or `event:<type>`: never the matching text. */
  source: string;
  kind: LeakKind;
}

/** Walk JSON: keys that name a choice, and string values (lowercased) found anywhere. */
function walk(value: unknown, onKey: (k: string, v: unknown) => void, onString: (s: string) => void): void {
  if (typeof value === "string") onString(value);
  else if (Array.isArray(value)) for (const v of value) walk(v, onKey, onString);
  else if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      onKey(k, v);
      walk(v, onKey, onString);
    }
  }
}

/**
 * Personal data or ballot contents inside one audit `details` or event payload. A ballot row
 * (`proposal.vote`, `coop.vote.cast`) must hold no choice value at all; any row is a leak when a
 * key names a choice with a choice value, or when it contains a comment body or an email.
 */
export function leaksIn(
  source: string,
  value: unknown,
  opts: { ballot: boolean; commentBodies: readonly string[]; emails: readonly string[] },
): Leak[] {
  const kinds = new Set<LeakKind>();
  const choices = new Set<string>(VOTE_CHOICES);
  walk(
    value,
    (k, v) => {
      if (CHOICE_KEYS.has(k) && typeof v === "string" && choices.has(v.trim().toLowerCase())) kinds.add("vote-choice");
    },
    (s) => {
      if (opts.ballot && choices.has(s.trim().toLowerCase())) kinds.add("vote-choice");
    },
  );
  const text = value === undefined ? "" : JSON.stringify(value);
  const lower = text.toLowerCase();
  if (opts.commentBodies.some((b) => b.length > 0 && text.includes(b))) kinds.add("comment-body");
  if (opts.emails.some((e) => e.includes("@") && lower.includes(e.toLowerCase()))) kinds.add("email");
  return [...kinds].map((kind) => ({ source, kind }));
}

/** Every leak in the audit and event rows the scenario read, grouped by source and kind. */
export function rowLeaks(
  audit: readonly AuditRow[],
  events: readonly EventRow[],
  opts: { commentBodies: readonly string[]; emails: readonly string[] },
): Leak[] {
  const out = new Map<string, Leak>();
  const add = (l: Leak) => out.set(`${l.source}\u0000${l.kind}`, l);
  for (const r of audit)
    for (const l of leaksIn(`audit:${r.action}`, r.details, { ...opts, ballot: BALLOT_ACTIONS.has(r.action) })) add(l);
  for (const r of events)
    for (const l of leaksIn(`event:${r.type}`, r.payload, { ...opts, ballot: BALLOT_EVENTS.has(r.type) })) add(l);
  return [...out.values()].sort((a, b) => a.source.localeCompare(b.source) || a.kind.localeCompare(b.kind));
}

// ---------------------------------------------------------------- service logs

/** A choice logged under a choice key, in JSON or key=value form. */
export const CHOICE_FIELD_PATTERN = /["']?\b(?:choice|myVote|my_vote|vote)["']?\s*[:=]\s*["']?(?:yes|no|abstain)\b/i;
/** A choice as a quoted value (JSON logs), used only on lines that name a voter. */
const QUOTED_CHOICE = /["'](?:yes|no|abstain)["']/i;

export interface LogLeak {
  source: string;
  line: number;
  kind: LeakKind;
}

/**
 * Lines of one service's log that tie a vote choice to a user (a choice field, or a voter's id or
 * username next to a quoted choice), or carry a comment body or an email. Returns positions and
 * kinds only, never the text.
 */
export function scanCoopLog(
  source: string,
  text: string,
  needles: { voters: readonly string[]; commentBodies: readonly string[]; emails: readonly string[] },
): LogLeak[] {
  const out: LogLeak[] = [];
  const emails = needles.emails.filter((e) => e.includes("@")).map((e) => e.toLowerCase());
  const bodies = needles.commentBodies.filter((b) => b.length >= 8);
  const voters = needles.voters.filter((v) => v.length >= 3);
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.length === 0) continue;
    const kinds = new Set<LeakKind>();
    if (CHOICE_FIELD_PATTERN.test(line) || (QUOTED_CHOICE.test(line) && voters.some((v) => line.includes(v))))
      kinds.add("vote-choice");
    if (bodies.some((b) => line.includes(b))) kinds.add("comment-body");
    const lower = line.toLowerCase();
    if (emails.some((e) => lower.includes(e))) kinds.add("email");
    for (const kind of kinds) out.push({ source, line: i + 1, kind });
  }
  return out;
}

export function summarizeLogLeaks(leaks: readonly LogLeak[]): { source: string; kind: LeakKind; count: number }[] {
  const by = new Map<string, { source: string; kind: LeakKind; count: number }>();
  for (const l of leaks) {
    const key = `${l.source}\u0000${l.kind}`;
    const e = by.get(key);
    if (e) e.count++;
    else by.set(key, { source: l.source, kind: l.kind, count: 1 });
  }
  return [...by.values()].sort((a, b) => a.source.localeCompare(b.source) || a.kind.localeCompare(b.kind));
}

// ---------------------------------------------------------------- compose override layering

export interface ComposeFile {
  services?: Record<string, { environment?: unknown; volumes?: unknown } | null>;
}

export interface LayeredCompose {
  /** Per service, the environment the overrides set after layering (later files win). */
  env: Record<string, Record<string, string>>;
  /** Keys two overrides set to different values for the same service. */
  conflicts: { service: string; key: string }[];
  /** Services whose `environment` is not a mapping (compose would replace a list instead of merging). */
  notMappings: { file: number; service: string }[];
}

/** Layer compose override files the way `podman compose -f a -f b` merges `environment` mappings. */
export function layerComposeEnv(files: readonly ComposeFile[]): LayeredCompose {
  const env: Record<string, Record<string, string>> = {};
  const conflicts: { service: string; key: string }[] = [];
  const notMappings: { file: number; service: string }[] = [];
  files.forEach((f, i) => {
    for (const [service, def] of Object.entries(f.services ?? {})) {
      const e = def?.environment;
      if (e === undefined) continue;
      if (typeof e !== "object" || e === null || Array.isArray(e)) {
        notMappings.push({ file: i, service });
        continue;
      }
      const target = (env[service] ??= {});
      for (const [key, raw] of Object.entries(e as Record<string, unknown>)) {
        const value = String(raw);
        if (key in target && target[key] !== value) conflicts.push({ service, key });
        target[key] = value;
      }
    }
  });
  return { env, conflicts, notMappings };
}

// ---------------------------------------------------------------- report

/** Run-unique comment text: it becomes a log and payload needle and never enters the report. */
export function commentText(runId: string, who: string): string {
  return `harness e5 comment ${who} ${runId}`;
}
