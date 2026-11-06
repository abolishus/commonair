<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Art director: visual system and brand

Read-only investigation, 2026-11-06. Staging was walked signed out (`/api/me` returned 401) in
tab-2: home, `/directory`, `/demo_streamer1`, `/signup`, `/coop`, `/transparency` and
`/search?q=pixel`, at 1440×900 and 375×812, in both themes. Light was forced with
`data-theme="light"` on `<html>` because staging persists `data-theme="dark"`. Studio, admin and
settings were reviewed from source. The companion spec teammates designed against is
`design-team/art-direction-v1.md` (v1 + v1.1 pinned values).

## 1. What exists now

**Tokens** (`packages/ui/src/styles/globals.css`):

- Stock shadcn zinc in OKLCH, dark first, plus three copies of the light block (`.light`,
  `[data-theme=light]` and the system media query). They are hand-synced.
- Semantic extras: `live`, `overlay`, `success`/`warning`/`info`, 8 chart colours, 12 channel
  accents, 12 chat colours.
- `--radius: .625rem` is defined, but base-lyra hard-codes `rounded-none` (112 uses).
  `rounded-md/lg/sm` still appear 27 times across 19 files (e.g. `channel/banner.tsx`,
  `developer/*`, `analytics-page.tsx`).
- Missing tokens: brand colour, surface levels beyond background/card/popover, elevation and
  motion.
- One extra type step, `--text-2xs`.
- `apps/web/src/styles.css` only imports the globals and re-skins ALTCHA.

**Type in use:** 448× `text-xs` against 279× `text-sm`, 13× `text-base`, and 25 uses at
`text-lg` or larger. The product reads at 12 px. PageHeader h1 is 24/600, the only real step
above body.

**Elevation in use:** a mix of `shadow`, `shadow-md`, `shadow-lg`, `shadow-xl` and a custom
`shadow-overlay`, all ad hoc. Dark cards use `ring-1 ring-foreground/10`.

**Motion:** ad-hoc `duration-100…1000`. A global reduced-motion rule makes everything instant
(good). `LiveBadge` pulse is motion-safe.

**Shell:** one `AppShell`, which `DashboardShell` wraps for both `StudioShell` and `AdminShell`.
Structure is consistent. Widths are not: `PageContainer` defaults to `max-w-6xl` with ad-hoc
`max-w-lg/md/3xl/7xl/prose` (13× `max-w-lg` in components alone). The gutter is always `px-4`,
even at 1440.

**Brand:** the mark in `apps/web/public/icons/icon.svg` is "broadcast arcs" (white on zinc-950,
CC-BY-SA). The wordmark is "CommonAir" in Rubik 600. There is no brand colour and no brand moment
anywhere.

**Per route:**

- **Home (1440 dark):**
  - The welcome strip ("Welcome to CommonAir…") is a small bordered bar.
  - Spotlight is one raw thumbnail at about 60 % width, with empty space to its right and title
    and meta below.
  - "Live now" shows one card at the same large size.
  - Categories shows two tall portrait tiles.
  - "Recently live" is a 6-column grid of 24 grey tiles, each with a gradient avatar circle in the
    centre. It is the visual weight of the page, and it is all placeholders.
  - The footer has 16 px links beside 12 px "Cookie settings" and language (F35 still open).
- **Home (375):** the welcome strip wraps to 4 lines. Spotlight is fine. The header has
  "Sign in" only, so Sign up exists only in the dismissible strip. Once, under load, the whole
  page body was "The directory could not be loaded", a bare icon plus text.
- **Directory (both themes):** the category fallback art already exists (`category-tile.tsx`,
  chart-token tint + Hugeicons glyph). In dark the tints are muddy (15 % chart over card), and the
  tile is a card inside a card (double surface). Every 0-live category carries a
  "0 channels live" overlay. Light is clean pastel.
- **Channel (1440 dark):**
  - The player is a black box with "Loading stream…".
  - Follow and Support are both white primary fills, so two equal CTAs. Report sits beside them.
  - The channel accent shows only as the avatar ring.
  - No banner.
  - Chat is a card column.
  - One load returned a 500 and the generic error state: centred `text-sm`/`text-xs` on a vast
    empty page.
- **Channel (375):** the header block works. The tab row has a stray right-edge bar. The "Home"
  panel skeleton is rounded (`rounded-md`) against square cards.
