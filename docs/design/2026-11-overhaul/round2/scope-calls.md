<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# scope-calls: open decisions 3 and 4

Read only. The repo is at `97156a86`. Staging data came from read-only `SELECT`s inside
`BEGIN READ ONLY … ROLLBACK`. Outside research was done signed out in my own browser tab. No cookie
banner appeared on the pages I read.

---

## Decision 3: the optional interest list (D2.9 / growth-funnels P8)

### 1. The question

Should we build a double opt-in email list for people with no account ("creator interest" and
"co-op news"), sent through our own mail, now or only after `/creators` ships? Or never?

### 2. What we found

**The proposal.** In `growth-funnels.md` §P8 (lines 188-194), one form on `/creators` would collect
an email address only, with a topic. Rows go into a new `interest_signups (email, topic,
confirmed_at)` table. Double opt-in goes through `packages/email`, with RFC 8058 unsubscribe. Rows
are deleted after the one send or after 12 months. P8 rates it **S, impact low-med**.

**What exists today. Every mail list is tied to an account:**

- `UNSUBSCRIBE_LISTS = ["go_live", "governance", "moved"]` (`packages/contracts/src/enums.ts:318`).
  `PREFERENCE_TYPES = ["go_live"]` (`:312`).
- The one-click unsubscribe is built and works: `List-Unsubscribe` plus `List-Unsubscribe-Post` go to
  `/api/email/unsubscribe` (ADR 0028 §1, `docs/decisions/0028-notifications.md:273-279`). Its token
  **resolves to a member's user id**: `applyUnsubscribe(…)` returns `userId`
  (`services/api/src/notifications/email-unsubscribe.ts:61`, and see
  `services/api/src/notifications/unsubscribe/apply.ts:35-39`). An address with no account has no
  subject to unsubscribe, so we would need a new token subject and a new apply path.
- `moved` is already a one-shot email, "email me once if this channel moves". That proves the
  "one send, then delete" pattern, but only for account holders.
- `governance` stores email-off rows for `proposal` and `vote_open`, "ready for when governance mail
  has a sender" (ADR 0028:278-279). So **co-op news for members already has a list, and it has no
  sender yet.**
- `consent_records` (`packages/db/src/schema/safety.ts:441-460`) records **cookie** consent, for a
  `userId` or a first-party `anonymousId`. It has no email column and was not designed for mail
  consent.
- There is no waitlist, newsletter or interest table anywhere. `git grep` for
  waitlist|newsletter|interest_signup finds nothing in packages, services or web.
- Sign-up already has abuse protection: self-hosted ALTCHA proof-of-work
  (`services/api/src/auth/altcha.ts`). It also has the 13+ age gate, with a birth date fixed at
  sign-up (ADR 0017:26). A form with no account would have neither.

**The "governance story" in P8 is not real.** P8 says the members already voted down "Add a
members' newsletter". That title is a random filler topic in the harness seed
(`harness/src/seed/coop/plan.ts:266`, `FILLER_TOPICS`). The seed made up the vote; no members cast
it. We must not cite it as a member decision on any public page.

**Is there an audience to capture?** Not yet. There are no deployments and no self-hosters. The
2,119 users on staging are seed and harness accounts. `/creators` does not exist, and P8's only
form would live there. Before launch the list would mostly collect our own test addresses.

**What the "S" estimate leaves out:**

| Hidden cost                                                                                                               | Why it is needed                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| A new unsubscribe token subject (email or signup id) and an apply path                                                    | The current tokens resolve to a user id                                                               |
| A confirm-link flow: token, expiry, a confirmed and an unconfirmed state, and a cleanup job for unconfirmed rows          | Double opt-in. Gmail says to confirm each address before subscribing it                               |
| ALTCHA on the form, plus per-IP and per-address rate limits                                                               | A double opt-in form is a **mail-bombing tool**: anyone can make us send confirmations to a victim    |
| Data-subject requests by email address with no account behind it: export, deletion, and proof of consent (GDPR Art. 7(1)) | Our deletion and export flows (ADR 0004 pseudonymization) all key on `users.id`                       |
| A privacy-policy section for non-member data, a counsel note (maintainer call, per the no-counsel memo), and es/en copy   | New category of personal data                                                                         |
| Self-host parity: the form, confirmation and sender must work on every operator's SMTP                                    | Memo: self-host parity                                                                                |
| Sender reputation: mail to cold, unverified addresses goes from the same domain as go-live and password reset             | Gmail's spam limit is under 0.3% (aim for under 0.1%). Bounces and complaints hurt transactional mail |
| No age gate                                                                                                               | We would store children's emails with no 13+ check                                                    |

