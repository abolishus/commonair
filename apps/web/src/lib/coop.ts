// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure helpers for the co-op pages (E5): labels for the contract's enums, the proposal timeline
 * and author actions, the change editor's rows, membership and share rules read from the
 * settings, the decided tally's rows and the API's refusal reasons. The API decides everything;
 * these only shape what the pages show. Money stays integer cents with its currency.
 */
import type {
  CouncilView,
  ElectionView,
  GovernanceSetting,
  MembershipView,
  PatronagePeriodView,
  PatronageStatement,
  ProposalComment,
  ProposalView,
  ShareView,
  TransparencyMonth,
} from "@commonair/contracts/dto";
import {
  COUNCIL_STANCES,
  ELECTION_STATUSES,
  MEMBER_CLASSES,
  MEMBERSHIP_BASES,
  MEMBERSHIP_STATUSES,
  PATRONAGE_STATUSES,
  PROPOSAL_KINDS,
  PROPOSAL_STATUSES,
  SHARE_STATUSES,
  VOTE_CHOICES,
} from "@commonair/contracts/enums";
import type { PATRONAGE_COMPONENTS } from "@commonair/contracts/shapes";
import { z } from "zod";
import { t, type MessageKey } from "../i18n/index.ts";
import { errorCode } from "./api.ts";

export type MembershipViewDto = z.infer<typeof MembershipView>;
export type MembershipDto = MembershipViewDto["memberships"][number];
export type EligibilityDto = MembershipViewDto["eligibility"][number];
export type ShareDto = z.infer<typeof ShareView>;
export type SettingDto = z.infer<typeof GovernanceSetting>;
export type ProposalDto = z.infer<typeof ProposalView>;
export type ProposalCommentDto = z.infer<typeof ProposalComment>;
export type CouncilDto = z.infer<typeof CouncilView>;
export type ElectionDto = z.infer<typeof ElectionView>;
export type StatementDto = z.infer<typeof PatronageStatement>;
export type PatronagePeriodDto = z.infer<typeof PatronagePeriodView>;
export type CoopMonthDto = z.infer<typeof TransparencyMonth>;
export type BoardSeatDto = {
  user: { id: string; username: string; displayName: string };
  class: MemberClass;
  termStart: string;
  termEnd: string;
};

export type MemberClass = (typeof MEMBER_CLASSES)[number];
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];
export type MembershipBasis = (typeof MEMBERSHIP_BASES)[number];
export type ShareStatus = (typeof SHARE_STATUSES)[number];
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];
export type VoteChoice = (typeof VOTE_CHOICES)[number];
export type CouncilStance = (typeof COUNCIL_STANCES)[number];
export type PatronageStatus = (typeof PATRONAGE_STATUSES)[number];
export type ElectionStatus = (typeof ELECTION_STATUSES)[number];
export type PatronageComponent = (typeof PATRONAGE_COMPONENTS)[number];

export { COUNCIL_STANCES, MEMBER_CLASSES, PROPOSAL_STATUSES, SHARE_STATUSES, VOTE_CHOICES };

// ── Labels ────────────────────────────────────────────────────────────────────────────────────

