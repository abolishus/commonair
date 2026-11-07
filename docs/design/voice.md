<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Voice, tone and glossary

How CommonAir sounds, which word it uses for each thing, and the honesty rules every string must
keep. This is the standing guide for anyone who writes user-facing copy: product strings, emails,
marketing pages, docs shown in the app. It comes from the round 2 voice-copy report
([`2026-11-overhaul/round2/voice-copy.md`](2026-11-overhaul/round2/voice-copy.md)), which has the
audit, the counts and the copy for each key overhaul moment.

`apps/web/tests/i18n-voice.test.ts` checks the rules a regex can check, over every English and
Spanish catalog string. A string that breaks one fails the unit tests.

## What we are, in one breath

CommonAir is a live streaming platform owned by the people who use it. We talk the way a well-run
co-op talks to its own members: **plain about money, open about our numbers, calm under pressure,
and never selling harder than the ledger can back up.**

## Principles

1. **Say the number, then the condition.** "Creators keep 90% of every sub and tip" comes with
   "payouts go out monthly once you've earned $25". The condition is never hidden in a tooltip.
2. **Plain words over system words.** "Video", not "VOD". "Every 7 days", not "604800". No JSON,
   cron strings, setting keys, ADR numbers or raw ids for anyone but developers and admins.
3. **Always a next step.** Every error, empty state and gate says what the person can do now:
   Retry, a link, or what happens on its own.
4. **Calm, not hype.** No "Oops", no "Awesome", no urgency we didn't earn. Celebrate facts
   ("You're live"), not feelings.
5. **Owner to owner.** "We" is the co-op, "you" is the reader. Members aren't customers, so we
   explain decisions instead of announcing them.
6. **Short first.** Lead with the point, in about 12 words. Detail goes in a second sentence or
   behind "How this works".
7. **Translation-ready.** One whole sentence per key, ICU plurals and selects, never a sentence
   built from fragments in code.

## Honesty rules (binding)

Reviewers reject copy that breaks these. They hold on every surface, marketing included.

| Never say                                                                  | Say instead                                                                                                         | Why                                                                                     |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| "The highest share", "More than anyone"                                    | "Keep 90% from your first sub"                                                                                      | Another platform pays a higher share of subs once you reach its status tier             |
| "No thresholds", "Get paid instantly"                                      | "No audience gate to turn on support", with the payout minimum and hold in a visible footnote                       | `payout.rules`: a minimum, a hold and a monthly schedule                                |
| "Share in the profits", "Earn dividends", "Your share of the surplus"      | "If the co-op ends a year with money left over, members can vote to share it. Right now there is nothing to share." | The co-op runs at a deficit today (`/transparency`); never project a future amount      |
| "Card fees are free"                                                       | "Card fees are paid from the co-op's 10%"                                                                           | Fees exist; the co-op pays them                                                         |
| "90%" with no basis                                                        | "90% of every sub and tip, after sales tax"                                                                         | The cut is computed on gross minus tax                                                  |
| A hard-coded "90%" in a string or in code                                  | A `{creatorShare}` placeholder formatted from `platform.cut`                                                        | It is a member-voted setting and can change                                             |
| Competitor figures with no date                                            | "As published on {date}, last checked {checkedDate}", with a source link                                            | They change, and we have to be right                                                    |
| "Bet", "wager", "win big", "jackpot"                                       | "Predict", "your prediction", "points"                                                                              | Points have no cash value and can't be bought or cashed out; the co-op is anti-gambling |
| Points described like money ("paid out", "cash in", "balance to withdraw") | "{points} {name} went to the winners", "returned"                                                                   | Points are never cash-like                                                              |
| Viewer numbers that aren't verified                                        | "Verified viewers", with a "How we count" link                                                                      | `<ViewerCount>` shows verified viewers only                                             |
| "Free" for anything that costs money                                       | "Free account", "Watching is free"                                                                                  | The member share and subs cost money                                                    |

Facts the copy reads from config, never from a literal: `platform.cut` → `{creatorShare}`;
`payout.rules` → `{minimum}` and `{holdDays}`; `membership.classes` → `{shareAmount}`, `{minSub}`
and the streamer `{hours}`, `{viewers}` and `{days}`; the deletion grace → `{days}`.

## Do and don't