- **Signup:** a narrow form plus an aside card titled "Streaming its members own". It is
  functional but has no brand presence. The submit button is the disabled grey fill while ALTCHA
  verifies.
- **Co-op and transparency:** the sub-nav is a boxed toggle row. Pages load as big grey skeleton
  slabs. Typographic hierarchy is flat: section titles at `text-base`/`text-lg`, body at 12 px.
- **Search:** results are a plain list with a lot of dead space.

**Signed-in pass (streamer1, 1440 dark):**

- **`/dashboard`:** the studio shell puts the nav sidebar at full height _above_ the header
  start (the logo is offset right of the nav). In `_app` the rail sits _below_ the header. That is
  two shell geometries for one product. The nav active item is a filled block, and the sidebar is
  the card colour, not a distinct sunken level. The page opens on a large grey preview slab and
  skeleton bars, with the chat card beside it.
- **Signed-in home:** "Following" and "Live now" each show one 360 px card with about 65 % of
  the row empty (fixed `xl:grid-cols-3` inside a narrow container). That is the best case for the
  auto-fill grid. The rail is "Followed channels" with seeded gradient avatars, and works well.
- **The user menu** shows an initial "A" for a channel that has an avatar.
- **Session not honoured:** `/settings` (1440) and `/dashboard` (375) redirected to `/signin`
  while `fetch('/api/me')` from the same page returned 200, and the header showed "Sign in". This
  is a route-guard bug, not design. It was reported to the orchestrator. No sign-in was attempted.

## 2. Findings

| ID    | Problem                                                                                                                                                                                                         | Evidence                                                         | Sev  |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---- |
| AD-1  | No brand colour or brand moment. Every CTA is the same white/black `primary`, so conversion CTAs cannot stand out and the product looks like an unthemed shadcn demo.                                           | `globals.css` `:root`; home 1440 dark; signup                    | high |
| AD-2  | Body text defaults to 12 px. Help text, card bodies and notes are mostly `text-xs`, so pages read cramped and low-hierarchy, especially at 1440.                                                                | 448× `text-xs` vs 279× `text-sm`; `card.tsx` `text-xs/relaxed`   | high |
| AD-3  | Placeholder imagery dominates. "Recently live" is 24 grey tiles with centred avatar blobs, the heaviest visual block on home. Category tiles in dark are muddy tints in a double surface.                       | home 1440 dark/light; directory dark                             | high |
| AD-4  | No surface hierarchy. Only background/card/popover exist, so rails, sticky bars, hover cards and tables improvise, and elevation is ad-hoc shadows (`shadow`/`md`/`lg`/`xl`/`overlay`) that do nothing in dark. | `globals.css`; shadow counts                                     | med  |
| AD-5  | Corner language is inconsistent: `rounded-md/lg/sm` in 19 files against the square lyra system, and an unused `--radius`.                                                                                       | grep; channel 375 skeleton                                       | med  |
| AD-6  | Page widths and gutters are ad hoc: `max-w-6xl` default, many `max-w-lg/md/3xl/7xl`, and a 16 px gutter at every breakpoint.                                                                                    | `page-layout.tsx`; grep                                          | med  |
| AD-7  | Two equal filled CTAs on the channel page (Follow and Support), and the channel accent is barely used.                                                                                                          | channel 1440 dark                                                | med  |
| AD-8  | Empty, error and loading states are tiny and bare: a 32 px icon square plus 12–14 px text in a vast field, and full-width grey skeleton slabs that don't mirror the content.                                    | channel 500 error; transparency and co-op skeletons; `empty.tsx` | med  |
| AD-9  | The home hero is a raw thumbnail with no frame, overlay or side content, and leaves about 35 % empty at 1440.                                                                                                   | home 1440                                                        | med  |
| AD-10 | No motion tokens: 10 different durations, no shared easing.                                                                                                                                                     | grep `duration-*`                                                | low  |
| AD-11 | Footer type mismatch: links inherit 16 px while Cookie settings and language are 12 px. There is no footer structure (no columns, no mark, no co-op promise).                                                   | every page, 1440 and 375                                         | low  |
| AD-12 | Light theme is defined three times by hand, a drift risk for every new token.                                                                                                                                   | `globals.css` `.light` / `[data-theme=light]` / `@media`         | low  |
| AD-13 | `--warning` (amber) would collide with any yellow brand, and the "Protected" co-op badge uses an amber tone.                                                                                                    | `globals.css`; coop-trust report                                 | low  |
| AD-15 | Two shell geometries: in studio/admin the nav sidebar is full-height beside the header, while the `_app` rail sits below a full-width header. The logo moves between areas.                                     | `/dashboard` vs `/` at 1440 (signed in)                          | med  |
| AD-16 | Fixed column grids leave single cards stranded: signed-in home shows one 360 px tile per row with about 65 % empty.                                                                                             | `/` signed in, 1440                                              | med  |
| AD-14 | Mobile header has no Sign up. The only signed-out acquisition CTA at 375 is the dismissible welcome strip.                                                                                                      | home 375 (passed to growth-funnels)                              | med  |

