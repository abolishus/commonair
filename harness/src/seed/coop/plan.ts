// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-coop's pure plans: who is appointed, who buys a share, which proposals run and how each
 * member votes, the board elections, the jury's opt-ins and votes, and the patronage window. Every
 * co-op row is protected, so nothing here is written directly: the API steps (`api.ts`) carry the
 * plans out. Plans take the facts the run reads (the store, adult accounts, subscription tiers,
 * the active electorate) as inputs, so the same seed and facts always give the same plan.
 */
import {
  type CastVote,
  type Choice,
  type MemberClass,
  MEMBER_CLASSES,
  STREAMER_MAJORITY_NOT_MET,
  choosePatronagePeriod,
  expectedTally,
  qualifyingTier,
} from "../../coop.ts";
import type { Rng } from "../prng.ts";
import type { SeedScale } from "../scale.ts";
import type { SeededChannel, SeededUser } from "../types.ts";

// ---------------------------------------------------------------- facts

export interface SubscriptionFact {
  channelSlug: string;
  tier: number;
  status: string;
}

export interface TierPrice {
  tier: 1 | 2 | 3;
  price: { cents: number };
}

/** What the plans read besides the RNG and the scale (all of it from the store or the database). */
export interface CoopFacts {
  users: readonly SeededUser[];
  channels: readonly SeededChannel[];
  /** Handles whose birth date makes them adults today. */
  adults: ReadonlySet<string>;
  /** `store.extra.money.subscriptionsByUser` (handle → subscriptions). */
  subscriptionsByUser: Readonly<Record<string, readonly SubscriptionFact[]>>;
  /** Tier prices by channel slug (`channel_sub_tiers`). */
  tierPrices: Readonly<Record<string, readonly TierPrice[]>>;
  /** `membership.classes.viewer.minSubscriptionCents`. */
  minSubscriptionCents: number;
}

/** Whether one subscription makes its holder eligible for the viewer class (`syncMemberships`' rule, as far as the store can tell). */
export function subscriptionQualifies(
  s: SubscriptionFact,
  holder: string,
  facts: Pick<CoopFacts, "channels" | "tierPrices" | "minSubscriptionCents">,
): boolean {
  if (s.status !== "active") return false;
  const owner = facts.channels.find((c) => c.slug === s.channelSlug)?.ownerHandle;
  if (owner === holder) return false;
  const tiers = facts.tierPrices[s.channelSlug] ?? [];
  const cheapest = qualifyingTier(tiers, facts.minSubscriptionCents);
  if (cheapest === null) return false;
  const price = tiers.find((t) => t.tier === s.tier)?.price.cents;
  return price !== undefined && price >= facts.minSubscriptionCents;
}

/** Handles a membership-sync makes viewer members on their subscriptions, sorted. */
export function qualifyingViewers(facts: CoopFacts): string[] {
  const humans = new Set(facts.users.filter((u) => u.kind !== "bot").map((u) => u.handle));
  return Object.entries(facts.subscriptionsByUser)
    .filter(([handle, subs]) => humans.has(handle) && subs.some((s) => subscriptionQualifies(s, handle, facts)))
    .map(([handle]) => handle)
    .sort();
}

/** Adult on `now` for an ISO birth date (`YYYY-MM-DD`); unknown or malformed dates are not adults. */
export function isAdult(birthDate: string | null, now: Date): boolean {
  const m = birthDate ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate) : null;
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const eighteenth = Date.UTC(y + 18, mo - 1, d);
  return Number.isFinite(eighteenth) && eighteenth <= now.getTime();
}

// ---------------------------------------------------------------- memberships and shares

/** Jury members the seed wants opted in (ADR 0038 needs at least 12; a margin covers conflicts). */
export const JURY_MIN_OPTINS = 12;
export const juryOptInTarget = (scale: Pick<SeedScale, "factor">) => JURY_MIN_OPTINS + 2 * scale.factor;

export interface MembershipPlan {
  /** Appointed worker members (board decisions), member1 first. */
  workers: string[];
  /** Who opts in to the jury: member1 and adult bulk viewers, every one an appointed worker. */
  juryOptIns: string[];
  shares: {
    /** Bought and confirmed by the treasurer (member1 first). */
    held: string[];
    /** Bought, never confirmed. */
    pending: string[];
    /** Bought, confirmed, then the viewer class is left and the treasurer pays the share back. */
    refunded: string[];
  };
  /** Viewer members once the sync ran: qualifying subscribers and held shares. */
  expectedViewerMembers: string[];
  /** The board minute reference every appointment cites (no personal data). */
  boardMinute: string;
}

