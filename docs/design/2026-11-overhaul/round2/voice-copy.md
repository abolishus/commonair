<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# voice-copy: voice, tone, glossary and key copy (round 2)

Author: voice-copy. Date: 2026-11-06. Read only. Sources: `docs/design/2026-11-overhaul/README.md`,
`growth-funnels.md`, `coop-trust.md`, `market-research.md`, and every English catalog. That is
`apps/web/src/i18n/locales/en/*.json` (58 namespaces, **4,805 strings**) and
`packages/email/src/messages/locales/en/*.json` (9 files, **309 strings**), 5,114 in all. I
flattened them to `key → string` and counted with case-insensitive regexes over the string values.
Counts are "strings that match", not occurrences. I used no staging and no browser.

## The question

Round 1 decided what to build and barely touched the words. **What should CommonAir sound like,
which words does it use for which things, and what exactly do the key overhaul moments say?** The
honesty rules must hold everywhere, and every string must stay translation-ready (ICU, no
concatenation).

## Recommendation (summary)

1. **Adopt the voice guide in §1.** Plain, specific, calm, owner-to-owner. Every claim must be
   checkable.
2. **Fix four term collisions now**, while they're cheap:
   - "member" means co-op member only (never "account");
   - "video" is the user-facing word (not VOD, replay or past broadcast);
   - "Creator studio" is the one name for the studio (not "Creator dashboard");
   - "predict" replaces **"bet"** (33 strings).
3. **One error pattern**, `{section} didn't load` + **Retry**, replaces 100 load-failure strings,
   50 of which give no next step. The 20 duplicate "Try again" button keys collapse into
   `common.retry`.
4. **Ship the key-moment copy in §4** with the keys given. The honesty rules are encoded as copy
   rules, not left to reviewers' memory.

Teammates have the copy already: mockups-acquisition (headlines and CTAs), mockups-product
(microcopy), ux-journeys (key message per step) and scope-calls (points and the interest list).

---

## 1. Voice and tone guide

### What we are, in one breath

CommonAir is a live streaming platform owned by the people who use it. We talk like a
well-run co-op talks to its own members. We're **plain about money, open about our numbers, calm
under pressure, and never sell harder than the ledger can back up.**

### Principles

1. **Say the number, then the condition.** "Creators keep 90% of every sub and tip" comes with
   "payouts go out monthly once you've earned $25". The condition is never hidden in a tooltip.
2. **Plain words over system words.** Write "video", not "VOD". Write "Creators keep 90%", not
   `platform.cut 0.9`. Write "Every 7 days", not "604800". No JSON, cron strings, setting keys,
   ADR numbers or raw ids for anyone but developers and admins.
3. **Always a next step.** Every error, empty state and gate says what the person can do now:
   Retry, a link, or what happens on its own.
4. **Calm, not hype.** No "!", no "Oops", no "Awesome", no urgency we didn't earn. Celebrate
   facts ("You're live") rather than feelings.
5. **Owner to owner.** Say "we" for the co-op and "you" for the reader. Members aren't customers,
   so we explain decisions instead of announcing them.
6. **Short first.** Lead with the point (front-loaded, about 12 words). Detail goes in a second
   sentence or behind "How this works".
7. **Translation-ready.** Whole sentences per key, ICU plurals and selects, and no
   string-building from fragments.

### Honesty rules (binding; reviewers reject copy that breaks them)

| Never say                                                                                    | Say instead                                                                                                         | Why                                                                                          |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| "The highest share" / "More than anyone"                                                     | "Keep 90% from your first sub"                                                                                      | Kick pays 95% of subs after Streamer status (market-research MR-2)                           |
| "No thresholds" / "Get paid instantly"                                                       | "No audience gate to turn on support", with the payout minimum and hold in a visible footnote                       | `payout.rules`: $25 minimum, 7-day hold, monthly (`packages/db/src/seed.ts:65-67`)           |
| "Share in the profits" / "Earn dividends" / "Your share of the surplus" (on marketing pages) | "If the co-op ends a year with money left over, members can vote to share it. Right now there is nothing to share." | Surplus is −$11,192 over 12 months (`/transparency`)                                         |
| "Card fees are free"                                                                         | "Card fees are paid from the co-op's 10%"                                                                           | Fees exist; the co-op pays them                                                              |
| "90%" with no basis                                                                          | "90% of every sub and tip, after sales tax"                                                                         | The cut is computed on gross minus tax                                                       |
| A hard-coded "90%" in product code                                                           | Read `platform.cut` and format it                                                                                   | It is a member-voted setting; it can change                                                  |
| Competitor figures with no date                                                              | "As published on {date}, last checked {checkedDate}", with a source link                                            | They change, and we have to be right                                                         |
| "Bet", "wager", "win big"                                                                    | "Predict", "your prediction", "points"                                                                              | Points have no cash value (`bot.settings.pointsEnabledHint`), and the co-op is anti-gambling |
| Viewer numbers that aren't verified                                                          | "Verified viewers", with a "How we count" link                                                                      | `<ViewerCount>` is verified only                                                             |
| "Free" for anything that costs money                                                         | "Free account" / "Watching is free"                                                                                 | The share costs $5; subs cost money                                                          |

### Do / don't pairs

| Do                                                                 | Don't                                               |
| ------------------------------------------------------------------ | --------------------------------------------------- |
| "Recent videos didn't load. The rest of the page is fine." [Retry] | "Something went wrong."                             |
| "Have an account? Sign in"                                         | "Already a member? Sign in"                         |
| "Create a free account to follow {channel}"                        | "Sign in to follow"                                 |
| "Creators keep 90% · co-op 10%"                                    | `platform.cut {"streamer":0.9,"coop":0.1}`          |
| "Voting closes in 6 days"                                          | "Voting · in 6 days"                                |
| "Predict {outcome}"                                                | "Bet on {outcome}"                                  |
| "Busy right now. Retrying in 5 seconds…"                           | A redirect to /signin on a 429                      |
| "Set by {proposal}" (one key, with the link inside)                | "Set by" + "the proposal" (two keys joined in code) |
| "{count, plural, one {# follower} other {# followers}}"            | "{count} followers"                                 |
| "Delete your account?" + what happens to money and votes           | "Are you sure?"                                     |

### How the voice shifts by context

| Context                                | Tone                                   | Rules                                                                                                                                                           | Example                                                                                                              |
| -------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Marketing** (home, /creators, pitch) | Confident, warm, specific              | One claim per line, one number per claim, a footnote for every condition, one brand CTA per screen. Display headlines under 8 words.                            | "Keep 90% from your first sub"                                                                                       |
| **Product** (watch, chat, studio)      | Brief, helpful, out of the way         | Labels are 1–3 words, hints one sentence. Never interrupt live content. Celebrate with facts.                                                                   | "You're live. Support is on from this stream."                                                                       |
| **Money** (support, revenue, payouts)  | Exact, itemised, neutral               | `<MoneyAmount>` always. State who pays fees and when money arrives. Never round in our favour. Estimates are labelled "about" or "estimated".                   | "About $4.50 reaches {channel}. Card fees are paid by the co-op."                                                    |
| **Moderation and safety**              | Firm, fair, unemotional                | Name the rule (with a link), the action and the appeal path. No blame words ("you violated"); say what happened. Never reveal reporters.                        | "A moderator removed this message under {rule}. You can appeal on your appeals page."                                |
| **Errors**                             | Calm, owning, actionable               | What failed, whether anything was lost, what to do: "{thing} didn't load / save", then Retry. Say "we" when it's our fault. No codes unless support needs them. | "Your title didn't save. Your text is still here." [Retry]                                                           |
| **Governance**                         | Civic, plain, even-handed              | Formatted values, never JSON. Before → after diffs. Deadlines as countdowns. Rules stated as they stood when voting opened. Neutral about outcomes.             | "Creators keep 90% → 85%. Protected: needs 2/3 of members, a majority of streamers, 20% turnout and council review." |
| **Account and privacy**                | Respectful, explicit                   | State what is kept, what is removed, and when. Consent boxes unticked. Destructive actions name the thing.                                                      | "Votes, payments and the ledger stay, with your name removed."                                                       |
| **Email**                              | Same as product, a little more context | The subject says the fact, the preview the next step. One action button.                                                                                        | "Your {instance} account will be deleted on {date}"                                                                  |

