// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-safety's plan: who reports, streams, uploads, appeals and files what, and in which state each
 * item must end. Pure: the same seed, scale and store give the same plan. The runner (`run.ts`)
 * drives every step through the API, the worker and the test hooks; nothing here touches the stack.
 *
 * Accounts are partitioned from seed-social's store so no account plays two parts that would
 * interfere: the T0 uploaders end permanently suspended, the enforcement-cell targets are
 * suspended for `CELL_SUSPENSION_SECONDS` (the ban lapses and clears on their next sign-in), and the
 * live roles go on air only during this unit.
 */
import { ENFORCEMENT_REPORT_RULES, type REPORT_REASONS } from "@commonair/contracts/enums";
import type { Rng } from "../prng.ts";
import type { SeedScale } from "../scale.ts";
import type { SeedStore, SeededUser } from "../types.ts";

export const K = ENFORCEMENT_REPORT_RULES.k;
/** How long a cell suspension lasts: short, so later units can still sign the account in. */
export const CELL_SUSPENSION_SECONDS = 60;
/** The scripted classifier's scores: T2 labels at 0.85, T1 restricts at 0.99 (as `trust-safety`). */
export const T2_SCORE = 0.85;
export const T1_SCORE = 0.99;
/** Seconds a stream runs before its clips are cut (clips take the last seconds of the DVR). */
export const CLIP_LEAD_SECONDS = 12;
export const CLIP_SECONDS = 5;

type ReportReason = (typeof REPORT_REASONS)[number];

/**
 * The clauses a moderator's decision on a report cites (`REPORT_REASON_CLAUSES` in
 * `@commonair/moderation`, which the harness does not depend on): only the reasons the plan uses.
 */
export const REASON_CLAUSES = {
  spam: "honesty.spam",
  harassment: "decency.harassment",
  hate: "decency.hate",
  impersonation: "honesty.impersonation",
  other: "guidelines.general",
} as const satisfies Partial<Record<ReportReason, string>>;
export type PlanReason = keyof typeof REASON_CLAUSES;
const CHAT_REASONS: readonly PlanReason[] = ["spam", "harassment", "hate", "other"];

/** The two enforcement-report cells the plan fills to k (ADR 0019): staff suspensions citing a clause. */
export const CELLS = [
  { clauseId: REASON_CLAUSES.harassment, reason: "harassment" },
  { clauseId: REASON_CLAUSES.spam, reason: "spam" },
] as const satisfies readonly { clauseId: string; reason: PlanReason }[];

/** Fixed template text: every note, resolution and appeal body the seed sends (never user free text). */
export const TEXT = {
  resolution: "Reviewed by the demo seed: action taken under the cited rule.",
  dismissal: "Reviewed by the demo seed: no rule was broken.",
  caseNote: "Demo seed review (template text).",
  t0Confirm: "Demo seed: synthetic fixture match confirmed.",
  t0Dismiss: "Demo seed: first review of a synthetic fixture match.",
  appeal: "I believe this decision was a mistake and ask for a second look (demo seed).",
  appealResolution: "Demo seed appeal review (template text).",
  dmcaNote: "Demo seed DMCA review (template text).",
  nciiNote: "Demo seed takedown review (template text).",
  nciiDescription: "Demo seed takedown request for a synthetic test pattern.",
  suspension: "Demo seed suspension (template text).",
  hold: "Demo seed litigation hold (template text).",
  copyrightedWork: "Demo seed synthetic work",
  counterStatement: "Demo seed counter-notice: the synthetic pattern was removed by mistake.",
} as const;

// ---------------------------------------------------------------- specs

/** A channel that goes live during the unit, publishing its own run-unique benign pattern. */
export type LiveRole = "t2" | "t2Keep" | "t1Clear" | "t1Warn" | "t1Open" | "nciiAux" | "dmcaAux" | "viewer2" | "banned";
export const LIVE_ROLES: readonly LiveRole[] = [
  "t2",
  "t2Keep",
  "t1Clear",
  "t1Warn",
  "t1Open",
  "nciiAux",
  "dmcaAux",
  "viewer2",
  "banned",
];
/** Live roles played by bulk streamers, in the order they are handed out (fewer streamers drop the tail). */
export const BULK_LIVE_ROLES: readonly LiveRole[] = [
  "t2",
  "t1Clear",
  "t1Open",
  "t2Keep",
  "t1Warn",
  "dmcaAux",
  "nciiAux",
];