export function planMemberships(rng: Rng, scale: SeedScale, facts: CoopFacts): MembershipPlan {
  const bulkViewers = facts.users
    .filter((u) => u.kind === "bulk-viewer")
    .map((u) => u.handle)
    .sort();
  const adultBulk = bulkViewers.filter((h) => facts.adults.has(h));
  const juryBulk = rng.fork("jury-optins").sample(adultBulk, Math.max(0, juryOptInTarget(scale) - 1));
  juryBulk.sort();
  const member1 = facts.users.some((u) => u.handle === "member1") ? ["member1"] : [];
  const juryOptIns = [...member1, ...juryBulk];
  const workers = [...juryOptIns];

  const taken = new Set(juryOptIns);
  const rest = rng.fork("share-buyers").shuffle(bulkViewers.filter((h) => !taken.has(h)));
  const pending = rest.slice(0, 2 * scale.factor).sort();
  const refunded = rest.slice(2 * scale.factor, 2 * scale.factor + 1);
  const held = [...member1];
  const viewers = new Set([...qualifyingViewers(facts), ...held]);
  return {
    workers,
    juryOptIns,
    shares: { held, pending, refunded },
    expectedViewerMembers: [...viewers].sort(),
    boardMinute: "seed board minute 2026-01",
  };
}

// ---------------------------------------------------------------- governance

export interface ElectorateMember {
  handle: string;
  classes: readonly MemberClass[];
}

/** The governance rules the plan's outcomes are computed against (the stack's frozen snapshot values). */
export interface PlanRules {
  ordinary: { threshold: number; quorum: number };
  protected: {
    memberWideThreshold: number;
    quorum: number;
    streamerClassQuorum: number;
    streamerClassThreshold: number;
  };
}

/** The e5 bootstrap's rules (`E5_GOVERNANCE_BOOTSTRAP` over the seeded defaults). */
export const BOOTSTRAP_RULES: PlanRules = {
  ordinary: { threshold: 0.5, quorum: 0.01 },
  protected: { memberWideThreshold: 2 / 3, quorum: 0.01, streamerClassQuorum: 0.01, streamerClassThreshold: 0.5 },
};

export type ProposalTarget =
  | "draft"
  | "discussion"
  | "council_review"
  | "voting"
  | "applied"
  | "rejected"
  | "withdrawn";
export type ChangeKind = "spotlight" | "juryOn" | "ordinaryDefaults" | "protectionsDefaults" | "platformCut";
export type Stance = "support" | "oppose" | "mixed" | "neutral";

/** When a proposal is submitted. */
export type Gate =
  | { after: "start" }
  /** Once `ref` reached `status` (or moved past it). */
  | { after: "status"; ref: string; status: "voting" }
  /** Once `ref` is applied. */
  | { after: "applied"; ref: string }
  /** Once `ref`'s vote ends within `seconds` (so this discussion outlasts `ref`'s decision). */
  | { after: "votingEndsWithin"; ref: string; seconds: number };

export interface PlannedVote extends CastVote {
  handle: string;
}

export interface ProposalSpec {
  ref: string;
  author: string;
  title: string;
  body: string;
  change: ChangeKind | null;
  affectsCreators: boolean;
  /** Protected (a protected key changes): forces council review and the streamer-class rule. */
  protected: boolean;
  target: ProposalTarget;
  /** The tally reason a decided proposal must end with. */
  reason: string | null;
  gate: Gate;
  comments: { author: string; body: string }[];
  /** Published by a seated council member while the proposal is in council review. */
  councilStance: Stance | null;
  votes: PlannedVote[];
}

export interface ElectionSpec {
  cls: MemberClass;
  target: "closed" | "voting" | "nominating";
  candidates: { handle: string; statement: string }[];
  ballots: { voter: string; approve: string[] }[];
  /** Seconds from creation until nominations close, and until voting ends. */
  nominationsSeconds: number;
  votingSeconds: number;
}

export interface GovernancePlan {
  proposals: ProposalSpec[];
  elections: ElectionSpec[];
  /** Published as `proposalId` (decided, tallied, with comments and a council response). */
  showcase: string;
  /** Published as `draftProposalId`. */
  draft: string;
}

export interface GovernanceInput {
  electorate: readonly ElectorateMember[];
  /** Board seats per class (`board.seats`). */
  seats: Readonly<Record<MemberClass, number>>;
  rules?: PlanRules;
}

