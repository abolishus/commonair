// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Button } from "@commonair/ui/components/button";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@commonair/ui/components/item";
import { StatusBadge, type StatusTone } from "../../primitives/status-badge.tsx";
import { SwitchField } from "./switch-field.tsx";

export interface ActionRowAction {
  label: string;
  onAction: () => void;
  variant?: React.ComponentProps<typeof Button>["variant"];
  "data-testid"?: string;
}
export interface ActionRowProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  media?: React.ReactNode;
  status?: { label: string; tone?: StatusTone };
  actions?: readonly ActionRowAction[];
  tone?: "default" | "destructive";
  trailingSwitch?: {
    label: string;
    checked?: boolean;
    onCheckedChange?: (value: boolean) => void;
    "data-testid"?: string;
  };
  "data-testid"?: string;
}
export function ActionRow({
  title,
  description,
  icon,
  media,
  status,
  actions,
  tone = "default",
  trailingSwitch,
  ...props
}: ActionRowProps): React.JSX.Element {
  return (
    <Item variant="outline" data-tone={tone} data-testid={props["data-testid"]}>
      <ItemMedia variant={media ? "image" : "icon"}>{media ?? icon}</ItemMedia>
      <ItemContent>
        <ItemTitle>
          {title}
          {status && <StatusBadge tone={status.tone}>{status.label}</StatusBadge>}
        </ItemTitle>
        {description && <ItemDescription>{description}</ItemDescription>}
      </ItemContent>
      <ItemActions>
        {actions?.map((action) => (
          <Button
            key={action.label}
            type="button"
            variant={action.variant ?? (tone === "destructive" ? "destructive" : "outline")}
            onClick={action.onAction}
            data-testid={action["data-testid"]}
          >
            {action.label}
          </Button>
        ))}
        {trailingSwitch && <SwitchField {...trailingSwitch} label={trailingSwitch.label} />}
      </ItemActions>
    </Item>
  );
}