export interface LiveSpec {
  role: LiveRole;
  handle: string;
  /** Seed of the ffmpeg `cellauto` pattern: unique per channel, so an NCII hash never matches another stream. */
  patternSeed: number;
  /** Scripted `sexual` score while live, or null (unscored). */
  sexualScore: number | null;
  clips: number;
}

export interface ClipRef {
  role: LiveRole;
  index: number;
}

export interface T0Spec {
  handle: string;
  /** Which synthetic fixture the account uploads as its avatar. */
  fixture: "csam" | "ncii";
  /** `legal` confirms (hashes to the local list) or files the first of two dismissals. */
  decision: "confirm" | "first_dismissal";
}

export type NciiState = "received" | "removed" | "rejected" | "auto_hidden";
export const NCII_STATES: readonly NciiState[] = ["auto_hidden", "received", "removed", "rejected"];

export interface Party {
  name: string;
  email: string;
  address: string;
  phone: string;
  signature: string;
}

export interface NciiSpec {
  state: NciiState;
  clip: ClipRef;
  requester: Party;
}

export type DmcaState = "received" | "rejected" | "actioned" | "countered" | "restored";
export const DMCA_STATES: readonly DmcaState[] = ["received", "rejected", "actioned", "countered", "restored"];

export interface DmcaSpec {
  key: string;
  state: DmcaState;
  /** A clip one of the live roles cut, or one of seed-media's VODs. */
  target: { kind: "clip"; clip: ClipRef } | { kind: "vod"; vodId: string };
  claimant: Party;
  /** The owner who files the counter-notice (countered and restored). */
  counter: { handle: string; party: Party } | null;
}

export type ReportSubject =
  | { kind: "chat"; index: number }
  | { kind: "chatBy"; authorHandle: string }
  | { kind: "channel"; ownerHandle: string }
  | { kind: "user"; handle: string }
  | { kind: "clip"; clip: ClipRef };

export type ReportOutcome =
  | { status: "open" }
  | { status: "dismissed" }
  | {
      status: "actioned";
      action: "remove_content" | "suspend_user" | "ban_from_channel";
      clauseId: string | null;
      durationSeconds: number | null;
    };

export interface ReportSpec {
  key: string;
  reporter: string;
  subject: ReportSubject;
  reason: PlanReason;
  outcome: ReportOutcome;
  /** Index into `CELLS` when this resolution fills an enforcement-report cell. */
  cell: number | null;
}

export type AppealSubject =
  | { kind: "reportAction"; reportKey: string }
  | { kind: "strike"; dmcaKey: string }
  | { kind: "termination" }
  | { kind: "label" };

export interface AppealSpec {
  key: string;
  appellant: string;
  subject: AppealSubject;
  outcome: "open" | "upheld" | "overturned";
}

/**
 * Fixed staff logins by duty. appeals.resolve refuses an appeal of the caller's own decision, and
 * `mod` takes every report action, DMCA decision and NCII decision, so `admin` resolves appeals.
 */
export const STAFF = { reports: "mod", dmca: "mod", ncii: "mod", appeals: "admin" } as const;

/** Who made the decision an appeal is against (`system` for the classifier's label). */
export function deciderOf(subject: AppealSubject): string {
  switch (subject.kind) {
    case "reportAction":
      return STAFF.reports;
    case "strike":
    case "termination":
      return STAFF.dmca;
    case "label":
      return "system";
  }
}

/**
 * The keys this unit publishes under `store.extra.safety`: the brief's jury keys, plus
 * `restrictedUserIds`, which seed-platform reads so it never signs in as a suspended account.
 */
export interface SafetyStoreExtra {
  juryCaseIds: string[];
  juryReportIds: string[];
  restrictedUserIds: string[];
}

