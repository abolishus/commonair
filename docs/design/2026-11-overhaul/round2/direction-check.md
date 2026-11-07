<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Decision 1: approve "Open Broadcast"? (direction-check)

**Recommendation: approve, with five changes.** The token values stand as pinned. The changes
are usage rules plus one palette conflict, and none of them changes a colour value the mockups
already use.

Artefacts are in `round2/direction-check/`:

- `contrast.ts` computes the contrast numbers (`bun contrast.ts`); its output is in
  `contrast-out.md`.
- `proto.html` puts current and proposed side by side. It is served from `round2/` on port 4173:
  `/direction-check/proto.html`, `?theme=light`, `#pro`.
- `rubik-latin-wght-normal.woff2` is copied from the repo's `@fontsource-variable/rubik@5.3.0`, so
  the prototype makes no network calls.

## 1. The question

Should the maintainer approve these four changes?

- Marigold `--brand` oklch(0.83 0.155 84) / #f7bd36, with zinc-950 text.
- Light `--brand-text` #8f5d00.
- `--radius: 0`.
- 14 px body text instead of 12 px.

Round 1 left the contrast sign-off and the live light-theme check open.

## 2. What we found

### 2.1 Contrast (WCAG 2.x ratio; APCA Lc as a second opinion)

Method:

- oklch values are converted to sRGB exactly. Alpha tokens are composited over their surface.
- WCAG thresholds: 4.5 for text, 3 for UI and large text.
- APCA is APCA-W3 0.0.98G-4g. Its Bronze guide asks for Lc 75 minimum for body text, 90
  preferred, 60 for content text and 15 for non-text.

The surfaces resolve to these values:

- **Dark:** page #09090b, sunken #0f0f12, card #18181b, raised #212124, muted #27272a.
- **Light:** page and card #ffffff, sunken #fafafa, muted #f4f4f5.

**Brand**

| Pair                                                    | WCAG                         | APCA Lc      | Result                      |
| ------------------------------------------------------- | ---------------------------- | ------------ | --------------------------- |
| #09090b text on #f7bd36 fill                            | 11.66                        | 73           | pass (APCA: fine at 14/600) |
| white text on brand fill                                | 1.71                         | 34           | **fail** (never use)        |
| dark brand-text on page/sunken/card/raised              | 11.65 / 11.21 / 10.39 / 9.38 | 70–72        | pass                        |
| dark brand-text on muted, on brand-subtle #372f1f       | 8.73 / 7.74                  | 69 / 67      | pass                        |
| light #8f5d00 on white                                  | 5.62                         | 78           | pass                        |
| light #8f5d00 on zinc-50 / muted / brand-subtle #fef6e3 | 5.38 / 5.10 / 5.21           | 75 / 71 / 73 | pass                        |
| foreground on brand-subtle (dark / light)               | 12.65 / 18.45                | 99 / 101     | pass                        |
| muted-fg on brand-subtle (dark / light)                 | 5.02 / 5.58                  | 46 / 75      | pass (dark is thin on APCA) |

**Brand fill as a UI shape (1.4.11)**

| Pair                                                    | WCAG               | Result                   |
| ------------------------------------------------------- | ------------------ | ------------------------ |
| fill against dark page/sunken/card/raised               | 9.4–11.7           | pass                     |
| fill against light white / zinc-50 / muted              | 1.71 / 1.63 / 1.55 | **fail**: needs the ring |
| light 1px #8f5d00 ring against white / against the fill | 5.62 / 3.29        | pass: the ring fixes it  |

**Focus ring**

| Pair                                             | WCAG               | Result                          |
| ------------------------------------------------ | ------------------ | ------------------------------- |
| dark --ring #9f9fa9 against page/card/raised     | 7.56 / 6.74 / 6.09 | pass                            |
| light --ring #71717b against white / zinc-50     | 4.83 / 4.62        | pass                            |
| --ring directly on the brand fill (dark / light) | 1.54 / 2.83        | **fail**: needs the 2 px offset |