const DAY_S = 86_400;
/** The discussion of a gated proposal ends this long after the proposal it waits for decides. */
export const GATE_LEAD_SECONDS = 12;

const COMMENTS = [
  "I support this; the smaller channels need the extra room.",
  "Could we revisit this in six months and compare the numbers?",
  "The council response covers my main worry, thanks.",
  "Happy to vote yes as long as the change is reported on the transparency page.",
  "This seems reasonable, but let us keep an eye on the side effects.",
  "Thanks for writing this up so clearly.",
  "I would prefer a smaller step first.",
  "Agreed, this matches what members asked for at the last meeting.",
] as const;

const FILLER_TOPICS = [
  "Publish the moderation handbook in more languages",
  "Hold a quarterly members' call",
  "Add a members' newsletter",
  "Fund an accessibility review of the player",
  "Sponsor a community art stream",
  "Create a volunteer translators' group",
  "Survey members about the patronage formula",
  "Open a members' forum for feature ideas",
] as const;

const has = (m: ElectorateMember, c: MemberClass) => m.classes.includes(c);

/** `n` choices that pass an ordinary threshold of 0.5 (or fail it), shuffled. Pure given `rng`. */
export function choiceMix(rng: Rng, n: number, outcome: "pass" | "fail"): Choice[] {
  if (n <= 0) return [];
  const out: Choice[] = [];
  if (outcome === "pass") {
    const no = Math.floor(n * 0.2);
    const abstain = Math.floor(n * 0.1);
    const yes = n - no - abstain;
    out.push(
      ...Array<Choice>(yes).fill("yes"),
      ...Array<Choice>(no).fill("no"),
      ...Array<Choice>(abstain).fill("abstain"),
    );
  } else {
    const yes = Math.floor(n * 0.2);
    const abstain = Math.floor(n * 0.1);
    const no = n - yes - abstain;
    out.push(
      ...Array<Choice>(yes).fill("yes"),
      ...Array<Choice>(no).fill("no"),
      ...Array<Choice>(abstain).fill("abstain"),
    );
  }
  return rng.shuffle(out);
}

/** Voters for an ordinary decision: enough for the quorum with a margin, at least `6 × factor`. */
export function voterCount(scale: Pick<SeedScale, "factor">, electorate: number, quorum: number): number {
  const need = Math.ceil(electorate * quorum * 2);
  return Math.min(electorate, Math.max(6 * scale.factor, need));
}

const vote = (m: ElectorateMember, choice: Choice): PlannedVote => ({
  handle: m.handle,
  classes: [...m.classes],
  choice,
});

/** What the tally will say for the planned votes (the rules in `@commonair/governance` `tally`, same order and reasons). */
export function plannedOutcome(
  votes: readonly PlannedVote[],
  electorate: readonly ElectorateMember[],
  isProtected: boolean,
  rules: PlanRules = BOOTSTRAP_RULES,
): { passed: boolean; reason: string } {
  const t = expectedTally(votes);
  const m = t.memberWide;
  const s = t.byClass.streamer;
  const eligible = electorate.length;
  const sEligible = electorate.filter((e) => has(e, "streamer")).length;
  const turnout = m.yes + m.no + m.abstain;
  const sTurnout = s.yes + s.no + s.abstain;
  const quorum = isProtected ? rules.protected.quorum : rules.ordinary.quorum;
  const threshold = isProtected ? rules.protected.memberWideThreshold : rules.ordinary.threshold;
  if (!(eligible > 0 && turnout / eligible >= quorum)) return { passed: false, reason: "member-wide quorum not met" };
  if (!(m.yes + m.no > 0 && m.yes / (m.yes + m.no) >= threshold))
    return { passed: false, reason: "member-wide threshold not met" };
  if (isProtected) {
    if (!(sEligible > 0 && sTurnout / sEligible >= rules.protected.streamerClassQuorum))
      return { passed: false, reason: "streamer-class quorum not met" };
    if (!(s.yes + s.no > 0 && s.yes / (s.yes + s.no) > rules.protected.streamerClassThreshold))
      return { passed: false, reason: STREAMER_MAJORITY_NOT_MET };
  }
  return { passed: true, reason: "passed" };
}