| Do                                                          | Don't                                               |
| ----------------------------------------------------------- | --------------------------------------------------- |
| "Recent videos didn't load." [Retry]                        | "Something went wrong."                             |
| "Have an account? Sign in"                                  | "Already a member? Sign in"                         |
| "Create a free account to follow {channel}"                 | "Sign in to follow"                                 |
| "Creators keep 90% · co-op 10%"                             | `platform.cut {"streamer":0.9,"coop":0.1}`          |
| "Voting closes in 6 days"                                   | "Voting · in 6 days"                                |
| "Predict {outcome}"                                         | "Bet on {outcome}"                                  |
| "Busy right now. Retrying in 5 seconds…"                    | A redirect to sign-in on a rate limit               |
| "Set by {proposal}" (one key, the link inside)              | "Set by" + "the proposal" (two keys joined in code) |
| `{count, plural, one {# follower} other {# followers}}`     | "{count} followers"                                 |
| "Delete your account?" plus what happens to money and votes | "Are you sure?"                                     |

## How the voice shifts by context

The voice stays the same; the tone moves.

| Context                                | Tone                                   | Rules                                                                                                                                    | Example                                                                               |
| -------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Marketing** (home, /creators, pitch) | Confident, warm, specific              | One claim per line, one number per claim, a footnote for every condition, one brand CTA per screen. Display headlines under 8 words.     | "Keep 90% from your first sub"                                                        |
| **Product** (watch, chat, studio)      | Brief, helpful, out of the way         | Labels 1 to 3 words, hints one sentence. Never interrupt live content. Celebrate with facts.                                             | "You're live. Support is on from this stream."                                        |
| **Money** (support, revenue, payouts)  | Exact, itemised, neutral               | `<MoneyAmount>` always. Say who pays fees and when money arrives. Never round in our favour. Estimates say "about" or "estimated".       | "About $4.50 reaches {channel}. Card fees are paid by the co-op."                     |
| **Moderation and safety**              | Firm, fair, unemotional                | Name the rule (with a link), the action and the appeal path. No blame words ("you violated"); say what happened. Never reveal reporters. | "A moderator removed this message under {rule}. You can appeal on your appeals page." |
| **Errors**                             | Calm, owning, actionable               | What failed, whether anything was lost, what to do now. Say "we" when it's our fault, and only then. No codes unless support needs them. | "Your title didn't save. Your text is still here." [Retry]                            |
| **Governance**                         | Civic, plain, even-handed              | Formatted values, never JSON. Before → after. Deadlines as countdowns. Rules as they stood when voting opened. Neutral about outcomes.   | "Creators keep 90% → 85%. Protected: needs 2/3 of members and a streamer majority."   |
| **Account and privacy**                | Respectful, explicit                   | Say what is kept, what is removed and when. Consent boxes start unticked. Destructive actions name the thing.                            | "Votes, payments and the ledger stay, with your name removed."                        |
| **Email**                              | Same as product, a little more context | The subject says the fact, the preview the next step. One action button.                                                                 | "Your {instance} account will be deleted on {date}"                                   |

## Errors: one pattern

| Situation                     | English                                                                      | Notes                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| A section failed to load      | "{Thing} didn't load." + a **Retry** button                                  | `{Thing}` is the section's own name: "Your subscriptions", "The directory"  |
| The whole page failed         | "This page didn't load" / "Check your connection, then retry."               |                                                                             |
| More items failed to load     | "More {things} didn't load. Try again."                                      | The "Show more" button stays, so pressing it again is the next step         |
| No Retry button exists yet    | "{Thing} didn't load. Refresh the page to retry."                            | A stopgap: give the component a Retry button, then drop the second sentence |
| A save failed                 | "{Thing} didn't save. Your changes are still here."                          | Never clear the input                                                       |
| An action failed, cause known | "{Thing} wasn't sent." / "didn't go through." + "Try again."                 |                                                                             |
| Someone else changed it first | "Someone changed this while you were editing. Refresh to see their version." | A **Refresh** action refetches the data; it is not a page reload            |
| A provider or service is down | "… Try again in a few minutes."                                              |                                                                             |
| Rate limited                  | "Busy right now. Retrying in {seconds}…" or "Wait a moment, then try again." | Never a redirect                                                            |