## 3. Proposals

### 3.1 Visual direction: three options

**A. Quiet Broadcast (monochrome)**

- Pure zinc, with colour only from content (thumbnails, channel accents).
- Fix type, surfaces and placeholders.
- Pros: least work, safest for AA.
- Cons: no brand recall and no way to lift the conversion CTA. Looks like every shadcn app.

**B. Open Broadcast (zinc + one signal hue + square editorial). RECOMMENDED.**

- Zinc chrome and square lyra surfaces.
- One marigold `--brand` reserved for the single conversion CTA per view and for brand moments.
- Larger editorial type at the top of the scale.
- A self-hosted SVG motif (broadcast arcs + "signal bars" built from the 12 channel-accent
  tokens) for hero, empty, offline and error art.
- Colour otherwise comes from creators: channel accent on channel pages.

**C. Community Poster (multicolour)**

- Channel-accent rainbow as the brand.
- Coloured section bands and big display type everywhere.
- Pros: loud and memorable.
- Cons: fights the thumbnails, competes with channel accents, harder AA, and tiring in a product
  people sit in for hours.

**Recommendation: B.** The restraint of A goes on product surfaces and C's energy is confined to
marketing surfaces and illustrations. Market-research confirmed that no streaming peer owns
golden yellow (Twitch purple, Kick green, YouTube red, Owncast purple-blue). The hue is kept
golden rather than orange because PeerTube and Substack own orange.

### 3.2 Token plan (all in `packages/ui/src/styles/globals.css`)

**Add:**