const CLASS_KEYS: Record<MemberClass, MessageKey> = {
  streamer: "coop.class.streamer",
  viewer: "coop.class.viewer",
  worker: "coop.class.worker",
};
const MEMBERSHIP_STATUS_KEYS: Record<MembershipStatus, MessageKey> = {
  active: "coop.membershipStatus.active",
  lapsed: "coop.membershipStatus.lapsed",
  exited: "coop.membershipStatus.exited",
};
const BASIS_KEYS: Record<MembershipBasis, MessageKey> = {
  streaming_hours: "coop.basis.streaming_hours",
  share: "coop.basis.share",
  subscription: "coop.basis.subscription",
  board_appointment: "coop.basis.board_appointment",
};
const SHARE_STATUS_KEYS: Record<ShareStatus | "none", MessageKey> = {
  none: "coop.shareStatus.none",
  pending: "coop.shareStatus.pending",
  held: "coop.shareStatus.held",
  refund_pending: "coop.shareStatus.refund_pending",
  refunded: "coop.shareStatus.refunded",
  cancelled: "coop.shareStatus.cancelled",
};
const PROPOSAL_STATUS_KEYS: Record<ProposalStatus, MessageKey> = {
  draft: "coop.proposalStatus.draft",
  discussion: "coop.proposalStatus.discussion",
  council_review: "coop.proposalStatus.council_review",
  voting: "coop.proposalStatus.voting",
  passed: "coop.proposalStatus.passed",
  rejected: "coop.proposalStatus.rejected",
  withdrawn: "coop.proposalStatus.withdrawn",
  applied: "coop.proposalStatus.applied",
};
const KIND_KEYS: Record<ProposalKind, MessageKey> = {
  ordinary: "coop.kind.ordinary",
  protected: "coop.kind.protected",
};
const KIND_HINT_KEYS: Record<ProposalKind, MessageKey> = {
  ordinary: "coop.kind.ordinaryHint",
  protected: "coop.kind.protectedHint",
};
const STANCE_KEYS: Record<CouncilStance, MessageKey> = {
  support: "coop.stance.support",
  oppose: "coop.stance.oppose",
  mixed: "coop.stance.mixed",
  neutral: "coop.stance.neutral",
};
const VOTE_KEYS: Record<VoteChoice, MessageKey> = {
  yes: "coop.vote.choice.yes",
  no: "coop.vote.choice.no",
  abstain: "coop.vote.choice.abstain",
};
const VOTE_HINT_KEYS: Record<VoteChoice, MessageKey> = {
  yes: "coop.vote.choice.yesHint",
  no: "coop.vote.choice.noHint",
  abstain: "coop.vote.choice.abstainHint",
};
const PATRONAGE_STATUS_KEYS: Record<PatronageStatus, MessageKey> = {
  draft: "coop.patronageStatus.draft",
  computed: "coop.patronageStatus.computed",
  approved: "coop.patronageStatus.approved",
  distributed: "coop.patronageStatus.distributed",
};
const ELECTION_STATUS_KEYS: Record<ElectionStatus, MessageKey> = {
  nominating: "coop.electionStatus.nominating",
  voting: "coop.electionStatus.voting",
  closed: "coop.electionStatus.closed",
};
const COMPONENT_KEYS: Record<PatronageComponent, MessageKey> = {
  revenue: "coop.component.revenue",
  streamingHours: "coop.component.streamingHours",
  relayBandwidth: "coop.component.relayBandwidth",
  viewerHours: "coop.component.viewerHours",
  adjustment: "coop.component.adjustment",
};
const SCOPE_KEYS: Record<TallyScope, MessageKey> = {
  member_wide: "coop.tally.scope.member_wide",
  streamer: "coop.tally.scope.streamer",
  viewer: "coop.tally.scope.viewer",
  worker: "coop.tally.scope.worker",
};
/** `TALLY_REASONS` of `@commonair/governance` (the web does not import the governance package). */
const REASON_KEYS: Record<string, MessageKey> = {
  passed: "coop.tally.reason.passed",
  "member-wide quorum not met": "coop.tally.reason.memberWideQuorum",
  "member-wide threshold not met": "coop.tally.reason.memberWideThreshold",
  "streamer-class quorum not met": "coop.tally.reason.streamerClassQuorum",
  "streamer-class majority not met": "coop.tally.reason.streamerClassMajority",
};
/** `TALLY_RULES`. */
const RULE_KEYS: Record<string, MessageKey> = {
  member_wide_quorum: "coop.tally.rule.member_wide_quorum",
  member_wide_threshold: "coop.tally.rule.member_wide_threshold",
  streamer_class_quorum: "coop.tally.rule.streamer_class_quorum",
  streamer_class_majority: "coop.tally.rule.streamer_class_majority",
};

export const classLabel = (c: MemberClass): string => t(CLASS_KEYS[c]);
export const membershipStatusLabel = (s: MembershipStatus): string => t(MEMBERSHIP_STATUS_KEYS[s]);
export const basisLabel = (b: MembershipBasis): string => t(BASIS_KEYS[b]);
export const shareStatusLabel = (s: ShareStatus | "none"): string => t(SHARE_STATUS_KEYS[s]);
export const proposalStatusLabel = (s: ProposalStatus): string => t(PROPOSAL_STATUS_KEYS[s]);
export const kindLabel = (k: ProposalKind): string => t(KIND_KEYS[k]);
export const kindHint = (k: ProposalKind): string => t(KIND_HINT_KEYS[k]);
export const stanceLabel = (s: CouncilStance): string => t(STANCE_KEYS[s]);
export const patronageStatusLabel = (s: PatronageStatus): string => t(PATRONAGE_STATUS_KEYS[s]);
export const electionStatusLabel = (s: ElectionStatus): string => t(ELECTION_STATUS_KEYS[s]);
export const componentLabel = (c: PatronageComponent): string => t(COMPONENT_KEYS[c]);
export const tallyScopeLabel = (s: TallyScope): string => t(SCOPE_KEYS[s]);

