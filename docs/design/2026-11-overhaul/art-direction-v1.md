<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Art direction v1 (art-director) — design toward this; ask me for exceptions

Working name: "Open Broadcast". Zinc product chrome, square editorial surfaces, ONE brand hue
for conversion/brand moments, colour otherwise comes from content (thumbnails, channel accents).

1. Corners: keep base-lyra square (rounded-none) for all surfaces, buttons, inputs, cards,
   thumbnails. Round only: avatars, status dots, the live dot. Remove stray rounded-md/lg (18+4 uses).
2. Brand hue (NEW tokens): --brand (marigold, ~#f5b83d both themes as a fill), --brand-foreground
   (zinc-950 both themes), --brand-text (dark: same marigold; light: ~#9a5b00, AA on white),
   --brand-subtle (brand 14% over card). Use for: the ONE primary conversion CTA per view
   (Sign up / Join the co-op / Go live / Support), the logo mark, home hero. Never for live (red),
   status, links, or channel-owned surfaces (those use --channel-accent). Max one brand fill per viewport.
   --warning moves from amber to orange so it never reads as brand.
3. Primary (white in dark / zinc-900 in light) stays the default action button.
4. Type scale (Rubik only, tabular-nums for numbers):
   display clamp(2rem,4vw+1rem,3.5rem)/1.05 w650 — marketing/home hero only
   h1 page text-2xl (24)/1.2 w600
   h2 section text-lg (18)/1.3 w600
   h3 card/tile title text-sm (14)/1.35 w500
   body/notes text-sm (14)/1.5 — DEFAULT for prose, help text and notes (today 448 text-xs vs 279 text-sm)
   meta text-xs (12)/1.4 muted — metadata, table cells in dense admin, captions
   micro text-2xs (10) — over-video overlays only
5. Surfaces (dark L / light):
   page --background (0.141 / white)
   sunken --surface-sunken NEW (0.17 / zinc-50) — rails, sidebars, tables' header band, studio nav
   card --card (0.21 / white + ring-1 foreground/10)
   raised --surface-raised NEW (0.25 / white + shadow-md) — hover cards, popovers, sticky bars
   overlay --scrim NEW (black/60) + dialog on raised
   Dark elevation = lighter fill + 1px ring; light elevation = shadow. No shadows in dark.
6. Spacing: page gutter 16 / 24 (md) / 32 (xl); max content width 1600 (grids), 768 (forms/prose),
   1120 (settings/studio). Section rhythm: 40 px between home/directory sections (32 on mobile);
   h2 to content 12 px; card grids gap-4 (gap-x-4 gap-y-6 for media grids).
7. Motion tokens NEW: --duration-fast 120ms (hover/press), --duration-base 200ms (popover/menu/tabs),
   --duration-slow 320ms (sheet/drawer/hero cross-fade); --ease-out cubic-bezier(.2,0,0,1).
   Reduced motion: instant (global rule exists); no autoplay previews, no shimmer, no pulse.
8. Brand motif (self-hosted, inline SVG, tokens only): the broadcast arcs from icon.svg + a
   "signal bars" band built from the 12 channel-accent tokens. Used for: home hero, empty states,
   offline/no-thumbnail tiles, category fallback art, auth pages, error pages. No raster art, no stock.
9. Media fallbacks: no-thumbnail = channel-accent tinted field + arcs motif + avatar (one component
   <MediaFallback>), category without box art = <CategoryArt> (accent by hash, glyph, bars).
10. Icons: Hugeicons stroke 1.5 at 16/20/24; 2 only at <=14. Never mix filled + stroke in one row.

Shared components I'm proposing (tell me what else you need): PageHeader v2 (eyebrow, title, desc,
actions, tabs slot), SectionHeader (h2 + "See all"), Shelf (horizontal scroller w/ arrows),
MediaFallback, CategoryArt, EmptyState v2 (art variant + size), Hero (brand), Callout (one note style),
StatTile, MarketingSection. Ask before inventing a card/badge variant.

## v1.1 pinned values (after market-research + growth-funnels)

- --brand oklch(0.83 0.155 84) #f7bd36 both themes; --brand-foreground zinc-950 (11.6:1).
- --brand-text: dark = --brand; light = oklch(0.52 0.115 75) #8f5d00 (5.6:1 on white).
- Light theme brand fills carry ring-1 --brand-text (fill vs white is 1.7:1).
- Golden, not orange (PeerTube/Substack own orange).
- Brand-fill placement per growth-funnels list; creator surfaces use --channel-accent for Follow/Support.
- Home hero = one real live stream + slim co-op promise strip with one hard number; proof strip lower.