The real cost is **M**, not S, and the data it holds is the most sensitive we have: email addresses
of people who never agreed to our terms.

**Account creation already covers most of it.** "Creator interest" is sign-up with
`?intent=stream` (D2 §8, growth-funnels contract requests), and that lands on the `/dashboard`
checklist. "Co-op news" for members is the `governance` list, which already exists. The only gap
is a visitor who wants an email **when a feature they are missing ships** (P8's own examples:
payouts in their currency, or their region) and who will not make an account.

### 3. Options

| Option                                                                                                                                                                                                                                                                                    | Cost | Risk                                                          | Impact                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **A. Build P8 now** (non-account list on `/creators`)                                                                                                                                                                                                                                     | M    | High: privacy, abuse and deliverability, with no audience yet | Near zero before launch                                                  |
| **B. Account-bound "tell me when" instead.** A preference type `feature_ready` with a topic, on the existing `notification_preferences`, `UNSUBSCRIBE_LISTS` and token path. Shown on `/creators` and `/coop/membership` as "Create a free account and we'll email you once when X ships" | S    | Low: reuses the age gate, ALTCHA, deletion and unsubscribe    | Covers most real cases, and every signup counts toward the growth funnel |
| **C. Never.** Accounts plus the members' `governance` list only                                                                                                                                                                                                                           | 0    | Low                                                           | Loses the "won't make an account" visitor, who is probably a small group |

### 4. Recommendation

**Later, and as B before A.** Do not build an interest list with no account now. When `/creators`
ships, offer the account-bound version (B) if a real "not yet" topic exists. Build the
non-account list (A) only if B shows demand we cannot meet any other way.

Why: there is no audience to capture before launch. A costs M and carries the riskiest data and
abuse surface we would have. Its one cited reason, "members rejected a newsletter", is seed
filler. B gets the same "email me when it ships" outcome inside the systems we already built
(ADR 0004 deletion, RFC 8058 unsubscribe, 13+ gate, ALTCHA).

**Trigger for B** (all of these):

1. `/creators` is live.
2. At least one gated "not yet" exists that a visitor can name. Examples: card payments off in a
   region, payouts not offered in a currency, a feature on the public roadmap.

**Trigger for A** (after B):

- 90 days of `/creators` counters (growth-funnels' `ui_counters`) show the "Email me" CTA opened
  often, with a high bail-out at the sign-up step. A number to start from: at least 200 opens and
  under 25% of them finishing sign-up.
- Or the members vote for a newsletter in a real proposal.

**What would change my mind:** a launch partner bringing a known audience (a creator collective
or a co-op federation), which would make capture before launch worth the M. Or counsel and the
maintainer deciding that account creation is too heavy a step for people who are only curious.

### 5. If accepted: changes to the plan

- **D2.9** becomes: "Later. When `/creators` ships, an account-bound 'tell me when X ships' (one
  send) via notification preferences. No list without accounts until the trigger." Move it out
  of the D2 batch into a post-`/creators` follow-up.
- **growth-funnels P8:** strike the "seeded proposal rejected" sentence. If B goes ahead, replace
  the `interest_signups` table.
- **Contract request (only when B is triggered).** Add `feature_ready` to `PREFERENCE_TYPES` and
  `UNSUBSCRIBE_LISTS`. Add a `topic` enum in contracts, a closed list kept in code, never free
  text. The email template sends once, then deletes the preference row. No new PII table.
- **Brand colour** (agreed with direction-check). Any "Email me when…" control is an outline or
  secondary button, never a second brand fill. Keep it out of the viewport that holds the filled
  "Start streaming", because brand beside a white primary is 1.35:1 and the two separate by hue
  alone.

---

