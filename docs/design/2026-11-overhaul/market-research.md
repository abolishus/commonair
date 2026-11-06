<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# market-research: how comparable products design (2026-11-06)

Method: signed out, WebFetch plus my own browser tab (tab-8, closed). No sign-in, no form submitted,
no cookies accepted. Patterns only; no assets or copy taken. Fee numbers checked on primary sources
where they could be read (marked "primary"); otherwise "secondary" with the caveat stated.

## 1. What exists now (CommonAir, as it bears on positioning)

- Home copy today: "Welcome to {name}" / "A member-owned cooperative for live streaming." (`apps/web/src/i18n/locales/en/core.json:42-44`). No hard number, no proof, no creator pitch.
- Routes now exist for directory, category, search, channel tabs, coop membership, transparency (`apps/web/src/routes/_app/`). No `/creators` acquisition page.
- Money facts (repo): seed `platform.cut` = streamer 0.9 / co-op 0.1 (`packages/db/src/seed.ts:41`), computed on gross minus tax; the card processor fee is a **co-op expense**, not deducted from the creator (`docs/product/feature-wins.md` 4.1, `packages/ledger/src/rules.ts`). Checkout only requires the channel to be active and to have tiers (`services/api/src/money/checkout.ts:99,219`): no follower or hours threshold to earn.
- Feature-wins already plans a public fee schedule, payment breakdown and fee-schedule changelog (4.1). These are the strongest marketing assets we have and no competitor has them.

## 2. Findings

- **MR-1 (high)** No competitor in streaming shows a per-transaction or side-by-side fee comparison. Twitch's Creator Camp has no fee info at all; Patreon's /pricing states 10% but leaves processing, FX and payout fees unquantified; Kick's 95/5 lives in help articles and social posts, not on a landing page. Open lane for a fee calculator. Evidence: twitch.tv/creatorcamp, patreon.com/pricing, help.kick.com.
- **MR-2 (high)** Kick's headline (95% of subs) is higher than our 90%. We cannot claim "highest share". Our honest edges are: card fees absorbed by the co-op, no audience threshold to turn support on (Twitch 60/40 needs 100 Plus Points for 3 months, 70/30 needs 300; Kick needs "KICK Streamer" status), a member-voted cut with a dated public changelog, and patronage. Evidence: help.twitch.tv Plus Program (primary), help.kick.com (primary), repo files above.
- **MR-3 (high)** The best creator acquisition pages lead with earnings proof, not features: Substack's going-paid page puts an earnings calculator (subscribers × price → monthly) right after the hero. We have no /creators page.
- **MR-4 (med)** Products that win on trust say what they are and the hard number in the first two sentences (Stocksy: artist-owned co-op → 50–75% royalties). Our home tagline says "member-owned cooperative" but gives no number and no proof.
- **MR-5 (med)** FOSS peers market with precise, checkable claims (PeerTube: "funded over 90% by donations"; Open Collective: "by the numbers" strip; Ghost: non-profit/open-source badges with a source link). Our transparency data can beat all of them because it is live and ledger-backed.
- **MR-6 (med)** Cold start: PeerTube and Mastodon never show an empty network; they lead with network size and curated entry points. Twitch keeps offline followed channels visible (greyed) in the rail. Our live grid will often be sparse.
- **MR-7 (med)** Signed-out gating ranges from YouTube (page redirect "Sign in to chat") through Twitch/Kick (modal on send/follow, chat visible) to Owncast (chat with no account). Twitch adds a persistent bottom "Sign up" bar on every signed-out page (seen 2026-11-06).
- **MR-8 (low)** Gamified onboarding (Twitch Creator Camp badges, Kick achievements toward affiliate) frames earning as something to unlock. Our "earn from day one" is a counter-position worth stating in the checklist and on /creators.
- **MR-9 (low)** Brand colour space: Twitch purple, Kick green, YouTube red, Owncast/Mastodon purple-indigo, Ko-fi blue+red. Nearest to marigold: PeerTube orange and Substack orange. Golden marigold is free.
- **MR-10 (low)** Money leaderboards (Kick "top gifters" shelf on home) drive whales; incompatible with Calm Chat and co-op values. Do not borrow.

## 3. Proposals

### P1. `/creators` acquisition page (M, very high) — owner growth-funnels (adopted)

Top to bottom:

```
[Hero] what we are + one number ("Creators keep 90%. Card fees are on us.")  [Start streaming] (brand)  [See the math] (ghost)
[Calculator] tier price + supporters slider -> monthly net for: CommonAir | Twitch (50/50, Plus 60/40, 70/30) | YouTube 70% | Kick 95% | Patreon 10%+fees
             each row: rate, condition to get it, source link, "checked <date>"
[No audience gate] "Support turns on with your first stream" vs points/status ladders; payout minimum $25, 7-day hold stated plainly
[Who sets the cut] current cut + date + link to fee-schedule changelog on /transparency
[Works with your tools] OBS / Streamlabs / FFmpeg names row (Owncast pattern), "go live in 3 steps"
[Claim your channel] slug input with live URL preview -> /signup?intent=stream&slug=  (Ko-fi pattern)
[FAQ] "Do you take a fee?", "How is this different from Twitch/Kick?", "What if I leave?" (portability)
[Proof strip] creators paid this month, $ to creators, members (from transparency data)
```

Components: shadcn Card, Slider, Table, Accordion, Input; `<MoneyAmount>`, `formatMoney()`. New: `FeeCalculator` (pure function + table; competitor rates in a dated static data file in the repo, not fetched). Copy: never "highest share" and never "no thresholds" (payouts have a $25 minimum, 7-day hold, monthly schedule: `packages/db/src/seed.ts:65-67`); say "no fee deductions from the 90%, no audience threshold to turn support on, member-set rules, published fee history", and show the payout minimum and hold plainly in the calculator footnote. Data: `transparency.feeSchedule` (planned 4.1), current `platform.cut` (exists via reports). Measure: counters `creators.hero.click`, `creators.calc.used`, `creators.claim.submit`.

### P2. Home promise strip with one number (S, high) — owners discovery/art-director (adopted)

One real live stream as hero (Owncast "product is the hero"), a slim strip "Member-owned · creators keep 90% · no ads, no trackers" linking to /transparency, and a "by the numbers" strip lower (Open Collective).

### P3. Transparency "by the numbers" header + co-op commitments (S–M, high) — owner coop-trust

Stat strip: members, creators paid, $ to creators (month), co-op net (may be negative, said in words), last vote, fee schedule last changed. Below: a short "Co-op commitments" list (Mastodon Server Covenant pattern): no data sold, no third-party trackers, cut changes only by member vote, books open. Footer line linking it.

### P4. Cold-start discovery (M, high) — owner discovery

Low-live fallback: "Catch up" shelf of recent VODs/clips, "Live later" from schedules, recently-live channels as ChannelChips; top-level verticals above categories (Twitch /directory); "Stream here" quiet CTA in directory empty states (Owncast directory "Get listed").

### P5. Offline channel Home tab (M, high) — owner watch

Kick/Twitch pattern: banner fills player area, chat stays visible, Home tab = latest VOD + clips + "recently streamed in" + Schedule tab.

### P6. "Where your money goes" in the support dialog and under the player (S, med) — owners watch/coop-trust

Estimated breakdown before paying (planned 4.1) is the conversion-time trust moment; nobody else has it.

## 4. Funnel and conversion notes