export function safetyStoreExtra(e: SafetyStoreExtra): SafetyStoreExtra {
  return {
    juryCaseIds: [...e.juryCaseIds],
    juryReportIds: [...e.juryReportIds],
    restrictedUserIds: [...e.restrictedUserIds],
  };
}

/** Rows written by the unit: per-table count after the run less the count before it. */
export function countDelta(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [t, n] of Object.entries(after)) out[t] = Math.max(0, n - (before[t] ?? 0));
  return out;
}

export interface IncidentSpec {
  title: string;
  components: string[];
  body: string;
  /** Statuses posted in order (the first opens the incident). */
  statuses: ("investigating" | "identified" | "monitoring" | "resolved")[];
}

/** One recorded broadcast seed-media published (`store.extra.media.recordedBroadcasts`). */
export interface RecordedBroadcast {
  channelId: string;
  broadcastId: string;
}

export interface SafetyPlan {
  live: LiveSpec[];
  t0: T0Spec[];
  ncii: NciiSpec[];
  dmca: DmcaSpec[];
  reports: ReportSpec[];
  appeals: AppealSpec[];
  incidents: IncidentSpec[];
  /** Platform suspension by `admin` (a statement of reasons with its deliveries). */
  adminSuspension: { handle: string; clauseId: string } | null;
  legalHold: { handle: string; reasonCode: "litigation" | "law_enforcement" } | null;
  dataExport: string;
  /** A bulk viewer whose deletion stays scheduled (the grace period has not passed). */
  deletion: string | null;
  attestations: RecordedBroadcast[];
  /** streamer1's recorded broadcasts: the first with an excluded group is appealed and overturned. */
  groupAppealCandidates: RecordedBroadcast[];
  /** Accounts the unit leaves suspended or scheduled for deletion (later units should skip them). */
  restricted: string[];
  notes: string[];
}

// ---------------------------------------------------------------- planning

const handlesOf = (users: readonly SeededUser[], kind: SeededUser["kind"]) =>
  users
    .filter((u) => u.kind === kind)
    .map((u) => u.handle)
    .sort();

export function party(kind: "claimant" | "requester" | "uploader", n: number): Party {
  const label = kind === "claimant" ? "Claimant" : kind === "requester" ? "Requester" : "Uploader";
  return {
    name: `Demo ${label} ${n}`,
    email: `demo_${kind}${n}@demo-seed.invalid`,
    address: `${n} Demo Seed Lane, Example Town`,
    phone: `+1 555 01${String(n % 100).padStart(2, "0")}`,
    signature: `Demo ${label} ${n}`,
  };
}

export interface PlanInput {
  store: Pick<SeedStore, "users" | "channels">;
  /** seed-media's recordings; empty when it published none. */
  recorded: readonly RecordedBroadcast[];
  /** seed-media's VODs on channels other than streamer1's (DMCA targets), in a stable order. */
  vodIds: readonly string[];
}