## Decision 4: points redemption (D4.5 / watch WX-24, P12)

### 1. The question

Should viewers be able to redeem channel points (Twitch-style channel rewards) in this overhaul?
Or later, and on what trigger? Or should points leave the UI entirely?

### 2. What we found

**How points work today (ADR 0026, accepted 2026-10-27):**

- **Viewers earn points only for verified watch time.** The rule is per-minute blocks of
  `GATE_ELIGIBLE` playback sessions, defaulting to 10 points per 5 minutes and at most 1,000 points
  a day per channel (ADR 0026 decision 1, `docs/decisions/0026-interactivity-policies.md:86-108`;
  `services/worker/src/interact/points/accrue.ts:112`). Owners' own sessions are excluded
  (`accrue.ts:114`, `ps.user_id <> c.owner_id`). **Follows and chat earn nothing.** watch.md P12's
  copy, "How you earn: watch time, follow, chat" (`watch.md:329`), is wrong and must change.
- **Points are an append-only ledger with a balance kept by trigger and `CHECK (points >= 0)`**
  (`packages/db/drizzle/0034_e8_protections.sql:4-47`). `LOYALTY_REASONS` is a closed enum:
  watch, command, prediction_bet, prediction_payout, prediction_refund, poll_vote and
  moderator_adjust (`packages/contracts/src/enums.ts:251-259`).
- **No money path in either direction.** Points cannot be bought or cashed out, and predictions
  stake only points (ADR 0026 decision 3). The terms say points "have no cash value"
  (`packages/db/src/legal/terms.md:89`, a draft for counsel). Giveaways can never take points as an
  entry (ADR 0039:106, :221).
- **Points are on by default on every channel.** `accrue.ts:61` reads
  `coalesce(…'enabled','true')`. That is why the chip shows everywhere, including "0 points" on
  the owner's own channel.

**Points already have three ways to spend.** These are a kind of redemption already:

1. Prediction bets (`apps/web/src/chat/interact/prediction-card.tsx`).
2. Extra poll votes (`pointsPerExtraVote`, `poll-card.tsx:51`).
3. **Paid bot commands.** `bot_commands.cost_points` (`packages/db/src/schema/interactive.ts:68`)
   is spent in one transaction that refuses an overdraw and emits `channel.points.change`
   (`services/chat/src/plugins/bot/engine.ts:163-224`). A streamer can make a `!hydrate` that
   costs 500 points today. It only replies in chat, with no queue, no fulfilment state and no
   refund.

The design system already has a "Channel point rewards" mock-up
(`packages/ui/stories/pages/ChatBot.stories.tsx:135-154`). Nothing in contracts, the API or the web
app backs it. `git grep` for redeem|reward finds only the `POINTS_ADJUST_REASONS` value `reward`
and OAuth codes.

**Staging (seed-made, so not real behaviour):**

- 5,117 watch credits totalling 1,607,690 points.
- Spending: bets −26,300, poll −100, plus payouts and refunds.
- 3,054 balances, all above zero, with a maximum of 25,506.
- Two channels have a bot and two paid commands.
- Staging accrual is 10 points per **1** minute. The default is 10 per 5.

So viewers spend about **2% of what they earn**. Balances pile up and have nowhere to go, which
matches WX-24.

**Is the integrity good enough?** Yes. viewer-count confirms that `GATE_ELIGIBLE` is the strictest
count we have. The 16-vs-4 gap (F6) was two different broadcasts, not a loose filter. Owner
self-views inflate the live count and the analytics rollup, but not points. On staging, 8 of 12
headless sessions were correctly excluded as automation. **Integrity does not block redemption.**

**Money-like signals in the UI.** The chip uses Hugeicons `Coins01Icon`
(`apps/web/src/chat/interact/points-chip.tsx:5,39`). ADR 0026 says points must never look like
cash, and a coin says money.

**How others do it (outside research):**

