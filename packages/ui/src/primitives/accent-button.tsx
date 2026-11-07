// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { Button } from "../components/button.tsx";
import { cn } from "../lib/utils.ts";
import type { Accent } from "./channel-avatar.tsx";

/**
 * Channel-accent tone on top of the `default` Button. Hover moves the surface
 * away from its foreground (`bg-channel-accent-hover`), so contrast only grows;
 * the focus ring is Button's full-opacity `ring-ring` at a 2px offset (3:1 on
 * every surface, never drawn on the accent itself). Labels are 14 px / 600, the
 * size at which the darker dark-theme accents (indigo, red, violet) read well.
 * On creator pages this is the one filled call to action, never `variant="brand"`.
 */
export const accentButtonClasses =
  "bg-channel-accent text-sm font-semibold text-channel-accent-foreground hover:bg-channel-accent-hover aria-expanded:bg-channel-accent-hover";

export interface AccentButtonProps extends Omit<React.ComponentProps<typeof Button>, "variant"> {
  /** Sets `data-accent` on the button itself; omit to inherit the surrounding channel's accent. */
  accent?: Accent | null;
}

/** Follow / Subscribe / Support: the channel's call to action, in the channel's accent. */
export function AccentButton({ accent, className, ...props }: AccentButtonProps): React.JSX.Element {
  return (
    <Button
      variant="default"
      data-accent={accent ?? undefined}
      className={cn(accentButtonClasses, className)}
      {...props}
    />
  );
}
