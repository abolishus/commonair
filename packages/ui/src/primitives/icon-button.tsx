// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Button } from "../components/button.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip.tsx";

type ButtonProps = React.ComponentProps<typeof Button>;

export interface IconButtonProps extends Omit<ButtonProps, "children" | "size" | "aria-label"> {
  /** Required: the accessible name, also shown as the tooltip. */
  label: string;
  /** A Hugeicons icon, or `children` for a custom glyph. */
  icon?: IconSvgElement;
  children?: React.ReactNode;
  /** Tooltip text when it should differ from the label (e.g. include a shortcut). */
  tooltip?: React.ReactNode;
  tooltipSide?: React.ComponentProps<typeof TooltipContent>["side"];
  size?: "icon" | "icon-xs" | "icon-sm" | "icon-lg";
}

/** Icon-only control: always labelled (`aria-label`) and always explained by a Tooltip, never `title=`. */
export function IconButton({
  label,
  icon,
  children,
  tooltip,
  tooltipSide = "top",
  size = "icon",
  variant = "ghost",
  ...props
}: IconButtonProps): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button aria-label={label} size={size} variant={variant} {...props}>
            {icon ? <HugeiconsIcon icon={icon} strokeWidth={2} aria-hidden /> : children}
          </Button>
        }
      />
      <TooltipContent side={tooltipSide}>{tooltip ?? label}</TooltipContent>
    </Tooltip>
  );
}