| Platform                                                 | Earning                                                                                              | Redemption                                                                                                                                                                                                                                                                                                                                                                                          | What we would borrow                                                                                                                                        |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Twitch** (creator guide, Points Acceptable Use Policy) | Watching, watch streaks, follow, raids, Prime                                                        | Built-in rewards (highlight a message, unlock an emote) that Twitch fulfils. Custom rewards with optional text input, shown in chat, with cooldown (1 minute to 7 days), per-stream and per-user limits, and a rewards queue: Complete, or Reject which refunds, or Pause. Mods can complete, reject and refund. Up to 50 rewards. Policy: no gambling, no imitation currency, no trading for money | The queue model (complete, reject with refund, pause), mods sharing the work, and the three limits. A "points have no monetary value" clause much like ours |
| **Kick** (viewer guide, streamer guide)                  | 10 per 5 minutes watching. Following +50 once. Subs and gifts earn extra, which is paid acceleration | Custom rewards only, plus one default "Hydrate" for 500. Text input goes to chat. A request queue with complete, reject-refunds and pause. **At most 15 rewards**                                                                                                                                                                                                                                   | A small fixed cap, one sensible default, and the same queue. Not the paid acceleration                                                                      |
| **YouTube** (Live leaderboard help)                      | Chat, **Super Chats, Super Stickers, gifts**, XP for watching (capped). 18+ only, opt-out            | None. It is a status leaderboard with a crown badge for the top three                                                                                                                                                                                                                                                                                                                               | A warning: paid actions buy rank, which is the cash-like line we must not cross. Status without redemption is the cheaper path                              |

### 3. Options

| Option                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Cost | Risk                                                                                                                                                                                                                                                                                                                                                                                                               | Impact                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| **A. Drop points from the UI.** Hide the chip, keep the ledger for predictions                                                                                                                                                                                                                                                                                                                                                                                       | S    | Predictions and paid commands still spend points, so viewers would bet a balance they cannot see                                                                                                                                                                                                                                                                                                                   | Removes clutter, but breaks three working features           |
| **B. Explain and surface the spends we already have (P12, corrected).** The chip becomes a popover: balance, "Earned by watching {channel} live, verified watching only", the daily cap, and "Spend on": the open prediction, an extra poll vote, and the channel's paid commands (listed from `bot.commands` where `costPoints > 0`). Hide the chip at 0 points when nothing can be spent, and on the owner's own channel. Swap the coin icon for a sparkle or star | S    | Low. No contract change except perhaps exposing paid commands to viewers (check what `bot.commands` returns to them)                                                                                                                                                                                                                                                                                               | Fixes WX-24's dead weight with no new moderation surface     |
| **C. Full channel rewards** (Twitch/Kick model). `channel_rewards` and `reward_redemptions` tables, new `LOYALTY_REASONS` `reward_redeem` and `reward_refund`, optional viewer text input, a fulfilment queue for owner and mods (complete, reject with refund, pause), limits, events and EventSub, studio UI and viewer UI                                                                                                                                         | L    | **Moderation:** two free-text surfaces (the streamer's reward title and the viewer's input) need automod, reports and the Statement of Reasons (ADR 0019). **Integrity:** a new ledger reason, refund paths and races. **Legal:** custom rewards can be physical goods or raffles (Twitch bans gambling and tobacco), and our "no cash value" clause hasn't been reviewed. Free text cannot go in append-only rows | High for creator engagement, but only once there are viewers |

A smaller middle path inside C: **fixed rewards only, no free text.** "Highlight my message" runs
through the normal chat pipeline and automod. "Streamer shout-out" queues a username and nothing
else. That is M, and it cuts most of the moderation load.

### 4. Recommendation

**Later. In this overhaul, ship B. Do not drop points, and do not build custom rewards yet.**

Why:

- Paid bot commands are already a working redemption with refusal and an outbox event. Once B
  lists them, viewers have somewhere to spend for nearly no cost.
- C is L, adds two free-text moderation surfaces and a ledger change, and pays off only with a
  real audience. We have none before launch.
- Dropping points (A) would hide the balance that predictions stake.
- Integrity is not the blocker (viewer-count confirms it).

**Trigger for redemption** (start with the fixed-catalogue middle path, then custom rewards):

- **Data:** 60 days after public launch, at least 10 channels with points on and live weekly, and
  viewers spending under 10% of what they earn (spend divided by watch credits from
  `loyalty_transactions`, real accounts only).