- **Brand colour:**
  - `--brand: oklch(0.83 0.155 84)` (#f7bd36), the same in both themes.
  - `--brand-foreground`: zinc-950. Text on the fill is 11.6:1.
  - `--brand-text`: dark = `--brand`; light = `oklch(0.52 0.115 75)` (#8f5d00, 5.6:1 on white).
  - `--brand-subtle`: `color-mix(--brand 14%, --card)`.
  - In light, brand fills get `ring-1 ring-brand-text`, because the fill against white is only
    1.7:1.
- **Surfaces:**
  - `--surface-sunken`: dark `oklch(0.17 0.005 286)`, light zinc-50 `oklch(0.985 0 0)`. For rails,
    nav, table header bands and queue lists. It replaces `--sidebar` usage for the rail.
  - `--surface-raised`: dark `oklch(0.25 0.006 286)`, light white + `--shadow-raised`. For hover
    cards, sticky bars and bulk bars.
  - `--scrim`: `oklch(0 0 0 / 60%)`.
  - `--shadow-raised` (light only: `0 1px 2px oklch(0 0 0/6%), 0 4px 12px oklch(0 0 0/8%)`). Dark
    gets `none`, and the ring does the job.
- **Motion:** `--duration-fast: 120ms`, `--duration-base: 200ms`, `--duration-slow: 320ms`,
  `--ease-out: cubic-bezier(.2,0,0,1)`, `--ease-in-out: cubic-bezier(.4,0,.2,1)`. Expose them via
  `@theme` so `duration-fast` and `ease-out` utilities exist.
- **Type:** `--text-display: clamp(2rem, 4vw + 1rem, 3.5rem)` with line-height 1.05,
  letter-spacing -0.02em and weight 650.
- **Layout:** `--container-page: 100rem` (1600), `--container-board: 100rem`,
  `--container-form-page: 70rem` (1120), `--container-form: 48rem` (768),
  `--container-prose: 40rem`. Gutter: `px-4 md:px-6 xl:px-8`.

**Change:**

- `--warning`: amber → orange (dark #fb923c, light #9a3412), so it never reads as brand. Both are
  already in the chart and channel palettes; `tests/tokens.test.ts` must re-check the pairs.
- `--radius: 0`. Keep `rounded-full` only for avatars, dots and the live dot. Remove the 27 stray
  `rounded-sm/md/lg`.

**Refactor:** generate the light block once (one `@custom-variant`-driven block, or one
`:is(.light,[data-theme=light])` selector plus a single `@media` copy produced at build time) so
tokens are added in one place (AD-12).

### 3.3 Surface hierarchy

| Level   | Dark                               | Light                      | Use                                                                   |
| ------- | ---------------------------------- | -------------------------- | --------------------------------------------------------------------- |
| page    | `--background` 0.141               | white                      | the canvas                                                            |
| sunken  | `--surface-sunken` 0.17            | zinc-50                    | left rail, studio/settings/admin nav, queue lists, table header bands |
| card    | `--card` 0.21 + ring foreground/10 | white + ring foreground/10 | content groups; never nest card in card (fixes category tile)         |
| raised  | `--surface-raised` 0.25 + ring     | white + shadow-raised      | popover, hover card, sticky LiveStatusBar, bulk-action bar, menus     |
| overlay | `--scrim` + raised panel           | same                       | dialog, sheet, drawer                                                 |

Rule: in dark, a step up is lighter fill plus a ring; in light, a step up is a shadow. Over
video, `--overlay` stays theme-independent.

### 3.4 Type scale (Rubik variable only; `tabular-nums` for numbers, codes and timers; no mono)

| Role           | Size / line height            | Weight | Use                                                                  |
| -------------- | ----------------------------- | ------ | -------------------------------------------------------------------- |
| display        | clamp(32–56) / 1.05, −0.02em  | 650    | home hero, /creators, membership pitch, error code                   |
| h1             | 24 / 1.2, −0.01em             | 600    | page title (PageHeader); 30 on marketing pages                       |
| h2             | 18 / 1.3                      | 600    | section headers (SectionHeader)                                      |
| h3             | 14 / 1.35                     | 500    | card, tile and dialog titles                                         |
| body (default) | 14 / 1.5                      | 400    | prose, help text, notes, card bodies, form hints                     |
| meta           | 12 / 1.4, muted               | 400    | timestamps, counts, table cells in dense admin, tile secondary lines |
| micro          | 10                            | 500    | over-video badges only                                               |
| eyebrow        | 12, uppercase, +0.06em, muted | 500    | PageHeader eyebrow, marketing section kicker                         |

Migration: the Card default becomes `text-sm/relaxed`. Sweep `text-xs` paragraphs to `text-sm`,
keeping `text-xs` for meta. The footer goes to one 14 px size.

### 3.5 Spacing and layout

- 4 px base.
- Section rhythm: 40 px between home and directory sections (32 below md); h2 to content 12 px.
- Media grids: `grid-template-columns: repeat(auto-fill, minmax(248px, 1fr))` with
  `gap-x-4 gap-y-6`. That gives about 4 columns at 1440 with the rail and 5 at 1920.
- Widths:
  - Board pages (dashboard, mod, content, overlays, home, directory): 1600.
  - Forms: 1120 page with 768 inner.
  - Auth: 960 two-column.
  - Prose: 640.

### 3.6 Brand moment: home and marketing surfaces

The pattern is borrowed from Owncast (the product is the hero) and joinmastodon (one promise and
two CTAs). Signed-out home only, replacing WelcomeStrip and the separate Spotlight:

```
┌ rail ┬──────────────────────────────────────────────────────────────┐
│      │ EYEBROW  A MEMBER-OWNED CO-OP                                 │
│      │ Display: "Live streaming, owned by the people on it."  ((·))  │ <- arcs mark, large, brand-text, 8% opacity field
│      │ Body 16: one sentence + one hard number ("Creators keep 90%") │
│      │ [Create free account]=brand   [Browse live]=ghost             │
│      │ ▂▃▅▇▅▃▂ signal-bars band (12 channel-accent tokens, 6px tall) │
│      ├──────────────────────────────────────┬───────────────────────┤
│      │ StreamCard size=feature (62%)        │ title h3, channel,    │
│      │ live thumbnail, LiveBadge, viewers   │ category, tags,       │
│      │                                      │ [Watch now]=outline   │
│      ├──────────────────────────────────────┴───────────────────────┤
│      │ Live now shelf … Categories shelf … Recently live (ChannelChip│
│      │ rows) … "By the numbers" proof strip (StatTile×4: members,    │
│      │ creators paid, % to creators, open votes) → /transparency      │
└──────┴──────────────────────────────────────────────────────────────┘
```

- Signed in: no hero. Start at "Live now"/"Following".
- While the hero is in view, the header Sign up drops to outline (growth-funnels).
- **375:** the stack is eyebrow, display at 32, body, a full-width brand CTA, a ghost CTA, the
  bars, then the feature card stacked.
- **Marketing surfaces** (`/creators`, the public `/coop/membership`, auth pages): a
  `MarketingSection` (eyebrow, h1 at 30, body at 16, media slot, two-column at lg) and the same
  bars motif as a section divider. Auth pages get a left brand panel (arcs + promise + 3 bullets)
  at lg, collapsed to the bars band at <lg.

### 3.7 Illustration and empty-state approach (self-hosted, no raster, no stock)

There are three motifs, all inline SVG React components in `packages/ui/src/art/`, coloured only
by CSS variables, `aria-hidden`, and with no external fetch:

1. **Arcs**: the broadcast mark from `icon.svg`, scalable, with `currentColor` strokes.
2. **Signal bars**: 12 vertical bars in the 12 `--channel-*` tokens with deterministic heights. It
   echoes the test card that every stream shows, so it reads as "broadcast".
3. **Glyph plate**: a Hugeicons glyph at 40 px on a `--brand-subtle` or accent-tinted square.

Components:

- **`<EmptyArt variant="arcs|bars|glyph" icon?>`** at 96–160 px. `EmptyState` v2 gains
  `art`, `size="sm|md|lg"` (lg = page-level) and `secondaryAction`. The title moves to h3 at
  16/600 and the description to `text-sm`, with a max width of 40ch.
- **`<MediaFallback accent name avatarSrc kind="offline|nothumb|vod">`**: a channel-accent tinted
  field (accent at 18 % over card in dark, 12 % in light), the arcs at 30 % opacity off-centre, the
  avatar md bottom-start, and an optional "Offline" OverlayBadge. It replaces the grey tile +
  centred avatar in StreamCard, recently-live and VOD tiles.
- **`<CategoryArt name accent|tone shape="portrait|landscape" muted>`**:
  - The existing tint + glyph.
  - Tint raised to 22 % in dark so it isn't muddy.
  - A bars strip on the bottom edge.
  - Drawn directly as the card media, not a card inside a card.
  - The `muted` state (0 live) desaturates to `--muted` and drops the "0 live" badge.
- **Error pages** (404/500/offline): a display-size code ("404") in `--muted-foreground` with the
  arcs crossed by one bar, then h1, body, and Browse + Try again actions. Full-height, centred,
  `EmptyState size=lg`.
- **Loading:** skeletons mirror the real layout (tile = 16:9 block + 2 lines; table = header band
  - rows). No full-width slabs. Under reduced motion they are static (no pulse).
- **Seed** (from F10): seeded thumbnails remain the test card, and that's fine.

### 3.8 Motion spec

| Interaction                             | Duration              | Easing      | Property                                                                       |
| --------------------------------------- | --------------------- | ----------- | ------------------------------------------------------------------------------ |
| hover/press (buttons, tiles ring, rows) | fast 120              | ease-out    | color, background, ring, translate-y 1px press                                 |
| tile hover                              | fast 120              | ease-out    | ring-2 channel-accent + thumbnail scale 1.02 (motion-safe only)                |
| popover, menu, tooltip, hover card      | base 200              | ease-out    | opacity + 4px translate from the anchor side                                   |
| tabs indicator, segmented               | base 200              | ease-in-out | transform                                                                      |
| sheet, drawer, dialog                   | slow 320 in / 200 out | ease-out    | translate / opacity + scrim fade                                               |
| hero / feature cross-fade, shelf scroll | slow 320              | ease-in-out | opacity, scroll-snap                                                           |
| toasts                                  | base 200              | ease-out    | slide 8px + fade                                                               |
| live dot                                | 2s loop               | none        | opacity pulse; LiveBadge pulse only on the channel page header, never in grids |

**Reduced motion:**

- The existing global rule stays: everything is instant.
- In addition, behind `motion-safe:`:
  - no thumbnail scale,
  - no hover video previews,
  - no skeleton pulse,
  - no live-dot pulse,
  - no smooth-scroll shelves (jump instead),
  - no autoplay of the hero player. It shows the poster with a Play button. It is muted
    regardless.
- No parallax, no scroll-linked animation, and nothing over 320 ms except the live-dot loop.

### 3.9 Iconography

- Hugeicons stroke 1.5 at 16/20/24 (stroke 2 only at ≤14).
- One icon style per row; never mix filled and stroke.
- Icon-only buttons always go through `IconButton tooltip`.
- `EmptyState` currently forces `strokeWidth={2}` at 20 px. It moves to the art system.

### 3.10 App shell, header, nav and footer

- **Header:**
  - 56 px, background with a bottom border.
  - The mark gets a brand-text tint on the arcs only (the wordmark stays foreground).
  - Nav links are ghost buttons with an active underline (2 px foreground).
  - Signed-out actions: Sign in (ghost) + Sign up (outline; brand when no hero is visible). At 375
    the Sign up button shows beside Sign in, with search as an icon (AD-14). Width check with
    responsive-a11y: it fits at 320 when the wordmark collapses to the mark below 360 px.
- **Rail:** `--surface-sunken`, with section labels as an `eyebrow`.
- **Studio/admin/settings nav:** the same `NavGroups` on sunken, with an active item as a 2 px
  start border + foreground text, not a filled block.
- **Footer:** three columns at md and stacked at 375:
  - Mark + one-line co-op promise + Source (AGPL).
  - Platform links (Transparency, Co-op, Attestations, DMCA, Intimate-image reports).
  - Preferences (Cookie settings, Language, Theme). The theme toggle moves here (F14).
  - All 14 px, muted, with foreground on hover.
- **One shell geometry (AD-15):** a full-width header everywhere, with the rail or nav below it, so the logo never moves.
- **Consistency:** `_app`, `_studio` and `_admin` all use PageHeader v2 and the width tokens. Admin
  gets an "Admin" eyebrow and never a brand fill.

### 3.11 Component inventory

**Redesign (house primitives):**

| Primitive / block                   | Change                                                                                                   | Effort |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- | ------ |
| `StreamCard`                        | MediaFallback; reason as a quiet meta line; `size="feature"`; motion-safe hover; uses the auto-fill grid | M      |
| `EmptyState` / `empty.tsx`          | v2: art, size, secondaryAction, text-sm desc                                                             | S      |
| `Skeleton*`                         | layout-mirroring sets (tile, row, table, header); static under reduced motion                            | S      |
| `ChannelAvatar`                     | keep; add `ring` accent when live; gradient seeded avatars stay                                          | S      |
| `LiveBadge`                         | keep; pulse only on the channel header                                                                   | S      |
| `PageHeader`                        | v2: eyebrow, tabs slot already there, size `marketing` (30), sticky option                               | S      |
| `Card`                              | default `text-sm`; no nesting                                                                            | S      |
| `category-tile.tsx` → `CategoryArt` | portrait + landscape + muted, no double surface                                                          | S      |
| `site-footer`, `site-header`        | per 3.10                                                                                                 | M      |
| `CopyField`                         | add a masked Reveal option (stream key)                                                                  | S      |
| `goal-bar`                          | studio variant with an edit slot                                                                         | S      |
| `DataTable`                         | stacked <sm, sticky sunken header, raised bulk bar                                                       | M      |
| `FilterBar`                         | result count slot                                                                                        | S      |
| `Timeline`                          | v2 current step + deadline; AuditTrail variant                                                           | M      |
| `tally-table`                       | VoteTally bar mode with threshold ticks                                                                  | M      |
| `AlertCallout`                      | becomes the one note style (`Callout`); destructive tone = DangerZone                                    | S      |
| `Section` / `FormSection`           | SettingsSection/SettingsRow variants                                                                     | S      |
| `Button`                            | add a `brand` variant (fill + light-theme ring)                                                          | S      |
| `StatusBadge`                       | `warning` re-toned to orange; a "Protected" neutral outline + lock                                       | S      |

**New shared components (requester in brackets):**

| Component                                                                | For                                                | Effort |
| ------------------------------------------------------------------------ | -------------------------------------------------- | ------ |
| `art/Arcs`, `art/SignalBars`, `EmptyArt`                                 | everyone [AD]                                      | S      |
| `MediaFallback`                                                          | discovery, watch                                   | S      |
| `Hero` (signed-out home)                                                 | discovery, growth-funnels                          | M      |
| `MarketingSection`                                                       | coop-trust, growth-funnels (/creators, membership) | S      |
| `SectionHeader` (h2 + See all)                                           | discovery, watch                                   | S      |
| `Shelf` (horizontal scroller, snap, arrows)                              | discovery                                          | M      |
| `MediaCard` (kind vod/clip)                                              | discovery, watch                                   | M      |
| `ChannelChip` (offline channel row)                                      | discovery                                          | S      |
| `StatTile` + `Sparkline`                                                 | creator-studio, coop-trust, home proof strip       | M      |
| `ChartCard` (promoted from analytics)                                    | creator-studio                                     | S      |
| `LiveStatusBar`                                                          | creator-studio                                     | M      |
| `SetupChecklist`                                                         | creator-studio, growth-funnels                     | M      |
| `EncoderGuide`                                                           | creator-studio                                     | S      |
| `QueueLayout`                                                            | account-admin                                      | M      |
| `AuthGatePrompt` (Callout + brand button; Popover desktop / Drawer <640) | growth-funnels, watch                              | S      |
| `MoneyFlow` (later; BreakdownBars first)                                 | coop-trust                                         | L      |

## 4. Funnel and conversion notes (visual system's part)

- **The brand fill is the conversion signal.** Exactly one per viewport, on the step's CTA, per
  the growth-funnels list. On creator surfaces (channel, VOD, clip, `/m/`) the single fill is
  Follow, then Support once followed, in `--channel-accent`. It is never brand on Sign in,
  Report, settings, admin or destructive actions.
- **Entry → home hero.** The CTA is "Create free account" (brand); "Browse live" is secondary.
  The drop-off risk is a hero that pushes live content below the fold. The feature live card
  stays in the first viewport at 1440 (hero ≤ 360 px tall before the card).
- **375:** the header Sign up gives a persistent CTA after the hero is dismissed or scrolled.
- **Measurement** (first-party aggregate counters, growth-funnels' model): instrument
  `surface=home_hero|header|auth_gate`, `action=cta_click`, `step=view|click`. That's enough to
  A/B the brand fill against outline by build flag, with no third-party code.

## 5. Cross-team decisions (all in `decisions-log.md`)

- **Direction v1 "Open Broadcast"** and the pinned brand values. Agreed with market-research,
  growth-funnels. Messages also went to discovery, watch, creator-studio, coop-trust,
  account-admin and responsive-a11y.
- **Brand fill placement:** creator surfaces use the channel accent. Agreed with growth-funnels.
- **Media tiles:** StreamCard feature, MediaCard, ChannelChip, CategoryArt shapes, auto-fill grid
  248 px, quiet reason line, signed-out-only Hero. Agreed with discovery.
- **Studio:** boards at 1600, forms at 1120/768. LiveStatusBar, SetupChecklist, Sparkline and
  ChartCard are new; CopyField and GoalBar are extended. The brand CTA is the first-run step, then
  "Share your channel". Agreed with creator-studio.
- **Settings/admin:** sunken section nav at lg; extend Section, FormSection, AlertCallout,
  DataTable, FilterBar and Timeline; QueueLayout is new; codes in tabular-nums, never mono. Agreed
  with account-admin.
- **Co-op data viz:** BreakdownBars first, MoneyFlow later, the VoteTally mode, Timeline v2, and a
  neutral "Protected" badge. Agreed with coop-trust.
- **Depends on responsive-a11y** to confirm the 375/320 header (Sign up + Sign in + search icon +
  mark) and the text-sm migration. The direction was sent; there was no reply at the time of
  writing.

## 6. References (patterns only, no assets or copy)

- **Owncast (owncast.online):** the product as the hero (a real player on the landing page). This
  became the home hero holding one real live stream.
- **joinmastodon.org:** one promise line with two CTAs, then value cards. This became the
  hero's display line + brand/ghost CTA pair.
- **Stocksy (stocksy.com):** says "artist-owned co-op" in the first sentence with a hard number.
  This became the co-op promise strip with one number.
- **Open Collective:** a "by the numbers" proof strip. This became the home StatTile proof strip
  linked to /transparency.
- **Twitch (twitch.tv):** a single featured stream at the top of the front page, and the
  directory's dense auto-fill grids. This became the feature StreamCard and the 248 px auto-fill
  grid.
- **The colour landscape** (via market-research): Twitch purple, Kick green, YouTube red,
  PeerTube/Substack orange. Golden marigold was chosen to stay clear of all of them.
- **SMPTE colour bars and the test card:** a public-domain broadcast convention. This became the
  "signal bars" motif, drawn from our own channel-accent tokens.

## 7. Top 5

1. **Brand token + `Button variant="brand"` + the one-fill rule** (AD-1, AD-7). S effort, very
   high impact on conversion and recognisability.
2. **Type migration to a `text-sm` body and the scale in 3.4** (AD-2, AD-11). M effort, the
   largest perceived-quality lift across all three shells.
3. **The art system (Arcs, SignalBars, EmptyArt, MediaFallback, CategoryArt) replacing the grey
   placeholders, bare empty/error states and slab skeletons** (AD-3, AD-8). M effort, makes home,
   directory and every empty page look designed.
4. **Signed-out home Hero (one real live stream + promise + proof strip) and the footer
   redesign** (AD-9, AD-11, AD-14). M effort, the brand moment and the main acquisition surface.
5. **Surface, width and motion tokens, plus removing stray radii and de-duplicating the light
   block** (AD-4, AD-5, AD-6, AD-10, AD-12). M effort, the foundation that keeps the other nine
   designers' work consistent.

## 8. Decisions-log reconciliation (final read)

- **Brand fill on channel pages:** growth-funnels' first line says "channel Follow" in brand. It
  is superseded by the later agreed line: creator surfaces use `--channel-accent` for
  Follow/Support. growth-funnels agreed by message.
- **"Go live" brand CTA** (growth-funnels line): there is no Go live button, because going live
  happens in OBS. The studio brand CTA is the current first-run step, then "Share your channel".
  Agreed by creator-studio and me.
- **`LiveStatusBar`** gains a `compact` variant (LiveBadge, viewers, uptime, "Open stream
  manager") for the signed-in home, where the viewer's own channel is excluded (discovery +
  creator-studio). It is added to the inventory, on `--surface-raised`.
- **Watch routes:** the site header scrolls away below lg and there is no bottom nav (watch +
  responsive-a11y). This is consistent with the header spec in 3.10, which applies to non-watch
  routes. The player poster cross-fade uses a view transition only when motion is allowed, which
  matches the motion spec.
- **The Clip button** (watch) uses the existing control-bar icon style (`IconButton tooltip`),
  never a fill.
- **`/creators`** (discovery, market-research): it uses `MarketingSection` + display type, with
  the brand CTA "Start streaming".
- **Codes and stream keys** stay in tabular-nums, never mono (creator-studio, account-admin):
  consistent.
- **Settings nav groups** (account-admin) render with the shared `NavGroups` on
  `--surface-sunken`: consistent with AD-15's one shell geometry.
- **Resolved (AD-14):** a compact "Sign up" sits beside "Sign in" at all widths, and the
  wordmark collapses to the mark below 400 px (raised from 360 px by responsive-a11y). It is outline whenever a brand or channel-accent
  fill is in the viewport, and primary zinc (never brand) elsewhere. In tab order it comes first
  after search, and it keeps `?redirect=`. Agreed with growth-funnels, who logged it.
- **Accessibility sign-off (responsive-a11y):** all the colour contrasts pass. Their conditions
  are adopted:
  - One focus rule everywhere: `ring-2 ring-ring ring-offset-2 ring-offset-background`. The 9
    primitives that use `ring-1` migrate, and the ring never sits directly on a brand fill.
  - Warning, destructive and live always pair an icon with a word.
  - `text-2xs` is used only over video with a scrim. Viewer counts on tiles and in the rail move
    to 12 px tabular-nums.
  - Header: mark only below 400 px or whenever the signed-in cluster shows (a container query on
    the header). Icon hit areas are 40–44 px below md.
- **New: bottom tab bar below md, browse routes only.**
  - Tabs: Home, Browse, Following (signed in) or Co-op (signed out), You.
  - 56 px + safe area, on `--surface-raised`, labels always visible.
  - Hidden on watch, auth, studio, settings and admin, and when the keyboard is open.
  - The header below md keeps mark + search + Sign up (outline) or the avatar. Sign in moves into
    the You tab.
- **Breakpoints:** sm 640, md 768, lg 1024 (watch two-column, chat 340), xl 1280, 2xl 1536, with
  a maximum content width of 1600.
- **New component:** `BottomTabBar` (responsive-a11y, M).