**Neighbours of the brand fill**

| Pair                                                     | WCAG | Result                         |
| -------------------------------------------------------- | ---- | ------------------------------ |
| brand beside dark `--primary` #e4e4e7                    | 1.35 | **fail** to separate: hue only |
| brand vs channel-amber / chat-3 / chart-3 #fbbf24 (dark) | 1.02 | **identical** to the eye       |

**`--warning` (new orange)**

| Pair                                            | WCAG                      | Result                                                      |
| ----------------------------------------------- | ------------------------- | ----------------------------------------------------------- |
| dark #fb923c on page / card / 15% tint / raised | 8.79 / 7.83 / 6.04 / 7.08 | pass (APCA 53–58)                                           |
| light #9a3412 on white / zinc-50 / 15% tint     | 7.31 / 7.00 / 5.72        | pass                                                        |
| warning vs live red / vs destructive (dark)     | 2.13 / 1.22               | needs icon + word (already agreed)                          |
| brand vs new warning                            | 1.33                      | hue gap 84° to 55°, distinct to the eye; amber→orange works |

**14 px body (also 12 px meta)**

| Pair                                                   | WCAG                             | APCA Lc | Result                       |
| ------------------------------------------------------ | -------------------------------- | ------- | ---------------------------- |
| dark foreground on every surface                       | 14.3–19.1                        | 101–104 | pass                         |
| dark muted-fg #9f9fa9 on page/sunken/card/raised/muted | 7.56 / 7.27 / 6.74 / 6.09 / 5.66 | 47–51   | WCAG pass; **APCA below 60** |
| light foreground on every surface                      | 18.1–19.9                        | 99–106  | pass                         |
| light muted-fg #62626c on white/zinc-50/muted          | 6.02 / 5.77 / 5.47               | 74–80   | pass                         |

**Channel accents (fill + foreground; fill against page; hover mix)**

| Accent | Dark fill/fg | Dark fill/page | Dark hover/fg | APCA dark | Light fill/fg | Light hover/fg | APCA light |
| ------ | ------------ | -------------- | ------------- | --------- | ------------- | -------------- | ---------- |
| zinc   | 13.46        | 13.46          | 14.07         | 81        | 10.44         | 11.55          | 98         |
| red    | 7.19         | 7.19           | 8.04          | 51        | 6.47          | 7.67           | 85         |
| orange | 8.79         | 8.79           | 9.61          | 60        | 5.18          | 6.24           | 80         |
| amber  | 11.92        | 11.92          | 12.55         | 75        | 5.02          | 6.05           | 79         |
| lime   | 13.19        | 13.19          | 13.72         | 80        | 4.99          | 6.00           | 80         |
| green  | 11.42        | 11.41          | 12.02         | 72        | 5.02          | 6.04           | 80         |
| teal   | 10.69        | 10.69          | 11.32         | 69        | 5.47          | 6.53           | 82         |
| sky    | 9.29         | 9.28           | 10.06         | 62        | 5.93          | 7.04           | 84         |
| blue   | 7.83         | 7.82           | 8.76          | 54        | 6.70          | 7.86           | 87         |
| indigo | 6.67         | 6.67           | 7.68          | 48        | 7.90          | 9.10           | 91         |
| violet | 7.31         | 7.31           | 8.30          | 51        | 7.10          | 8.31           | 88         |
| pink   | 7.51         | 7.51           | 8.36          | 53        | 6.04          | 7.21           | 84         |

**Every pair passes WCAG AA.** The lowest is light lime, 4.99. Under APCA, dark-theme indigo,
red, violet, pink and blue fills with #09090b text sit at Lc 48–54. White text on those fills
would give Lc 55–62, but it fails WCAG (2.5–3.0), so keep dark text. A Follow label at 14 px
weight 600 is acceptable at that level. 12 px labels are not.

**Flags**

1. **The light brand fill against the page** is 1.71:1. It is fixed by the 1px #8f5d00 ring
   already pinned in v1.1, which measures 3.29 against the fill.