/** Problems that make a governance plan impossible to carry out (empty when it can run). */
export function governanceProblems(input: GovernanceInput): string[] {
  const out: string[] = [];
  const e = input.electorate;
  for (const h of ["member1", "council1", "council2"])
    if (!e.some((m) => m.handle === h)) out.push(`${h} is not an active member`);
  if (!e.some((m) => m.handle === "council1" && has(m, "streamer"))) out.push("council1 is not a streamer member");
  if (!e.some((m) => m.handle === "council2" && has(m, "streamer"))) out.push("council2 is not a streamer member");
  return out;
}

/**
 * Every proposal, election and vote of the run. The gated proposals carry the open statuses: the
 * run first restores the default governance periods (two decided proposals), and the proposals
 * that must stay open start just before those restorations decide, so their council review, vote
 * or discussion gets the long default window and is still open when the seed is done.
 */
export function planGovernance(rng: Rng, scale: SeedScale, input: GovernanceInput): GovernancePlan {
  const problems = governanceProblems(input);
  if (problems.length > 0) throw new Error(`seed-coop: cannot plan governance: ${problems.join("; ")}`);
  const rules = input.rules ?? BOOTSTRAP_RULES;
  const electorate = [...input.electorate].sort((a, b) => a.handle.localeCompare(b.handle));
  const streamers = electorate.filter((m) => has(m, "streamer"));
  const nonStreamers = electorate.filter((m) => !has(m, "streamer"));
  const viewers = electorate.filter((m) => has(m, "viewer"));
  const workers = electorate.filter((m) => has(m, "worker"));
  const byHandle = new Map(electorate.map((m) => [m.handle, m]));
  const member = (h: string) => byHandle.get(h) as ElectorateMember;
  const otherWorkers = workers.filter((m) => m.handle !== "member1");
  const worker1 = (otherWorkers[0] ?? member("member1")).handle;
  const worker2 = (otherWorkers[1] ?? otherWorkers[0] ?? member("member1")).handle;
  const commentPool = rng.fork("comment-text");
  const comment = (author: string) => ({ author, body: commentPool.pick(COMMENTS) });
  const n = voterCount(scale, electorate.length, rules.ordinary.quorum);

  /** `count` voters with member1 first when `withMember1`, the rest sampled. */
  const pickVoters = (r: Rng, pool: readonly ElectorateMember[], count: number, withMember1 = true) => {
    const first = withMember1 && pool.some((m) => m.handle === "member1") ? [member("member1")] : [];
    const rest = r.sample(
      pool.filter((m) => m.handle !== "member1"),
      Math.max(0, count - first.length),
    );
    return [...first, ...rest];
  };
  const ordinaryVotes = (label: string, outcome: "pass" | "fail", count = n) => {
    const r = rng.fork(`votes:${label}`);
    const voters = pickVoters(r, electorate, count);
    const choices = choiceMix(r, voters.length, outcome);
    // member1 votes yes on what passes and no on what fails, so its ballot shows both.
    if (voters[0]?.handle === "member1") {
      const want: Choice = outcome === "pass" ? "yes" : "no";
      const i = choices.indexOf(want);
      if (i > 0) [choices[0], choices[i]] = [choices[i] as Choice, choices[0] as Choice];
    }
    return voters.map((m, i) => vote(m, choices[i] ?? "abstain"));
  };

  const proposals: ProposalSpec[] = [];
  const base = {
    affectsCreators: false,
    protected: false,
    comments: [] as { author: string; body: string }[],
    councilStance: null as Stance | null,
    votes: [] as PlannedVote[],
    reason: null as string | null,
  };

  proposals.push({
    ...base,
    ref: "spotlight",
    author: "council2",
    title: "More spotlight slots for small channels",
    body: "Raise the number of home-page spotlight slots reserved for channels under the size cap.",
    change: "spotlight",
    affectsCreators: true,
    target: "applied",
    reason: "passed",
    gate: { after: "start" },
    comments: [comment("member1"), comment("council1"), comment(worker1)],
    councilStance: "support",
    votes: ordinaryVotes("spotlight", "pass"),
  });

  const juryVoters = rng.fork("votes:juryOn").sample(electorate, n);
  proposals.push({
    ...base,
    ref: "juryOn",
    author: "member1",
    title: "Turn the advisory member jury on",
    body: "Let monthly panels of opted-in members review a sample of closed moderation cases (ADR 0038).",
    change: "juryOn",
    target: "applied",
    reason: "passed",
    gate: { after: "start" },
    votes: juryVoters.map((m) => vote(m, "yes")),
  });

  proposals.push({
    ...base,
    ref: "rejected",
    author: worker1,
    title: "Close the co-op to new viewer members for a year",
    body: "An advisory proposal to pause new viewer memberships while the board reviews the share price.",
    change: null,
    target: "rejected",
    reason: "member-wide threshold not met",
    gate: { after: "start" },
    comments: [comment("member1"), comment("council2")],
    votes: ordinaryVotes("rejected", "fail"),
  });

  // Protected: a majority of members says yes, the streamer class says no.
  {
    const r = rng.fork("votes:platformCut");
    // At most half the streamer voters say yes (the majority must be *more* than half); enough
    // other members say yes for the 2/3 member-wide threshold, shrinking the streamer side to fit.
    let s = Math.min(streamers.length, Math.max(2, 3 * scale.factor));
    const need = (k: number) => 2 * (k - Math.floor(k / 2)) - Math.floor(k / 2) + 1;
    while (s > 2 && need(s) > nonStreamers.length) s--;
    const sVoters = [
      member("council1"),
      ...r.sample(
        streamers.filter((m) => m.handle !== "council1"),
        s - 1,
      ),
    ];
    const sYes = Math.floor(sVoters.length / 2);
    const others = r.sample(nonStreamers, Math.max(need(sVoters.length), n - sVoters.length));
    const votes = [
      ...sVoters.map((m, i) => vote(m, i === 0 || i > sYes ? "no" : "yes")),
      ...others.map((m) => vote(m, "yes")),
    ];
    proposals.push({
      ...base,
      ref: "platformCut",
      author: worker2,
      title: "Raise the streamer share to 85 percent",
      body: "Change the platform cut so streamers keep 85 percent of subscription and tip revenue.",
      change: "platformCut",
      affectsCreators: true,
      protected: true,
      target: "rejected",
      reason: STREAMER_MAJORITY_NOT_MET,
      gate: { after: "start" },
      comments: [comment("council1"), comment(worker2)],
      councilStance: "oppose",
      votes,
    });
  }

  proposals.push({
    ...base,
    ref: "withdrawn",
    author: "council2",
    title: "Rename the creator council",
    body: "An advisory proposal to rename the creator council, withdrawn by its author.",
    change: null,
    target: "withdrawn",
    gate: { after: "start" },
  });

  const fillers = 4 * scale.factor;
  const fillerVoters = voterCount({ factor: 1 }, electorate.length, rules.ordinary.quorum);
  const fillerAuthors = rng.fork("filler-authors");
  for (let i = 0; i < fillers; i++) {
    const outcome = i % 3 === 2 ? "fail" : "pass";
    const topic = FILLER_TOPICS[i % FILLER_TOPICS.length] as string;
    proposals.push({
      ...base,
      ref: `filler-${i + 1}`,
      author: fillerAuthors.pick(electorate).handle,
      title: i < FILLER_TOPICS.length ? topic : `${topic} (${Math.floor(i / FILLER_TOPICS.length) + 1})`,
      body: `An advisory proposal: ${topic.toLowerCase()}.`,
      change: null,
      target: outcome === "pass" ? "applied" : "rejected",
      reason: outcome === "pass" ? "passed" : "member-wide threshold not met",
      gate: { after: "start" },
      votes: ordinaryVotes(`filler-${i + 1}`, outcome, fillerVoters),
    });
  }

  // Restore the default protections, then the default ordinary periods (both pass).
  {
    const r = rng.fork("votes:protectionsDefaults");
    const sVoters = [
      member("council1"),
      member("council2"),
      ...r.sample(
        streamers.filter((m) => !["council1", "council2"].includes(m.handle)),
        Math.max(0, 2 * scale.factor - 2),
      ),
    ];
    const others = r.sample(nonStreamers, Math.max(0, n - sVoters.length));
    proposals.push({
      ...base,
      ref: "protectionsDefaults",
      author: "council1",
      title: "Restore the default protected-decision periods",
      body: "Return council review, the minimum vote and the protected quorums to the co-op's defaults.",
      change: "protectionsDefaults",
      affectsCreators: true,
      protected: true,
      target: "applied",
      reason: "passed",
      gate: { after: "start" },
      councilStance: "support",
      votes: [...sVoters, ...others].map((m) => vote(m, "yes")),
    });
  }
  proposals.push({
    ...base,
    ref: "ordinaryDefaults",
    author: "council1",
    title: "Restore the default discussion and voting periods",
    body: "Return the ordinary discussion and voting periods and quorum to the co-op's defaults.",
    change: "ordinaryDefaults",
    target: "applied",
    reason: "passed",
    gate: { after: "status", ref: "protectionsDefaults", status: "voting" },
    votes: ordinaryVotes("ordinaryDefaults", "pass"),
  });

  // Open states, each started so its window is the long default one.
  proposals.push({
    ...base,
    ref: "councilReview",
    author: "council2",
    title: "Weekly creator office hours",
    body: "Hold a weekly open call where creators can bring questions to the council.",
    change: null,
    affectsCreators: true,
    target: "council_review",
    gate: { after: "votingEndsWithin", ref: "protectionsDefaults", seconds: GATE_LEAD_SECONDS },
    councilStance: "support",
  });
  {
    const r = rng.fork("votes:voting");
    const voters = pickVoters(r, electorate, Math.max(3, Math.floor(n / 2)));
    const choices = choiceMix(r, voters.length, "pass");
    proposals.push({
      ...base,
      ref: "voting",
      author: "member1",
      title: "Publish the co-op budget every quarter",
      body: "Publish a plain-language co-op budget on the transparency page every quarter.",
      change: null,
      target: "voting",
      gate: { after: "votingEndsWithin", ref: "ordinaryDefaults", seconds: GATE_LEAD_SECONDS },
      votes: voters.map((m, i) => vote(m, choices[i] ?? "yes")),
    });
  }
  proposals.push({
    ...base,
    ref: "discussion",
    author: "council1",
    title: "A members' code of conduct for co-op meetings",
    body: "Adopt a short code of conduct for members' calls and the proposal discussions.",
    change: null,
    target: "discussion",
    gate: { after: "applied", ref: "ordinaryDefaults" },
    comments: [comment("member1"), comment("council2"), comment(worker1)],
  });
  proposals.push({
    ...base,
    ref: "draft",
    author: "member1",
    title: "Lower the viewer share price",
    body: "Draft: lower the one-time viewer member share so more viewers can join.",
    change: null,
    target: "draft",
    gate: { after: "start" },
  });

  // Every decided proposal must end the way its target says.
  for (const p of proposals) {
    if (p.target !== "applied" && p.target !== "rejected") continue;
    const o = plannedOutcome(p.votes, electorate, p.protected, rules);
    if ((p.target === "applied") !== o.passed || (p.reason !== null && p.reason !== o.reason))
      throw new Error(`seed-coop: planned votes for ${p.ref} give "${o.reason}", not ${p.target} (${p.reason ?? ""})`);
  }

  return {
    proposals,
    elections: planElections(rng.fork("elections"), scale, { streamers, viewers, workers, seats: input.seats }),
    showcase: "spotlight",
    draft: "draft",
  };
}

