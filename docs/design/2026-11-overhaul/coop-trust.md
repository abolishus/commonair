<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# coop-trust: co-op, governance and trust surfaces

Reviewer: coop-trust. Date: 2026-11-06. Read-only. Staging was viewed signed out (`/api/me` 401
throughout), at 1440 dark, 375 and 320. The 375 light emulation still rendered dark. Signed-in
member views (patronage, jury, membership panel, proposal form) were reviewed from source.
Staging rate-limited the shared team IP often (429). That limit exposed a real resilience
problem, CT-3.

## 1. What exists now

| Route                           | What I saw                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/coop`                         | PageHeader with "The co-op" and a one-line intro that leads with mechanics ("protected decisions also need the streamer class"). Below it: 8 tabs, open proposals (3 cards), recent decisions (capped at 5, so F19 is fixed), "Members by class" (105/104/32 BreakdownBar) and the **Creator council, all 50 rows uncapped** ("Rank N", no links). **Signed out there is no pitch and no join CTA anywhere**: the membership card renders only when `signedIn` (`components/coop/overview.tsx:107`).                                                                                                |
| `/coop/membership`              | `requireSession`. Signed out it redirects to a bare `/signin` with no returnTo. Signed in (source): memberships list, an eligibility list with progress bars, and a share card ($5, refundable, bank-transfer reference).                                                                                                                                                                                                                                                                                                                                                                           |
| `/coop/proposals`               | Filter chips and ProposalCards. Each card shows only title, status badge and a participation bar. There is no author, no excerpt, no deadline, and decided proposals carry no result.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `/coop/proposals/$id`           | Good bones. Body, "What changes", council response, discussion, then a sidebar with "Your vote" (secret ballot), participation and a Timeline. Decided proposals show a per-class tally table and a "Rules checked" list (met/not met). **"What changes" shows raw JSON** (`{"coopShare":0.1,...}`), and so does the 320 layout. Signed out, the vote radios are disabled and a small line reads "Sign in to vote". On a proposal that changes no settings, the "Yes" option still says "Change the settings as proposed". The timeline lists "Voting · in 6 days", which is really the close date. |
| `/coop/council`                 | Creator council (50 rows with "Rank 1 · score 0.347"), board elections (a live viewer-seat vote, closed streamer seats with winners, worker seats taking nominations) and a "How the council is seated" panel that **dumps raw keys and JSON** (`totals {"relayBytes":67893622,...}`, a cron string). Candidates and council members are not linked to channels.                                                                                                                                                                                                                                    |
| `/coop/settings`                | Every governance setting shown as a raw key (`platform.cut`) with raw JSON or a key-value list (`votingSeconds 604800`, `quorum 0.1`, `recomputeCron "0 3 1 * *"`). Descriptions come from the DB in English and cite "ADR 0011". "Set by the proposal" names no proposal and has no link.                                                                                                                                                                                                                                                                                                          |
| `/coop/patronage`, `/coop/jury` | Visible tabs that redirect signed-out users to `/signin` (no returnTo, no explainer).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `/transparency`                 | Four StatTiles (Revenue $4,772, Creator payouts $297, Costs $11,669, Surplus −$11,192), "Where every dollar went", a 12-month table, split shortfalls, 45 uncapped governance outcomes, patronage distributed, member relays 16%, **the fee schedule (90/10), which is buried at roughly the 6th screen**, enforcement by rule and the jury seed commitment. No co-op tabs. At 375 the month table scrolls sideways inside its card and hides the Surplus and Patronage columns.                                                                                                                    |
| `/attestations/verify`          | A textarea and a Verify button. There is no "why this exists" (sponsors, advertisers), no example statement and no link to the keys. The footer calls it "audience **attestation**", the page "audience **statement**".                                                                                                                                                                                                                                                                                                                                                                             |
| `/dmca`, `/takedown`            | Solid, plain-language, legally careful forms with a "How a notice is handled" callout. Fine as they are. They only need the layout system (768 form width) and a link to policy.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Legal                           | **No public Terms, Privacy or Community guidelines pages.** Documents (`/api/legal`: terms, privacy, guidelines, cookies, dmca_policy) open only as dialogs on signup (`components/legal-document-link.tsx`). The footer (`lib/nav.ts:352`) has Transparency, Attestation, Takedown, DMCA, Cookie settings, Language and Source. It has no Co-op, About, Terms, Privacy, Guidelines or Fees link.                                                                                                                                                                                                   |
| Support dialog                  | Shows the 90/10 split bar (`support-dialog.tsx:530`), which is good. It never says that a $3+ subscription **makes you a co-op member**.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Auth pages                      | The CoopPitch card ("Streaming its members own", two bullets, "See the books") is the only marketing copy for the co-op in the whole app.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Public data the UI does not yet tell as a story: `GET /api/coop/settings` (all fee and
eligibility facts), `/api/coop/council` (contribution scores, term end) and
`coop.transparency` (`egressBySource`, patronage, `coopRetained`).

## 2. Findings

- **CT-1 (high). The co-op has no public pitch and no signed-out join path.** `/coop` hides the
  membership card unless the visitor is signed in (`overview.tsx:107`). The Membership tab
  redirects to `/signin` with no returnTo (`coop.membership.tsx:22`). Nothing on staging says
  what membership costs ($5 refundable), that a $3+/mo subscription qualifies, or that streamers
  join automatically. Evidence: `/coop` at 1440 and 375, signed out.
- **CT-2 (high). "Where every dollar went" is mislabeled and misleading on the trust page.** It
  is subtitled "Revenue … split by where it ended up", but `transparencyFlow`
  (`lib/money.ts:503`) puts the creators' revenue share ($4,294.80) and the co-op's costs
  ($11,669) in one bar. The bar sums to about $15,964 on $4,772 of revenue, so "Creators 27%"
  is wrong as a share of revenue (it is 90%). It also sits next to a "Creator payouts $297" tile
  with nothing explaining earned versus paid out. The cost labels are raw enums ("Costs:
  bandwidth" via `t("transparency.flow.cost", {category})`).
- **CT-3 (high). Public co-op pages fail all-or-nothing.** `CoopLoadGate` replaces the whole page
  with "This did not load" when any one load fails. Under 429 rate limiting, `/coop`,
  `/coop/council` and `/coop/settings` showed only the error, with the intro dropped (375, 1440).
  No static content (the pitch, how it works) survives. The copy also cannot tell "busy, retry
  in 2 s" (429 carries `retryAfterSeconds`) from a real failure.
- **CT-4 (high). Governance is written for the database, not members.** Raw JSON appears in
  proposal "What changes" (`/coop/proposals/$id` at 1440 and 320), in settings
  (`/coop/settings`) and in the council method panel (`council.tsx:70`). Fractions (0.1), seconds
  (604800), cron strings and setting keys are shown verbatim. The proposal form asks members to
  type **"New value (JSON)"** (`coop.form.changeValue`), so only engineers can propose a
  settings change.
- **CT-5 (high). The 90/10 split, the core promise, is buried.** It appears in the fee schedule
  roughly six screens down `/transparency`, in the support dialog, and nowhere on `/coop`, home,
  channel pages or the footer.
- **CT-6 (med). Proposal cards don't sell participation.** There is no deadline ("Voting closes
  in 6 days"), no author, no one-line summary, no "affects creators" tag and no result on
  decided cards (`proposals.tsx:31`). Participation shows 30/226 but not the quorum line (10%), so
  "is my vote needed?" goes unanswered.
- **CT-7 (med). The signed-out vote panel is a dead end.** It shows disabled radios and a small
  "Sign in to vote". It should say "Members vote. Join for $5 refundable, or subscribe to any
  channel" and link to the join flow. The "Yes" helper text is wrong on proposals with no
  setting changes.
- **CT-8 (med). Council and board are lists of names.** There are 50 rows with an opaque "score
  0.347", nothing links to channels, and the live board election (a real engagement hook) sits
  below the 50-row list. The overview repeats all 50 council rows in the aside (`overview.tsx:216`).
- **CT-9 (med). No public legal or policy pages, and no trust links in the footer.** Terms,
  Privacy and Guidelines are readable only inside the signup dialog. There is no link to the
  co-op, no "how we're funded" and no commitments. Enforcement statements cite
  `guidelines.general@1`, but there is no page to read that rule.
- **CT-10 (med). Transparency has no narrative order and no headline numbers that tell the
  story.** It goes KPIs → mislabeled bar → table → niche split-shortfalls section →
  45 uncapped outcomes. There is no "members / creators paid / last vote" strip, no period
  comparison, and no explanation of the deficit, which is a trust risk if unexplained (−$11k with
  no note that the co-op is pre-launch or what the costs fund).
- **CT-11 (med). The membership cross-sell is missing from checkout.**
  `membership.classes.viewer.activeSubscriptionQualifies = true` (min $3), but the support
  dialog and its success state never mention it.
- **CT-12 (low). The attestations page lacks purpose and a sample.** There is no audience
  ("prove your numbers to a sponsor"), no "Try an example" and no published-keys link, and the
  page name conflicts with the footer label.
- **CT-13 (low). Patronage and Jury tabs bounce signed-out visitors to /signin.** Both should
  render a public explainer: patronage formula 2026.1, $362.66 distributed in Nov, and jury
  seed/commitment proof.
- **CT-14 (low). Tab row overflow.** Eight tabs clip mid-word at 375 and 320 ("S…"), the earlier
  review's F30 area. Transparency is a tab but has no tabs itself, so the user leaves the
  section.
- **CT-15 (low). Settings descriptions aren't i18n and cite ADRs.** These are DB strings such as
  "Open captions (ADR 0011)…". They need catalog keys per setting, with the DB text only as a
  fallback.
- **CT-17 (high). A rate-limited session check signs members out.** The pane was signed in as
  streamer1 (per the brief update). `/coop/membership` still redirected to `/signin` because
  `/api/me` returned 429, and `requireSession` treats any failure as "no session". A signed-in
  member under load lands on a sign-in form. Evidence: tab at 1440, `fetch('/api/me')` = 429
  twice, about 10 s apart. Fix: treat 429 and 5xx from the session read as "unknown" and retry or
  render with a busy state, never a redirect. This was not verified on a quiet server, and I
  stopped retrying to avoid adding load. It blocked my live signed-in review, so the member views
  in this report come from source.
- **CT-16 (low, verify).** The protected-proposal "Rules checked" panel says "at least 1.00%
  required" for quorum, while `governance.protections.quorum` is 0.2. This may be a rules
  snapshot from a seed that lowered thresholds. If it is a snapshot, the panel should say "rules
  as they stood when voting opened".

## 3. Proposals

### P1. Public membership pitch (CT-1, CT-5, CT-11). Effort M, impact very high

Signed out, or signed in without a membership, `/coop/membership` renders the pitch. Members see
the existing panel, with "Why the co-op" collapsed into the aside. This was agreed with
growth-funnels, who owns CTA and flow. The order follows Stocksy: what we are, then the hard
number, then proof.

```
[MarketingSection, display type, arcs motif]
  eyebrow: CommonAir co-op
  H: Own a piece of the platform you watch
  sub: Creators keep 90%. Members set the rules, one member, one vote.
  [brand] Create account and join      How the co-op works ↓   (growth-funnels copy)
