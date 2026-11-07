<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# mockups-acquisition: high-fidelity mockups of the signed-out surfaces (round 2)

Author: mockups-acquisition. Date: 2026-11-06. Nothing in the repo or on staging was changed.
Everything is in `round2/mockups/acquisition/`, made of self-contained HTML, one shared
`tokens.css` and `shell.js` (header, footer, bottom tab bar, icons, theme), and mock content in
`data.js`. The Rubik Variable woff2 files are copied from
`node_modules/@fontsource-variable/rubik@5.3.0` (OFL, licence alongside). There are no CDNs, no
remote images and no third-party scripts. Thumbnails are CSS gradients, and the art is the arcs
from `apps/web/public/icons/icon.svg` plus the signal bars, all drawn from tokens.

**View:**
`python3 serve_nocache.py mockups/acquisition 4174`,
then open http://127.0.0.1:4174/. `python3 -m http.server 4174 --directory <that folder>` also
works, but it caches. Every page takes `?theme=dark|light`, or use the switch in the striped
"Mockup" bar or in the footer.

## 1. The surfaces, restated

Turn round 1's plan into mockups the maintainer can look at:

- **D2.3 / D3.1:** signed-out home v2 (hero, promise strip, shelves, co-op band, streaming band,
  bottom tab bar), at 1440 and 375, including the cold start.
- **D2.4:** `/creators` with a working, sourced fee calculator.
- **D2.5:** the public membership pitch and the `/coop` join band.
- **D2.1 / D2.2:** sign-up with intent, and AuthGatePrompt in place on a channel.

## 2. Pages

| Page                | Variants (query)                                                                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.html`        | Every screen                                                                                                                                                                                    |
| `home.html`         | 9 live (default) · `?live=2` cold start (staging today) · `?live=0` nobody live                                                                                                                 |
| `creators.html`     | `#calculator`, `#claim` (try `fees` = reserved, `aurora-pixel` = taken)                                                                                                                         |
| `import.html`       | `/import` signed out (growth-funnels P5)                                                                                                                                                        |
| `membership.html`   | signed out (pitch) · `?state=nonmember` · `?state=joined-by-sub` (pending, honest first-vote timeline)                                                                                          |
| `coop.html`         | join band · `?state=busy` (one section rate-limited, the rest renders: F3)                                                                                                                      |
| `signup.html`       | `?intent=none\|follow\|chat\|support\|predict\|clip\|watch\|stream\|import\|join` (+`&channel=`, `&username=`) · `&step=sent` · `?mode=signin`                                                  |
| `channel-gate.html` | `?gate=follow\|chat\|support\|clip\|predict\|watch(18+)\|report` · `?confirm=follow` (back after verifying) · `?entry=clip&gate=follow` (clip page as the cold entry, plus a link-preview mock) |

Checked in my own browser tab at 1440×900 and 375×812, in both themes, with no console errors
and no horizontal scroll at 375 (`scrollWidth == innerWidth` on every page).

## 3. What we found while building (evidence)

- **Streamer membership needs 10 hours, not just 2 viewers.** `packages/db/src/seed.ts`
  `membership.classes.streamer = { minStreamingHours: 10, windowDays: 90, minVerifiedViewers: 2 }`.
  Round 1's copy ("automatic once you stream to 2+ verified viewers") leaves the hours out. It's
  fixed in the mockups and in voice-copy's keys (`coop.pitch.way.streamer.body/window`).
- **Vote rules for the FAQ** (`seed.ts`, `governance.protections` / `governance.ordinary`):
  - Protected decisions need 2/3 member-wide, a streamer-class majority, 20% quorum and council
    review.
  - Ordinary decisions need 10% quorum and 50%.
- **The Twitch import ships off** (`docs/decisions/0031-twitch-import.md`:
  `TWITCH_IMPORT_ENABLED=false`). Naming Twitch on our pages is on the post-launch review list.
  The import brings title, description, category, tags, panels and emotes. It does not bring
  followers, VODs or the schedule (there is no schedule table).
- **Seeded proposal titles** used in the decision lists come from `harness/src/seed/coop/plan.ts`,
  e.g. "Publish the co-op budget every quarter" and "Close the co-op to new viewer members for a
  year".
- **direction-check confirmed the art-direction values unchanged.** Their rules are applied:
  - every light brand fill carries the #8f5d00 ring;
  - brand labels are 14/600;
  - no brand fill sits beside a filled primary;
  - no amber channel accent anywhere, because amber reads as the brand;
  - warning always comes with an icon and a word.

## 4. Design decisions made beyond round 1 (for the maintainer to accept or reject)

1. **Header Sign up follows the fill rule automatically.** It is outline while any brand or
   channel-accent fill (`[data-fill]`) is on screen, and primary zinc otherwise. It is never
   brand.