/** One election per class: the streamer one closes (board seats), the viewer one stays in voting, the worker one nominating. */
export function planElections(
  rng: Rng,
  scale: SeedScale,
  pools: {
    streamers: readonly ElectorateMember[];
    viewers: readonly ElectorateMember[];
    workers: readonly ElectorateMember[];
    seats: Readonly<Record<MemberClass, number>>;
  },
): ElectionSpec[] {
  const statement = (r: Rng) =>
    r.pick([
      "I want the board to keep the co-op's books open and simple.",
      "I will push for faster payouts and clearer statements.",
      "I stream every week and want small channels heard on the board.",
      "I will hold regular members' calls and report back.",
    ]);
  const ballots = (r: Rng, pool: readonly ElectorateMember[], candidates: readonly string[], seats: number) => {
    const voters = r.sample(pool, Math.min(pool.length, 4 * scale.factor + 2));
    return voters.map((v, i) => {
      const k = Math.max(1, Math.min(seats, candidates.length, r.int(1, Math.max(1, seats))));
      // The first ballot approves the first candidate, so every election has a front-runner.
      const approve = i === 0 ? [candidates[0] as string] : r.sample(candidates, k);
      return { voter: v.handle, approve: approve.sort() };
    });
  };
  const handles = (pool: readonly ElectorateMember[]) => pool.map((m) => m.handle);
  const out: ElectionSpec[] = [];
  {
    const r = rng.fork("streamer");
    const extra = r.sample(
      handles(pools.streamers).filter((h) => h !== "council1" && h !== "council2"),
      1,
    );
    const candidates = ["council1", "council2", ...extra].filter((h) => pools.streamers.some((m) => m.handle === h));
    out.push({
      cls: "streamer",
      target: "closed",
      candidates: candidates.map((handle) => ({ handle, statement: statement(r) })),
      ballots: ballots(r, pools.streamers, candidates, pools.seats.streamer),
      nominationsSeconds: 25,
      votingSeconds: 70,
    });
  }
  {
    const r = rng.fork("viewer");
    const others = r.sample(
      handles(pools.viewers).filter((h) => h !== "member1"),
      2,
    );
    const candidates = [...(pools.viewers.some((m) => m.handle === "member1") ? ["member1"] : []), ...others];
    if (candidates.length > 0)
      out.push({
        cls: "viewer",
        target: "voting",
        candidates: candidates.map((handle) => ({ handle, statement: statement(r) })),
        ballots: ballots(r, pools.viewers, candidates, pools.seats.viewer),
        nominationsSeconds: 25,
        votingSeconds: 30 * DAY_S,
      });
  }
  {
    const r = rng.fork("worker");
    const candidates = [
      ...(pools.workers.some((m) => m.handle === "member1") ? ["member1"] : []),
      ...r.sample(
        handles(pools.workers).filter((h) => h !== "member1"),
        1,
      ),
    ];
    if (candidates.length > 0)
      out.push({
        cls: "worker",
        target: "nominating",
        candidates: candidates.map((handle) => ({ handle, statement: statement(r) })),
        ballots: [],
        nominationsSeconds: 14 * DAY_S,
        votingSeconds: 28 * DAY_S,
      });
  }
  return out;
}