/** The ballot's choices, in contract order. */
export function voteChoices(): { value: VoteChoice; label: string; description: string }[] {
  return VOTE_CHOICES.map((value) => ({ value, label: t(VOTE_KEYS[value]), description: t(VOTE_HINT_KEYS[value]) }));
}

export const voteChoiceLabel = (choice: VoteChoice): string => t(VOTE_KEYS[choice]);

export function stanceOptions(): { value: CouncilStance; label: string }[] {
  return COUNCIL_STANCES.map((value) => ({ value, label: t(STANCE_KEYS[value]) }));
}

/** The tally's reason in words; an unknown reason is shown as the API wrote it. */
export function tallyReasonText(reason: string): string {
  const key = REASON_KEYS[reason];
  return key ? t(key) : reason;
}

export function tallyRuleLabel(rule: string): string {
  const key = RULE_KEYS[rule];
  return key ? t(key) : rule;
}

const PROPOSAL_FILTER_KEYS: Record<ProposalStatus | "all", MessageKey> = {
  all: "coop.proposals.filter.all",
  ...PROPOSAL_STATUS_KEYS,
};

export type ProposalFilter = ProposalStatus | "all";

/** The list's status filter: "all", then every status (`proposals-filter-<status>`). */
export function proposalFilterOptions(): { value: ProposalFilter; label: string; "data-testid": string }[] {
  return (["all", ...PROPOSAL_STATUSES] as const).map((value) => ({
    value,
    label: t(PROPOSAL_FILTER_KEYS[value]),
    "data-testid": `proposals-filter-${value}`,
  }));
}

export function parseProposalFilter(value: string): ProposalFilter | null {
  if (value === "all") return "all";
  return PROPOSAL_STATUSES.find((s) => s === value) ?? null;
}

// ── Roles and membership ──────────────────────────────────────────────────────────────────────

/** The web only uses the role to decide what to render; the API enforces `admin` on every call. */
export function isAdmin(me: object | null | undefined): boolean {
  return me !== null && me !== undefined && "role" in me && me.role === "admin";
}

/** Active classes in contract order (`coop-membership-card` `data-classes`). */
export function activeClasses(view: Pick<MembershipViewDto, "memberships"> | null): MemberClass[] {
  if (!view) return [];
  const active = new Set(view.memberships.filter((m) => m.status === "active").map((m) => m.class));
  return MEMBER_CLASSES.filter((c) => active.has(c));
}

export function isMember(view: Pick<MembershipViewDto, "memberships"> | null): boolean {
  return activeClasses(view).length > 0;
}

/**
 * Buying is offered only when the API would accept it: no pending, held or refund_pending share
 * and no active viewer membership (the one share is per member).
 */
export function canBuyShare(view: Pick<MembershipViewDto, "memberships" | "share">): boolean {
  const blocking: readonly ShareStatus[] = ["pending", "held", "refund_pending"];
  if (view.share && blocking.includes(view.share.status)) return false;
  return !view.memberships.some((m) => m.class === "viewer" && m.status === "active");
}

const ShareRules = z.object({
  viewer: z.object({ shareCents: z.number().int().min(0), shareRefundableOnExit: z.boolean() }),
});

/** `membership.classes` → the share price and whether an exit refunds it; null when unreadable. */
export function shareRules(
  settings: readonly Pick<SettingDto, "key" | "value">[] | null,
): { shareCents: number; refundableOnExit: boolean } | null {
  const parsed = ShareRules.safeParse(settings?.find((s) => s.key === "membership.classes")?.value);
  if (!parsed.success) return null;
  return { shareCents: parsed.data.viewer.shareCents, refundableOnExit: parsed.data.viewer.shareRefundableOnExit };
}

/** Whether leaving `cls` sets the held share to refund_pending (viewer class, held share, rule on). */
export function exitRefundsShare(
  view: Pick<MembershipViewDto, "share">,
  cls: MemberClass,
  refundableOnExit: boolean | null,
): boolean {
  return cls === "viewer" && view.share?.status === "held" && refundableOnExit === true;
}