export function planSafety(rng: Rng, scale: SeedScale, input: PlanInput): SafetyPlan {
  const notes: string[] = [];
  const f = Math.max(1, Math.round(scale.factor));
  const fixed = new Set(input.store.users.filter((u) => u.kind === "fixed").map((u) => u.handle));
  for (const h of ["admin", "mod", "legal", "viewer1", "viewer2", "banned", "streamer1"])
    if (!fixed.has(h)) throw new Error(`seed-safety: fixed login "${h}" is missing (seed-social runs first)`);

  const pools = rng.fork("pools");
  const viewers = pools.shuffle(handlesOf(input.store.users, "bulk-viewer"));
  const streamers = pools.shuffle(handlesOf(input.store.users, "bulk-streamer"));
  const take = (pool: string[], n: number) => pool.splice(0, Math.max(0, Math.min(n, pool.length)));

  // Live roles: bulk streamers first, then the fixed viewer2 and banned (their own channels).
  const patterns = rng.fork("patterns");
  const seeds = new Set<number>();
  const patternSeed = () => {
    for (;;) {
      const s = patterns.int(1, 0x7fff_ffff);
      if (!seeds.has(s)) {
        seeds.add(s);
        return s;
      }
    }
  };
  const roleHandles = take(streamers, BULK_LIVE_ROLES.length);
  const clipsOf: Partial<Record<LiveRole, number>> = { nciiAux: 4, dmcaAux: 4, viewer2: 1, banned: 3 };
  const scoreOf: Partial<Record<LiveRole, number>> = {
    t2: T2_SCORE,
    t2Keep: T2_SCORE,
    t1Clear: T1_SCORE,
    t1Warn: T1_SCORE,
    t1Open: T1_SCORE,
  };
  const live: LiveSpec[] = [];
  const add = (role: LiveRole, handle: string) =>
    live.push({
      role,
      handle,
      patternSeed: patternSeed(),
      sexualScore: scoreOf[role] ?? null,
      clips: clipsOf[role] ?? 0,
    });
  BULK_LIVE_ROLES.forEach((role, i) => {
    const h = roleHandles[i];
    if (h) add(role, h);
  });
  add("viewer2", "viewer2");
  add("banned", "banned");
  const has = (role: LiveRole) => live.some((l) => l.role === role);
  const dropped = BULK_LIVE_ROLES.filter((r) => !has(r));
  if (dropped.length > 0) notes.push(`seed-safety: too few bulk streamers for the live roles ${dropped.join(", ")}`);

  // Bulk viewers: T0 uploaders, the deletion requester, reporters, cell targets, other subjects.
  const t0Handles = take(viewers, 2);
  const t0: T0Spec[] = t0Handles.map((handle, i) =>
    i === 0
      ? { handle, fixture: "csam", decision: "confirm" }
      : { handle, fixture: "ncii", decision: "first_dismissal" },
  );
  const deletion = take(viewers, 1)[0] ?? null;
  const reporters = take(viewers, Math.min(4 * f, Math.max(1, Math.floor(viewers.length / 4))));
  const cellSize = Math.min(K * f, Math.floor(viewers.length / CELLS.length));
  const cellTargets = CELLS.map(() => take(viewers, cellSize));
  const subjects = viewers;
  if (cellSize < K) notes.push(`seed-safety: too few bulk viewers for enforcement cells of k = ${K} (got ${cellSize})`);
  if (reporters.length === 0) reporters.push("viewer1");

  const r = rng.fork("reports");
  const reporter = (i: number) => reporters[i % reporters.length] as string;
  const reports: ReportSpec[] = [];
  let n = 0;
  const report = (s: Omit<ReportSpec, "key" | "reporter"> & { reporter?: string }) => {
    const key = `r${String(++n).padStart(4, "0")}`;
    reports.push({ key, reporter: s.reporter ?? reporter(n), ...s });
    return key;
  };
  // Enforcement cells: each target reported once and suspended briefly, citing the cell's clause.
  CELLS.forEach((c, ci) => {
    for (const handle of cellTargets[ci] ?? [])
      report({
        subject: { kind: "user", handle },
        reason: c.reason,
        outcome: {
          status: "actioned",
          action: "suspend_user",
          clauseId: c.clauseId,
          durationSeconds: CELL_SUSPENSION_SECONDS,
        },
        cell: ci,
      });
  });
  // Chat lines: a third removed under the reason's clause, a third dismissed, a third left open.
  const chatReports = 12 * f;
  for (let i = 0; i < chatReports; i++) {
    const reason = r.pick(CHAT_REASONS);
    const outcome: ReportOutcome =
      i % 3 === 0
        ? { status: "actioned", action: "remove_content", clauseId: REASON_CLAUSES[reason], durationSeconds: null }
        : i % 3 === 1
          ? { status: "dismissed" }
          : { status: "open" };
    report({ subject: { kind: "chat", index: i }, reason, outcome, cell: null });
  }
  // One channel ban (channel scope: it cites no clause and moves no enforcement count).
  report({
    subject: { kind: "chat", index: chatReports },
    reason: "harassment",
    outcome: { status: "actioned", action: "ban_from_channel", clauseId: null, durationSeconds: null },
    cell: null,
  });
  // Channels: half dismissed, half open.
  const channelOwners = input.store.channels.map((c) => c.ownerHandle).filter((h) => h !== "streamer1");
  const channelReports = Math.min(4 * f, channelOwners.length);
  r.sample(channelOwners, channelReports).forEach((ownerHandle, i) =>
    report({
      subject: { kind: "channel", ownerHandle },
      reason: r.pick(["spam", "impersonation", "other"] as const),
      outcome: i % 2 === 0 ? { status: "dismissed" } : { status: "open" },
      cell: null,
    }),
  );
  // Accounts that are not cell targets: open (none is suspended).
  for (const handle of r.sample(subjects, Math.min(2 * f, subjects.length)))
    report({ subject: { kind: "user", handle }, reason: "impersonation", outcome: { status: "open" }, cell: null });
  // A clip report, dismissed (the dmca aux role's spare clip).
  if (has("dmcaAux"))
    report({
      subject: { kind: "clip", clip: { role: "dmcaAux", index: 3 } },
      reason: "other",
      outcome: { status: "dismissed" },
      cell: null,
    });
  // viewer2 files one report itself (before its suspension below, which refuses reports); it
  // stays open.
  report({
    reporter: "viewer2",
    subject: { kind: "chat", index: chatReports + 1 },
    reason: "spam",
    outcome: { status: "open" },
    cell: null,
  });
  // viewer2's lesser action: a brief suspension over one of its chat lines (appealed, upheld
  // below). A suspension, not a removal: only a restriction of the account gets a statement of
  // reasons (services/worker/src/moderation/sor-build.ts, `report.resolve`), and /settings/appeals
  // lists viewer2's statements. It lapses like the cell suspensions.
  const viewer2Removal = report({
    subject: { kind: "chatBy", authorHandle: "viewer2" },
    reason: "harassment",
    outcome: {
      status: "actioned",
      action: "suspend_user",
      clauseId: REASON_CLAUSES.harassment,
      durationSeconds: CELL_SUSPENSION_SECONDS,
    },
    cell: null,
  });

  // NCII: one request per state, each on its own clip of the ncii aux role.
  const ncii: NciiSpec[] = has("nciiAux")
    ? NCII_STATES.map((state, i) => ({
        state,
        clip: { role: "nciiAux", index: i },
        requester: party("requester", i + 1),
      }))
    : [];
  if (ncii.length === 0) notes.push("seed-safety: no NCII requests (no bulk streamer left for the ncii aux role)");

  // DMCA: viewer2 counters one, banned gets three strikes (termination), the aux role covers the rest.
  let claimants = 0;
  const claimant = () => party("claimant", ++claimants);
  const dmca: DmcaSpec[] = [];
  dmca.push({
    key: "viewer2",
    state: "countered",
    target: { kind: "clip", clip: { role: "viewer2", index: 0 } },
    claimant: claimant(),
    counter: { handle: "viewer2", party: party("uploader", 1) },
  });
  for (let i = 0; i < 3; i++)
    dmca.push({
      key: `banned${i + 1}`,
      state: "actioned",
      target: { kind: "clip", clip: { role: "banned", index: i } },
      claimant: claimant(),
      counter: null,
    });
  const aux = live.find((l) => l.role === "dmcaAux");
  if (aux) {
    dmca.push({
      key: "received",
      state: "received",
      target: { kind: "clip", clip: { role: "dmcaAux", index: 0 } },
      claimant: claimant(),
      counter: null,
    });
    dmca.push({
      key: "rejected",
      state: "rejected",
      target: { kind: "clip", clip: { role: "dmcaAux", index: 1 } },
      claimant: claimant(),
      counter: null,
    });
    dmca.push({
      key: "restored",
      state: "restored",
      target: { kind: "clip", clip: { role: "dmcaAux", index: 2 } },
      claimant: claimant(),
      counter: { handle: aux.handle, party: party("uploader", 2) },
    });
  }
  const vod = input.vodIds[0];
  if (vod)
    dmca.push({
      key: "vod",
      state: "received",
      target: { kind: "vod", vodId: vod },
      claimant: claimant(),
      counter: null,
    });

  // Appeals: banned's pending, viewer2's one decided and one pending, a label overturned, and a
  // few suspended cell targets (one overturned, the rest pending in `mod`'s queue).
  const appeals: AppealSpec[] = [
    { key: "banned", appellant: "banned", subject: { kind: "termination" }, outcome: "open" },
    {
      key: "viewer2-removal",
      appellant: "viewer2",
      subject: { kind: "reportAction", reportKey: viewer2Removal },
      outcome: "upheld",
    },
    { key: "viewer2-strike", appellant: "viewer2", subject: { kind: "strike", dmcaKey: "viewer2" }, outcome: "open" },
  ];
  const t2 = live.find((l) => l.role === "t2");
  if (t2) appeals.push({ key: "label", appellant: t2.handle, subject: { kind: "label" }, outcome: "overturned" });
  const cellReports = reports.filter((x) => x.cell !== null);
  cellReports.slice(0, Math.min(cellReports.length, 3 * f)).forEach((x, i) => {
    if (x.subject.kind !== "user") return;
    appeals.push({
      key: `cell-${x.key}`,
      appellant: x.subject.handle,
      subject: { kind: "reportAction", reportKey: x.key },
      outcome: i === 0 ? "overturned" : "open",
    });
  });

  const incidents: IncidentSpec[] = [
    {
      title: "Delayed chat delivery (demo seed)",
      components: ["chat"],
      body: "Chat messages arrived late for some viewers. Demo seed incident.",
      statuses: ["investigating", "identified", "resolved"],
    },
    {
      title: "Slow VOD processing (demo seed)",
      components: ["origin"],
      body: "New VODs take longer than usual to appear. Demo seed incident.",
      statuses: ["investigating", "monitoring"],
    },
  ];

  const s1 = input.store.channels.find((c) => c.ownerHandle === "streamer1");
  const attestations = [...input.recorded];
  const groupAppealCandidates = s1 ? input.recorded.filter((b) => b.channelId === s1.id) : [];
  if (attestations.length === 0)
    notes.push("seed-safety: seed-media published no recordedBroadcasts, so nothing was attested");
  // Only the test-hook clock reaches these states, and the worker stamps rows with that clock.
  if (dmca.some((d) => d.state === "restored"))
    notes.push(
      "seed-safety: the restored DMCA notice's restore (restoredAt on its items and counter-notice) and strike reversal are stamped about 12 weekdays ahead, the dmca-restore tick's clock; /admin/dmca and the aux owner's /settings/copyright show those future times",
    );
  if (ncii.some((n) => n.state === "auto_hidden"))
    notes.push(
      "seed-safety: the auto-hidden NCII request's 24 h and 36 h escalations and its auto-hide are stamped about 48 h ahead, the NCII clock tick's clock; the NCII queue on /admin/moderation shows those future times",
    );

  return {
    live,
    t0,
    ncii,
    dmca,
    reports,
    appeals,
    incidents,
    adminSuspension: { handle: "banned", clauseId: REASON_CLAUSES.harassment },
    legalHold: { handle: "banned", reasonCode: "litigation" },
    dataExport: "viewer1",
    deletion,
    attestations,
    groupAppealCandidates,
    restricted: ["banned", ...t0Handles, ...(deletion ? [deletion] : [])],
    notes,
  };
}