/** Board seats a closed election fills: its seats, at most the candidates with an approval. */
export function expectedBoardSeats(e: ElectionSpec, seats: number): number {
  if (e.target !== "closed") return 0;
  const approved = new Set(e.ballots.flatMap((b) => b.approve));
  return Math.min(seats, e.candidates.filter((c) => approved.has(c.handle)).length);
}

// ---------------------------------------------------------------- setting values

/** The seeded defaults the restorations bring back (`packages/db/src/seed.ts`). */
export const DEFAULT_PERIODS = {
  "governance.ordinary": {
    discussionSeconds: 14 * DAY_S,
    minVotingSeconds: 3 * DAY_S,
    votingSeconds: 7 * DAY_S,
    quorum: 0.1,
  },
  "governance.protections": {
    councilReviewSeconds: 7 * DAY_S,
    minVotingSeconds: 7 * DAY_S,
    quorum: 0.2,
    streamerClassQuorum: 0.2,
  },
} as const;

const objectOf = (v: unknown, key: string): Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`coop.settings has no ${key} object`);
  return v as Record<string, unknown>;
};

/** The whole new value of the setting a change kind sets (the API applies a value wholesale). Pure. */
export function changeFor(
  kind: ChangeKind,
  settings: readonly { key: string; value: unknown }[],
): { key: string; value: Record<string, unknown> } {
  const current = (key: string) => objectOf(settings.find((s) => s.key === key)?.value, key);
  switch (kind) {
    case "spotlight": {
      const v = current("discovery.ranking");
      return { key: "discovery.ranking", value: { ...v, spotlightSlots: v.spotlightSlots === 5 ? 6 : 5 } };
    }
    case "juryOn":
      return { key: "jury.enabled", value: { enabled: true } };
    case "ordinaryDefaults":
      return {
        key: "governance.ordinary",
        value: { ...current("governance.ordinary"), ...DEFAULT_PERIODS["governance.ordinary"] },
      };
    case "protectionsDefaults":
      return {
        key: "governance.protections",
        value: { ...current("governance.protections"), ...DEFAULT_PERIODS["governance.protections"] },
      };
    case "platformCut":
      return { key: "platform.cut", value: { ...current("platform.cut"), streamerShare: 0.85, coopShare: 0.15 } };
  }
}

