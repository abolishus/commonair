// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";

/**
 * Marks a page's one filled call to action (the brand "Create free account", a channel-accent
 * Follow, `AuthGatePrompt`'s "Create account"). While one is on screen the header's Sign up drops
 * to an outline, so a viewport never has two filled CTAs (art direction: one per screen). The
 * units that build those CTAs put the attribute on them; until one does, Sign up stays filled.
 */
export const FILLED_CTA_ATTRIBUTE = "data-filled-cta";
const SELECTOR = `[${FILLED_CTA_ATTRIBUTE}]`;

/** The sticky header's height: a CTA scrolled under it is not on screen. */
const HEADER_PX = 56;

/**
 * Whether any element marked `data-filled-cta` is in the viewport (below the header). Off while
 * `enabled` is false (signed in: there is no Sign up to restyle), and false where the browser has
 * no IntersectionObserver.
 */
export function useFilledCtaInView(enabled: boolean): boolean {
  const [inView, setInView] = React.useState(false);
  React.useEffect(() => {
    if (!enabled || typeof IntersectionObserver === "undefined") return;
    const visible = new Set<Element>();
    const observed = new Set<Element>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target);
          else visible.delete(entry.target);
        }
        setInView(visible.size > 0);
      },
      { rootMargin: `-${HEADER_PX}px 0px 0px 0px` },
    );
    // Pages mount and drop their CTA as they load; rescan at most once a frame (chat mutates a lot).
    let frame = 0;
    const scan = () => {
      frame = 0;
      const now = new Set(document.querySelectorAll(SELECTOR));
      for (const element of now)
        if (!observed.has(element)) {
          observed.add(element);
          io.observe(element);
        }
      for (const element of observed)
        if (!now.has(element)) {
          observed.delete(element);
          visible.delete(element);
          io.unobserve(element);
        }
      setInView(visible.size > 0);
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(scan);
    };
    scan();
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [FILLED_CTA_ATTRIBUTE],
    });
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      mo.disconnect();
      io.disconnect();
      setInView(false);
    };
  }, [enabled]);
  return enabled && inView;
}
