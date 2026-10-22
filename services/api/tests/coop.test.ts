// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Co-op pure logic: the access matrix for every `coop.*` procedure, the proposal action policy,
 * the view builders (secret ballot, drafts), eligibility, draft classification and the mapping of
 * every trigger refusal to a contract error.
 */
import { describe, expect, test } from "vite-plus/test";
import { contract, type ProcedureMeta } from "@commonair/contracts";
import { DEFAULT_GOVERNANCE_SETTINGS } from "@commonair/db";
import { membershipClassesOf } from "@commonair/governance";
import { mapCoopDbError } from "../src/coop/errors.ts";
import { type ActionFacts, type ProposalAction, refuseProposalAction } from "../src/coop/policy.ts";
import { classifyDraft } from "../src/coop/shared.ts";
import {
  buildProposalView,
  councilResponseMissed,
  eligibility,
  proposalVisibleTo,
  votingOpen,
  type ProposalFacts,
} from "../src/coop/views.ts";
import { decideAccess, type Caller, type CallerUser } from "../src/lib/access.ts";

const SETTINGS = Object.fromEntries(DEFAULT_GOVERNANCE_SETTINGS.map((s) => [s.key, s.value]));
const T0 = new Date("2026-10-21T12:00:00Z");
const at = (s: number) => new Date(T0.getTime() + s * 1000);

// Access matrix -------------------------------------------------------------------------------

type Persona = "anonymous" | "user" | "suspended" | "treasurer" | "admin" | "moderator";
const person = (role: CallerUser["role"], suspended = false): Caller => ({
  kind: "session",
  user: { id: "u1", username: "u", role, accountType: "human", suspended },
  sessionId: "s",
});
const PERSONAS: Record<Persona, Caller | null> = {
  anonymous: null,
  user: person("user"),
  suspended: person("user", true),
  treasurer: person("treasurer"),
  admin: person("admin"),
  moderator: person("moderator"),
};

/** Procedure → platform access level (members, authors and council seats are checked in handlers). */
const EXPECTED: Record<string, ProcedureMeta["access"]> = {
  "coop.membership": "user",
  "coop.buyShare": "user",
  "coop.shares.list": "treasurer",
  "coop.shares.refund": "treasurer",
  "coop.exit": "user",
  "coop.appointWorker": "admin",
  "coop.settings": "public",
  "coop.proposals.list": "public",
  "coop.proposals.get": "public",
  "coop.proposals.create": "user",
  "coop.proposals.update": "user",
  "coop.proposals.submit": "user",
  "coop.proposals.withdraw": "user",
  "coop.proposals.comments": "public",
  "coop.proposals.comment": "user",
  "coop.proposals.vote": "user",
  "coop.proposals.councilRespond": "user",
  "coop.council": "public",
  "coop.elections.list": "public",
  "coop.elections.nominate": "user",
  "coop.elections.vote": "user",
  "coop.elections.create": "admin",
  "coop.board": "public",
  "coop.patronage.statements": "user",
  "coop.patronage.statement": "user",
  "coop.patronage.run": "treasurer",
  "coop.patronage.approve": "finance",
  "coop.patronage.periods": "finance",
  "coop.transparency": "public",
};

type Proc = { "~orpc": { meta: ProcedureMeta; route: { method?: string } } };
function procedures(node: unknown, path: string, out: Map<string, Proc>) {
  if (node && typeof node === "object" && "~orpc" in node) out.set(path, node as Proc);
  else if (node && typeof node === "object")
    for (const [k, v] of Object.entries(node)) procedures(v, `${path}.${k}`, out);
  return out;
}

/** Who passes the platform check for each access level. */
const ALLOWED: Record<string, readonly Persona[]> = {
  public: ["anonymous", "user", "suspended", "treasurer", "admin", "moderator"],
  user: ["user", "treasurer", "admin", "moderator"],
  admin: ["admin"],
  treasurer: ["treasurer"],
  finance: ["treasurer", "admin"],
};

describe("access matrix for coop.*", () => {
  const procs = procedures(contract.coop, "coop", new Map());

  test("every procedure is in the matrix with its access level", () => {
    expect([...procs.keys()].sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const [path, p] of procs) expect(p["~orpc"].meta.access, path).toBe(EXPECTED[path]);
  });

  for (const [path, access] of Object.entries(EXPECTED)) {
    test(`${path} (${access})`, () => {
      const p = procs.get(path);
      if (!p) throw new Error(`missing ${path}`);
      const write = (p["~orpc"].route.method ?? "POST") !== "GET";
      for (const [name, caller] of Object.entries(PERSONAS) as [Persona, Caller | null][]) {
        const d = decideAccess({ meta: p["~orpc"].meta, caller, write });
        // Suspended accounts may read what users read, never write.
        const allowed = name === "suspended" && access === "user" ? !write : (ALLOWED[access] ?? []).includes(name);
        expect(d.ok, `${path} as ${name}`).toBe(allowed);
      }
    });
  }
});