/** `/coop` members by class, from the newest transparency month (zeros when none). */
export function membersByClass(months: readonly Pick<CoopMonthDto, "members">[] | null): Record<MemberClass, number> {
  const members = months?.[0]?.members;
  return {
    streamer: members?.streamer ?? 0,
    viewer: members?.viewer ?? 0,
    worker: members?.worker ?? 0,
  };
}

// ── Proposals ─────────────────────────────────────────────────────────────────────────────────

const OPEN: readonly ProposalStatus[] = ["discussion", "council_review", "voting"];

/** Open for discussion, council review or voting (`coop-open-proposal`, the comment composer). */
export const isOpenProposal = (status: ProposalStatus): boolean => OPEN.includes(status);

/** Statuses the worker moves on its own: the page polls while the proposal is in one. */
export const changesOnItsOwn = (status: ProposalStatus): boolean => isOpenProposal(status) || status === "passed";

export const PROPOSAL_POLL_MS = 5000;

const DECIDED: readonly ProposalStatus[] = ["passed", "rejected", "applied"];
export const isDecided = (status: ProposalStatus): boolean => DECIDED.includes(status);

export interface AuthorActions {
  submit: boolean;
  edit: boolean;
  withdraw: boolean;
}

/** What the author may do now (the API and the triggers decide; this hides what would be refused). */
export function authorActions(p: Pick<ProposalDto, "author" | "status">, meId: string | null): AuthorActions {
  const author = meId !== null && p.author.id === meId;
  return {
    submit: author && p.status === "draft",
    edit: author && (p.status === "draft" || p.status === "discussion"),
    withdraw: author && (p.status === "draft" || p.status === "discussion" || p.status === "council_review"),
  };
}

/**
 * The ballot is shown only while voting is open by status and by the clock: after `votingEndsAt`
 * the panel gives way to "counting" until the worker decides, so a stale panel never accepts input.
 */
export function votingOpen(p: Pick<ProposalDto, "status" | "timeline">, now: number): boolean {
  if (p.status !== "voting") return false;
  const ends = p.timeline.votingEndsAt;
  return ends === null || Date.parse(ends) > now;
}

export interface TimelineStepView {
  id: ProposalStatus;
  label: string;
  state: "done" | "current" | "upcoming";
  /** ISO time the step began, "" when unknown. */
  at: string;
  /** When the step ends or ended, if known (for the meta line). */
  until: string | null;
}

const STEP_ORDER: Record<ProposalStatus, number> = {
  draft: 0,
  discussion: 1,
  council_review: 2,
  voting: 3,
  passed: 4,
  rejected: 4,
  applied: 5,
  withdrawn: 6,
};

/**
 * The proposal's steps (`proposal-timeline-<status>`): draft, discussion, council review (only when
 * it affects creators), voting, then the outcome once decided (passed → applied, or rejected). A
 * withdrawn proposal shows the steps it reached and then `withdrawn`.
 */
export function proposalTimeline(
  p: Pick<ProposalDto, "status" | "affectsCreators" | "timeline" | "createdAt">,
): TimelineStepView[] {
  const tl = p.timeline;
  const at: Record<ProposalStatus, string | null> = {
    draft: p.createdAt,
    discussion: null,
    council_review: p.affectsCreators ? tl.discussionEndsAt : null,
    voting: tl.votingStartsAt,
    passed: tl.decidedAt,
    rejected: tl.decidedAt,
    applied: tl.appliedAt,
    withdrawn: null,
  };
  const until: Record<ProposalStatus, string | null> = {
    draft: null,
    discussion: tl.discussionEndsAt,
    council_review: tl.councilReviewEndsAt,
    voting: tl.votingEndsAt,
    passed: tl.decidedAt,
    rejected: tl.decidedAt,
    applied: tl.appliedAt,
    withdrawn: null,
  };
  const ids: ProposalStatus[] = [
    "draft",
    "discussion",
    ...(p.affectsCreators ? ["council_review" as const] : []),
    "voting",
  ];

  if (p.status === "withdrawn") {
    // Only what it reached: submitted (discussion clock set), in review (review clock set).
    const reached = ids.filter(
      (id) =>
        id === "draft" ||
        (id === "discussion" && tl.discussionEndsAt !== null) ||
        (id === "council_review" && tl.councilReviewEndsAt !== null) ||
        (id === "voting" && tl.votingStartsAt !== null),
    );
    return [...reached, "withdrawn" as const].map((id) => ({
      id,
      label: proposalStatusLabel(id),
      state: "done",
      at: id === "withdrawn" ? "" : (at[id] ?? ""),
      until: id === "withdrawn" ? null : until[id],
    }));
  }

  if (p.status === "rejected") ids.push("rejected");
  else if (p.status === "passed" || p.status === "applied") ids.push("passed", "applied");

  const current = STEP_ORDER[p.status];
  const terminal = p.status === "rejected" || p.status === "applied";
  return ids.map((id) => {
    const order = STEP_ORDER[id];
    const state =
      order < current || (order === current && terminal) ? "done" : order === current ? "current" : "upcoming";
    return {
      id,
      label: proposalStatusLabel(id),
      state,
      at: state === "upcoming" ? "" : (at[id] ?? ""),
      until: until[id],
    };
  });
}

