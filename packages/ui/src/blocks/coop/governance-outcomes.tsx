// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@commonair/ui/components/item";
import { cn } from "@commonair/ui/lib/utils";
import type { DataAttributes } from "../../lib/data-attributes.ts";
import { TargetLink, type LinkTarget } from "../../lib/link.tsx";
import { StatusBadge } from "../../primitives/status-badge.tsx";
import { ProtectedBadge } from "./setting-change.tsx";

/**
 * A row's one link, stretched over the row (overhaul D6.3: governance lists are rows you tap): the
 * focus ring is drawn on the stretched area so the whole row shows it.
 */
export const STRETCHED =
  "min-w-0 wrap-anywhere after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring";

export interface GovernanceOutcomeItem {
  proposalId: string;
  title: React.ReactNode;
  link: LinkTarget;
  /** `PROPOSAL_STATUSES` value; set as `data-status`. */
  status: string;
  /** `PROPOSAL_KINDS` value; set as `data-kind`. */
  kind: string;
  /** Shown as a lock badge on protected decisions. */
  protectedLabel?: string;
  /** From the tally; null when not decided by a tally (withdrawn). Set as `data-passed` ("" when null). */
  passed: boolean | null;
  /** "Passed" / "Rejected" / "Withdrawn". */
  outcomeLabel: string;
  /** The tally's reason, translated ("Streamer-class majority not met"). */
  reason?: React.ReactNode;
  /** `YYYY-MM`; set as `data-month`. */
  month: string;
  /** When it was decided (`RelativeTime` or formatted text). */
  decidedAt?: React.ReactNode;
}

export interface GovernanceOutcomeListProps extends Omit<React.ComponentProps<"div">, "children"> {
  items: readonly GovernanceOutcomeItem[];
  /** Accessible name of the list. */
  label: string;
  empty?: React.ReactNode;
  /** Set on every item besides its `data-*` (e.g. `{ "data-testid": "transparency-governance" }`). */
  itemProps?: DataAttributes;
}

/** Proposals decided in a period, with their outcome, kind and reason (transparency, co-op overview); each row is one link. */
export function GovernanceOutcomeList({
  items,
  label,
  empty,
  itemProps,
  className,
  ...props
}: GovernanceOutcomeListProps): React.JSX.Element {
  if (items.length === 0 && empty) return <>{empty}</>;
  return (
    <ItemGroup aria-label={label} className={cn("gap-2", className)} {...props}>
      {items.map((item) => (
        <Item
          {...itemProps}
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- ItemGroup is a `div role="list"`, and an `li` needs a `ul` parent.
          role="listitem"
          key={item.proposalId}
          variant="outline"
          size="sm"
          data-proposal-id={item.proposalId}
          data-status={item.status}
          data-kind={item.kind}
          data-passed={item.passed === null ? "" : String(item.passed)}
          data-month={item.month}
          className="relative transition-colors hover:bg-muted/40 motion-reduce:transition-none"
        >
          <ItemContent className="min-w-0">
            <ItemTitle className="flex-wrap">
              <TargetLink target={item.link} className={STRETCHED}>
                {item.title}
              </TargetLink>
              {item.kind === "protected" && item.protectedLabel ? <ProtectedBadge label={item.protectedLabel} /> : null}
            </ItemTitle>
            {item.reason || item.decidedAt ? (
              <ItemDescription>
                {item.reason}
                {item.reason && item.decidedAt ? " · " : null}
                {item.decidedAt}
              </ItemDescription>
            ) : null}
          </ItemContent>
          <ItemActions>
            <StatusBadge
              tone={item.passed === null ? "neutral" : item.passed ? "success" : "danger"}
              icon={item.passed === null ? undefined : item.passed ? Tick02Icon : Cancel01Icon}
            >
              {item.outcomeLabel}
            </StatusBadge>
          </ItemActions>
        </Item>
      ))}
    </ItemGroup>
  );
}