// ---------------------------------------------------------------- derived views (tests and run)

/** Accounts the runner signs in, in order: the ones it suspends first (their session must exist before). */
export function signInOrder(plan: SafetyPlan): string[] {
  const out = new Set<string>(["admin", "mod", "legal", "banned", "viewer2"]);
  for (const a of plan.appeals) out.add(a.appellant);
  for (const l of plan.live) out.add(l.handle);
  for (const t of plan.t0) out.add(t.handle);
  for (const x of plan.reports) out.add(x.reporter);
  for (const d of plan.dmca) if (d.counter) out.add(d.counter.handle);
  out.add(plan.dataExport);
  if (plan.deletion) out.add(plan.deletion);
  out.add("streamer1");
  return [...out];
}

/** Statements per enforcement cell the plan makes (staff suspensions citing the cell's clause). */
export function cellCounts(plan: SafetyPlan): number[] {
  return CELLS.map((_, i) => plan.reports.filter((x) => x.cell === i).length);
}

/** Moderation case statuses the plan ends with (T2 overturned → cleared). */
export function plannedCaseStatuses(plan: SafetyPlan): string[] {
  const out = new Set<string>();
  const label = plan.appeals.some((a) => a.subject.kind === "label" && a.outcome === "overturned");
  for (const l of plan.live) {
    if (l.role === "t2") out.add(label ? "cleared" : "labelled");
    if (l.role === "t2Keep") out.add("labelled");
    if (l.role === "t1Clear") out.add("cleared");
    if (l.role === "t1Warn") out.add("actioned");
    if (l.role === "t1Open") out.add("open");
  }
  for (const t of plan.t0) out.add(t.decision === "confirm" ? "confirmed" : "dismissal_pending");
  return [...out].sort();
}