/** `board.seats` per class, defaulting each to 0. */
export function seatsOf(settings: readonly { key: string; value: unknown }[]): Record<MemberClass, number> {
  const v = (settings.find((s) => s.key === "board.seats")?.value ?? {}) as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === "number" && Number.isInteger(x) && x >= 0 ? x : 0);
  return Object.fromEntries(MEMBER_CLASSES.map((c) => [c, n(v[c])])) as Record<MemberClass, number>;
}

/** The rules the plan checks its outcomes against, from `coop.settings`. */
export function rulesOf(settings: readonly { key: string; value: unknown }[]): PlanRules {
  const get = (key: string) => (settings.find((s) => s.key === key)?.value ?? {}) as Record<string, unknown>;
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const o = get("governance.ordinary");
  const p = get("governance.protections");
  const b = BOOTSTRAP_RULES;
  return {
    ordinary: { threshold: num(o.threshold, b.ordinary.threshold), quorum: num(o.quorum, b.ordinary.quorum) },
    protected: {
      memberWideThreshold: num(p.memberWideThreshold, b.protected.memberWideThreshold),
      quorum: num(p.quorum, b.protected.quorum),
      streamerClassQuorum: num(p.streamerClassQuorum, b.protected.streamerClassQuorum),
      streamerClassThreshold: num(p.streamerClassThreshold, b.protected.streamerClassThreshold),
    },
  };
}

