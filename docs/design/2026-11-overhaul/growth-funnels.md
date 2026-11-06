<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Growth and funnels: conversion, leads and measurement

Author: growth-funnels. Date: 2026-11-06. Staging: https://staging-stream.abolish.us/ (signed out,
`/api/me` 401 throughout). Read only; no form submitted. Builds on
`docs/design/2026-11-design-review.md` (F8, F17) and `docs/product/feature-wins.md` (4.1, 4.14).

## 1. What exists now

| Route / surface                                     | What I saw (viewport, theme)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/` home                                            | 1440 dark: slim dismissible WelcomeStrip ("Welcome to CommonAir. A member-owned cooperative for live streaming." + Sign up), then Spotlight, Live now, Categories, Recently live. No creator CTA anywhere. 375 light: the strip wraps to four lines and pushes Spotlight down. Header Sign up / Sign in carry `?redirect=` (site-chrome.tsx:175-193).                                                                                                                                                                              |
| Footer                                              | Transparency, Verify an audience attestation, Report intimate images, Copyright (DMCA), Source. No About, For creators, Fees, FAQ, Terms or Privacy links.                                                                                                                                                                                                                                                                                                                                                                         |
| `/signup`                                           | 1440: form + "Streaming its members own" card (two bullets + "See the books"). Six controls: email, username ("also your channel address"), password (10+), birth date (three Selects), terms checkbox (no visible document links when the list is loading/empty), ALTCHA ("I'm not a robot" manual checkbox at 375). "Already a member? Sign in" (`signup.haveAccount`). Nothing says the account is free or what it gets you. 375: one column, pitch below the fold. After submit: "Check your email" with resend; no next step. |
| `/signin`                                           | Email, password, Forgot password, "New here? Sign up", same pitch. Default destination after sign-in is `/dashboard` for everyone (signin.tsx:94).                                                                                                                                                                                                                                                                                                                                                                                 |
| `/demo_streamer2` (live)                            | Follow -> `/signin`, Support -> `/signin`, chat "Sign in to chat. [Sign in]" -> `/signin`: all bare, no redirect, and Sign in rather than Sign up. 1.17K followers shown (good social proof). `/demo_streamer1` returned HTTP 500 twice (watch traced it to a 429 during SSR).                                                                                                                                                                                                                                                     |
| `/coop`                                             | Signed out: "This did not load" (sub-requests 429 rate-limited; `/api/coop/transparency?months=3` 404). With data, the overview has no join CTA for signed-out visitors (coop-trust).                                                                                                                                                                                                                                                                                                                                              |
| `/coop/membership`, `/coop/patronage`, `/coop/jury` | Signed out: redirect to bare `/signin`, no `returnTo`. A visitor cannot read what membership costs or gives.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `/transparency`                                     | Strong proof (monthly ledger, governance outcomes with the rule that decided each). The 90/10 split is not stated; "Where every dollar went" says Creators 27% (coop-trust is flagging the label); the 12-month surplus is -$11,191.95.                                                                                                                                                                                                                                                                                            |
| `/creators`                                         | 404 "This channel does not exist". There is no creator landing; `creators` is not a reserved username.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `/import`, `/move`, `/dashboard`                    | Studio only. Signed out: redirect to bare `/signin`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `/m/$channel/$nonce` (move link)                    | Signed out the CTA is "Sign in to follow" (landing.tsx:104), though most arrivals from Twitch have no account. An invalid link's title still says "{channel} has moved".                                                                                                                                                                                                                                                                                                                                                           |
| Lead capture                                        | None: no waitlist, newsletter, creator interest form or co-op news list. Notification preferences have one type, `go_live`, with email off by default (`packages/contracts/src/notify.ts`, `NOTIFY_DEFAULTS`).                                                                                                                                                                                                                                                                                                                     |
| Measurement                                         | No account-created or verified event in `packages/contracts/src/events.ts`. `channel.follow`, `channel.subscribe`, `channel.tip`, `coop.membership.update`, `coop.share.update`, `stream.online`, `portability.import.finished` exist. Move links already count conversions (`entities.ts:2237`). No admin growth view.                                                                                                                                                                                                            |

## 2. Findings

- **GF-1 (high). Signed-out channel actions dead-end on the wrong form and lose the channel.** Follow, Support, chat, Report and the 18+ gate link to bare `/signin`. Evidence: `components/channel-follow.tsx:62`, `support/support-dialog.tsx:104`, `chat/chat-panel.tsx:652`, `safety/mature-gate.tsx:121,169`, `channel/channel-meta.tsx:158`, `safety/report-dialog.tsx:61`; confirmed live on `/demo_streamer2` at 1440 dark. This is the highest-traffic conversion moment in the product.
- **GF-2 (high). No creator acquisition funnel.** There's no landing, pitch, fee comparison or "go live in N steps". `/creators` 404s as a channel name. Import and Move, the strongest switching tools, are invisible until after signup.
- **GF-3 (high). Membership is invisible to the people it targets.** `/coop/membership` is behind `requireSession` with no `returnTo` (coop.membership.tsx guard; staging redirects to bare `/signin`). `/coop` has no signed-out join CTA. A $3+ subscription already qualifies as viewer membership (`coop/settings` `activeSubscriptionQualifies`), but the support dialog never says so (coop-trust).
- **GF-4 (high). Guards and gates drop the return path.** `requireSession()` callers other than `/activate`, and every `<Navigate to="/signin">` fallback (about 30 routes), pass no `returnTo`. After signing in, a visitor lands on `/dashboard` (signin.tsx:94), the creator studio, even if they are a viewer.
- **GF-5 (med). The signup page sells the co-op, not the account.** It doesn't say "free" or what an account does (follow, chat, go-live alerts, a vote). "Already a member?" conflates account with co-op member. There's no intent-specific headline (following X, streaming, joining). The check-email screen has no next step and no digest or alert opt-in.
- **GF-6 (med). The move-link landing asks newcomers to sign in.** The conversion-attributed landing for streamers moving from Twitch (`components/portability/landing.tsx:104`) offers only "Sign in to follow".
- **GF-7 (med). Followers are acquired but not retained.** Go-live email defaults to off and nothing prompts for alerts after a first follow, so most follows never produce a return visit. `packages/contracts/src/notify.ts` `NOTIFY_DEFAULTS`.
- **GF-8 (med). Marketing slugs collide with channel names.** The reserved list (`services/api/src/auth/identity.ts`) has about/help/docs/blog/terms/privacy, but not creators, streamers, stream, start, join, pricing, fees, faq, why, features, compare, members, news, waitlist. With no existing users this is free to fix now and costly later.
- **GF-9 (med). Proof pages undercut the pitch.** `/transparency` never states the 90/10 split, labels creators as 27% of every dollar, and shows a deep deficit without context. `/api/transparency/fee-schedule` exists but nothing public surfaces it. Rate-limited sub-requests blank `/coop` and SSR-500 a channel page for signed-out visitors (shared-IP viewers will hit this).
- **GF-10 (med). Nothing is measured.** There is no first-party view of visit -> account -> verified -> first follow -> first support, or of creator signup -> first live. The team can't tell whether any proposal here works.
- **GF-11 (low). The footer lacks the trust and marketing links** visitors look for (About, For creators, Fees, FAQ, Terms, Privacy, Co-op).
- **GF-13 (high). A rate-limited session check signs members out.** Signed in as streamer1 at 1440 dark, `/dashboard` redirected to `/signin` while `/api/me` returned 429. The rail also showed "could not be loaded". Cause: `apps/web/src/server/bootstrap.ts:80`, where `fetchMe(cookie).catch(() => null)` turns any error into "no session", and `requireSession` then redirects. Fix: return null only on 401. On 429 or 5xx, render the route's retry state and keep the cookie. SSR calls to the API should bypass, or be keyed apart from, the per-IP anonymous limit. Shared-IP households, campuses and CGNAT users will hit this mid-funnel.
- **GF-14 (med). The signed-in membership page doesn't sell.** `/coop/membership` as streamer1 at 1440 dark:
  - The intro is a rules sentence.
  - The Viewer card says "A held member share, or a qualifying paid subscription" without naming $3/month.
  - Nothing says what a member gets (a vote, proposals, board elections, jury).
  - "Buy the share" sits in a side card in default styling.
  - "Leave" (destructive) sits beside the active Streamer badge.
  - The eligibility line reads "53.92 of 0.01 hours", which reads like a bug.
  - The Support dialog (demo_streamer3, viewed only) is strong: tiers, the 90/10 bar, and the card fee "paid from the co-op's share". It confirms the missing "$3+ makes you a member" line (P3).
- **GF-15 (med). At 375 the header has only Sign in.** The only Sign up on mobile is the dismissible welcome strip (staging, 375 light). Fix agreed with art-director: a compact Sign up at all widths, outline while a brand or channel-accent CTA is in view.
- **GF-12 (low). Mobile friction on signup.** Three stacked Selects for birth date plus a manual ALTCHA checkbox at 375 put Create account about two viewports down. The welcome strip wraps to four lines at 375.

## 3. Proposals

### P1. `<AuthGatePrompt action>`: one signed-out gate for every action (GF-1, GF-4) — S/M, impact very high

- **Component:** new `components/auth-gate-prompt.tsx`. It renders a `Callout` with a brand `Button` inside a `Popover` anchored to the trigger on desktop, and a `Drawer` below 640px. Watch owns placement; I own logic and copy.
- **Layout:**
  ```
  ┌ Follow Lumen Beats ───────────────────────┐
  │ Get notified when they go live. Free.     │
  │ [ Create account ]   Sign in              │
  └───────────────────────────────────────────┘
  ```
- **Intent enum:** none | follow | chat | support | predict | clip | watch (the 18+ gate) | stream | import | join. Watch asked for clip and watch. The 18+ gate's signed-out state needs Create account primary (intent=watch). Its chat-side text "Confirm on the player" must become the same prompt for signed-out viewers.
- **Headlines by action** (i18n `authGate.<action>.title/body`): clip "Create a free account to clip this moment"; follow "Follow {channel}" / "Get notified when they go live"; chat "Join the chat" / "A free account lets you chat in every channel"; support "Support {channel}" / "90% reaches the creator; card fees are on the co-op"; predict "Take part"; report "Sign in to report" (Sign in primary here, no brand fill).
- **Links:** `/signup?redirect=<current path>?intent=<action>` and `/signin` with the same redirect. Share a `authHref(action)` helper with the header's `useAuthRedirect`.
- **After verify:** the intent resumes as a one-tap confirm Callout ("You're in. Follow {channel}?" [Follow] [Not now]). It never auto-acts, because a crafted link must not make anyone follow. The param is stripped with `history.replaceState`. The chat intent focuses the composer.
- **Guards:** every `requireSession` and `<Navigate to="/signin">` passes `returnTo: location.href`. One lint-style test asserts no bare `/signin` link exists outside the header.
- **Sign-in default destination:** `/` for viewers; `/dashboard` only when the account has a stream key or a broadcast (agreed with creator-studio).

### P2. `/creators` landing: "Stream on CommonAir" (GF-2, GF-8) — M, impact high

Add a new public route, `_app/creators.tsx`, and reserve the slug. Top to bottom:

1. **Hero.** H1 "Keep 90% of every sub and tip. Card fees are on us." with a sub on member ownership. Brand CTA "Start streaming" -> `/signup?redirect=/dashboard?intent=stream`. Secondary "Bring your Twitch channel" -> `/signup?redirect=/import?intent=import`. Beside it, the live `StreamCard size=feature`.
2. **Earnings calculator** (the hero proof; borrowed from Substack's slider pattern). Sliders for subs, average sub price and monthly tips, with `<MoneyAmount>` output. A comparison `Table` lists Creator net / platform / card fee per platform:
   - CommonAir 90/10, with the co-op absorbing processor fees.
   - Twitch 50/50 of net by default (60/40 and 70/30 via Plus thresholds).
   - YouTube 70% of net.
   - Kick 95/5 after Streamer status (shown truthfully: it beats us on headline %).
   - Patreon 10% plus processing.
     Every competitor row shows "as published on <date>" with a source link and a "last checked" date. Data comes from a static, dated JSON in `packages/config` that is reviewed when it changes; our row reads `/api/transparency/fee-schedule`.
3. **"No audience gate to turn support on"**: three `Card`s. No points or status to earn your rate (contrast Twitch Plus points and Kick Streamer status); the calculator footnote states the real thresholds: $25 payout minimum, 7-day hold, monthly payouts (seed.ts:65-67, market-research/coop-trust correction). Your cut is a member-voted, dated setting (links to the fee schedule). You become a streamer member automatically after streaming to 2+ verified viewers.
4. **"Go live in 4 steps"**: the checklist step ids from creator-studio, plus a "Works with OBS, Streamlabs and phone encoders" names row (text only; no third-party logos unless licensed). Borrowed from Owncast.
5. **Bring your audience**: Import from Twitch (profile, panels) and Move links with counted conversions (ADR 0031, 0037).
6. **Tools Twitch doesn't have**: Rehearsal, free DVR, verified viewers and attestations, open captions (from feature-wins). Each is an `Item` with a Hugeicon.
7. **FAQ** (`Accordion`): fees, payouts (monthly, $25 minimum, 7-day hold), what if I leave (export bundle), mature content, who owns it, how the cut can change (protected vote).
8. **Closing CTA band**: a claim-your-handle `Input` prefilled into signup's username field (`/signup?username=`) with a live availability check. Borrowed from Ko-fi.

**Entry points:**

- Home hero tertiary link "Stream on CommonAir".
- The footer "For creators" link.
- The `home.empty` state.
- Search with no results ("Be the first to stream {query}").
- The channel 404 for an unknown slug ("This name is free. Claim it").
- A link from `/transparency`.

### P3. Public membership pitch and join flow (GF-3) — M, impact high (coop-trust owns content, I own flow)

- **Signed-out `/coop/membership`** renders the pitch, with no new route. Brand CTA "Create account and join" -> `/signup?redirect=/coop/membership?intent=join`.
- **Signed-in non-member** sees "Become a member: $5 refundable share", plus "or subscribe to any channel at $3+/month, which qualifies you".
- **`/coop` and the patronage/jury tabs**, signed out, show a public explainer and a join band: "Own a piece of the platform you watch". No bare redirect.
- **Support dialog** gets one line under the split bar: "A $3+/month subscription also makes you a co-op member: one vote, and a say in where the money goes." Wording follows coop-trust's honesty fix (no surplus promise). The success state reads "Welcome to the co-op" -> `/coop/proposals` (outline).
- **Streamer membership** is announced at the first-live success moment (creator-studio).
- Copy never out-sells the ledger: patronage lives in the FAQ with formula 2026.1 spelled out.

### P4. Signup and verify, intent-aware (GF-5, GF-12) — S, impact med-high

- **Headline by intent:** "Create your free account" (default), "Follow {channel} — create your free account", "Start streaming", "Join the co-op".
- **Under the H1,** three ticks for the default intent: Follow and get go-live alerts / Chat in every channel / One member, one vote.
- **Wording fixes:** "Already a member?" becomes "Already have an account?". `?username=` prefill from P2.
- **Birth date:** keep the three Selects but lay them out in one row from `sm` (they are short).
- **Terms:** always link the documents inline in the label.
- **Pitch card** becomes coop-trust's top three facts.
- **Check-your-email screen:**
  - "Open your email app" hint, resend, and "Wrong address? Start over".
  - An **unticked** opt-in "Send me a weekly 'what you missed' email" (account-admin's digest), recorded in `consent_records`.
  - Below that, "While you wait" with live channels.
- **After verify,** land on the redirect target and show the intent confirm (P1). The first follow then triggers the one-time "Turn on go-live alerts?" prompt (push or email; account-admin, GF-7).

### P5. Move-link and import landings for switching audiences (GF-6) — S, impact med

- **`/m/...`:** brand (channel-accent) "Create account to follow {channel}" -> `/signup?returnTo=<link>`, with "I have an account" secondary. Add one line of co-op context and fix the invalid-link title.
- **`/import` signed out:** don't redirect. Show a public explainer (what gets imported, Twitch read-only scopes), then "Create account to import".

### P6. Reserve marketing slugs, footer IA, trust pages (GF-8, GF-11, GF-9) — S, impact med

- **Reserve now:** creators, streamers, stream, start, join, members, membership, pricing, fees, faq, why, features, compare, news, waitlist, newsletter, about (already reserved).
- **Footer groups** (`NavGroups`):
  - Watch: Browse, Categories, Search.
  - Create: For creators, Import from Twitch, Fees.
  - Co-op: How it works, Transparency, Proposals.
  - Legal & safety: Terms, Privacy, DMCA, Takedown, Verify attestation.
  - Source.
- **`/transparency`:** add a "Fees" section from `fee-schedule` ("Creators keep 90%. Changed by member vote only. Last change: <date>"). Add deficit context ("Staging/early-stage: costs exceed revenue while the co-op grows"), wording owned by coop-trust.
- **Rate-limit grace:** signed-out pages must render a graceful partial on 429, never a 500 or a blank tab (watch and coop-trust are logging the engineering side).

### P7. First-party funnel measurement (GF-10) — M, impact high (it unlocks iteration)

The principles follow Plausible's no-cookie, aggregate-only model, but go further: there is no visitor id at all, not even a daily-salted hash.

**A. Server-derived funnel (no client code).** A nightly worker job writes `growth_daily (day, metric, segment, value)` from existing rows:

- **Viewer funnel:**
  - accounts_created (users.created_at)
  - accounts_verified (email_verified)
  - first_follow_within_7d (`follows`)
  - first_chat_within_7d
  - first_support_within_30d (`payments`)
  - became_member (`coop.membership.update`)
  - notify_optin (`notification_preferences`)
- **Creator funnel** (creator-studio's ids): channel_profile, stream_info, stream_key, encoder_connected, rehearsal, first_live, second_live_within_14d, plus median days from signup per step.
- **Switching:** move-link conversions (exists), imports finished (`portability.import.finished`).
- **Segments:** intent at signup only. Add a nullable `users.signup_intent` enum: none | follow | chat | support | stream | import | join. It is a contract and schema request, contains no PII, and is not append-only.

**B. Client counters for CTA impressions and clicks only.** These are the things the server can't see.

- **Endpoint:** `POST /api/metrics/ui` with body `{surface, action, step}`, all validated against a closed Zod enum in `packages/contracts`. It is sent with `fetch(..., {keepalive:true})`, carries no cookie, and the server ignores the session for it.
- **Storage:** an upsert increments `ui_counters (day, surface, action, step) count`. No IP, user id or user agent is stored. A per-IP token bucket lives in Valkey memory only, and the counter is capped per (surface, day) against floods.
- **Off switch:** respect `navigator.globalPrivacyControl` / DNT by not sending.
- **Surface ids agreed:**
  - Home and discovery: home.hero, home.coopBand, rail.followNudge, home.empty, search.empty, home.shelf.<id>.click.
  - Auth gate: authGate.<action>.view|create|signin.
  - Signup and onboarding: signup.view|submit|error.<code>, verify.landed, intent.confirm|dismiss.
  - Creators page: creators.hero.cta, creators.calc.used, creators.import.cta.
  - Co-op and support: coop.band.cta, support.sub_member_notice.view, coop.welcome.click.
  - Retention: notify.optin, notify.optin.firstFollow.push|email|dismiss, notify.level.change, digest.sent, digest.click, inbox.open, follow.from_notification.
  - PWA (responsive-a11y): pwa.install.offered|accepted|dismissed, pwa.push.offered|enabled|dismissed, pwa.standalone.session.
- **Email links:** carry `?src=` from a fixed enum (digest | golive | coop), counted server-side and stripped.

**C. Where it shows:**

- A new admin page `/admin/growth` uses `ChartCard`, a step funnel bar, and `StatTile` + `Sparkline` (art-director components).
- A public "By the numbers" block on `/transparency` shows monthly accounts, members and active streamers (market-research's idea, Open Collective style).
- Every query reads aggregates only. A k-anonymity floor hides any cell below 5.

**Contract requests (orchestrator):**

- Zod enum `UiMetric` and the `metrics.ui` route.
- Tables `ui_counters` and `growth_daily`, plus the `users.signup_intent` column.
- An `account.created` outbox event with no PII (user_id and intent only), for future webhooks.
- `?intent` and `?username` on the auth search schema (`lib/auth-return.ts`).

### P8. Consent-based lead capture without accounts — S, impact low-med (optional)

Only one form, on `/creators`: "Not ready yet? Get one email when [feature X / your region / payouts in your currency] ships."

- Collects email only, double opt-in via `packages/email`, and is stored in a `interest_signups (email, topic, confirmed_at)` table.
- One-click RFC 8058 unsubscribe; rows are deleted after the one send or after 12 months.
- No newsletter list until members vote one in. The seeded proposal "Add a members' newsletter" was rejected, which is a nice governance story; respect it.

## 4. Funnel and conversion notes

| Funnel                          | Steps (CTA at each)                                                                                                                                                     | Drop-off risks                                                                 | Measure                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Visitor -> viewer               | Home hero / search / shared channel link -> channel page (watch is free, no gate)                                                                                       | SSR 500 on 429; 18+ gate; slow first frame                                     | server: page renders (no). ui: home.hero, shelf clicks                  |
| Viewer -> account               | Follow/chat/support (AuthGatePrompt "Create account") -> /signup (submit) -> email (verify link) -> back on channel (confirm intent)                                    | bare /signin today (GF-1); 6 fields + ALTCHA; email latency; lost context      | authGate.* ui; accounts_created/verified by intent (server)             |
| Account -> follower -> retained | Intent confirm "Follow" -> one-time "Turn on go-live alerts" -> digest opt-in                                                                                           | go_live email off by default; no /following                                    | first_follow_within_7d; notify_optin; follow.from_notification          |
| Follower -> supporter / member  | Support (channel-accent) -> dialog with 90/10 + "$3+ makes you a member" -> checkout -> "Welcome to the co-op"                                                          | card payments off -> bank transfer friction for shares; membership unmentioned | first_support_within_30d; became_member; support.sub_member_notice.view |
| Visitor -> co-op member         | /coop band or /coop/membership pitch ("Create account and join") -> signup intent=join -> "Become a member" $5 share or $3 sub                                          | guard redirect today; deficit on /transparency read without context            | intent=join cohort -> became_member                                     |
| Visitor -> streamer             | /creators (Start streaming / Bring your Twitch channel / claim handle) -> signup intent=stream or import -> /dashboard checklist (6 steps) -> first_live -> second live | no landing today; stream key hidden on settings; no first-run                  | creator step counts + median days; second_live_within_14d               |
| Twitch audience -> follower     | Move link /m/... ("Create account to follow") -> signup returnTo link -> follow attributed                                                                              | "Sign in to follow" today                                                      | move-link conversions (exists)                                          |

## 5. Cross-team decisions (all logged in decisions-log.md)

- **watch:** AuthGatePrompt logic is mine, placement is theirs (composer row, inline under interactive cards, a once-per-tab 5-minute follow nudge, offline Follow hero). The intent resumes as a confirm, never auto-acts. Counters (surface, action, step, day), no ids. The offline card falls back to "Last live …" until a schedule entity exists (watch's contract request).
- **art-director:** one brand fill per viewport. The list: hero "Create free account", AuthGatePrompt, auth submit, /creators "Start streaming", membership CTAs, the dashboard step then "Go live". Channel, VOD, clip and /m/ pages use `--channel-accent` for Follow, then Support. Never brand on Sign in, Report, settings, admin or destructive actions. AuthGatePrompt is Callout + brand button.
- **discovery:** signed-out home hero replaces the WelcomeStrip. I added a tertiary "Stream on CommonAir" link. The co-op band after categories uses an outline CTA. Plus the rail follow nudge and empty states; surface ids as listed.
- **coop-trust:** public pitch at `/coop/membership` (their content, my CTA/flow), the join band on /coop, patronage and jury. Support dialog "$3+ = member" line with their honesty wording; patronage only in the FAQ.
- **creator-studio:** first-run checklist step ids; `?intent=stream|import` lands on the right step; sign-in goes to /dashboard only for creators.
- **watch (signed-in pass):** Following becomes a split button with a menu: notification level, "Email me once if they move", and Unfollow. The first-follow alert prompt is a one-time Popover anchored to it, after which these settings live in the menu.
- **responsive-a11y:** PWA install offer (account menu and mobile sheet always, contextual after a second visit with 3+ minutes watched, decided in localStorage only), manifest shortcuts and screenshots, an offline page. Their push prompt merges into the single first-follow prompt.
- **account-admin:** /inbox, opt-in weekly digest, /following, the first-follow alerts prompt; `?src` fixed enum; counter ids.
- **watch (late):** intent enum gains clip (viewer Clip button) and watch (18+ gate signed out, Create account primary).
- **market-research (correction):** never "no thresholds". Say "no audience gate to turn support on", with the $25 minimum and 7-day hold in the footnote.
- **market-research:** verified competitor splits for the calculator (2026-11-06), with the honesty flag that Kick's 95% must be shown truthfully. Signup stays a full page entered from an anchored prompt. No visitor hash at all.

## 6. References

- Substack, https://substack.com/going-paid: an earnings calculator as hero proof. Borrowed the pattern, not the copy.
- Ko-fi, https://ko-fi.com/: the claim-your-handle closing field and a fee FAQ that answers "does it take a cut" head-on.
- Patreon, https://www.patreon.com/pricing: an example of unquantified fees; our gap to exploit by itemizing.
- Ghost, https://ghost.org/pricing/: "0% fees" as a table row; borrowed the row framing.
- Owncast, https://owncast.online/: a "works with your existing encoder" row and steps-to-live.
- Twitch, https://www.twitch.tv/ (signed-out modal gate and "Join the community" bottom bar), plus help.twitch.tv Plus Program for the split figures; YouTube support answer 72902; Kick help center: the gate-at-action pattern (we keep a full page for a11y) and calculator figures.
- Plausible, https://plausible.io/privacy-focused-web-analytics: cookieless aggregate counting. We go further and keep no visitor hash.
- Open Collective's public "by the numbers": publishing funnel totals on /transparency.
- All competitor facts were relayed by market-research (see market-research.md); figures must carry "as published on <date>".

## 7. Top 5 (ranked)

1. **P1 AuthGatePrompt plus return paths everywhere, and stop treating a 429 as signed out** (GF-1, GF-4, GF-13): signed-out actions lead to "Create account" with intent and redirect, and the intent is confirmed after verify. Small effort, on the highest-traffic step.
2. **P2 `/creators` landing with the honest fee calculator** and Import/Move up front (GF-2, GF-8), handing into creator-studio's first-run checklist.
3. **P7 first-party measurement**: server-derived funnel plus closed-enum UI counters, `/admin/growth`, public "by the numbers". Without it nothing else can be judged.
4. **P3 public membership pitch and "$3+ subscription makes you a member"** in the support flow (GF-3).
5. **P4 intent-aware signup and verify, with the alerts and digest opt-ins** (GF-5, GF-7), plus P6 slug reservation done now while there are no users.