[3 StatTiles from live data]  241 members · 90% to creators · last vote decided {RelativeTime}
[Three ways in: 3 cards]
  Viewer: $5 one-time, refundable on exit; or any $3+/mo channel subscription
  Streamer: automatic once you stream to 2+ verified viewers (90-day window)
  Worker: appointed by the board
[What members get]  vote on proposals · stand for/elect board (3/3/1 seats) · advisory jury ·
  patronage by contribution (formula shown) · open books
[Co-op commitments list]  (Mastodon Server Covenant pattern, via market-research)
  cut changes only by member vote (protected, enforced in the database) · books public monthly ·
  no ads sold on your data, no third-party trackers · AGPL source
[Proof strip]  latest 3 decisions (GovernanceOutcomeList) → /coop/proposals?status=decided
[FAQ Accordion]  quorum & thresholds, refunds, what "protected" means, deficit honesty
[brand CTA repeated at the end only when the first one is out of view]
```

- **Components:** MarketingSection, StatTile (art-director), Card, Accordion, GovernanceOutcomeList,
  MoneyAmount, RelativeTime, Badge (Protected: neutral outline with a lock).
- **Data:** `GET /coop/settings` (membership.classes, platform.cut, board.seats, patronage.formula)
  and `coop.transparency({months:1})`. Both exist, so no contract change is needed.
- **Copy rule:** never out-sell the ledger. No "share of surplus" while the surplus is negative,
  no "highest share" (Kick is 95/5) and no "no thresholds" (there is a $25 minimum payout).

### P2. `/coop` overview becomes a "front door" (CT-1, CT-3, CT-8). Effort M, impact high

```
PageHeader (eyebrow "Member-owned", title, intro rewritten to lead with value)
[Join band for non-members]  1-line pitch + brand CTA (same copy as P1) — static, renders even if APIs fail
[Live now in governance]  open proposals as cards v2 (P4); the board election card, if one is open
[Recent decisions] (5, existing)
aside: Members by class (existing) · Council top 5 with avatar links → /coop/council · "Open books" mini
       (90/10 + last month revenue) → /transparency