// Proposal action policy ------------------------------------------------------------------------

const AUTHOR = "author";
const OTHER = "other";
const proposal = (status: ActionFacts["proposal"]["status"], over: Partial<ActionFacts["proposal"]> = {}) => ({
  authorId: AUTHOR,
  status,
  votingStartsAt: status === "voting" ? at(-10) : null,
  votingEndsAt: status === "voting" ? at(10) : null,
  ...over,
});
const facts = (p: ActionFacts["proposal"], callerId: string, over: Partial<ActionFacts> = {}): ActionFacts => ({
  proposal: p,
  callerId,
  member: true,
  inElectorate: true,
  seated: false,
  responded: false,
  now: T0,
  ...over,
});
const code = (a: ProposalAction, f: ActionFacts) => refuseProposalAction(a, f)?.code ?? "ok";

describe("proposal action policy", () => {
  test("drafts exist only for their author", () => {
    for (const a of ["edit", "submit", "withdraw", "comment", "vote", "councilRespond"] as const)
      expect(code(a, facts(proposal("draft"), OTHER))).toBe("NOT_FOUND");
    expect(proposalVisibleTo(proposal("draft"), null)).toBe(false);
    expect(proposalVisibleTo(proposal("discussion"), null)).toBe(true);
  });

  test("edit: the author, while draft or discussion", () => {
    expect(code("edit", facts(proposal("draft"), AUTHOR))).toBe("ok");
    expect(code("edit", facts(proposal("discussion"), AUTHOR))).toBe("ok");
    expect(code("edit", facts(proposal("discussion"), OTHER))).toBe("FORBIDDEN");
    for (const s of ["council_review", "voting", "passed", "rejected", "withdrawn", "applied"] as const)
      expect(code("edit", facts(proposal(s), AUTHOR)), s).toBe("CONFLICT");
  });

  test("submit: the author, drafts only", () => {
    expect(code("submit", facts(proposal("draft"), AUTHOR))).toBe("ok");
    expect(code("submit", facts(proposal("discussion"), AUTHOR))).toBe("CONFLICT");
    expect(code("submit", facts(proposal("discussion"), OTHER))).toBe("FORBIDDEN");
  });

  test("withdraw: the author, before voting", () => {
    for (const s of ["draft", "discussion", "council_review"] as const)
      expect(code("withdraw", facts(proposal(s), AUTHOR)), s).toBe("ok");
    for (const s of ["voting", "passed", "rejected", "withdrawn", "applied"] as const)
      expect(code("withdraw", facts(proposal(s), AUTHOR)), s).toBe("CONFLICT");
    expect(code("withdraw", facts(proposal("discussion"), OTHER))).toBe("FORBIDDEN");
  });

  test("comment: members, while discussion, council review or voting", () => {
    for (const s of ["discussion", "council_review", "voting"] as const) {
      expect(code("comment", facts(proposal(s), OTHER)), s).toBe("ok");
      expect(code("comment", facts(proposal(s), OTHER, { member: false })), s).toBe("PRECONDITION_FAILED");
    }
    for (const s of ["passed", "rejected", "withdrawn", "applied"] as const)
      expect(code("comment", facts(proposal(s), OTHER)), s).toBe("CONFLICT");
    expect(code("comment", facts(proposal("draft"), AUTHOR))).toBe("CONFLICT");
  });

  test("vote: electorate members inside the window", () => {
    expect(code("vote", facts(proposal("voting"), OTHER))).toBe("ok");
    expect(refuseProposalAction("vote", facts(proposal("voting"), OTHER, { inElectorate: false }))).toMatchObject({
      code: "FORBIDDEN",
      reason: "not_in_electorate",
    });
    const closed = proposal("voting", { votingEndsAt: at(-1) });
    expect(refuseProposalAction("vote", facts(closed, OTHER))).toMatchObject({
      code: "CONFLICT",
      reason: "voting_closed",
    });
    expect(code("vote", facts(proposal("voting", { votingStartsAt: at(1) }), OTHER))).toBe("CONFLICT");
    // The window's last instant still counts (the trigger uses `>` voting_ends_at to refuse).
    expect(code("vote", facts(proposal("voting", { votingEndsAt: T0 }), OTHER))).toBe("ok");
    for (const s of ["discussion", "council_review", "passed", "rejected"] as const)
      expect(code("vote", facts(proposal(s), OTHER)), s).toBe("CONFLICT");
  });

  test("council response: a seated member, in council review, once", () => {
    expect(code("councilRespond", facts(proposal("council_review"), OTHER, { seated: true }))).toBe("ok");
    expect(code("councilRespond", facts(proposal("council_review"), OTHER))).toBe("FORBIDDEN");
    expect(code("councilRespond", facts(proposal("council_review"), OTHER, { seated: true, responded: true }))).toBe(
      "CONFLICT",
    );
    for (const s of ["discussion", "voting", "passed"] as const)
      expect(code("councilRespond", facts(proposal(s), OTHER, { seated: true })), s).toBe("CONFLICT");
  });
});