// ── The change editor ─────────────────────────────────────────────────────────────────────────

export interface ChangeRow {
  id: string;
  /** "" while no key is chosen. */
  key: string;
  /** JSON text of the whole new value. */
  value: string;
}

export interface KeyOption {
  value: string;
  label: string;
  protected: boolean;
  "data-testid": string;
}

/** Every setting key, with its protected flag (`proposal-change-key-<key>`). */
export function changeKeyOptions(settings: readonly Pick<SettingDto, "key" | "protected">[]): KeyOption[] {
  return settings.map((s) => ({
    value: s.key,
    label: s.key,
    protected: s.protected,
    "data-testid": `proposal-change-key-${s.key}`,
  }));
}

/** `protected` as soon as one chosen key is protected (the API classifies the same way). */
export function deriveKind(
  rows: readonly Pick<ChangeRow, "key">[],
  settings: readonly Pick<SettingDto, "key" | "protected">[],
): ProposalKind {
  const protectedKeys = new Set(settings.filter((s) => s.protected).map((s) => s.key));
  return rows.some((r) => protectedKeys.has(r.key)) ? "protected" : "ordinary";
}

/** The whole current value as editable JSON (a change replaces the setting wholesale). */
export function settingJson(settings: readonly Pick<SettingDto, "key" | "value">[], key: string): string {
  const setting = settings.find((s) => s.key === key);
  return setting ? JSON.stringify(setting.value ?? null, null, 2) : "";
}

export function rowsFromProposal(p: Pick<ProposalDto, "changes">): ChangeRow[] {
  return p.changes.map((c, i) => ({ id: `c${i + 1}`, key: c.key, value: JSON.stringify(c.to ?? null, null, 2) }));
}

export type RowError = "noKey" | "invalidJson" | "duplicate";

const ROW_ERROR_KEYS: Record<RowError, MessageKey> = {
  noKey: "coop.form.change.noKey",
  invalidJson: "coop.form.change.invalidJson",
  duplicate: "coop.form.change.duplicate",
};

export const rowErrorText = (error: RowError): string => t(ROW_ERROR_KEYS[error]);

/** A row's problem, if any: no key, a key used above, or a value that is not JSON. */
export function rowError(row: ChangeRow, rows: readonly ChangeRow[]): RowError | null {
  if (!row.key) return "noKey";
  const first = rows.find((r) => r.key === row.key);
  if (first && first.id !== row.id) return "duplicate";
  try {
    JSON.parse(row.value);
    return null;
  } catch {
    return "invalidJson";
  }
}

/** The rows as the API's `changes`, or null while any row has a problem. */
export function changesFromRows(rows: readonly ChangeRow[]): { key: string; value: unknown }[] | null {
  if (rows.some((r) => rowError(r, rows) !== null)) return null;
  return rows.map((r) => ({ key: r.key, value: JSON.parse(r.value) as unknown }));
}

export const PROPOSAL_TITLE_MIN = 5;
export const PROPOSAL_TITLE_MAX = 140;
export const PROPOSAL_BODY_MAX = 50_000;
export const COMMENT_MAX = 10_000;
export const COUNCIL_RESPONSE_MAX = 20_000;
export const BOARD_MINUTE_MAX = 200;
export const REFUND_NOTE_MAX = 500;

export interface ProposalDraft {
  title: string;
  body: string;
  affectsCreators: boolean;
  rows: ChangeRow[];
}