```

Make `CoopLoadGate` per-section: each section shows its own inline `CoopLoadError`, the header,
intro and band always render, and a 429 shows "Busy, retrying…" with auto-retry after
`retryAfterSeconds`. Effort S for the gate change.

### P3. Transparency as the marketing asset (CT-2, CT-5, CT-10). Effort M, impact high

Top to bottom:

1. A "By the numbers" strip, following Open Collective: members, creators paid this period, the
   creator share (90%), the last vote, and the date the fee schedule last changed.
2. **Fee promise card**, moved up from the bottom: "Creators keep 90% of every subscription and
   tip. Card fees come out of the co-op's 10%." Place a fee comparison table (market-research
   data: Twitch 50/50, YouTube 70/30, Kick 95/5, Patreon 10% plus processing) beside it, dated and
   sourced. A comparison like this needs an "as published on" date.
3. **Two BreakdownBars** (agreed with art-director). (a) "Where a supporter's dollar goes":
   creators 90% / co-op 10%, from revenue and coopRetained. (b) "What the co-op spent": costs by
   category with translated labels. Each bar gets its table. A Sankey-lite MoneyFlow comes later.
4. **Honest deficit note.** When the surplus is negative, show a Callout: "Costs exceed the
   co-op's 10% today. Here's what pays the gap." This needs a short treasurer-authored note
   (contract request: optional `note` per transparency month, or a static i18n string to start).
5. The month table, stacked rows below `sm`.
6. Governance outcomes capped at 10, with "All decisions" linking to `/coop/proposals?status=decided`.
7. Patronage, member relays, enforcement and jury, unchanged.
8. Split shortfalls collapsed in an Accordion.

Add CoopTabs, or a "Part of the co-op" breadcrumb.

### P4. Readable governance (CT-4, CT-6, CT-7). Effort L overall, impact high

- **SettingValue formatters** (`lib/coop-settings-format.ts`, one per key, i18n): `platform.cut`
  reads "Creators keep 90% · co-op 10%"; `governance.ordinary` reads "10% quorum · simple
  majority · 14-day discussion · 7-day vote". Used on `/coop/settings`, in proposal "What
  changes" (rendered as "90% → 85%" with the diff highlighted, and the raw JSON behind a
  "Technical details" disclosure) and in the council method panel.
- **Settings page:** group by theme (Money, Governance, Membership, Discovery, Safety, Features),
  each a Card row of title, formatted value, Protected badge and "Changed by <proposal link>". The
  key appears only as meta text.
- **Proposal form:** typed editors per setting. Percent sliders/inputs for the cut, MoneyAmount
  input for payouts, duration pickers for periods. Show a before→after preview, and keep JSON as
  an "Advanced" fallback for unknown keys.
- **ProposalCard v2:** title, a one-line excerpt, an author `ChannelAvatar`, tags (Protected,
  Affects creators), and the next step with countdown ("Voting closes in 6 days"). For open
  votes, a participation bar with a quorum tick. Decided cards get a result chip and the deciding
  rule.
- **Detail page:** VoteTally bar mode with threshold ticks (agreed with art-director). Timeline v2
  shows the current step and the next deadline. The signed-out vote card becomes a join prompt.

### P5. Council and board humanised (CT-8). Effort S–M, impact med

- The council is a grid of the top 12 `ChannelAvatar` tiles linked to `/$channel`, then "Show all
  50". Replace "score 0.347" with a contribution share ("3.5% of contribution") and a
  "How seating works" explainer in formatted prose.
- Move board elections to the top of the page whenever one is open or nominating, with
  "Nominations close in …" and a member CTA.

### P6. Trust layer across the app (CT-9, CT-11, CT-12). Effort M, impact high

- **Footer v2, in three columns.** Co-op (About the co-op, Membership, Transparency, Governance
  settings). Policies (Terms, Privacy, Community guidelines, Copyright, Intimate-image removal,
  Cookie settings). Open (Source AGPL, Verify viewer counts, Language). Add a strap line following
  Ghost: "Member-owned co-op · Open source · No ads sold on your data, no trackers".
- **Public `/legal/$kind` pages** (terms, privacy, guidelines, cookies, dmca_policy) render
  `/api/legal` with the version, effective date and draft banner, plus a table of contents and
  "What changed". `/guidelines` anchors per rule ID (`guidelines.general@1`) so enforcement
  statements can deep-link. Check the reserved-slug list: `terms`, `privacy` and `legal` are
  reserved, `guidelines` is not.
- **Support dialog (watch placement, growth-funnels copy):** "A $3+/month subscription also makes
  you a co-op member: one vote, and a say in where the money goes." The success state reads
  "Welcome to the co-op".
- **Channel About / offline header (agreed with watch):** a single neutral mark, Creator council
  > Member-owner. A "How we count viewers" link in About and in VOD/clip channel cards goes to the
  > attestations explainer.
- **Studio (proposed to creator-studio):** a Co-op card with membership progress and council
  rank, plus a one-time "You are now a member-owner" notice after the first qualifying stream.
- **Attestations page:** add an intro for sponsors and creators, "Try a sample statement", a
  published-keys link, and one name ("audience statement") everywhere.

### P7. Public patronage and jury explainers (CT-13). Effort S, impact med

Signed out, render the explainer with the same join band (agreed with growth-funnels):

- **Patronage:** the formula weights as a BreakdownBar, the total distributed by month and how
  your share is computed.
- **Jury:** the panel size, how members are drawn (seed and commitment proof), and that the jury
  is advisory only.

## 4. Funnel and conversion notes

- **Entry points.**
  - Footer "About the co-op" (P6).
  - Home co-op band (discovery/growth-funnels).
  - Auth CoopPitch: reuse the top 3 P1 facts.
  - Support dialog and its success state.
  - The signed-out vote card on a proposal.
  - Patronage and jury explainers.
  - The studio co-op card.
  - Share links to proposals and transparency. Both are good social proof, so give them OG titles
    and descriptions with the real numbers.
- **Steps.**
  1. Pitch (`/coop/membership` signed out).
  2. Brand CTA "Create account and join" → `/signup?redirect=/coop/membership&intent=join`.
  3. Verify email.
  4. Land on the membership panel with the share card focused. Choose the $5 share or "subscribe
     to a channel you like".
  5. Bank-transfer instructions or card (when enabled).
  6. Pending → held: email plus inbox notice "You're a member".
  7. Point to the open vote.
- **Drop-off risks.**
  - Bare `/signin` redirects that lose intent (fixed by growth-funnels' returnTo).
  - The bank-transfer step for the share. Card payments are off on staging, and a reference code
    plus manual treasury confirmation is slow, so show a "what happens next" timeline and expected
    days.
  - Jargon such as quorum or protected decisions before the value. Lead with 90/10 and one member,
    one vote, and put the mechanics in the FAQ.
  - Error-page collapse under load (CT-3).
- **Measurement.** Use the first-party aggregate counters from the shared log: (surface, action,
  step, day), no user ID, IP or cookie. Proposed IDs:
  - `coop.pitch.view`, `coop.pitch.cta`, `coop.join.signup_complete`
  - `coop.share.instructions_shown`, `coop.share.held`
  - `coop.vote.signed_out_prompt`
  - `support.sub_member_notice.view`, `coop.welcome.click` (growth-funnels)
  - `transparency.view`, `transparency.fee_table.view`

  Market-research suggested publishing funnel totals on `/transparency` itself.

## 5. Cross-team decisions

- **growth-funnels:**
  - Signed-out `/coop/membership` renders the public pitch. I own content and layout,
    growth-funnels owns the CTA, flow and returnTo.
  - Signed-out `/coop`, patronage and jury show an explainer plus a join band, not a redirect.
  - The support-dialog member line and "Welcome to the co-op" state.
  - My honesty caveat: no surplus promise.
- **art-director:**
  - Transparency ships two BreakdownBars plus tables first, MoneyFlow (chart tokens, table
    always) later.
  - VoteTally is a bar mode of `blocks/coop/tally-table.tsx` with threshold ticks.
  - Timeline v2 extends `data/timeline.tsx` with `deadline-countdown`.
  - Protected is a neutral outline badge with a lock, never warning or brand.
  - StatTile and Sparkline belong to art-director.
  - The pitch uses MarketingSection with one brand fill.
- **watch:**
  - Trust marks: council > member-owner, one neutral badge in the ChannelHeader badges slot on
    About and offline only, plus the About card.
  - The "How we count" link goes in About and in VOD/clip channel cards, not inside the
    ViewerCount tooltip.
- **market-research:**
  - Adopted the Stocksy order, the Open Collective stat strip, the Ghost footer line and a
    Mastodon-covenant-style commitments list.
  - Fact fix sent back: there is a $25 minimum payout, so don't claim "no thresholds". Never claim
    "highest share".
- **responsive-a11y:**
  - `/transparency` at 320 has 55 tap targets under 24 px, mostly 16 px inline links.
  - Governance outcome, decision and council lists become block-link rows (`min-h-11` below md,
    a chevron, the status chip on the right). Outcomes are capped at 10.
  - The period, report and panel Selects get visible labels and sit in one wrapping row at 320.
  - The mobile bottom bar's Co-op tab for signed-out visitors lands on the `/coop` join band.
- **creator-studio:** agreed and placed.
  - The Co-op card sits in the control-room right column when offline and moves into the
    LiveStatusBar overflow when live.
  - A one-time member-owner Callout appears after the first qualifying stream.
  - A "/revenue" share line.
  - Copy keys sent:
    - card: `coop.studio.card.{title,member,progress,viewersNeeded,council,openVotes,patronage}`
    - welcome Callout: `coop.studio.welcome.{title,body,cta}`
    - revenue line: `money.revenue.shareNote` and `money.revenue.feeHistory`
  - The percent always comes from `platform.cut` and is never hard-coded.
- **Contract requests (orchestrator):**
  - An optional treasurer `note` per transparency month, or start with static copy.
  - The settings page needs the `updatedByProposalId` title. Today it has only the ID, so resolve
    the title client-side or add `updatedByProposal {id,title}`.
  - Public `/legal/$kind` routes need nothing new from the API.

## 6. References

- **Stocksy United, stocksy.com/service/about** (via market-research): the order "artist-owned
  co-op", then the royalty number, then proof. Used for the P1 pitch.
- **joinmastodon.org and the Mastodon Server Covenant** (via market-research): value cards, and
  a published commitments list. Used for the P1 "Co-op commitments".
- **Open Collective** collective pages (via market-research): the "By the numbers" stat strip.
  Used for the P3 top strip.
- **Ghost, ghost.org footer** (via market-research): the non-profit and open-source strap line.
  Used in the P6 footer.
- **PeerTube / Framasoft funding statements** (via market-research): precise funding claims,
  including uncomfortable ones. Used for the P3 deficit note.
- **REI Co-op membership page** (named product, from my own knowledge): a one-time lifetime fee
  plus "what you get" cards plus a dividend explainer. Used for the P1 "three ways in / what
  members get" structure. No copy borrowed.
- **Fee figures** (Twitch, YouTube, Kick, Patreon, Ko-fi) were verified by market-research and
  must carry an "as published on <date>" source line.

## 7. Top 5 for coop-trust

1. **P1 public membership pitch and P2 join band on `/coop`** (CT-1). Today the co-op, the
   differentiator, has no signed-out way in.
2. **P3 transparency fix and reorder** (CT-2, CT-5, CT-10). The trust page currently shows a
   wrong-summing bar and buries the 90/10 promise.
3. **P4 readable governance** (CT-4): formatters, then the "90% → 85%" diff, settings cards, typed
   proposal editors and ProposalCard v2.
4. **P6 trust layer:** footer v2 with public legal/guidelines pages, and the support-dialog
   membership line (CT-9, CT-11).
5. **Per-section load resilience and a session guard that tolerates 429** (CT-3, CT-17, effort S). Public co-op pages should never collapse to
   "This did not load" because one call hit a 429.
