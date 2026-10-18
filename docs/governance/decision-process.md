<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Co-op Decision Process

This document describes how the CommonAir cooperative's members make decisions
through the platform: how a proposal moves from draft to applied, which
decisions are protected, and how votes are counted. For how technical decisions
about the code are made, see [GOVERNANCE.md](../../GOVERNANCE.md).

The cooperative is in formation. Every number below is a **default**. Each
instance, including the flagship, can change its defaults through its
governance settings, and changing them is itself a protected decision.

## Who votes

Members belong to one of three classes: **streamers**, **viewers**, and
**workers**. Each member has one vote, regardless of class, income, or
audience size. Board seats are elected per class.

The **creator council** is an advisory body seated by the highest-contributing
streamers. It has a voice in the process, not extra votes.

## Proposal lifecycle

```
draft → discussion → creator council review (if creator-affecting)
      → voting → tally → published result → applied
```

1. **Draft.** Any member, or the board, writes a proposal: what changes, why,
   and the exact settings or text affected. The author can edit freely.
2. **Discussion.** The proposal is opened to all members for comment.
   Default: at least 14 days. The text is frozen at the end of discussion.
3. **Creator council review.** If the proposal affects creators (earnings,
   payouts, discovery, monetization, content rules, or anything protected),
   the creator council reviews it and publishes a written response before
   voting opens. Default: 7 days. The response is attached to the ballot. If
   the council does not respond in time, voting opens with a note saying so.
4. **Voting.** All eligible members can vote yes, no, or abstain. Default: 7
   days. Members can change their vote until voting closes.
5. **Tally.** When voting closes, the software counts votes member-wide and per
   class and checks them against the thresholds for the decision type.
6. **Published result.** The result, the per-class and member-wide counts,
   turnout, and whether each threshold was met are published to all members.
7. **Applied.** A passed decision takes effect. For settings, the software
   applies the new value from the governance record on the effective date
   stated in the proposal. A failed proposal changes nothing.

## Ordinary and protected decisions

**Ordinary decisions** cover everything not listed as protected, such as
policy positions, budget priorities, or non-binding direction to the board.
They pass by a simple majority of votes cast member-wide.

**Protected decisions** cover:

- The platform cut (default: 90% to the streamer, 10% to the co-op).
- The patronage formula and its weights.
- Payout rules.
- Membership classes.
- The protections themselves, including the list of protected decisions, the
  thresholds, and the code that enforces them.

A protected decision passes only if **both** are true:

- A member-wide supermajority of votes cast is yes (default: two thirds).
- A majority of votes cast within the streamer class is yes.

The streamer-class requirement exists because protected settings decide how
streamers are paid. Viewers and workers together cannot change those terms
without the streamers who live under them.

The software enforces these rules. Protected values are read from the
governance record. There is no admin setting, configuration file, or code path
that changes them outside a passed vote.

## Quorum

A vote is valid only if turnout meets quorum. Defaults:

- Ordinary decisions: 10% of eligible members.
- Protected decisions: 20% of eligible members, and 20% of eligible streamer
  members.

Abstentions count toward quorum but not toward yes or no. A vote that misses
quorum fails, and the result says so.

## Eligibility

Members eligible on the day voting opens may vote. The eligible roll is
snapshotted at that moment so that sign-ups during the vote cannot change the
outcome.

## Audit trail

Every step is recorded and kept:

- Each version of the proposal text, with timestamps.
- Discussion comments.
- The creator council response.
- The eligibility snapshot.
- Each ballot, recorded so a member can verify their own vote was counted,
  while totals are published without revealing how any individual voted.
- The tally, the thresholds applied, and the published result.
- The settings change applied, linked to the decision that authorized it.

Any member can inspect the record for any decision. Settings history shows,
for every protected value, which decision set it.

## Defaults summary

| Setting                         | Default                          |
| ------------------------------- | -------------------------------- |
| Discussion period               | 14 days                          |
| Creator council review          | 7 days                           |
| Voting period                   | 7 days                           |
| Ordinary threshold              | Simple majority                  |
| Protected member-wide threshold | Two thirds of votes cast         |
| Protected streamer-class rule   | Majority of streamer votes cast  |
| Ordinary quorum                 | 10% of eligible members          |
| Protected quorum                | 20% overall and 20% of streamers |

All defaults are configurable through governance settings. Changing them is a
protected decision.

Questions: governance@commonair.tv.
