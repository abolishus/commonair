// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { SquareLock01Icon } from "@hugeicons/core-free-icons";
import { cn } from "@commonair/ui/lib/utils";
import type { DataAttributes } from "../../lib/data-attributes.ts";
import { TargetLink, type LinkTarget } from "../../lib/link.tsx";
import { StatusBadge } from "../../primitives/status-badge.tsx";
import { KeyValueList } from "../data/key-value-list.tsx";
import { SettingValue } from "./proposal-changes.tsx";

export interface GovernanceSettingItem {
  key: string;
  description?: React.ReactNode;
  value: unknown;
  protected: boolean;
  /** The proposal that last set it (`data-updated-by`), or null when it is still the seeded value. */
  updatedBy: { proposalId: string; label: React.ReactNode; link: LinkTarget } | null;
  /** When it was last set (`RelativeTime` or formatted text). */
  updatedAt?: React.ReactNode;
}

export interface GovernanceSettingsListProps extends Omit<React.ComponentProps<"ul">, "children"> {
  items: readonly GovernanceSettingItem[];
  labels: {
    protected: string;
    /** "Seeded" (never changed by a proposal). */
    seeded: React.ReactNode;
    /** "Set by" before the proposal link. */
    setBy: React.ReactNode;
  };
  /** Set on every row besides its `data-*` (e.g. `{ "data-testid": "setting-row" }`). */
  itemProps?: DataAttributes;
}

const isFlatRecord = (value: unknown): value is Record<string, string | number | boolean | null> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length > 0 &&
  Object.values(value).every((entry) => entry === null || ["string", "number", "boolean"].includes(typeof entry));

/** The governance settings: key, protected badge, value and the decision that last set it. */
export function GovernanceSettingsList({
  items,
  labels,
  itemProps,
  className,
  ...props
}: GovernanceSettingsListProps): React.JSX.Element {
  return (
    <ul className={cn("flex min-w-0 flex-col gap-3", className)} {...props}>
      {items.map((item) => (
        <li
          {...itemProps}
          key={item.key}
          data-key={item.key}
          data-protected={String(item.protected)}
          data-updated-by={item.updatedBy?.proposalId ?? ""}
          className="flex min-w-0 flex-col gap-2 border p-3"
        >
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <code className="min-w-0 text-xs font-medium wrap-anywhere">{item.key}</code>
            {item.protected ? (
              <StatusBadge tone="warning" icon={SquareLock01Icon}>
                {labels.protected}
              </StatusBadge>
            ) : null}
          </div>
          {item.description ? <p className="text-xs text-muted-foreground">{item.description}</p> : null}
          {isFlatRecord(item.value) ? (
            <KeyValueList
              dense
              className="bg-muted px-2 py-1.5"
              rows={Object.entries(item.value).map(([term, value]) => ({
                term: <code>{term}</code>,
                value: <code>{JSON.stringify(value)}</code>,
              }))}
            />
          ) : (
            <SettingValue value={item.value} />
          )}
          <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
            {item.updatedBy ? (
              <span>
                {labels.setBy}{" "}
                <TargetLink target={item.updatedBy.link} className="underline underline-offset-4">
                  {item.updatedBy.label}
                </TargetLink>
              </span>
            ) : (
              <span>{labels.seeded}</span>
            )}
            {item.updatedAt ? <span>· {item.updatedAt}</span> : null}
          </p>
        </li>
      ))}
    </ul>
  );
}