- **Or demand:** three or more independent streamer requests, or a member proposal.
- **And a prerequisite:** account-admin's `moderation.assign` and assignee field have shipped, so a
  rewards queue can reuse the mod queue instead of adding a second one.
- **Custom text rewards** come only after the maintainer signs off the terms' "no cash value" and
  reward-content rules (no gambling, raffles, goods with outside value, or alcohol and tobacco,
  following Twitch's AUP).

**What would change my mind:**

- Launch creators who all ask for rewards (a creator-led launch). Then do the fixed-catalogue M in
  the D4 batch.
- Or real launch data where spends stay under 2%, as on staging, even after B. That would mean
  the problem is the earn rate, not the lack of rewards, and the fix is a governance setting.

### 5. If accepted: changes to the plan

- **D4.5** becomes: "Points popover (B): balance, verified watch time as the only way to earn, the
  daily cap, and the spends that exist now (prediction, extra poll vote, paid commands). Hide at
  zero with nothing to spend, and on the owner's channel. Non-coin icon. Redemption deferred, with
  the trigger above." Keep the size at S, inside D4.
- **watch.md P12:** fix the copy. "How you earn" is verified watch time only, not follow or chat.
  I am sending this to voice-copy.
- **Contract check (watch unit):** confirm that a viewer can read a channel's enabled paid commands
  (name and `costPoints`, not the response template). If the route is owner-only, the contract
  request is a public `bot.commands.public({channel})` returning `{name, costPoints,
  cooldownSeconds}`.
- **README "Contract requests → Watch":** replace "points redemption" with "(deferred) channel
  rewards; see the trigger in round2/scope-calls.md". Add the public paid-commands read above if it
  is needed.
- **Colour** (agreed with direction-check): the chip and popover stay neutral (`StatusBadge` tone
  neutral). `--channel-accent` may be used only as a tint or outline, and not on amber channels,
  where `#fbbf24` against `--brand` is 1.02:1. Never `--brand`, and never a filled accent, which
  would compete with Follow.
- **Icon:** replace `Coins01Icon` in `points-chip.tsx`, a web-unit change.

---

## References

**Points**

- Twitch, Channel Points Guide for Creators: https://help.twitch.tv/s/article/channel-points-guide.
  Read 2026-11-06, signed out. We borrow the queue (complete, reject with refund, pause), mods
  sharing the work, the three limits, and the 50-reward cap as an upper bound.
- Twitch, Channel Points Acceptable Use Policy (last modified 2019-12-09):
  https://legal.twitch.com/legal/channel-points-acceptable-use-policy. We borrow the "no monetary
  value", no-purchase and no-trade rules, and the banned reward types (gambling, imitation currency,
  alcohol and tobacco) for our terms.
- Kick, Guide to Channel Points (viewers):
  https://help.kick.com/en/articles/10709188-guide-to-channel-points. The earn rate (10 per 5
  minutes) matches our default, which is evidence our setting is market-normal.
- Kick, Guide to Channel Points for Streamers:
  https://help.kick.com/en/articles/11033027-guide-to-channel-points-for-streamers. We borrow the
  15-reward cap and one default reward.
- YouTube Help, Live leaderboard for top fans: https://support.google.com/youtube/answer/16132193.
  We use it as a counter-example: paid Super Chats and gifts buy rank. It does show status-only
  points work without redemption.

**Interest list**

- Google, Email sender guidelines: https://support.google.com/a/answer/81126. We borrow one-click
  unsubscribe as a must, confirming addresses before subscribing them, no pre-ticked boxes, and a
  spam rate under 0.3% (aim for under 0.1%).
- RFC 8058, Signaling One-Click Functionality for List Email Headers:
  https://www.rfc-editor.org/rfc/rfc8058. We already implement it (ADR 0028).
- GDPR Art. 7(1), demonstrating consent: https://eur-lex.europa.eu/eli/reg/2016/679/oj. This is
  why a list without accounts needs its own proof-of-consent and deletion paths.

**Teammates**

- viewer-count: `GATE_ELIGIBLE` is trustworthy, and owners are excluded in `accrue.ts:114`.
- direction-check: an outline interest button, a neutral points chip, and the amber-accent caution.