- Creator funnel: search/social → `/creators` (hero CTA) → calculator (proof) → claim slug → `/signup?intent=stream` → first-run checklist → first live. Drop-off risks: no proof before signup (fixed by calculator), unclear encoder setup (EncoderGuide), fear of switching (portability FAQ, "Import from Twitch" intent).
- Viewer funnel: watch → gated action (AuthGatePrompt, intent preserved) → signup → action auto-completes. Twitch-style bottom bar only on watch pages, dismissible (growth-funnels decision).
- Member funnel: transparency/home strip → `/coop/membership` public pitch → join.
- Measurement: first-party aggregate counters (surface, step, day), no visitor ids at all (growth-funnels decision; stricter than Plausible's daily-rotating id, which I offered as an option). Publish funnel totals on /transparency.

## 5. Cross-team decisions

- Marigold kept on the golden side to stay clear of PeerTube/Substack orange; home = one real stream + promise strip with one number + by-the-numbers strip (agreed with: art-director, growth-funnels; logged by art-director).
- Fee calculator as /creators hero proof; competitor numbers labelled with source and "checked" date; never claim "highest share" (agreed with: growth-funnels).
- Verified numbers sent to growth-funnels and coop-trust (below). Patterns sent to discovery, watch, creator-studio, coop-trust; no replies needed beyond acknowledgements.

## 6. References (source → pattern → what we borrow)

| Source                                             | Pattern                                                                                                                      | Borrow                                                         |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| https://substack.com/going-paid                    | earnings calculator right after hero; single repeated CTA                                                                    | calculator as proof on /creators                               |
| https://ko-fi.com/                                 | creator-type chips; FAQ answers "do you take a fee" and "vs Patreon"; claim-your-URL input as final CTA                      | fee FAQ, slug claim with URL preview                           |
| https://www.patreon.com/pricing                    | one plan, "pay when you earn"; extra fees unquantified                                                                       | contrast: we itemize every fee                                 |
| https://ghost.org/pricing/                         | "0% payment fees" table row; non-profit/open-source footer badges + source link                                              | footer trust line                                              |
| https://www.twitch.tv/creatorcamp/en/              | learning paths with chapter count + runtime; badges                                                                          | time estimate + learn link per checklist step (no badges)      |
| https://www.youtube.com/creators/                  | Create / Grow / Earn three-card IA                                                                                           | /creators IA sanity check                                      |
| https://owncast.online/                            | product (player + chat) as hero; "works with OBS/Streamlabs/FFmpeg" row; audience segments                                   | product-as-hero, tool compatibility row                        |
| https://owncast.directory/                         | tag nav, NSFW label, "Get listed" CTA inside discovery                                                                       | supply CTA in directory empty states                           |
| https://joinmastodon.org/                          | "not for sale" promise, 4 value cards, funding-without-influence paragraph                                                   | value cards, "who funds / who decides"                         |
| https://joinmastodon.org/servers                   | filters: language, topic, region, safety covenant; covenant commitment for listing                                           | directory filters; "Co-op commitments" list                    |
| https://joinpeertube.org/                          | network-size proof, precise funding claim (>90% donations)                                                                   | precise claims; no empty network                               |
| https://www.stocksy.com/service/about/             | "artist-owned cooperative" + royalty number in first two sentences                                                           | what we are → number → proof order                             |
| https://opencollective.com/                        | "by the numbers" stat strip                                                                                                  | transparency/home proof strip                                  |
| https://www.twitch.tv/ , /directory , /twitch      | single featured carousel, icon rail, bottom sign-up bar; verticals + Categories/Live tabs; offline banner + tabs + open chat | verticals, offline layout, watch-only bottom bar (no carousel) |
| https://kick.com/                                  | featured creators, top categories, gifter leaderboards; offline channel Home shelves                                         | offline Home shelves; NOT leaderboards                         |
| https://plausible.io/privacy-focused-web-analytics | cookieless, aggregate-only analytics                                                                                         | principles for first-party counters                            |

Fee sources: Twitch https://help.twitch.tv/s/article/plus-program (primary: 50/50 default; L1 60/40 at ≥100 Plus Points × 3 months; L2 70/30 at ≥300 × 3 months; net revenue; 12-month lock). YouTube https://support.google.com/youtube/answer/72902 (primary: 70% of net for memberships, Super Chat/Stickers/Thanks). Kick https://help.kick.com/en/?q=subscription+revenue (primary search snippets: 95/5 subs, flat $5 sub, 100% donations, "KICK Streamer" status needed). Patreon https://support.patreon.com/hc/en-us/articles/36426991446797 (10% for pages published after 2025-08-04, plus processing). Ko-fi: help.ko-fi.com blocks automated reads; secondary summaries say 0% tips (5% with Contributor on), 5% memberships/shop, 0% with Gold; processor fees on creator. Substack: 10% + card fees (its own page).

## 7. Positioning: where CommonAir can credibly win, per competitor

- **Twitch:** 90% from the first sub (payout minimum $25, 7-day hold) vs 50% default and 70% only after 300 Plus Points for 3 months; card fees not deducted; open fee schedule vs repeatedly changed tiers; verified viewer counts. Do not compete on scale or catalogue.
- **Kick:** Kick wins the headline percentage (95 vs 90). We win on: no status gate to turn on subs, governance (members vote the cut, dated changelog), open books, and a calm, non-gambling community. Say "member-set and on the record", not "more money".
- **YouTube Live:** 90% vs 70% of net; no programme to qualify for (YPP + module); creator owns the relationship and can leave with their data (portability).
- **Owncast / PeerTube:** same values, none of the ops burden: payments, discovery and moderation included; still AGPL and self-hostable. "Owncast's freedom with a built-in audience and payouts."
- **Patreon / Ko-fi / Substack:** they are side-tools to a streaming platform; we are both, with card fees absorbed (Patreon 10% + ~3% + 30¢; Ko-fi 5% + processor). Per $5 sub: us $4.50 vs Patreon ≈ $3.90.
- **Co-op/FOSS peers (Stocksy, Open Collective, Mastodon):** we can show live ledger-backed numbers they only describe.

## 8. Top 5

1. `/creators` page with a sourced, dated fee calculator (P1) — the one asset no competitor has.
2. Home promise strip with one hard number + product-as-hero (P2).
3. Transparency "by the numbers" + co-op commitments list (P3).
4. Cold-start discovery fallbacks: catch-up, live later, recently live, stream-here CTA (P4).
5. Support-dialog breakdown estimate as the payment-time trust moment (P6).

Note: before the context summary I created a browser tab whose id I lost; I did not close tabs I could not confirm as mine (tab-1 has an empty origin and may be it).

- Correction agreed with coop-trust: no "no thresholds" claim; payout.rules seed has minimumCents 2500, holdDays 7, monthly schedule. Use "no fee deductions from the 90%, member-set rules, published fee history".