// Views -------------------------------------------------------------------------------------------

const breakdown = {
  memberWide: { eligible: 4, yes: 3, no: 1, abstain: 0 },
  byClass: {
    streamer: { eligible: 2, yes: 1, no: 1, abstain: 0 },
    viewer: { eligible: 1, yes: 1, no: 0, abstain: 0 },
    worker: { eligible: 1, yes: 1, no: 0, abstain: 0 },
  },
  checks: [{ rule: "streamer_class_majority", passed: false, detail: "1/2" }],
};

function proposalFacts(over: Partial<ProposalFacts> = {}, row: Partial<ProposalFacts["row"]> = {}): ProposalFacts {
  return {
    row: {
      id: "p1",
      authorId: AUTHOR,
      title: "Change the cut",
      body: "Body",
      kind: "protected",
      affectsCreators: true,
      status: "voting",
      changes: [{ key: "platform.cut", value: { streamerShare: 0.85, coopShare: 0.15 } }],
      discussionEndsAt: at(-100),
      councilReviewEndsAt: at(-50),
      votingStartsAt: at(-40),
      votingEndsAt: at(40),
      decidedAt: null,
      appliedAt: null,
      createdAt: at(-200),
      ...row,
    },
    author: { id: AUTHOR, username: "a", displayName: "A" },
    from: new Map([["platform.cut", { streamerShare: 0.9, coopShare: 0.1 }]]),
    protectedKeys: new Set(["platform.cut"]),
    councilResponse: null,
    tally: { breakdown, passed: false, reason: "streamer-class majority not met" },
    participation: { voted: 3, eligible: 4 },
    callerVote: "yes",
    callerInElectorate: true,
    callerId: OTHER,
    now: T0,
    ...over,
  };
}

describe("proposal view", () => {
  test("no tally while voting, even if a row were present; participation counts only", () => {
    const v = buildProposalView(proposalFacts());
    expect(v.tally).toBeNull();
    expect(v.participation).toEqual({ voted: 3, eligible: 4 });
    expect(v.canVote).toBe(true);
    expect(v.myVote).toBe("yes");
  });

  test("decided proposals show the tallies row", () => {
    const v = buildProposalView(proposalFacts({}, { status: "rejected", decidedAt: at(-1), votingEndsAt: at(-2) }));
    expect(v.tally).toEqual({ breakdown, passed: false, reason: "streamer-class majority not met" });
    expect(v.canVote).toBe(false);
  });

  test("myVote is only ever the caller's own; anonymous callers have none and cannot vote", () => {
    const v = buildProposalView(proposalFacts({ callerId: null, callerVote: "no" }));
    expect(v.myVote).toBeNull();
    expect(v.canVote).toBe(false);
    expect(buildProposalView(proposalFacts({ callerVote: null })).myVote).toBeNull();
  });

  test("outside the electorate or the window the caller cannot vote", () => {
    expect(buildProposalView(proposalFacts({ callerInElectorate: false })).canVote).toBe(false);
    expect(buildProposalView(proposalFacts({}, { votingEndsAt: at(-1) })).canVote).toBe(false);
  });

  test("before voting opens there is no participation", () => {
    const v = buildProposalView(
      proposalFacts({ participation: { voted: 0, eligible: 0 } }, { status: "discussion", votingStartsAt: null }),
    );
    expect(v.participation).toBeNull();
    expect(v.tally).toBeNull();
  });

  test("changes carry from, to and protected", () => {
    expect(buildProposalView(proposalFacts()).changes).toEqual([
      {
        key: "platform.cut",
        from: { streamerShare: 0.9, coopShare: 0.1 },
        to: { streamerShare: 0.85, coopShare: 0.15 },
        protected: true,
      },
    ]);
  });

  test("council response missed once review ended without one", () => {
    const p = { affectsCreators: true, councilReviewEndsAt: at(-1) };
    expect(councilResponseMissed({ ...p, status: "voting" }, false, T0)).toBe(true);
    expect(councilResponseMissed({ ...p, status: "voting" }, true, T0)).toBe(false);
    expect(councilResponseMissed({ ...p, status: "council_review" }, false, T0)).toBe(true);
    expect(councilResponseMissed({ ...p, status: "council_review", councilReviewEndsAt: at(5) }, false, T0)).toBe(
      false,
    );
    expect(
      councilResponseMissed({ affectsCreators: false, councilReviewEndsAt: null, status: "voting" }, false, T0),
    ).toBe(false);
    expect(councilResponseMissed({ ...p, status: "withdrawn", councilReviewEndsAt: at(5) }, false, T0)).toBe(false);
  });

  test("votingOpen needs status voting and the window", () => {
    expect(votingOpen({ status: "voting", votingStartsAt: at(-1), votingEndsAt: at(1) }, T0)).toBe(true);
    expect(votingOpen({ status: "passed", votingStartsAt: at(-1), votingEndsAt: at(1) }, T0)).toBe(false);
    expect(votingOpen({ status: "voting", votingStartsAt: null, votingEndsAt: null }, T0)).toBe(false);
  });
});