2. **Below 768 on browse pages, Sign in leaves the header** and becomes the bottom tab bar's
   fourth tab (Home, Browse, Co-op, Sign in). Auth pages show no header auth buttons; the form
   has the switch link instead.
3. **An open AuthGatePrompt or post-verify confirm holds the one fill.** The page's own
   accent-filled Follow drops to outline while it is open. Round 1 left accent Follow and the
   brand prompt both filled.
4. **The Report gate** uses Sign in in primary zinc, Create account as ghost, and no brand fill.
5. **Gate placement:**
   - **Follow and Support:** a popover under the button (Support is anchored right).
   - **Clip:** opens upward from the control bar.
   - **Chat:** opens upward from the composer.
   - **Predict:** under the prediction strip.
   - **18+:** a full overlay on the player, with Create account (brand) and Sign in.
   - **Below 640:** the same prompt is a bottom sheet over a scrim.
6. **The Support gate** carries the "$3+/month makes you a co-op member" line as a footer
   callout, so the membership cross-sell appears before the account exists.
7. **Live now when fewer than 4 others are live:** the row is completed with videos badged
   "Video", plus a plain sentence saying so ("2 channels are live. Recent videos fill the rest
   of the row, marked as videos."). Categories with nobody live show "N videos", never "0 live".
8. **The hero feature card** shows its reason ("Featured because it has the most verified
   viewers right now", plus "How we order this page"), "Muted preview" and a Play poster. There
   is no autoplay.
9. **The promise strip** sits under the hero CTAs, with the signal bars as its top rule. Below
   480 px only "Member-owned co-op" and "Creators keep 90%" remain, per voice-copy.
10. **The signed-out rail never ends in grey.** It shows Live now, then Recently live, then a
    "Follow channels you like" card with a text link to sign up. The link is not a second fill.
11. **Calculator modelling:**
    - The result is one big CommonAir number, then one row per platform. Each row has a bar,
      the condition the rate needs, a source link and "checked 2026-11-06".
    - The bars are foreground (us) and muted (others), never brand.
    - The sliders are neutral (foreground accent), not marigold.
    - Twitch counts subs only, because Bits payouts weren't verified. It also shows the 70%
      figure under its row.
    - Kick uses its flat $5 price.
    - Patreon and Ko-fi subtract an assumed 2.9% + 30¢ per payment, said in their rows, with a
      $10 average tip for the per-payment count.
    - Kick and Ko-fi can beat us at some inputs, and the mockup shows that honestly.
12. **Co-op proof numbers** say "$4,294.80 earned by creators in October" (90% of revenue), not
    "paid", because only $297 was paid out (minimum and hold). See open question 2.
13. **The membership pitch shows decisions with threshold marks** (yes share against the rule's
    line) and a Protected lock badge. The joined-by-sub state reads "You're joining the co-op",
    not "Welcome": membership syncs hourly (voice-copy). It gives an honest first-vote timeline.
14. **Sign-up:**
    - A "You were watching {channel}" chip above the H1.
    - "A CommonAir account is free." and three ticks that change with intent.
    - An "After you confirm your email, we'll bring you back to …" line.
    - Birth date selects in one row.
    - Terms links inline in the checkbox label.
    - ALTCHA shown as a passive "Checked: you're not a bot · proof of work, no tracking" row.
15. **Check-your-email** adds:
    - the cross-device exit (ux-journeys);
    - Resend with a countdown;
    - "Wrong address? Start over";
    - an unticked weekly-digest opt-in;
    - "While you wait" with live tiles.
16. **`/coop` join band** sits on `--brand-subtle` with the arcs. It is static markup, so it
    renders even when every API call fails (coop-trust P2).
17. **The clip-entry page** carries a link-preview mock: og:title, og:description, a 1200×630
    still with the channel name, and twitter:card. Staging serves none of these (found by
    ux-journeys).

## 5. Options (where the mockups force a choice)

| Topic                                  | A (mocked)                                  | B                                                       | Cost / risk                                                 |
| -------------------------------------- | ------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| Fill while a gate is open (decision 3) | The page's Follow drops to outline          | Keep both filled (brand prompt + accent Follow)         | A: S, one prop on the trigger. B breaks the one-fill rule.  |
| Mobile Sign in (decision 2)            | In the tab bar's 4th tab, out of the header | Header keeps Sign in + Sign up (README D1.6 as written) | A frees header width at 320; B is what D1.6 literally says. |
| Calculator tips for Twitch             | Subs only, with the reason stated           | Model Bits (≈ $0.01 per Bit to the creator)             | B needs a verified primary source first (market-research).  |

## 6. Recommendation

Accept the mockups as the visual target for D2.1–D2.5 and D3.1, with decisions 1 to 4 as the
rules for the brand fill and the header. What would change my mind: art-director rejecting
decision 3 (then the gate needs a different emphasis, e.g. an outline brand), or
responsive-a11y finding the 4-tab bar plus a Sign up-only header too thin at 320.

## 7. If accepted (changes to the plan)

- **D1.6 (shell):**
  - `site-header` hides Sign in below md when `BottomTabBar` renders, and shows no auth buttons
    on auth routes.
  - The Sign up variant is driven by an `IntersectionObserver` on `[data-fill]`.
- **D2.1:**
  - `AuthGatePrompt` gets a `placement` (`below | above | sheet`).
  - The trigger receives `aria-expanded`, and its fill drops to outline while the prompt is open.
  - The `report` variant uses Sign in in primary zinc.
  - The `support` variant carries the membership line.
- **D2.2:** `&step=sent` adds the cross-device line (i18n `signup.sent.otherDevice`).
- **D2.4:** the competitor data file in `packages/config` gains the fields below; the
  calculator reads them.
  - `pricing: "fixed"` (Kick) and `tipsModelled: false` (Twitch);
  - `processing: { pct, fixedCents, assumed: true }`;
  - `sourceQuality: "primary" | "secondary"`.
- **Contract requests (orchestrator):**
  - A rate-limited, public `GET /api/auth/username-available?name=` returning
    `free | taken | reserved | invalid`, for the claim field. It must stay safe against
    enumeration: it only says whether a name is free, which the public channel URL already
    shows.
  - SSR `og:*` and `twitter:card` meta, plus a 1200×630 still endpoint, for clip, video, channel
    and proposal pages.
- **Copy corrections** (in voice-copy's keys): the streamer membership hours, and "turnout" in
  public vote rules.

## 8. Open questions

1. **Naming Twitch** on `/creators`: "Bring your Twitch channel", "Tools Twitch doesn't have"
   and the comparison rows. ADR 0031 lists this for post-launch review, and the import is off
   by default. Until then, should `/creators` hide the import section when
   `TWITCH_IMPORT_ENABLED=false`? I recommend yes. Should the section title become "Tools other
   platforms don't have"?
2. **Proof numbers:** "earned by creators" ($4,294.80) or "paid out" ($297)? Earned is accurate
   and larger; paid out is what has reached bank accounts. I used earned, labelled as such.
3. **Calculator assumptions** need market-research's sign-off: the Patreon and Ko-fi
   processing, the $10 average tip, and Bits excluded.
4. **The marketing domain** in the claim field: the mockup shows `commonair.example/`. Real pages
   take it from `instanceSite()`.
5. **Hero preview:** a muted live preview, or a poster with Play only? I mocked the poster. A
   muted autoplay behind `motion-safe` would show off the product better, but costs bandwidth
   for every visitor.

## 9. Coordination

- **mockups-product:** shares `tokens.css` and `shell.js` (paths, classes and placeholders
  sent). Product-only CSS goes in their own file. The header avatar takes `data-avatar` and
  `data-accent` at their request. The icons now use the real Hugeicons paths
  (core-free-icons 4.3.5, MIT) from their sprite, so both sets match; only four category glyphs
  (game, pan, tree, chess) stay hand-drawn, with round caps.
- **direction-check:** the values stand and the usage rules are applied (section 3).
- **voice-copy:** all headline and CTA copy is theirs, used verbatim, and they filled the four
  band slots. I sent them the streamer-hours correction, which they confirmed and fixed.
- **ux-journeys:** has every URL. I added the 4 gap screens they asked for: clip entry plus
  unfurl, the cross-device exit, joined-by-sub, and /import signed out.

## 10. References (borrowed in round 1, applied here)

- Owncast (owncast.online): the product as the hero. Applied as one real live stream in the home
  hero.
- Substack (substack.com/going-paid): the earnings calculator as proof. Applied on `/creators`,
  with the sources Substack doesn't give.
- Ko-fi (ko-fi.com): the claim-your-handle closing field and the "do you take a fee?" FAQ.
- Stocksy (stocksy.com/service/about): what we are, then the number, then the proof. Applied in
  the membership pitch order.
- Mastodon Server Covenant (joinmastodon.org/servers): a commitments list. Applied as "Co-op
  commitments".
- Open Collective (opencollective.com): the "by the numbers" strip. Applied as the co-op band
  stats and the pitch stat tiles.
- Twitch (twitch.tv), seen signed out by market-research: a modal gate on action. We use an
  anchored popover or sheet and keep sign-up a full page.
- Competitor rates: market-research.md §6, checked 2026-11-06 (Twitch Plus Program, YouTube
  Help 72902, Kick help centre, Patreon Help 36426991446797, Ko-fi secondary).