// ---------------------------------------------------------------- jury

export const JURY_K = 10;

export type JuryVote = "agree" | "disagree" | "unsure";
export type JuryReason = "clause_fits" | "action_too_severe" | "evidence_unclear";

/** Problems with the jury's inputs (seed-safety's case lists and the opt-ins); empty when it can reach k. */
export function juryInputProblems(input: {
  caseIds: readonly string[];
  reportIds: readonly string[];
  optIns: readonly string[];
}): string[] {
  const out: string[] = [];
  const cases = new Set([...input.caseIds, ...input.reportIds]).size;
  if (cases < JURY_K)
    out.push(`seed-safety published ${cases} jury cases and reports (k = ${JURY_K} needs at least that many)`);
  if (input.optIns.length < JURY_MIN_OPTINS)
    out.push(`${input.optIns.length} jury opt-ins (at least ${JURY_MIN_OPTINS} needed)`);
  return out;
}

/**
 * Each seated juror's votes: every juror disagrees with `target` (the flagged case); on the other
 * cases at most one dissenter per case says `unsure`, so no other case reaches a disagree majority.
 */
export function planJuryVotes(
  rng: Rng,
  lists: readonly (readonly string[])[],
  target: string | null,
): { juror: number; caseId: string; vote: JuryVote; reasonCode: JuryReason }[] {
  const all = [...new Set(lists.flat())].sort();
  const dissenter = new Map<string, number>();
  for (const id of all)
    if (id !== target && rng.chance(0.5)) dissenter.set(id, rng.int(0, Math.max(0, lists.length - 1)));
  const out: { juror: number; caseId: string; vote: JuryVote; reasonCode: JuryReason }[] = [];
  lists.forEach((list, juror) => {
    for (const caseId of list) {
      if (caseId === target) out.push({ juror, caseId, vote: "disagree", reasonCode: "action_too_severe" });
      else if (dissenter.get(caseId) === juror)
        out.push({ juror, caseId, vote: "unsure", reasonCode: "evidence_unclear" });
      else out.push({ juror, caseId, vote: "agree", reasonCode: "clause_fits" });
    }
  });
  return out;
}

/** Clauses never sampled (NCII and minor safety), as `services/worker/src/jury/sample.ts` lists them. */
export const JURY_EXCLUDED_CLAUSES: ReadonlySet<string> = new Set([
  "decency.intimate-images",
  "illegal.ncii",
  "safety.minors",
]);

export interface SampledCase {
  subjectId: string;
  tier: string | null;
  listCategory: string | null;
  ruleRef: string | null;
}

/** Sampled jury cases that must never have been sampled: T0, hash-list, NCII or minor safety. */
export function forbiddenSamples(rows: readonly SampledCase[]): string[] {
  return rows
    .filter((r) => {
      const clause = r.ruleRef ? r.ruleRef.slice(0, r.ruleRef.lastIndexOf("@")) : "";
      return r.tier === "t0" || r.listCategory !== null || JURY_EXCLUDED_CLAUSES.has(clause);
    })
    .map((r) => r.subjectId)
    .sort();
}

// ---------------------------------------------------------------- patronage

/**
 * The patronage period: from the seed run's start (the money unit's revenue all lands after it,
 * since ledger rows keep their real times) to a second ago, after any period already on the
 * instance. Null when nothing is left.
 */
export function patronageWindow(
  runStart: Date,
  now: Date,
  existing: readonly { periodEnd: string }[],
): { start: Date; end: Date } | null {
  return choosePatronagePeriod(runStart, now, existing);
}

/** Whether `window` lies in the UTC month `revenuePeriod` (`YYYY-MM`). */
export function inRevenuePeriod(window: { start: Date; end: Date }, revenuePeriod: string | null): boolean {
  if (!revenuePeriod) return true;
  return (
    window.start.toISOString().slice(0, 7) === revenuePeriod &&
    new Date(window.end.getTime() - 1).toISOString().slice(0, 7) === revenuePeriod
  );
}