export const reportStatuses = (plan: SafetyPlan) => [...new Set(plan.reports.map((x) => x.outcome.status))].sort();
export const appealStatuses = (plan: SafetyPlan) => [...new Set(plan.appeals.map((x) => x.outcome))].sort();

// ---------------------------------------------------------------- jury inputs (seed-coop)

export interface JuryCaseCandidate {
  id: string;
  tier: "t0" | "t1" | "t2";
  status: string;
  /** Hash-list category (T0) or null. */
  listCategory: string | null;
}

export interface JuryReportCandidate {
  id: string;
  status: string;
  reason: string;
}

const CLOSED_CASE = new Set(["cleared", "actioned", "dismissed", "confirmed"]);

/** Closed T1/T2 cases (never T0 or NCII) and resolved reports (never NCII), for seed-coop's jury. */
export function juryInputs(
  cases: readonly JuryCaseCandidate[],
  reports: readonly JuryReportCandidate[],
): { juryCaseIds: string[]; juryReportIds: string[] } {
  return {
    juryCaseIds: cases
      .filter((c) => (c.tier === "t1" || c.tier === "t2") && CLOSED_CASE.has(c.status) && c.listCategory === null)
      .map((c) => c.id),
    juryReportIds: reports.filter((r) => r.status !== "open" && r.reason !== "ncii").map((r) => r.id),
  };
}