2. **The focus ring directly on the brand fill.** It is fixed by the 2 px offset in the agreed
   focus rule. Today `button.tsx:10` puts `ring-2` with **no offset** plus `border-ring` on the
   button itself, so the brand variant must not inherit that.
3. **Brand beside `--primary`** is 1.35:1, so the two buttons differ by hue alone. Never place
   them side by side.
4. **New: the brand is the same colour as the dark `amber` channel accent** (and `--chat-3`,
   `--chart-3`, all #fbbf24): 1.02:1, ΔL≈0, hue ≈1° apart. An amber channel's Follow button, an
   amber chat name or an amber chart series will read as "brand".
5. **APCA only:** the dark muted-foreground is Lc ~50. Help text that moves to 14 px muted sits
   below APCA's Lc 60 for content text. WCAG passes at 6–7.5. This is a quality issue, not a
   compliance one.

**Values that need no change:** `--brand`, `--brand-foreground`, `--brand-text` (both themes),
`--brand-subtle`, both `--warning` values and every channel accent pass AA. Lifting the brand
to L 0.85 (#fdc43f) would move APCA from 73 to 77, but it is not needed once labels are 14/600.

### 2.2 Visual proof (proto.html, 1440 and 375, both themes)

**Dark, 1440:**

- **Proposed:**
  - The marigold "Create free account" is the only warm, saturated object above the fold, and
    it reads instantly. The 90% figure in brand-text ties to it.
  - The signal-bars band and accent-tinted fallback tiles with arcs replace the grey slabs.
    "Recently live" stops being the heaviest block.
  - The square corners look intentional against the square tiles.
- **Current:**
  - The Follow and Support white fills compete with each other.
  - The rounded spotlight thumbnail clashes with the square tiles.
  - The "Payout on hold" badge is the same amber as the proposed brand. That collision is
    exactly what moving warning to orange removes.

**Light, 1440:**

- With the #8f5d00 ring, the brand button holds its edge on white and reads as mustard/gold. It
  is weaker than in dark but clearly the primary target.
- Brand-text "90%" reads as a warm brown-gold, legible.
- At 12 % tint, the light fallback tiles are pastel and calm. At 30 % opacity the arcs on them
  are faint but fine for decoration.
- The **amber tile (Chess openings) sits beside the brand CTA and looks related**: the flag-4
  conflict made visible.

**375:**

- The hero stacks: eyebrow, display at 32, a 2-line lede, then the brand CTA and the ghost
  CTA. The CTA lands at about 340 css px and the first tile starts at about 520.
- The header fits mark, search, Sign in and Sign up with no horizontal scroll
  (`scrollWidth` 375).
- Light 375: the ring keeps the button defined on white.

**Focus (tabbed, dark):** the brand button shows the grey 2 px outline at a 2 px offset
(computed `rgb(159,159,169) solid 2px`, offset 2px), clearly visible against the page.

The prototype also serves as the light-theme check round 1 could not do live. One limit: it
uses hand-built token values, not the app.

### 2.3 Density: 14 px and square corners (measured in the prototype)

| Measure                                      | 12 px (current) | 14 px (proposed) | Change                          |
| -------------------------------------------- | --------------- | ---------------- | ------------------------------- |
| Settings row (label + 1-line hint), 1440     | 63 px           | 67 px            | +6 %                            |
| Settings card, 2 rows + intro, 1440 / 375    | 204 / 242       | 214 / 277        | +5 % / +14 %                    |
| 3-sentence help paragraph at 640 px / 343 px | 39 / 59 px      | 42 / 84 px       | +8 % / **+42 %** (3 to 4 lines) |
| Admin table row (cells kept at 12 px)        | 36 px           | 35 px            | 0                               |
| Admin table row if cells went to 14 px       | 35 px           | 38 px            | +9 %                            |
| 5-column table natural width at 12 / 14 px   | 358 px          | 405 px           | +13 %                           |
| Media tile (auto-fill, ~216 px wide)         | 171 px          | 165 px           | 0                               |

**At 1440 the cost is small.** About 22 table rows per 900 px screen stay 22 if cells stay at
12 px. Settings pages get about 5 % taller, and media grids don't change.

**At 375, prose-heavy pages grow 15–40 %.** That is the readability gain, at the cost of more
scrolling on settings and studio forms. It is acceptable because those are read, not scanned.

**Square corners cost no density** (0 px either way). Setting `--radius: 0` also flattens every
`rounded-sm/md/lg/xl` utility automatically, because they are `calc(var(--radius) * n)`
(`globals.css:110-116`). The 27 stray uses go square without edits. Two side effects:

- Sonner toasts (`sonner.tsx:37`) go square, which is intended.
- Tailwind's own `rounded-xs` is not overridden. Grep for it in the sweep.

**Tables are the real risk.**

- The table already overflows at 375 at 12 px: 358 px natural width in a 343 px card.
- At 14 px, it would add 13 % width to roughly 14 table consumers:
  - money/*, coop transparency, `admin/egress`, `studio/stacked-rows`, the analytics page,
    `relays`, `bot-studio/commands-panel`;
  - `packages/ui/src/blocks/data/data-table.tsx`.
- These are all `whitespace-nowrap` (`table.tsx:52,64`). A blind `text-xs → text-sm` sweep would
  push studio and admin tables into horizontal scroll at 1024–1280 with the rail open.

## 3. Options

| Option                                       | What                                              | Cost                     | Risk                                                                                                                                        | Impact  |
| -------------------------------------------- | ------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| A. Approve as is                             | Ship the tokens and the blanket text-sm migration | M                        | **Med**: the table sweep, the amber collision and a missing focus offset on the brand variant would surface in review or in CI's token test | High    |
| **B. Approve with changes (recommended)**    | Same tokens, plus 5 rules below                   | M (plus S for the rules) | Low                                                                                                                                         | High    |
| C. Reject, go "Quiet Broadcast" (monochrome) | Zinc only, 14 px body, square                     | S                        | Lowest a11y risk; loses the conversion lift and brand recall that AD-1 and growth-funnels rely on                                           | Low–med |

## 4. Recommendation: B, approve with these changes

1. **Brand button contract** (`Button variant="brand"`):
   - **Labels:** 14 px weight 600, size `default` or `lg`, never `xs` or `sm`. This takes APCA
     Lc 73 into its comfortable range.
   - **Light theme:** `ring-1 ring-inset ring-brand-text`.
   - **Focus:** `focus-visible:ring-2 ring-offset-2 ring-offset-background`. Drop the base
     `focus-visible:border-ring`, so the grey never touches the marigold.
   - **No filled neighbours:** never next to a filled `primary` or `channel-accent` button. The
     second action is outline or ghost.
2. **Resolve the amber collision.** The decision is the maintainer's, with no back-compat cost
   (no deployments yet). Preferred: change only the dark `--channel-amber` / `--chat-3` /
   `--chart-3` from #fbbf24 to Tailwind yellow-300 #fde047. The hue moves from 84° to about 98°,
   lemon against marigold: OKLab ΔE about 0.085, against 0.012 today. The luminance ratio
   against the brand is only 1.30, so the hue does the separating. #09090b text on it is
   15.09:1 and 13.44:1 on card, so `tokens.test.ts` passes. Light amber
   #b45309 is already brown-orange and distinct. Fallback: keep amber and accept that amber
   channels look on-brand.
3. **14 px migration scope:** sweep `text-xs` to `text-sm` on prose only: paragraphs, help text,
   card bodies, descriptions and form hints. Keep 12 px for:
   - `Table` / `TableCell` / `DataTable` cells;
   - `KeyValueList` values;
   - StatCard delta and hint (`stat-card.tsx:57-58`);
   - timestamps and counts;
   - chat metadata.

   Table `TableHead` stays at 12/500 on `--surface-sunken`. Studio and admin keep their density.

4. **Dark `--muted-foreground` from oklch 0.705 to 0.74 (#aaaab4), optional but recommended**
   with the 14 px move.
   - Effect: WCAG 8.6 on the page and 7.7 on card; APCA rises from about 50 to about 56. That
     closes most of the APCA gap for help text.
   - Cost: still clearly secondary to the foreground. `--ring` keeps 0.705.
   - If the maintainer wants zero shadcn drift, skip it. WCAG already passes.
5. **The test guard.** Extend `packages/ui/tests/tokens.test.ts` to cover these pairs:
   - brand / brand-foreground;
   - brand-text on page, sunken, card, muted and brand-subtle, in both themes;
   - the light brand ring against page and fill (≥3);
   - warning on the surfaces and its 15 % tint;
   - a check that every channel, chat and chart colour is at least OKLab ΔE 0.07 from
     `--brand`. This catches a future amber-style collision; #fbbf24 today is about 0.012.

**What would change my mind:**

- **Toward a lighter brand (L 0.85):** first-party counters show the light-theme brand CTA
  under-performing the dark one.
- **Toward option C:** user testing finds the marigold reads as a "warning" despite the orange
  move.

## 5. If accepted: changes to the plan (D1)

- **Tokens** (`packages/ui/src/styles/globals.css`, orchestrator):
  - add `--brand`, `--brand-foreground`, `--brand-text`, `--brand-subtle`, `--surface-sunken`,
    `--surface-raised`, `--scrim`, the motion tokens and the type tokens as pinned;
  - set `--radius: 0`;
  - set `--warning` to #fb923c / #9a3412;
  - if change 2 is accepted, set dark `--channel-amber`, `--chat-3` and `--chart-3` to #fde047;
  - if change 4 is accepted, set dark `--muted-foreground` to oklch(0.74 0.015 286.067);
  - generate the light block once (AD-12) before adding any of these, so they are written in
    one place, not three.
- **`button.tsx`:** the `brand` variant per change 1, and a `focus-visible:ring-offset-2` audit
  for every variant.
- **Type sweep:** an allowlist-driven codemod per change 3, with a reviewer check that no
  `table.tsx`, `data-table.tsx` or `stat-card.tsx` meta line changed.
- **Tests:** the `tokens.test.ts` pairs from change 5. A unit test fails on any
  `variant="brand"` with `size="xs"|"sm"`.
- **Brief to every D-batch:** at most one brand fill per viewport, never white on brand, the amber
  rule.
- **Coordination:**
  - Sent to mockups-acquisition and mockups-product (values unchanged, rules 1–6).
  - Agreed with scope-calls: the interest-list button is outline/secondary under the
    `/creators` brand CTA, never a second brand fill. The points chip stays neutral, never
    brand, and accent only as a tint, with a non-coin icon per ADR 0026.

## 6. References

- **WCAG 2.2:** SC 1.4.3 Contrast (Minimum), 1.4.11 Non-text Contrast, 2.4.7 / 2.4.13 Focus
  Visible / Focus Appearance. Borrowed: the thresholds and the "adjacent colour" rule that
  drives the ring offset.
- **APCA-W3 0.0.98G-4g** (Myndex, the `apca-w3` reference constants) and the APCA "Bronze
  simple mode" levels (Lc 90/75/60/45/30/15). Borrowed: the second-opinion scoring and the
  14/600 label floor. Used as advisory only, since WCAG 3 is not final.
- **Björn Ottosson, "A perceptual color space for image processing" (Oklab, 2020).** Borrowed:
  the oklch-to-sRGB conversion matrices used in `contrast.ts`.
- **Tailwind CSS v4 default palette:** amber-400 #fbbf24, yellow-300 #fde047. Borrowed: the
  replacement value for the dark amber accent, so it stays a known palette step.
- **Round-1 sources:** `art-director.md` §3.2/§3.4, `art-direction-v1.md` v1.1 pins,
  `responsive-a11y.md` P4/P9/§5 sign-off. That sign-off quoted 11.6, 5.6 and about 5.3, and this
  check confirms 11.66, 5.62 and 5.38.