describe("eligibility", () => {
  const rules = membershipClassesOf(SETTINGS);
  const base = { rules, streamingHours: 0, heldShareCents: null, qualifyingSubscription: false, activeWorker: false };

  test("nothing yet: progress toward each threshold", () => {
    const [s, v, w] = eligibility(base);
    expect(s).toMatchObject({ class: "streamer", eligible: false, basis: null });
    expect(s?.progress).toEqual({ have: 0, need: rules.streamer.minStreamingHours, unit: "hours" });
    expect(v).toMatchObject({ class: "viewer", eligible: false, basis: null });
    expect(v?.progress).toEqual({ have: 0, need: rules.viewer.shareCents, unit: "cents" });
    expect(w).toMatchObject({ class: "worker", eligible: false, basis: null, progress: null });
  });

  test("streamer at exactly the threshold is eligible", () => {
    const [s] = eligibility({ ...base, streamingHours: rules.streamer.minStreamingHours });
    expect(s).toMatchObject({ eligible: true, basis: "streaming_hours" });
    const [below] = eligibility({ ...base, streamingHours: rules.streamer.minStreamingHours - 0.01 });
    expect(below?.eligible).toBe(false);
    expect(eligibility({ ...base, streamingHours: Number.NaN })[0]?.eligible).toBe(false);
  });

  test("a held share beats a subscription; subscriptions qualify only when the rules say so", () => {
    expect(eligibility({ ...base, heldShareCents: rules.viewer.shareCents })[1]).toMatchObject({
      eligible: true,
      basis: "share",
      progress: { have: rules.viewer.shareCents },
    });
    expect(
      eligibility({ ...base, heldShareCents: rules.viewer.shareCents, qualifyingSubscription: true })[1]?.basis,
    ).toBe("share");
    const off = { ...rules, viewer: { ...rules.viewer, activeSubscriptionQualifies: false } };
    expect(eligibility({ ...base, rules: off, qualifyingSubscription: true })[1]?.eligible).toBe(false);
    const on = { ...rules, viewer: { ...rules.viewer, activeSubscriptionQualifies: true } };
    expect(eligibility({ ...base, rules: on, qualifyingSubscription: true })[1]?.basis).toBe("subscription");
  });

  test("worker only by appointment", () => {
    expect(eligibility({ ...base, activeWorker: true })[2]).toMatchObject({
      eligible: true,
      basis: "board_appointment",
    });
  });
});