/** The edit form's starting point: the proposal as saved. */
export function draftFromProposal(
  p: Pick<ProposalDto, "title" | "body" | "affectsCreators" | "changes">,
): ProposalDraft {
  return { title: p.title, body: p.body, affectsCreators: p.affectsCreators, rows: rowsFromProposal(p) };
}

/** Only the author edits, and only while `draft` or `discussion` (the API refuses otherwise). */
export const editableBy = (p: Pick<ProposalDto, "author" | "status">, meId: string | null): boolean =>
  authorActions(p, meId).edit;

export type ProposalSaveError = "notMember" | "invalid" | "notEditable" | "failed";

const SAVE_ERROR_KEYS: Record<ProposalSaveError, MessageKey> = {
  notMember: "coop.form.notMember",
  invalid: "coop.form.invalid",
  notEditable: "coop.form.notEditable",
  failed: "coop.form.failed",
};

/** Why `create`/`update` was refused, in words (the session-expired case is a toast instead). */
export function proposalSaveError(err: unknown): string {
  const code = errorCode(err);
  const kind: ProposalSaveError =
    code === "PRECONDITION_FAILED" && errorRequirement(err) === "membership"
      ? "notMember"
      : code === "BAD_REQUEST"
        ? "invalid"
        : code === "CONFLICT" || code === "FORBIDDEN"
          ? "notEditable"
          : "failed";
  return t(SAVE_ERROR_KEYS[kind]);
}

/** The create/update input, or null while the form is incomplete (the API validates again). */
export function proposalInput(
  draft: ProposalDraft,
  kind: ProposalKind,
): { title: string; body: string; changes: { key: string; value: unknown }[]; affectsCreators: boolean } | null {
  const title = draft.title.trim();
  const body = draft.body.trim();
  if (title.length < PROPOSAL_TITLE_MIN || title.length > PROPOSAL_TITLE_MAX) return null;
  if (body.length === 0 || body.length > PROPOSAL_BODY_MAX) return null;
  const changes = changesFromRows(draft.rows);
  if (!changes) return null;
  return { title, body, changes, affectsCreators: kind === "protected" ? true : draft.affectsCreators };
}

// ── Tally ─────────────────────────────────────────────────────────────────────────────────────

export type TallyScope = "member_wide" | MemberClass;

export interface TallyRowView {
  scope: TallyScope;
  label: string;
  yes: number;
  no: number;
  abstain: number;
  eligible: number;
}

/** Member-wide first, then streamer, viewer and worker (a class missing from the row counts zero). */
export function tallyRows(breakdown: NonNullable<ProposalDto["tally"]>["breakdown"]): TallyRowView[] {
  const zero = { yes: 0, no: 0, abstain: 0, eligible: 0 };
  const row = (scope: TallyScope, c: typeof zero) => ({
    scope,
    label: tallyScopeLabel(scope),
    yes: c.yes,
    no: c.no,
    abstain: c.abstain,
    eligible: c.eligible,
  });
  return [row("member_wide", breakdown.memberWide), ...MEMBER_CLASSES.map((c) => row(c, breakdown.byClass[c] ?? zero))];
}

// ── API refusals ──────────────────────────────────────────────────────────────────────────────

/** `data.reason` of a refused call (`voting_closed`, `not_in_electorate`, `second_approver`). */
export function errorReason(err: unknown): string | null {
  if (typeof err !== "object" || err === null || !("data" in err)) return null;
  const data = err.data;
  if (typeof data !== "object" || data === null || !("reason" in data)) return null;
  return typeof data.reason === "string" ? data.reason : null;
}

/** `requirement` of a `PRECONDITION_FAILED` (`membership`, `manual_shares`, `surplus`). */
export function errorRequirement(err: unknown): string | null {
  if (typeof err !== "object" || err === null || !("data" in err)) return null;
  const data = err.data;
  if (typeof data !== "object" || data === null || !("requirement" in data)) return null;
  return typeof data.requirement === "string" ? data.requirement : null;
}

export type VoteRefusal = "voting_closed" | "not_in_electorate";

export function voteRefusal(err: unknown): VoteRefusal | null {
  const reason = errorReason(err);
  if (errorCode(err) === "CONFLICT" && reason === "voting_closed") return "voting_closed";
  if (errorCode(err) === "FORBIDDEN" && reason === "not_in_electorate") return "not_in_electorate";
  return null;
}

export const isSecondApproverRefusal = (err: unknown): boolean =>
  errorCode(err) === "FORBIDDEN" && errorReason(err) === "second_approver";