- **Retry** is the only label for the button after a failed load or save. One key,
  `common.retry` ("Retry" / "Reintentar"). Older per-area `*.retry` keys carry the same value
  until their components move to `common.retry`.
- **Try again** appears only inside sentences, in two wordings: "Try again." (now) and "Try again
  in a few minutes." (wait). A precise time ("Try again tomorrow", "15 minutes after the request")
  is better than either when we know it.
- Never "Something went wrong", "Oops", "Reload the page" or an error that stops at what failed.

## Mechanics

- **Sentence case** everywhere: titles, buttons, tabs, menu items.
- **Buttons are verbs**: "Create account", "Retry", "Follow". A destructive button names its object:
  "Delete account", not "Confirm".
- **Contractions are fine** and friendlier: "didn't", "you're", "can't". New strings use them; old
  strings change when they are touched for another reason, to limit translation churn.
- **No exclamation marks**, except in user-generated examples, chat commands (`!sr`) and the few
  celebration moments that already have one (winning a giveaway). Don't add more.
- **Numbers** are digits. Money goes through `formatMoney` / `<MoneyAmount>`, time through
  `<RelativeTime>` or "in 6 days", counts through ICU plurals.
- **The ellipsis "…"** marks progress ("Retrying…") or an action that opens a dialog ("Delete my
  account…").
- **No fragments joined in code.** One key per sentence with placeholders; lists through
  `Intl.ListFormat`; parentheses inside full-sentence keys, never as keys of their own.

## Glossary

Use the word in the first column. The "Not" column lists words to replace when you meet them.

| Use                                        | Means                                                                   | Not                                                | Notes                                                           |
| ------------------------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------- |
| **account**                                | What you sign up for, free                                              | member, profile, user (in UI)                      | "Create account", "Have an account?"                            |
| **member**                                 | A co-op member: held share, qualifying sub, streamer class or worker    | account holder, room participant, community member | "Member-owned", "one member, one vote"                          |
| **member-owner**                           | A member who also streams (badges and notices)                          | owner, shareholder                                 | "Shareholder" implies a return                                  |
| **people** / **guests** (watch rooms)      | Who is in a watch room                                                  | members                                            | "This room is full (8 people)"; the host invites guests         |
| **the co-op**                              | CommonAir the cooperative                                               | the company, the platform (for governance)         | "CommonAir co-op" on first mention                              |
| **channel**                                | A creator's page and stream identity; the viewer-facing name            | streamer (viewer-facing), broadcaster              | "{channel} is live", "The channel will contact you"             |
| **channel owner**                          | The person who runs a channel, where the channel's name isn't available | the streamer, the broadcaster                      | Mod and safety copy                                             |
| **creator**                                | The person, on marketing and money pages                                | streamer (marketing), talent, user                 | "Creators keep 90%"                                             |
| **streamer**                               | Only the co-op membership class                                         | —                                                  | "Streamer members", "the streamer class"                        |
| **stream** / **go live**                   | The live broadcast / starting it                                        | broadcast (UI), session                            | "Go live", "You're live", "{channel} went live"                 |
| **video**                                  | A saved stream                                                          | VOD, replay, past broadcast, recording             | The setting is "Save videos of my streams"; "VOD" stays in code |
| **clip**                                   | A short cut from a stream or video                                      | highlight                                          |                                                                 |
| **chat replay**                            | Chat played beside a video                                              | replay (alone)                                     |                                                                 |
| **rewind**                                 | Scrubbing back while live                                               | DVR                                                |                                                                 |
| **follow** / **follower**                  | Free; gets go-live alerts                                               | subscribe (for a free follow)                      |                                                                 |
| **Support**                                | The button and dialog for paying a channel                              | donate, pay                                        | Never "donate"                                                  |
| **sub** / **subscription**                 | A monthly payment to a channel                                          | membership (that's the co-op)                      | "sub" on buttons, "subscription" in settings and receipts       |
| **tip**                                    | A one-off payment                                                       | donation, cheer, bits                              |                                                                 |
| **gift sub**                               | A sub bought for someone else                                           |                                                    | Recipients can be "random viewers"                              |
| **points**                                 | The channel's own currency, no cash value; the channel may rename it    | coins, currency, credits                           | Always earned by watching, never bought                         |
| **prediction** / **predict**               | Using points on an outcome                                              | bet, wager, gamble, pool (as a verb)               | "Predictions close in 2 minutes", "Predict {outcome}"           |
| **verified viewers**                       | Viewers counted by the integrity checks                                 | viewers (bare), watchers                           | Always with "How we count"                                      |
| **creator share** / **the 90%**            | The value of `platform.cut`                                             | revenue share, rev share, take rate                | From config, never hard-coded                                   |
| **co-op share** / **the co-op's 10%**      | The co-op's part                                                        | platform fee, our cut                              | "Card fees are paid from the co-op's 10%"                       |
| **card fees**                              | Payment processor fees                                                  | processing fees, Stripe fees                       |                                                                 |
| **payout**                                 | Money sent to a creator                                                 | withdrawal, transfer (creator-facing)              | "Payouts go out monthly once you've earned {minimum}"           |
| **member share** / **{shareAmount} share** | The refundable viewer-membership share                                  | fee, dues, stock                                   | "refunded if you leave"                                         |
| **patronage**                              | Sharing a surplus by contribution                                       | dividend, profit share                             | FAQ only, with the current deficit stated                       |
| **proposal** / **vote** / **decision**     | Governance objects                                                      | motion, poll (a poll is a chat feature)            | "Voting closes in 6 days"                                       |
| **protected decision**                     | A change that needs the stricter rule                                   | locked, special                                    | Neutral lock badge                                              |
| **Creator studio**                         | `/dashboard` and the studio pages                                       | dashboard, creator dashboard, control room         | The route can stay `/dashboard`                                 |
| **stream key**                             | The secret an encoder streams with                                      | stream token, secret key                           |                                                                 |
| **two-step sign-in**                       | 2FA                                                                     | 2FA, MFA (in UI)                                   | "Two-step sign-in (2FA)" on first mention                       |
| **passkey**                                | A WebAuthn credential                                                   | security key (unless it's hardware)                |                                                                 |
| **sign in** / **sign out** / **sign up**   | The verbs                                                               | log in, login, register                            | Nouns: "Sign-in", "Create account"                              |
| **viewer count proof**                     | An audience attestation, user-facing                                    | attestation                                        | "Statement" stays as the object's name on its page              |
| **Retry**                                  | The button after a failed load or save                                  | Try again (as a button), Reload                    | One key, `common.retry`                                         |
| **Refresh**                                | Refetching data after a conflict                                        | Reload                                             | Not a full-page reload                                          |

Developer and admin consoles may use their audience's terms (client ids, egress, EventSub's
"broadcaster"), because that audience expects them.

## Translations

- Every new or changed English string ships with its Spanish translation in the same change
  (until Weblate takes over; `apps/web/src/i18n/README.md`).
- The glossary applies in every language. Spanish uses "predicción" / "predecir" for predictions
  (never "apuesta", "apostar" or "bote"), "video" for saved streams, "Estudio de creador" for the
  studio, "Reintentar" for Retry and "Actualiza" for Refresh.
- Separate keys per intent beat one `{intent, select}` when the sentences differ grammatically in
  other languages. Hyphenated compounds use a plural (`{days, plural, one {#-day} other {#-day}}`)
  because they agree differently elsewhere.

## Review checklist

Before a string ships:

- [ ] It breaks none of the honesty rules above.
- [ ] It uses the glossary word for everything it names.
- [ ] Every error, empty state and gate has a next step.
- [ ] Numbers, money and time come from placeholders formatted by the house primitives.
- [ ] It is one whole sentence per key, with ICU plurals where a noun follows a number.
- [ ] Spanish is updated in the same change.
- [ ] `apps/web/tests/i18n-voice.test.ts` and `apps/web/tests/i18n.test.ts` pass.

## References

The round 2 report credits the style guides it learned from; none of their copy is used here.
In short: the "voice is constant, tone shifts" table follows the Mailchimp Content Style Guide;
the error pattern (say what happened and how to fix it, no blame, no "oops") follows the GOV.UK
Design System; "an empty state says what goes here and gives one action" follows Shopify Polaris;
"own the error when it's ours" follows the Atlassian Design System; the plural and separate-key
rules follow Unicode CLDR and the ICU MessageFormat guide.
