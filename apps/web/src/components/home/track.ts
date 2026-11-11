// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Counting home's surfaces (D2.8): a view once the surface is on screen after hydration, and the
 * clicks the caller wires. `trackUi` itself drops everything when the browser asks not to be
 * tracked, and counts a view once per page load.
 */
import * as React from "react";
import { trackUi, type UiAction, type UiStep, type UiSurface } from "../../lib/ui-metrics.ts";

/** Counts one view of `surface` (with `step`) when the component mounts in the browser. */
export function useTrackView(surface: UiSurface, step: UiStep = "none", enabled = true): void {
  React.useEffect(() => {
    if (enabled) trackUi(surface, "view", step);
  }, [surface, step, enabled]);
}

/** A click handler that counts `action` on `surface`; the click itself goes on as usual. */
export function track(surface: UiSurface, action: UiAction, step: UiStep = "none"): () => void {
  return () => trackUi(surface, action, step);
}