export type AppointError = "noUser" | "suspended" | "alreadyWorker" | "invalid" | "failed";

const APPOINT_ERROR_KEYS: Record<AppointError, MessageKey> = {
  noUser: "coop.admin.noUser",
  suspended: "coop.admin.suspended",
  alreadyWorker: "coop.admin.alreadyWorker",
  invalid: "coop.admin.invalid",
  failed: "coop.admin.failed",
};

/** Why `coop.appointWorker` was refused: unknown (or banned/deleted) user, already a worker, bad input. */
export function appointError(err: unknown): string {
  const code = errorCode(err);
  const kind: AppointError =
    code === "NOT_FOUND"
      ? "noUser"
      : code === "PRECONDITION_FAILED"
        ? "suspended"
        : code === "CONFLICT"
          ? "alreadyWorker"
          : code === "BAD_REQUEST"
            ? "invalid"
            : "failed";
  return t(APPOINT_ERROR_KEYS[kind]);
}

// ── Patronage ─────────────────────────────────────────────────────────────────────────────────

const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** A `datetime-local` value read as UTC → ISO 8601, or null when it is not one. */
export function utcFromLocalInput(text: string): string | null {
  const m = LOCAL_DATETIME.exec(text.trim());
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  const date = new Date(ms);
  // Date.UTC rolls over (Feb 30 → Mar 2); refuse instead.
  if (date.getUTCDate() !== Number(m[3]) || date.getUTCMonth() !== Number(m[2]) - 1) return null;
  return date.toISOString();
}

/** `datetime-local` text (UTC, seconds) for an instant. */
export function localInputFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19);
}

/** Defaults for the run form: the start of the current UTC month to now. */
export function defaultRunWindow(now: number): { start: string; end: string } {
  const d = new Date(now);
  return {
    start: localInputFromMs(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)),
    end: localInputFromMs(now),
  };
}

export type RunWindowError = "invalidTimes" | "endInFuture" | "endBeforeStart";

const RUN_ERROR_KEYS: Record<RunWindowError, MessageKey> = {
  invalidTimes: "coop.patronageRun.invalidTimes",
  endInFuture: "coop.patronageRun.endInFuture",
  endBeforeStart: "coop.patronageRun.endBeforeStart",
};

export const runWindowErrorText = (e: RunWindowError): string => t(RUN_ERROR_KEYS[e]);

/** The run's period as ISO, or why the API would refuse it (`periodEnd` ≤ now, start < end). */
export function runWindow(
  start: string,
  end: string,
  now: number,
): { periodStart: string; periodEnd: string } | { error: RunWindowError } {
  const periodStart = utcFromLocalInput(start);
  const periodEnd = utcFromLocalInput(end);
  if (!periodStart || !periodEnd) return { error: "invalidTimes" };
  if (Date.parse(periodEnd) > now) return { error: "endInFuture" };
  if (Date.parse(periodStart) >= Date.parse(periodEnd)) return { error: "endBeforeStart" };
  return { periodStart, periodEnd };
}

/** The statement's inputs as the spec's `data-*` (`statement-inputs`). */
export function statementInputAttrs(inputs: StatementDto["inputs"]): {
  "data-revenue-cents": number;
  "data-hours": number;
  "data-relay-bytes": number;
  "data-viewer-hours": number;
} {
  return {
    "data-revenue-cents": inputs.revenueCents,
    "data-hours": inputs.eligibleStreamingHours,
    "data-relay-bytes": inputs.relayBytesVerified,
    "data-viewer-hours": inputs.viewerHoursVerified,
  };
}

/** Sum of a month's patronage per month (`transparency-patronage`): only months that distributed. */
export function patronageMonths(
  months: readonly Pick<CoopMonthDto, "month" | "patronageDistributed">[],
): { month: string; cents: number; currency: string }[] {
  return months
    .filter((m) => m.patronageDistributed.cents !== 0)
    .map((m) => ({ month: m.month, cents: m.patronageDistributed.cents, currency: m.patronageDistributed.currency }));
}

/** Every decided (or withdrawn) proposal of the months shown, with its month (`transparency-governance`). */
export function governanceOutcomes(
  months: readonly Pick<CoopMonthDto, "month" | "governance">[],
): (CoopMonthDto["governance"][number] & { month: string })[] {
  return months.flatMap((m) => m.governance.map((g) => ({ ...g, month: m.month })));
}