### Mechanics

- **Sentence case** for everything: titles, buttons and tabs.
- **Buttons are verbs**: "Create account", "Retry", "Follow". Destructive buttons name the
  object ("Delete account", not "Confirm").
- **Contractions are fine** and make text friendlier: "didn't", "you're". The catalog today mostly
  avoids them ("did not", "could not"). New strings use contractions; old ones change when touched.
  This is a deliberate shift, and both forms translate equally well.
- **No exclamation marks** except in user-generated examples and chat commands (`!sr`). The few
  existing ones (`giveaways.card.won`, `giveaways.card.entered`, `chatRaid.incoming`) are
  acceptable as celebration moments, but avoid adding more.
- **Numbers**: digits always. Money through `formatMoney`, and time through `<RelativeTime>` or
  "in 6 days".
- **The ellipsis "…"** marks progress ("Retrying…") or an action that opens a dialog ("Delete
  my account…").

---

## 2. Audit of the current catalog

Method: regexes over string values. "Strings" means matching catalog entries (web + email).

### 2.1 Inconsistent terms

| Issue                                                    | Count                                                                     | Evidence (keys)                                                                                                                                                                                                                                                                                                   | Fix                                                                                                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **member = account** on sign-up                          | 1 string, on the highest-traffic auth screen                              | `signup.haveAccount` "Already a member?"                                                                                                                                                                                                                                                                          | "Have an account?" (`signup.haveAccount`)                                                                                                                                 |
| **member = room participant**                            | 10 strings                                                                | `watchRooms.members`, `watchRooms.sync` ("follows the slowest member"), `watchRooms.refusal.room_full` ("8 members"), `watchRooms.band.*`, `watchRooms.evidence.members`                                                                                                                                          | "people in the room" / "{count, plural, one {# person} other {# people}}". "Member" is reserved for the co-op (94 strings use it, mostly correctly).                      |
| **Studio name**                                          | 3 strings                                                                 | `nav.dashboard` "Creator dashboard", `studio.nav` "Creator studio", `home.toDashboard` "Go to your dashboard"                                                                                                                                                                                                     | "Creator studio" everywhere; the route can stay `/dashboard`                                                                                                              |
| **Recordings: VOD / video / past broadcast / recording** | VOD 11, video 50, past broadcast(s) 4, recording 7                        | VOD: `chat.replayDisclosure`, `captions.studio.vod.*` (6), `dvr.settings.needsVods`, `federation.notes.posted`, `lists.captions.emptyTrackHint`, `privacy.export.kind.channelHint`. Past broadcasts: `content.vods`, `content.vodsEmpty`, `channel.tabs.videosEmptyVisitor`, `fuChannel.category.videosEmptyHint` | User-facing: **video** (the saved stream). The setting is **"Save videos of my streams"**, not "Turn on recording". "Replay" only for **chat replay**. VOD stays in code. |
| **Streamer vs creator vs channel**                       | streamer 25 (10 outside the co-op class meaning), creator 57, channel 299 | `giveaways.card.won` "The streamer will contact you", `giveaways.card.cancelled`, `safety.modq.confirmBody`, `portability.notice.*`, `channelMoved.*`                                                                                                                                                             | Viewer-facing: name the **channel** ("{channel} will contact you"). "Creator" on marketing and money pages. "Streamer" only for the co-op membership class.               |
| **Predictions use gambling words**                       | **33 strings** say bet or betting                                         | `chatPrediction.bet` "Bet on {outcome}", `chatPrediction.myBet`, `interact.prediction.intro` "Viewers bet channel points", `interact.prediction.window` "Betting window", `fairPrediction.*` (10)                                                                                                                 | "Predict {outcome}", "Your prediction: {points} {name} on {outcome}", "Predictions close {time}". Points have no cash value (`bot.settings.pointsEnabledHint`).           |
| **Tip vs support**                                       | tip 31, support 16                                                        | Mostly consistent: **Support** is the button that opens the dialog, and **sub** and **tip** are the two things in it.                                                                                                                                                                                             | Keep that, and write it down (glossary). Never "donate" (0 today; keep it at 0).                                                                                          |
| **Attestation vs statement**                             | 3 vs 57                                                                   | Footer "Verify an audience attestation" vs page "audience statement" (coop-trust CT-12)                                                                                                                                                                                                                           | "Viewer count proof" as the user-facing name; "statement" on the page itself                                                                                              |
| **Surplus label when negative**                          | 1                                                                         | `transparency.stat.surplus` "Surplus" shows −$11,192                                                                                                                                                                                                                                                              | `{sign, select, negative {Shortfall} other {Surplus}}` or "Net result"                                                                                                    |

### 2.2 Jargon shown to non-developers

| Issue                             | Count                                    | Keys                                                                                                                                  | Fix                                                                                        |
| --------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| JSON asked of members             | 3 strings (6 mention JSON in all)        | `coop.form.changeValue` "New value (JSON)", `coop.form.changeValueHint`, `coop.form.change.invalidJson`                               | Typed editors (D6.2); keep JSON as an "Advanced" disclosure                                |
| Raw JSON, cron, keys from data    | Not in the catalog: rendered from the DB | `/coop/settings`, proposal "What changes", council method panel (coop-trust CT-4). `{"coopShare":0.1}`, `0 3 1 * *`, `604800`         | Per-setting formatters with catalog keys (`coop.setting.<key>.value`)                      |
| Raw enum interpolated             | 3+                                       | `transparency.flow.cost` "Costs: {category}" (shows "bandwidth"), `health.unknown.hint` "reported “{code}”", `relays.suspendedReason` | Use `select` over known values with an `other` fallback                                    |
| Basis points                      | 4                                        | `splits.preview.invalid` "between 1 and 9,999 basis points"                                                                           | Percent with up to 2 decimals ("0.01% to 99.99%")                                          |
| Payment-processor ids to creators | 35 strings say Stripe, mostly admin      | `payoutTransfers.empty.body` "Stripe transfers…" (creator-visible), `transferSettle.reference`                                        | Creator-facing: "bank transfer" / "payout". The Stripe name and ids are admin-only (D5.7). |
| "Egress", "relay bytes"           | 8                                        | `admin.egress.*` (admin, fine), `transparency.egress.title` "Member relays" (public)                                                  | Public: "Bandwidth shared by members"                                                      |

Developer-console ids (`developer.app.clientId`, `developer.sub.userIdHint`: 16 "id" strings) are
fine. That audience expects them.

### 2.3 Dead-end and generic error strings

| Pattern                                                                   | Count                        | Keys (selection)                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Something went wrong"                                                    | **5**                        | `error.generic`, `chat.error.generic`, `polish.error.title`, `studio.mod.loadFailedHint`, `twitchImport.reason.other`                                                                                                                                                                                                                                                                                                                                                     |
| Load failures ("could not be loaded", "did not load")                     | **100**                      | including `coop.loadFailedTitle` "This did not load", `channel.tabs.loadFailed` "This list did not load", `payoutTransfers.loadFailed.title`                                                                                                                                                                                                                                                                                                                              |
| …of which give **no next step**                                           | **50**                       | `discovery.rail.loadFailed`, `notifications.loadFailed`, `notifySettings.loadFailed`, `support.loadFailed`, `content.loadFailed`, `privacy.deletion.loadFailed`, `feeSchedule.loadFailed`, `breakdown.payments.loadFailed`, `rehearsal.loadFailed`, `analytics.share.loadFailed`, `replay.error`, `captions.studio.loadFailed`, `bot.loadFailed`, `interact.loadFailed`, … (full list in the appendix)                                                                    |
| …that say **"Reload"**                                                    | **15** error strings         | `studio.preview.loadFailed`, `studio.info.loadFailed` ("Reload the page to try again"), `directory.loadFailed`, `discovery.directory.loadFailed`, `subscriptions.loadFailed`, `safety.appeals.loadFailed`, `safety.modq.loadFailed`, `safety.appealq.loadFailed`, `safety.legal.loadFailed`, `safety.enforcement.loadFailed`, `appeals.account.loadFailed`, `coop.elections.errorClosed`, `admin.integrity.conflict`, `developer.admin.conflict`, `splits.error.conflict` |
| "That did not work. Try again." / "Could not X. Try again." with no cause | **28**                       | `privacy.deletion.failed`, `follow.failed`, `auth.signOutFailed`, …                                                                                                                                                                                                                                                                                                                                                                                                       |
| "Try again" variants                                                      | 147 strings, 10 wordings     | "Try again." 69, "try again." 23, "Try again" 19, "Try again in a moment." 18, "Try again later." 11, plus "soon", "tomorrow" and others                                                                                                                                                                                                                                                                                                                                  |
| **Duplicate Retry button keys**                                           | **20** keys, all "Try again" | `common.retry`, `coop.retry`, `channel.tabs.retry`, `polish.error.retry`, `support.retry`, `analytics.retry`, `replay.retry`, `developer.retry`, `oauth.error.retry`, `payoutTransfers.retry`, `coopMoney.payouts.retry`, `refundRequests.retry`, `copyright.retry`, `dmcaq.retry`, `attestations.panel.retry`, `admin.*.retry` (3), `oauth.connections.retry`                                                                                                            |

Conflicts ("Someone changed this… Reload") are valid states, but the action should be a
**Refresh** button that reloads the data, not a full-page reload.

### 2.4 Sign-in and sign-up copy

| Issue                                                   | Count     | Keys                                                                                                                                                                                                                                                              | Fix                                                                              |
| ------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| "Already a member?"                                     | 1         | `signup.haveAccount`                                                                                                                                                                                                                                              | "Have an account?"                                                               |
| "Sign in to X" gates that should offer an account first | **8**     | `chat.signInPrompt`, `chat.notice.requiresLogin`, `chatPoll.signIn`, `chatPrediction.signIn`, `giveaways.card.signIn`, `coop.vote.signIn`, `portability.landing.signInToFollow`, `safety.mature.signinHint`, plus `chat.column.gatedBody` "Confirm on the player" | Replace with `authGate.<intent>.*` (§4.6)                                        |
| Nothing says "free"                                     | 0 strings | `signup.title` "Create your account"                                                                                                                                                                                                                              | "Create your free account"                                                       |
| The home tagline has no number                          | 1         | `home.tagline` "A member-owned cooperative for live streaming."; `home.title` "Welcome to {name}"                                                                                                                                                                 | §4.1                                                                             |
| The check-email screen has no exit                      | 1         | `signup.checkEmailBody`                                                                                                                                                                                                                                           | Add "Wrong address? Start over"                                                  |
| Verify email says "Please"                              | 1         | email `verifyEmail.body`                                                                                                                                                                                                                                          | "Confirm this is your email address to finish creating your {instance} account." |

### 2.5 Translation hazards

| Issue                             | Count                                                    | Evidence                                                                                                                                                   | Fix                                                                                       |
| --------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Sentence fragments joined in code | 63 strings start lowercase (most are fine as list items) | `coop.settings.setBy` "Set by" + `coop.settings.proposal` "the proposal"; `coop.statement.pool` "pool {amount}"; `copyright.item.notRemoved` "not removed" | One key per sentence with placeholders: `coop.settings.setByProposal` "Set by {proposal}" |
| Punctuation as keys               | 3                                                        | `common.openParen` "(", `common.closeParen` ")", `common.listSeparator` ", "                                                                               | Use `Intl.ListFormat`, and put parentheses inside full-sentence keys                      |
| `{count}` with no plural          | 31 (most are labels like "Choice {n}", fine)             | `admin.egress.capped` "The {count} broadcasts…", `studio.trend.followersAtLeast` "{count}+"                                                                | ICU plural wherever a noun follows a number                                               |

### 2.6 What's already good (keep it)

The catalog's base voice is strong: plain, specific and causal. Moderation and privacy copy
already names what's kept and why:

- `privacy.deletion.confirmBody`;
- `blocks.intro` ("They are not told");
- `analytics.exclusions.hiddenHint` (the k-anonymity explanation).

The aim is consistency and next steps, not a rewrite.

---

## 3. Glossary (preferred terms)

| Use                                      | Means                                                                         | Not                                        | Notes                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------- |
| **account**                              | What you sign up for, free                                                    | member, profile, user (in UI)              | "Create account", "Have an account?"                      |
| **member**                               | A co-op member: held share, $3+ sub, streamer class or worker                 | account holder, room participant           | "Member-owned", "one member, one vote"                    |
| **member-owner**                         | Badge and notice wording for a member who also streams                        | owner, shareholder                         | No "shareholder" (it implies a return)                    |
| **the co-op**                            | CommonAir the cooperative                                                     | the company, the platform (for governance) | "CommonAir co-op" on first mention                        |
| **channel**                              | A creator's page and stream identity; viewer-facing                           | streamer (viewer-facing), broadcaster      | "{channel} is live"                                       |
| **creator**                              | The person, on marketing and money pages                                      | streamer (marketing), talent, user         | "Creators keep 90%"                                       |
| **streamer**                             | Only the co-op membership class                                               | —                                          | "Streamer members"                                        |
| **stream** / **go live**                 | The live broadcast / starting it                                              | broadcast (UI), session                    | "Go live", "You're live", "{channel} went live"           |
| **video**                                | A saved stream                                                                | VOD, replay, past broadcast, recording     | Setting: "Save videos of my streams"                      |
| **clip**                                 | A short cut from a stream or video                                            | highlight                                  |                                                           |
| **chat replay**                          | Chat played beside a video                                                    | replay (alone)                             |                                                           |
| **rewind**                               | Scrubbing back while live                                                     | DVR                                        | Already consistent (11)                                   |
| **follow** / **follower**                | Free, gets alerts                                                             | subscribe (for free follows)               |                                                           |
| **Support**                              | The button and dialog for paying a channel                                    | donate, pay                                |                                                           |
| **sub** / **subscription**               | A monthly payment to a channel                                                | membership (that's the co-op)              | "sub" in buttons, "subscription" in settings and receipts |
| **tip**                                  | A one-off payment                                                             | donation, cheer, bits                      |                                                           |
| **gift sub**                             | A sub bought for someone else                                                 |                                            |                                                           |
| **points**                               | The channel's own currency, no cash value; the channel may rename it ({name}) | coins, currency, credits                   | Always earned, never bought                               |
| **prediction** / **predict**             | Using points on an outcome                                                    | bet, wager, gamble, pool (as a verb)       | "Predictions close in 2 minutes"                          |
| **verified viewers**                     | Viewers counted by the integrity checks                                       | viewers (bare), watchers                   | Always with "How we count"                                |
| **the 90%** / **creator share**          | The value of `platform.cut`                                                   | revenue share, rev share, take rate        | From config, never hard-coded                             |
| **the co-op's 10%** / **co-op share**    | The co-op's part                                                              | platform fee, our cut                      | "Card fees are paid from the co-op's 10%"                 |
| **card fees**                            | Payment processor fees                                                        | processing fees, Stripe fees               |                                                           |
| **payout**                               | Money sent to a creator                                                       | withdrawal, transfer (creator-facing)      | "Payouts go out monthly once you've earned {minimum}"     |
| **$5 share** / **member share**          | The refundable viewer-membership share                                        | fee, dues, stock                           | "refunded if you leave"                                   |
| **patronage**                            | The surplus distribution by contribution                                      | dividend, profit share                     | FAQ only; state the current deficit                       |
| **proposal** / **vote** / **decision**   | Governance objects                                                            | motion, poll (poll is chat)                | "Voting closes in 6 days"                                 |
| **protected decision**                   | A change that needs the stricter rule                                         | locked, special                            | Neutral lock badge                                        |
| **Creator studio**                       | `/dashboard` and the studio pages                                             | dashboard, creator dashboard, control room |                                                           |
| **stream key**                           | The secret                                                                    | stream token, secret key                   | Consistent (25)                                           |
| **two-step sign-in**                     | 2FA                                                                           | 2FA, MFA (in UI)                           | "Two-step sign-in (2FA)" on first mention                 |
| **passkey**                              | WebAuthn credential                                                           | security key (unless hardware)             |                                                           |
| **sign in** / **sign out** / **sign up** | Verbs                                                                         | log in, login, register                    | Nouns: "Sign-in", "Create account"                        |
| **viewer count proof**                   | An audience attestation, user-facing                                          | attestation                                | "statement" stays as the object's name on the page        |
| **Retry**                                | The button after a failed load or save                                        | Try again (as a button), Reload            | One key, `common.retry`                                   |

---

## 4. Copy for the key moments

Keys follow the catalog's `area.component.slot` style. New keys need English plus `es` in the same
change (i18n README). Placeholders are pre-formatted strings (`{amount}` from `formatMoney`,
`{relativeTime}` from `<RelativeTime>`), as the README requires.

### 4.1 Home hero (signed out), namespace `d1-discovery`

| Key                     | String                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `home.hero.eyebrow`     | Live now on {site}                                                                                      |
| `home.hero.title`       | Live streaming, owned by the people who make it                                                         |
| `home.hero.body`        | Watch free. Creators keep {creatorShare} of every sub and tip, and the platform belongs to its members. |
| `home.hero.cta`         | Create free account                                                                                     |
| `home.hero.browse`      | Browse live                                                                                             |
| `home.hero.stream`      | Stream on {site}                                                                                        |
| `home.hero.quiet.title` | Nobody's live this minute                                                                               |
| `home.hero.quiet.body`  | Catch up on recent videos, or follow a channel to hear when it goes live.                               |

`{creatorShare}` is "90%", formatted from `platform.cut`. The hero H1 reuses `app.title`'s
wording, so drop the current `home.title` "Welcome to {name}" and `home.tagline`.

### 4.2 Promise strip and proof strip

| Key                     | String                                            |
| ----------------------- | ------------------------------------------------- |
| `home.promise.label`    | What we promise                                   |
| `home.promise.owned`    | Member-owned co-op                                |
| `home.promise.share`    | Creators keep {creatorShare}                      |
| `home.promise.fees`     | Card fees paid by the co-op                       |
| `home.promise.trackers` | No third-party trackers                           |
| `home.promise.link`     | See the books                                     |
| `home.numbers.members`  | {count, plural, one {# member} other {# members}} |
| `home.numbers.paid`     | {amount} earned by creators in {month}            |
| `home.numbers.lastVote` | Last vote {relativeTime}                          |

The strip items are separate keys, rendered as a list with `·` separators by CSS, not
concatenated. At 320 px show only `owned` and `share`. Say "earned", not "paid": payout and
earnings differ (`transparency.stat` shows payouts of $297 against a $4,295 creator share).

### 4.3 `/creators` hero and calculator, new namespace `creators`

| Key                            | String                                                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `creators.hero.eyebrow`        | Stream on {site}                                                                                                                        |
| `creators.hero.title`          | Keep {creatorShare} from your first sub                                                                                                 |
| `creators.hero.body`           | Card fees come out of the co-op's share, not yours. No follower count or points to earn first. Only a member vote can change the split. |
| `creators.hero.cta`            | Start streaming                                                                                                                         |
| `creators.hero.import`         | Bring your Twitch channel                                                                                                               |
| `creators.calc.title`          | What you'd take home                                                                                                                    |
| `creators.calc.subs`           | Subscribers                                                                                                                             |
| `creators.calc.price`          | Average sub price                                                                                                                       |
| `creators.calc.tips`           | Tips a month                                                                                                                            |
| `creators.calc.result`         | About {amount} a month                                                                                                                  |
| `creators.calc.col.platform`   | Platform                                                                                                                                |
| `creators.calc.col.share`      | Your share                                                                                                                              |
| `creators.calc.col.condition`  | To get this rate                                                                                                                        |
| `creators.calc.col.net`        | You'd take home                                                                                                                         |
| `creators.calc.condition.none` | From your first sub                                                                                                                     |
| `creators.calc.note.ours`      | {site}: {creatorShare} of each sub and tip after sales tax. Card fees are paid from the co-op's share.                                  |
| `creators.calc.note.payout`    | Payouts go out monthly once you've earned {minimum}, after a {holdDays, plural, one {#-day} other {#-day}} hold.                        |
| `creators.calc.note.sources`   | Other platforms' rates as published on {date}, last checked {checkedDate}. Each row links its source.                                   |
| `creators.calc.note.kick`      | Kick pays a higher share of subs ({share}) once you reach KICK Streamer status.                                                         |
| `creators.calc.note.twitch`    | {defaultShare} by default. Higher rates after three months in a row of earning Plus Points.                                             |
| `creators.calc.note.estimate`  | Estimates only, before your own taxes and currency conversion. Refunds and chargebacks lower real earnings.                             |
| `creators.calc.note.vote`      | The {creatorShare} is a co-op setting. Changing it takes a protected member vote. See every change.                                     |
| `creators.gate.title`          | No audience gate to turn on support                                                                                                     |
| `creators.steps.title`         | Go live in {count, plural, one {# step} other {# steps}}                                                                                |
| `creators.claim.label`         | Claim your channel name                                                                                                                 |
| `creators.claim.submit`        | Claim it                                                                                                                                |
| `creators.claim.free`          | {name} is free                                                                                                                          |
| `creators.claim.taken`         | {name} is taken. Try another.                                                                                                           |
| `creators.claim.reserved`      | {name} is reserved.                                                                                                                     |

The `{holdDays, plural, …}` form is there because hyphenated "7-day" agrees differently in other
languages. The footnotes are always visible under the table, numbered, never in tooltips. The
payout figures read `payout.rules`.

### 4.4 Membership pitch (`/coop/membership` signed out), namespace `coop`

| Key                               | String                                                                                                                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `coop.pitch.eyebrow`              | {site} co-op                                                                                                                                                            |
| `coop.pitch.title`                | Own a piece of the platform you watch                                                                                                                                   |
| `coop.pitch.body`                 | Creators keep {creatorShare}. Members set the rules: one member, one vote.                                                                                              |
| `coop.pitch.cta.signedOut`        | Create account and join                                                                                                                                                 |
| `coop.pitch.cta.signedIn`         | Become a member                                                                                                                                                         |
| `coop.pitch.how`                  | How the co-op works                                                                                                                                                     |
| `coop.pitch.way.viewer.title`     | Viewers                                                                                                                                                                 |
| `coop.pitch.way.viewer.body`      | A {shareAmount} share, one time, refunded if you leave. Or subscribe to any channel at {minSub} or more a month.                                                        |
| `coop.pitch.way.streamer.title`   | Streamers                                                                                                                                                               |
| `coop.pitch.way.streamer.body`    | Automatic once you've streamed {hours, plural, one {# hour} other {# hours}} to {viewers, plural, one {# or more verified viewers} other {# or more verified viewers}}. |
| `coop.pitch.way.streamer.window`  | Counted over the last {days, plural, one {# day} other {# days}}.                                                                                                       |
| `coop.pitch.way.worker.title`     | Workers                                                                                                                                                                 |
| `coop.pitch.way.worker.body`      | Appointed by the board.                                                                                                                                                 |
| `coop.pitch.gets.title`           | What members get                                                                                                                                                        |
| `coop.pitch.gets.vote`            | A vote on every proposal                                                                                                                                                |
| `coop.pitch.gets.board`           | Elect the board, or stand for it                                                                                                                                        |
| `coop.pitch.gets.jury`            | A chance to serve on the advisory jury                                                                                                                                  |
| `coop.pitch.gets.books`           | Open books, every month                                                                                                                                                 |
| `coop.pitch.patronage`            | If the co-op ends a year with money left over, members can vote to share it by contribution. Right now costs are higher than income, so there is nothing to share yet.  |
| `coop.pitch.commitments.title`    | Our commitments                                                                                                                                                         |
| `coop.pitch.commitments.cut`      | The creator share changes only by a protected member vote, enforced in the database.                                                                                    |
| `coop.pitch.commitments.books`    | We publish the books every month.                                                                                                                                       |
| `coop.pitch.commitments.trackers` | No ads sold on your data. No third-party trackers.                                                                                                                      |
| `coop.pitch.commitments.source`   | The code is open source (AGPL).                                                                                                                                         |
| `coop.band.title`                 | Own a piece of the platform you watch                                                                                                                                   |
| `coop.band.body`                  | {shareAmount}, refunded if you leave. One member, one vote.                                                                                                             |
| `coop.band.cta`                   | Join the co-op                                                                                                                                                          |
| `coop.vote.joinPrompt`            | Members vote on this. Join for {shareAmount}, refunded if you leave, or subscribe to any channel at {minSub} or more a month.                                           |
| `support.memberNotice`            | A {minSub}+ monthly sub also makes you a co-op member: one vote, and a say in how the co-op is run.                                                                     |
| `support.success.member.title`    | You're joining the co-op                                                                                                                                                |
| `support.success.member.body`     | Your sub makes you a member. You'll be one within the hour, and we'll tell you in your inbox.                                                                           |
| `coop.joined.title`               | Welcome to the co-op                                                                                                                                                    |
| `coop.joined.nextVote`            | Your first vote: {proposal}. Voting opens {relativeTime}.                                                                                                               |
| `coop.joined.noVoteYet`           | Your first vote comes with the next proposal. Meanwhile, {proposal} is open for discussion.                                                                             |
| `coop.joined.nothingOpen`         | Nothing is up for a vote right now. We'll tell you when the next proposal opens.                                                                                        |

Membership timing (from ux-journeys, checked in code):

- **Sub membership is not instant.** The sync runs hourly, so "Welcome to the co-op" appears only
  in `coop.joined.*`, the inbox notice that follows the sync.
- **The electorate is frozen when voting opens** (`services/api/src/coop/policy.ts:75`). A new
  member is never told "your first vote" for a proposal already in voting. `coop.joined.nextVote`
  is only for a proposal whose voting opens after the join.

`coop.pitch.patronage` must switch on the real number. While `surplus > 0` use a second key,
`coop.pitch.patronageSurplus`: "Last year members voted to share {amount} by contribution." Never
project a future amount. In `support.memberNotice` I changed coop-trust's "a say in where the
money goes" to "how the co-op is run". The money is mostly allocated by rules and votes on
proposals, and the softer phrase over-promises less.

### 4.5 Sign-up headlines per intent, namespace `core`

| Key                            | String                                                              |
| ------------------------------ | ------------------------------------------------------------------- |
| `signup.title.none`            | Create your free account                                            |
| `signup.title.follow`          | Create a free account to follow {channel}                           |
| `signup.title.chat`            | Create a free account to chat with {channel}                        |
| `signup.title.support`         | Create a free account to support {channel}                          |
| `signup.title.predict`         | Create a free account to join the prediction                        |
| `signup.title.clip`            | Create a free account to clip this moment                           |
| `signup.title.watch`           | Create a free account to watch {channel}                            |
| `signup.title.stream`          | Start streaming on {site}                                           |
| `signup.title.import`          | Bring your Twitch channel to {site}                                 |
| `signup.title.join`            | Create your account, then join the co-op                            |
| `signup.perk.follow`           | Follow channels and get go-live alerts                              |
| `signup.perk.chat`             | Chat in every channel                                               |
| `signup.perk.vote`             | Join the co-op: one member, one vote                                |
| `signup.haveAccount`           | Have an account?                                                    |
| `signup.checkEmailBody`        | We sent a link to {email}. Open it to finish creating your account. |
| `signup.wrongAddress`          | Wrong address? Start over                                           |
| `signup.intentConfirm.follow`  | You're in. Follow {channel}?                                        |
| `signup.intentConfirm.dismiss` | Not now                                                             |

These are separate keys per intent, not `{intent, select}`, because each needs its own grammar
in other languages and some carry `{channel}`. If no channel is known (stale link), fall back to
`signup.title.none`.

### 4.6 AuthGatePrompt per intent, new namespace `auth-gate`

| Intent  | `authGate.<intent>.title` | `authGate.<intent>.body`                                                                  |
| ------- | ------------------------- | ----------------------------------------------------------------------------------------- |
| follow  | Follow {channel}          | Get told when they go live. Free account.                                                 |
| chat    | Join the chat             | A free account lets you chat in every channel.                                            |
| support | Support {channel}         | {creatorShare} of every sub and tip reaches them. Card fees are paid by the co-op.        |
| predict | Join the prediction       | Predictions use channel points, never money. You earn points by watching live, signed in. |
| clip    | Clip this moment          | Create a free account to save and share clips.                                            |
| watch   | This stream is for adults | Create a free account and confirm you're 18 or older to watch.                            |
| stream  | Start streaming           | A free account and a few minutes of setup.                                                |
| import  | Bring your Twitch channel | Create a free account, then copy your profile and panels. We only read from Twitch.       |
| join    | Join the co-op            | Create a free account first, then become a member.                                        |
| vote    | Members vote on this      | Create a free account, then join the co-op to vote.                                       |
| report  | Sign in to report         | Reports come from accounts, so we can follow up with you.                                 |

Shared: `authGate.create` "Create account", `authGate.signIn` "Sign in". For `report`, Sign in is
primary with no brand fill (README D2.1 brand rule). `vote` is an addition to the intent list:
it maps to `join` for `signup_intent`, so no enum change is needed.

### 4.7 First-follow alert prompt and the Following menu, namespace `d3-watch`

| Key                              | String                                                                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `follow.alertPrompt.title`       | Get told when {channel} goes live?                                                                                                 |
| `follow.alertPrompt.body`        | We'll only tell you when they start a stream. Change it any time from the Following button.                                        |
| `follow.alertPrompt.push`        | Push                                                                                                                               |
| `follow.alertPrompt.email`       | Email                                                                                                                              |
| `follow.alertPrompt.dismiss`     | Not now                                                                                                                            |
| `follow.alertPrompt.done`        | {method, select, push {You'll get a notification when {channel} goes live.} other {You'll get an email when {channel} goes live.}} |
| `follow.alertPrompt.pushBlocked` | Your browser is blocking notifications for this site. Choose Email, or allow notifications in your browser's site settings.        |
| `follow.menu.alertsAll`          | Alerts: every stream                                                                                                               |
| `follow.menu.alertsOff`          | Alerts: off                                                                                                                        |
| `follow.menu.move`               | Email me if they move to a new address                                                                                             |
| `follow.menu.unfollow`           | Unfollow                                                                                                                           |
| `follow.unfollow.title`          | Unfollow {channel}?                                                                                                                |
| `follow.unfollow.body`           | You'll stop getting their go-live alerts.                                                                                          |

### 4.8 Studio "Ready to go live" checklist, namespace `d5-studio`

| Key                                          | String                                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `studio.checklist.title`                     | Ready to go live                                                                             |
| `studio.checklist.progress`                  | {done} of {total, plural, one {# step} other {# steps}} done                                 |
| `studio.checklist.channel_profile.title`     | Set up your channel                                                                          |
| `studio.checklist.channel_profile.hint`      | Add a picture and a line about what you stream. It shows on your channel page and in search. |
| `studio.checklist.stream_info.title`         | Name your first stream                                                                       |
| `studio.checklist.stream_info.hint`          | A title and a category help people find you.                                                 |
| `studio.checklist.stream_key.title`          | Copy your stream key                                                                         |
| `studio.checklist.stream_key.hint`           | Paste it into OBS or your encoder. Keep it private: anyone with it can stream as you.        |
| `studio.checklist.encoder_connected.title`   | Connect your encoder                                                                         |
| `studio.checklist.encoder_connected.hint`    | Start streaming from OBS. This step ticks itself when we see your signal.                    |
| `studio.checklist.encoder_connected.waiting` | Waiting for your encoder… Start streaming in OBS with the server address and key above.      |
| `studio.checklist.encoder_connected.slow`    | Still nothing after a minute? Check the key, then open the setup guide.                      |
| `studio.checklist.encoder_connected.ok`      | Signal received: {resolution} at {fps} fps.                                                  |
| `studio.checklist.rehearsal.title`           | Do a rehearsal (optional)                                                                    |
| `studio.checklist.rehearsal.hint`            | Go live privately to check sound and picture. Only you and people you invite can watch.      |
| `studio.checklist.first_live.title`          | Go live                                                                                      |
| `studio.checklist.first_live.hint`           | Viewers can support you from your first stream. There's no follower count to reach.          |
| `studio.checklist.import_twitch.title`       | Bring your Twitch channel                                                                    |
| `studio.checklist.import_twitch.hint`        | Copy your profile, panels and links. We only read from Twitch; nothing changes there.        |
| `studio.checklist.done`                      | You're set up. Go live whenever you're ready.                                                |
| `studio.checklist.payoutsPending`            | Supporters can pay you now. Your earnings are kept until payouts are set up on this server.  |

Notes:

- `payoutsPending` shows when the instance has no payout provider. It matches the existing
  `studio.empty.payoutHint`, and it keeps `first_live.hint` honest.
- Mockups-product got a "10 minutes" estimate from me. **Drop it** until the funnel measures
  median time per step (D2.8).

### 4.9 Stream recap, namespace `d5-studio`

| Key                             | String                                                                                                                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `studio.recap.title`            | Stream recap                                                                                                                                                                           |
| `studio.recap.subtitle`         | {title} · {duration} · ended {relativeTime}                                                                                                                                            |
| `studio.recap.peak`             | {count, plural, one {# verified viewer at peak} other {# verified viewers at peak}}                                                                                                    |
| `studio.recap.followers`        | {count, plural, =0 {No new followers} one {# new follower} other {# new followers}}                                                                                                    |
| `studio.recap.chatters`         | {count, plural, =0 {Nobody chatted} one {# person chatted} other {# people chatted}}                                                                                                   |
| `studio.recap.earned`           | {amount} earned                                                                                                                                                                        |
| `studio.recap.earnedNote`       | After the co-op's share. Paid out with your next monthly payout.                                                                                                                       |
| `studio.recap.video.processing` | Your video is being saved. We'll let you know when it's ready.                                                                                                                         |
| `studio.recap.video.ready`      | Your video is ready.                                                                                                                                                                   |
| `studio.recap.video.off`        | This stream wasn't saved. Turn on "Save videos of my streams" to keep the next one.                                                                                                    |
| `studio.recap.next.clip`        | Make a clip                                                                                                                                                                            |
| `studio.recap.next.schedule`    | Tell followers when you're back                                                                                                                                                        |
| `studio.recap.first.title`      | That was your first stream                                                                                                                                                             |
| `studio.recap.first.body`       | Everything above counts verified viewers only. Here's how we count.                                                                                                                    |
| `coop.studio.welcome.title`     | You're a member-owner now                                                                                                                                                              |
| `coop.studio.welcome.body`      | You've streamed {hours, plural, one {# hour} other {# hours}} to verified viewers, so you've joined the co-op as a streamer member. You can vote on proposals and stand for the board. |
| `coop.studio.welcome.cta`       | See what's open for a vote                                                                                                                                                             |

Peak viewers uses whichever number viewer-count recommends (F6). The key says "verified" either way.

### 4.10 Empty and error states, with the Retry pattern

**The pattern.** These are shared keys in `core`, and every section uses them.

| Key                          | String                                                                                                 | Use                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `load.section.title`         | {section} didn't load                                                                                  | Title; `{section}` is the section's own heading (e.g. "Recent videos") |
| `load.section.body`          | The rest of the page is fine.                                                                          | When other sections loaded                                             |
| `load.page.body`             | Check your connection, then retry.                                                                     | When nothing loaded                                                    |
| `load.busy`                  | Busy right now. Retrying in {seconds, plural, one {# second} other {# seconds}}…                       | 429 with `retryAfterSeconds`; retries automatically                    |
| `load.stillFailing`          | Still not loading. Try again in a few minutes.                                                         | After 3 failed retries                                                 |
| `common.retry`               | Retry                                                                                                  | The only retry button key; drop the 19 duplicates                      |
| `save.failed`                | {thing} didn't save. Your changes are still here.                                                      | Form saves; never clear the input                                      |
| `save.conflict`              | Someone changed this while you were editing. Refresh to see their version; your text stays in the box. | Conflicts                                                              |
| `common.refresh`             | Refresh                                                                                                | Conflict action (refetches data, no page reload)                       |
| `error.generic`              | That didn't work, and it's on our side. Retry, or come back in a few minutes.                          | Replaces "Something went wrong. Try again."                            |
| `error.notFound.title`       | This page doesn't exist                                                                                |                                                                        |
| `error.notFound.body`        | It may have moved, or the link is wrong.                                                               |                                                                        |
| `error.channelNotFound.body` | Nobody has this channel name yet. It could be yours.                                                   | With "Claim it" → `/creators` (F10)                                    |

`{section}` is a whole noun phrase that the caller passes from its own heading key. In languages
where that breaks agreement, translators can use the existing per-section `*.loadFailed` keys
instead. So keep those keys, and rewrite them to the same shape: "{Thing} didn't load." plus
Retry. That is 100 strings, 50 of which gain a next step.

**Empty states.** These are in `d1-discovery`, `d3-watch`, `coop` and `safety`. Each one says
what goes here and what to do now.

| Key                          | Title                                    | Body                                                                    | Action               |
| ---------------------------- | ---------------------------------------- | ----------------------------------------------------------------------- | -------------------- |
| `home.empty`                 | Nobody's live this minute                | Catch up on recent videos, or be the one who goes live.                 | Start streaming      |
| `discovery.category.empty`   | Nobody's streaming {category} right now  | Here's who streamed it recently.                                        | Follow to get alerts |
| `search.empty`               | Nothing matches "{query}"                | Try a shorter word, or browse categories.                               | Browse categories    |
| `search.empty.claim`         | Nobody streams "{query}" yet             | Be the first.                                                           | Stream on {site}     |
| `following.empty`            | You're not following anyone yet          | Follow channels to see them here and hear when they go live.            | Browse live          |
| `chat.welcome.title`         | Welcome to {channel}'s chat              | Say hi. Be kind: the channel's rules are above.                         | —                    |
| `chat.welcome.noRules`       | Welcome to {channel}'s chat              | Say hi. Be kind.                                                        | —                    |
| `chat.offline`               | Chat is quiet while {channel} is offline |                                                                         | —                    |
| `chat.composer.offline`      | Chat opens when they go live             |                                                                         | —                    |
| `channel.offline.next`       | {channel} is offline                     | Next stream {relativeTime}.                                             | Follow               |
| `channel.offline.noSchedule` | {channel} is offline                     | Last live {relativeTime}. Follow to hear when they're back.             | Follow               |
| `channel.offline.never`      | {channel} hasn't streamed yet            | Follow to catch the first one.                                          | Follow               |
| `inbox.empty`                | You're all caught up                     | Go-live alerts, votes and payouts show up here.                         | —                    |
| `studio.content.empty`       | No videos yet                            | Your streams are saved here when "Save videos of my streams" is on.     | Turn it on           |
| `admin.queue.empty`          | Queue clear                              | Nothing is waiting for review. New reports show up here as they arrive. | —                    |
| `admin.queue.emptyFiltered`  | Nothing matches these filters            |                                                                         | Clear filters        |

### 4.11 Account deletion, namespace `ops`

| Key                                   | String                                                                                                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `privacy.deletion.title`              | Delete account                                                                                                                                                                                   |
| `privacy.deletion.intro`              | Deleting is final after a {days, plural, one {#-day} other {#-day}} wait. You can cancel any time before then.                                                                                   |
| `privacy.deletion.preview.title`      | What happens                                                                                                                                                                                     |
| `privacy.deletion.preview.removed`    | Removed: your profile, sign-in methods, chat messages, videos and clips.                                                                                                                         |
| `privacy.deletion.preview.kept`       | Kept, with your name and email removed: payments, the ledger, votes and audit history. The law and the co-op's books need them.                                                                  |
| `privacy.deletion.preview.subs`       | {count, plural, =0 {You have no subscriptions.} one {Your # subscription stops renewing when your account is deleted.} other {Your # subscriptions stop renewing when your account is deleted.}} |
| `privacy.deletion.preview.subsAdvice` | To stop paying sooner, cancel them on your subscriptions page now.                                                                                                                               |
| `privacy.deletion.preview.payout`     | {amount} you've earned is still owed to you. It's paid with the next payout if your payout details stay valid.                                                                                   |
| `privacy.deletion.preview.share`      | Your {shareAmount} member share is refunded, and your co-op membership ends.                                                                                                                     |
| `privacy.deletion.download.title`     | Download your data first                                                                                                                                                                         |
| `privacy.deletion.download.body`      | After deletion we can't get it back. The download link works for 7 days.                                                                                                                         |
| `privacy.deletion.request`            | Delete my account…                                                                                                                                                                               |
| `privacy.deletion.confirmTitle`       | Delete your account?                                                                                                                                                                             |
| `privacy.deletion.confirmCancel`      | Keep my account                                                                                                                                                                                  |
| `privacy.deletion.confirmUsername`    | Type your username to confirm                                                                                                                                                                    |
| `privacy.deletion.confirm`            | Delete in {days, plural, one {# day} other {# days}}                                                                                                                                             |
| `privacy.deletion.banner`             | Your account will be deleted on {date}.                                                                                                                                                          |
| `privacy.deletion.bannerCancel`       | Cancel deletion                                                                                                                                                                                  |
| `privacy.deletion.failed`             | Deletion wasn't scheduled. Nothing has changed. Retry.                                                                                                                                           |

Two claims to confirm with account-admin before they ship, because they depend on
`me.deletion.preview`:

- **Subscriptions.** ux-journeys found no subscription cancellation in the deletion job and has
  flagged it to the orchestrator. `preview.subs` must not ship until deletion actually stops
  billing. Until then, show only `subsAdvice`, reworded: "Deleting your account doesn't cancel
  subscriptions yet. Cancel them on your subscriptions page first."
- **The share refund.** Is it automatic?

The strings are written for the conservative reading.

### 4.12 Transparency deficit note, namespace `money`

| Key                                   | String                                                                                                                                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transparency.deficit.title`          | The co-op spends more than it earns right now                                                                                                                                                         |
| `transparency.deficit.body`           | Over the last {months, plural, one {month} other {# months}}, costs were {costs} and the co-op's share of revenue was {retained}, a gap of {gap}. Creators' {creatorShare} is never used to cover it. |
| `transparency.deficit.funding`        | {note}                                                                                                                                                                                                |
| `transparency.deficit.fundingMissing` | We'll publish how the gap is covered with next month's books.                                                                                                                                         |
| `transparency.deficit.commitment`     | We'll show this note every month until the gap closes.                                                                                                                                                |
| `transparency.stat.net`               | {sign, select, negative {Shortfall} other {Surplus}}                                                                                                                                                  |
| `transparency.split.title`            | Where a supporter's dollar goes                                                                                                                                                                       |
| `transparency.spend.title`            | What the co-op spent                                                                                                                                                                                  |
| `transparency.flow.cost`              | {category, select, bandwidth {Bandwidth} storage {Storage} payments {Card fees} compute {Servers} staff {People} other {Other costs}}                                                                 |

Notes:

- `transparency.deficit.funding` is the treasurer note, a contract request already in the
  README. **We must not invent who covers the gap**, so `fundingMissing` stands in until a note
  exists.
- "Creators' 90% is never used to cover it" holds only if the ledger rules guarantee it (the
  split is enforced in `packages/ledger/src/rules.ts` and the DB triggers). Coop-trust should
  confirm before it ships.
- The category values in `transparency.flow.cost` are illustrative. Use the real cost enum.

### 4.13 More home and /creators slots (for mockups-acquisition)

| Key                            | String                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `home.coopBand.title`          | Owned by the people who stream and watch here                                                                      |
| `home.coopBand.facts`          | Creators keep {creatorShare} · One member, one vote · Books open every month                                       |
| `home.coopBand.cta`            | How the co-op works                                                                                                |
| `home.streamBand.title`        | Go live on a platform you co-own                                                                                   |
| `home.streamBand.body`         | Free to start. {creatorShare} from your first sub. Works with OBS.                                                 |
| `home.streamBand.cta`          | Stream on {site}                                                                                                   |
| `home.hero.recorded.body`      | Nobody's live right now. Here's the latest from {channel}.                                                         |
| `home.hero.recorded.badge`     | Video                                                                                                              |
| `creators.close.title`         | Your channel name is waiting                                                                                       |
| `creators.calc.note.secondary` | {platform}: from a secondary source, because its help pages couldn't be read directly. Last checked {checkedDate}. |

Use the "Video" badge, not "Recorded": it is the glossary word. "Co-own" is fine because
streamers join automatically, but it must never be used for viewers who haven't joined.

### 4.14 Journey gaps (from ux-journeys)

| Key                               | String                                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `support.return.pending`          | Payment received. Confirming with {channel}…                                                                     |
| `support.return.confirmed`        | Thanks. {channel} gets about {amount} of your {price} sub each month.                                            |
| `support.return.cancelled`        | Checkout cancelled. Nothing was charged.                                                                         |
| `support.return.slow`             | Still confirming. You'll get a receipt by email once it's through; you don't need to pay again.                  |
| `follow.alertPrompt.iosInstall`   | Alerts on iPhone need {site} on your Home Screen. Add it from the Share menu, or choose Email instead.           |
| `chat.raid.incoming`              | {count, plural, one {{channel} is raiding with # viewer} other {{channel} is raiding with # viewers}}            |
| `chat.mode.slow`                  | Slow mode                                                                                                        |
| `chat.mode.slowHint`              | One message every {seconds, plural, one {# second} other {# seconds}} per person.                                |
| `chat.mode.followers`             | Followers only                                                                                                   |
| `chat.mode.followersHint`         | Only people who follow {channel} can chat.                                                                       |
| `chat.mode.surge`                 | Surge protection                                                                                                 |
| `chat.mode.surgeHint`             | Only viewers who've been watching for a while can chat, until the rush passes.                                   |
| `safety.report.sent`              | Thanks. Your report went to the moderators. We'll tell you in your inbox when it's decided.                      |
| `safety.report.outcome.actioned`  | We acted on your report about {target}. Thanks for helping keep {site} safe.                                     |
| `safety.report.outcome.noAction`  | We reviewed your report about {target} and found it didn't break the rules. You can read the rules here.         |
| `mod.granted.title`               | You're now a moderator for {channel}                                                                             |
| `mod.granted.body`                | You can remove messages, time people out and change chat modes. Every action is logged and visible to {channel}. |
| `privacy.deletion.banner`         | Your account will be deleted on {date}.                                                                          |
| `privacy.deletion.bannerCancel`   | Cancel deletion                                                                                                  |
| `chat.resume.gated.verifiedWatch` | Almost there. This chat is for viewers who've watched for a little while. Keep watching and it opens for you.    |
| `chat.resume.gated.accountAge`    | {channel}'s chat needs accounts older than {age}. You can chat here from {relativeTime}.                         |

Notes:

- **Report outcomes:** `{target}` is "a message" or "a channel" from a `select`, never the
  reported person's name in email. The reporter is never told what action was taken beyond
  acted or not acted.
- **The chat resume line** shows at the intent confirm, before the composer opens.
- **Raid copy:** the new `chat.raid.incoming` replaces the "!" version (`chatRaid.incoming`).
- **The deletion banner** button changes from my §4.11 "Keep my account" to "Cancel deletion",
  to match the email (`accountDeletionScheduled.action`).
- **`support.return.*`:** "Confirming…" is honest only once successUrl and cancelUrl differ,
  so that is a contract request (ux-journeys raised it).

---

## Options and recommendation

| Option                                                                                                                                                            | Cost                              | Risk                                                 | Impact                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------- | ----------------------------------------------- |
| A. **Ship the guide and glossary, and rewrite strings only as each batch touches them**                                                                           | S                                 | Drift: old and new voices coexist for a few releases | Medium                                          |
| B. **A + a dedicated "words" pass in D1**: the 4 term fixes, the error and Retry pattern, the 20 retry keys merged, the 33 "bet" strings, and concatenation fixes | S–M (about 250 strings plus `es`) | Weblate churn on `es`; an `i18n:check` regenerate    | High: consistent from the first overhaul screen |
| C. Full catalog rewrite to contractions and the new voice                                                                                                         | L                                 | Large translation churn for little user gain         | Low over B                                      |

**Recommendation: B.** The term and error fixes are mechanical, and they touch the same
components D1 rebuilds (EmptyState and the error art). Doing them once avoids every later batch
inventing its own "didn't load". Contractions and small tone changes ride along only when a
string is touched anyway (A's rule) to limit `es` churn.

**What would change my mind:**

- If Weblate's `es` maintainers can't absorb about 250 changed keys in one release, split B into
  two drops: terms and errors first, "bet" second.
- If scope-calls finds that points can ever be bought or redeemed for money, "predict" is still
  right, but the auth-gate line "never money" must go.

## If accepted: changes to the plan

- **D1:** add item 8, "Words pass".
  - Glossary terms (§3);
  - the `load.*`, `save.*` and `common.retry` keys, with the 19 duplicate retry keys removed;
  - the 100 `*.loadFailed` strings rewritten to "{Thing} didn't load." + Retry;
  - the 15 "Reload" strings changed to Retry or Refresh;
  - the 33 bet → predict strings;
  - `signup.haveAccount`, `nav.dashboard`, `home.toDashboard`, and the 10 watchRooms member
    strings;
  - concatenation fixes: `coop.settings.setBy`+`proposal`, and `common.openParen`/`closeParen`;
  - add a review checklist item: "honesty rules table, §1".
- **D2 / D3 / D4 / D5 / D6 / D7:** use the §4 keys for their screens.
- **A lint test** (cheap; it goes in `apps/web/tests/i18n.test.ts`) fails on any English catalog
  string matching:
  - `/something went wrong/i`;
  - `/reload the page/i`;
  - `/\bbet(s|ting)?\b/i`;
  - `/already a member/i`;
  - `/highest share|no thresholds/i`;
  - a hard-coded `90%` outside keys that take `{creatorShare}`.
- **Contract requests** (unchanged from round 1, restated because the copy depends on them):
  - `me.deletion.preview` (subs, payouts, share);
  - the treasurer `note` on transparency months;
  - `updatedByProposal {id,title}` for "Set by {proposal}";
  - the transparency cost category enum exposed as a closed list.
- **Membership and vote rules** (seed, `packages/db/src/seed.ts:79` and `governance.protections`): streamer membership needs 10 streaming hours to 2+ verified viewers within 90 days. Protected votes need a 2/3 member-wide majority, a streamer-class majority, 20% quorum and creator-council review. Ordinary votes need a 10% quorum and a simple majority. Read all of them from `/coop/settings`.
- **Facts the copy reads from config, never literals:**
  - `platform.cut` → `{creatorShare}`;
  - `payout.rules` → `{minimum}` and `{holdDays}`;
  - `membership.classes` → `{shareAmount}`, `{minSub}`, and the streamer `{hours}`/`{viewers}`/`{days}`;
  - the deletion grace → `{days}`.

## Coordination log

- **mockups-product:** answered all 7 requests (checklist, first-follow prompt and Following
  menu, offline hero, chat welcome, section error with Retry, Security intros, admin queue
  empty). One correction followed in §4.8: drop the "10 minutes" estimate.
- **mockups-acquisition:** sent the home hero, promise strip, /creators hero, calculator
  footnotes, membership pitch, auth gate per intent, and sign-up per intent.
- **ux-journeys:** sent one key message per step for the viewer, creator and co-op-join
  journeys, plus the error rule.
- **scope-calls** (answered):
  - Points can't be bought, gifted, transferred or cashed out (ADR 0026), and they're earned only
    from verified, signed-in, live watch time. The gate line is now "watching live, signed in".
    Never say "every minute" (the rate is a governance setting).
  - +1 on predict over bet. The ledger reason stays `prediction_bet`, which is internal.
  - The interest list is recommended as **account-bound and later**: "Create a free account and
    we'll email you once when {topic} ships" (`creators.notify.optin`). The preference row is
    deleted after the one send.
  - The "members rejected a newsletter" proposal is harness seed filler
    (`harness/src/seed/coop/plan.ts:266`). **Never cite it publicly.** We just don't call this
    a newsletter.
- **ux-journeys** (answered):
  - Their correction on the frozen electorate and the hourly membership sync is applied in §4.4.
  - Their seven gaps are covered in §4.14.
  - The deletion subscription risk is in §4.11.
- **mockups-acquisition** (answered): the four slots are in §4.13. Ko-fi gets a secondary-source
  footnote.

## References

These style guides were consulted from prior knowledge, not fetched this session. No copy is
taken from them.

- **Mailchimp Content Style Guide**, styleguide.mailchimp.com, "Voice and tone". Borrowed: the
  "voice is constant, tone shifts by context" table structure (§1 context table).
- **GOV.UK Design System**, design-system.service.gov.uk, error message and "There is a problem"
  patterns. Borrowed: say what happened and how to fix it, with no blame and no "oops" (§4.10).
- **Shopify Polaris**, polaris.shopify.com, "Error messages" and "Empty states". Borrowed: an
  empty state says what goes here and gives one action (§4.10 empty table).
- **Atlassian Design System**, atlassian.design, "Writing about errors". Borrowed: "own the
  error when it's ours" ("it's on our side").
- **Unicode CLDR plural rules** and the ICU MessageFormat guide (unicode-org.github.io/icu).
  Borrowed: separate keys over `select` for grammatically different sentences, and the
  `#-day` plural for hyphenated compounds (§4.3, §4.5).
- Round 1, via market-research: Kick and Twitch rates and conditions (help.kick.com,
  help.twitch.tv Plus Program); Stocksy's "what we are → number → proof" order for the pitch.

## Appendix: the 50 load-failure keys with no next step

coop.loadFailedTitle discovery.rail.loadFailed channel.tabs.loadFailed studio.mod.loadFailed
studio.mod.logFailed copyright.loadFailed dmcaq.loadFailed dmcaq.loadMoreFailed interact.loadFailed
bot.loadFailed oauth.connections.loadFailed developer.apps.loadFailed developer.app.loadFailed
developer.sub.loadFailed developer.sub.catalogFailed developer.delivery.loadFailed
developer.bots.loadFailed developer.tokens.loadFailed developer.admin.loadFailed
payoutTransfers.loadFailed.title coopMoney.payouts.loadFailed notifications.loadFailed
notifySettings.loadFailed twitchImport.loadFailed federation.settings.loadFailed
federation.followers.loadFailed federation.blocks.loadFailed simulcast.loadFailed
overlays.alertsLoadFailed overlays.tokenLoadFailed content.loadFailed privacy.export.loadFailed
privacy.deletion.loadFailed safety.modq.caseFailed safety.modq.frameFailed
safety.legal.evidenceFailed safety.legal.ncmecFailed support.loadFailed
breakdown.payments.loadFailed feeSchedule.loadFailed chatGate.loadFailed analytics.share.loadFailed
attestations.share.loadFailed captions.studio.loadFailed captions.studio.vod.loadFailed
rehearsal.loadFailed replay.error replay.watch.loadFailed portability.loadFailed
portability.grants.loadFailed
