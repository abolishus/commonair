// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The self-hosted art system ("Open Broadcast", art-direction-v1 §8–9): inline SVG coloured only
 * by CSS tokens, decorative (aria-hidden), static. No raster art, no remote fetch.
 */
export { Arcs, type ArcsProps } from "./arcs.tsx";
export { SignalBars, SIGNAL_ACCENTS, SIGNAL_HEIGHTS, type SignalBarsProps } from "./signal-bars.tsx";
export { EmptyArt, type EmptyArtProps, type EmptyArtSize, type EmptyArtVariant } from "./empty-art.tsx";
export { MediaFallback, type MediaFallbackKind, type MediaFallbackProps } from "./media-fallback.tsx";
export {
  CategoryArt,
  categoryFallback,
  categoryKind,
  type CategoryArtProps,
  type CategoryArtShape,
  type CategoryKind,
} from "./category-art.tsx";
export { artHash } from "./hash.ts";