// ---------------------------------------------------------------- seed-media's keys

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * What seed-safety reads from `store.extra.media` (seed-media's brief): `recordedBroadcasts`
 * (`{ channelId, broadcastId }[]`) and `vodsByChannel` (channel id → VOD ids). Anything missing or
 * malformed reads as empty. VODs on `skipChannelId` (streamer1's, which the watch routes show) are
 * never DMCA targets. Pure.
 */
export function mediaInputs(
  media: unknown,
  skipChannelId: string | null,
): { recorded: RecordedBroadcast[]; vodIds: string[] } {
  if (!isRecord(media)) return { recorded: [], vodIds: [] };
  const recorded = Array.isArray(media.recordedBroadcasts)
    ? media.recordedBroadcasts.flatMap((b: unknown) =>
        isRecord(b) && typeof b.channelId === "string" && typeof b.broadcastId === "string"
          ? [{ channelId: b.channelId, broadcastId: b.broadcastId }]
          : [],
      )
    : [];
  const vods = isRecord(media.vodsByChannel) ? media.vodsByChannel : {};
  const vodIds = Object.keys(vods)
    .filter((c) => c !== skipChannelId)
    .sort()
    .flatMap((c) => {
      const list = vods[c];
      return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
    });
  return { recorded, vodIds };
}

// ---------------------------------------------------------------- refusals

/** Env names a real NCMEC/CyberTipline reporter would be configured with; the instance ships none. */
const NCMEC_ENV = /^(NCMEC|CYBERTIP)/i;

/**
 * Why the run must not start because a real NCMEC reporter may be configured, or null. The instance
 * files nothing itself (`moderation.ncmecFile` only records a filing staff made by hand), so any
 * reporter setting means this is not the stack the seed is for.
 */
export function ncmecRefusal(env: Record<string, string | undefined>): string | null {
  const set = Object.entries(env)
    .filter(([k, v]) => NCMEC_ENV.test(k) && (v ?? "").trim() !== "")
    .map(([k]) => k)
    .sort();
  return set.length > 0
    ? `seed-safety refuses to run with a real NCMEC reporter configured (${set.join(", ")}): the seed's hash-match path must stay on the FOSS default, which files nothing`
    : null;
}
