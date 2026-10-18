<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Project Governance

This document describes how technical decisions about the CommonAir code get
made, and how that work relates to the cooperative that owns the platform. For
how the co-op's members propose and vote on decisions, see
[docs/governance/decision-process.md](docs/governance/decision-process.md).

CommonAir is pre-1.0 and the cooperative is in formation. This document will be
revised when the co-op incorporates and its bylaws are adopted.

## Roles

**Contributors** are anyone who opens an issue, reviews a PR, writes docs, or
submits code. No membership in the co-op is required.

**Maintainers** can review and merge pull requests, triage issues, and cut
releases. Maintainers are co-op worker members assigned to the project, plus
trusted outside contributors who have been invited. The current list is kept on the
repository's GitHub maintainers team.

**The co-op board** is elected by the members, with seats per membership class
(streamers, viewers, workers). It sets the cooperative's priorities, including
what the paid engineering work focuses on.

**The members** vote on proposals, one member one vote. Some settings are
_protected_ and can only change through a member vote (see below).

## Everyday decisions: lazy consensus

Most decisions happen in pull requests and issues.

- A PR can merge when CI is green, at least one maintainer other than the
  author has approved it, and no maintainer has an unresolved objection.
- Silence is consent. Anyone who disagrees should say so in the PR with a
  reason and, ideally, an alternative.
- Changes to security-sensitive code (authentication, payments, the ledger,
  governance enforcement, the relay protocol) need two maintainer approvals.
- Maintainers do not merge their own PRs without another maintainer's review.

## Significant decisions: ADRs

A decision is significant if it is hard to reverse, affects several parts of
the system, adds a dependency through a judgment call, or changes a public
interface. Significant decisions are recorded as Architecture Decision Records
in [`docs/decisions/`](docs/decisions/), numbered in order
(`NNNN-short-title.md`), with these sections:

- **Context**: the problem, constraints, and options considered.
- **Decision**: what we chose, stated plainly.
- **Consequences**: what follows, including costs and things we gave up.

An ADR is proposed in a PR, discussed there, and merged under the same lazy
consensus as code, with at least three days open for comment. ADRs are not
edited after acceptance; a later ADR supersedes an earlier one and says so.

## How the co-op and the code relate

- **The board sets priorities.** It decides which roadmap items the co-op
  funds and in what order. It does not review individual PRs.
- **Members govern protected settings.** The platform cut (default: streamer
  90%, co-op 10%), the patronage formula and weights, payout rules, membership
  classes, and the protections themselves can only change through a passed
  member vote. A protected change needs a member-wide supermajority (default
  two thirds) and a majority within the streamer class. The software enforces
  this: protected values are read from the governance record, not from code or
  configuration.
- **Maintainers cannot override protected settings in code.** A PR that
  changes a protected value, bypasses the governance check, or alters its
  defaults without a passed governance decision will not be merged. A PR
  implementing a passed decision links to the published result.
- **Changes to the enforcement code are themselves protected.** Any change to
  how protected decisions are tallied, what counts as protected, or the
  thresholds required is a protected decision. Maintainers may fix bugs that
  make enforcement stricter or more correct; anything that loosens it needs a
  member vote first.
- **The creator council** reviews creator-affecting proposals before they go
  to a vote and publishes a response. It advises; it has no veto and no extra
  votes.

Self-hosted instances run their own governance with the same software. Nothing
in this document gives the co-op authority over someone else's instance.

## Becoming a maintainer

Outside contributors become maintainers by showing sustained, good judgment,
not by reaching a fixed count of commits. A typical path:

1. Land several meaningful PRs over a few months.
2. Review others' PRs helpfully and triage issues.
3. Show familiarity with the engineering rules in [AGENTS.md](AGENTS.md) and
   the relevant ADRs.

Any maintainer can nominate a contributor. The nomination is discussed among
maintainers for one week and passes if no maintainer objects. Maintainers who
are inactive for six months move to emeritus status and can return by asking.
A maintainer can be removed for a Code of Conduct violation through that
process, or by a two-thirds vote of the other maintainers.

## Resolving disagreements

1. Discuss in the PR or issue. Focus on evidence: benchmarks, test cases,
   user impact, prior ADRs.
2. If it stalls, any party can ask for a written proposal (an ADR draft) laying
   out the options.
3. If maintainers still disagree, they decide by simple majority of active
   maintainers, recorded in the ADR.
4. If the disagreement is about priorities or co-op policy rather than
   technique, it goes to the board. If it touches a protected setting, it goes
   to a member vote.

Conduct problems follow the [Code of Conduct](CODE_OF_CONDUCT.md), not this
process.

## Roadmap

The public roadmap is [ROADMAP.md](ROADMAP.md). Work is tracked in GitHub
issues. Anyone can propose a roadmap change by opening an issue or a PR against
the roadmap. The board sets the order of co-op-funded work; maintainers keep
the document current.

## Contact

Governance questions: governance@commonair.tv.