describe("draft classification", () => {
  test("no changes: an ordinary proposal", () => {
    expect(classifyDraft([], false, SETTINGS)).toEqual({
      ok: true,
      kind: "ordinary",
      affectsCreators: false,
      keys: [],
    });
  });
  test("a protected key makes it protected and forces affectsCreators", () => {
    const value = { streamerShare: 0.85, coopShare: 0.15 };
    expect(classifyDraft([{ key: "platform.cut", value }], false, SETTINGS)).toMatchObject({
      ok: true,
      kind: "protected",
      affectsCreators: true,
    });
  });
  test("an ordinary key keeps the author's affectsCreators", () => {
    const ranking = SETTINGS["discovery.ranking"];
    expect(classifyDraft([{ key: "discovery.ranking", value: ranking }], true, SETTINGS)).toMatchObject({
      ok: true,
      kind: "ordinary",
      affectsCreators: true,
    });
  });
  test("unknown or duplicate keys and malformed values are refused", () => {
    expect(classifyDraft([{ key: "no.such", value: 1 }], false, SETTINGS).ok).toBe(false);
    const ranking = SETTINGS["discovery.ranking"];
    expect(
      classifyDraft(
        [
          { key: "discovery.ranking", value: ranking },
          { key: "discovery.ranking", value: ranking },
        ],
        false,
        SETTINGS,
      ).ok,
    ).toBe(false);
    expect(classifyDraft([{ key: "discovery.ranking", value: { spotlightSlots: 4 } }], false, SETTINGS).ok).toBe(false);
    expect(classifyDraft([{ key: "platform.cut", value: { streamerShare: 2 } }], false, SETTINGS).ok).toBe(false);
  });
});

// Trigger refusals → contract errors ----------------------------------------------------------

const pgError = (code: string, message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error("Failed query"), { cause: Object.assign(new Error(message), { code, ...extra }) });

describe("trigger refusals map to contract errors", () => {
  const cases: [string, string, string, unknown][] = [
    ["42501", "user 1 is not in the electorate for proposal 2", "FORBIDDEN", { reason: "not_in_electorate" }],
    ["23514", "voting is not open for proposal 2", "CONFLICT", { reason: "voting_closed" }],
    ["23514", "proposal changes must name existing settings, each once", "BAD_REQUEST", undefined],
    [
      "23514",
      "a proposal changing protected settings must be kind=protected and affect creators",
      "BAD_REQUEST",
      undefined,
    ],
    [
      "42501",
      "a proposal's content is frozen once review or voting begins, and cannot change during a transition",
      "CONFLICT",
      undefined,
    ],
    ["23514", "proposal status cannot go from voting to withdrawn", "CONFLICT", undefined],
    ["23514", "the discussion period has not ended", "CONFLICT", undefined],
    ["23514", "comments are open only during discussion, council review and voting", "CONFLICT", undefined],
    ["42501", "only members comment on proposals", "PRECONDITION_FAILED", { requirement: "membership" }],
    ["23514", "the council responds only while a proposal is in council review", "CONFLICT", undefined],
    ["23514", "only the current council term can respond", "FORBIDDEN", undefined],
    ["42501", "only a seated council member can publish the response", "FORBIDDEN", undefined],
    ["42501", "council responses are final (UPDATE rejected)", "CONFLICT", undefined],
    ["23505", "this member already has an open share", "CONFLICT", undefined],
    ["23514", "a member share cannot go from held to refunded", "CONFLICT", undefined],
    ["23514", "a share is refunded only once the refund is posted", "CONFLICT", undefined],
    [
      "42501",
      "a patronage period must be approved by someone other than the person who ran it",
      "FORBIDDEN",
      { reason: "second_approver" },
    ],
    ["42501", "a patronage period is approved by a treasurer or an admin", "FORBIDDEN", undefined],
    ["23514", "only a computed patronage period can be approved", "CONFLICT", undefined],
    ["42501", "an approved patronage period is frozen", "CONFLICT", undefined],
    ["42501", "setting platform.cut can only change by applying a passed proposal", "FORBIDDEN", undefined],
    ["42501", "some future rule", "FORBIDDEN", undefined],
    ["23514", "some future check", "CONFLICT", undefined],
    ["P0001", "raised", "CONFLICT", undefined],
  ];
  for (const [sqlstate, message, expected, data] of cases) {
    test(`${sqlstate} ${message}`, () => {
      const mapped = mapCoopDbError(pgError(sqlstate, message));
      expect(mapped?.code).toBe(expected);
      expect(mapped?.data).toEqual(data);
      // Never the trigger's own text.
      expect(mapped?.message).not.toContain(message);
    });
  }

  test("unique violations name the conflict, others pass through", () => {
    const dup = mapCoopDbError(pgError("23505", "duplicate key", { constraint_name: "council_responses_pkey" }));
    expect(dup).toMatchObject({ code: "CONFLICT", message: "The council already responded to this proposal" });
    expect(mapCoopDbError(new Error("boom"))).toBeNull();
    expect(mapCoopDbError(pgError("57014", "canceling statement"))).toBeNull();
  });
});
