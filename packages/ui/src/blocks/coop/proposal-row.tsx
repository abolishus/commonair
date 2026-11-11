// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { cn } from "@commonair/ui/lib/utils";
import { TargetLink, type LinkTarget } from "../../lib/link.tsx";
import { ChannelAvatar } from "../../primitives/channel-avatar.tsx";
import { StatusBadge, type StatusTone } from "../../primitives/status-badge.tsx";
import { ProtectedBadge } from "./setting-change.tsx";

export interface ProposalRowProps extends Omit<React.ComponentProps<"article">, "title" | "children"> {
  title: string;
  /** The proposal page; the whole card is the link (the title's link covers the card). */
  link: LinkTarget;
  /** One line from the body. */
  excerpt?: string;
  author: { name: string; label: React.ReactNode };
  status: string;
  statusTone?: StatusTone;
  /** "Protected" lock (neutral). */
  protectedLabel?: string;
  /** "Affects creators". */
  affectsCreatorsLabel?: string;
  /** "You can vote": the caller is in this vote's electorate and has not voted. */
  canVoteLabel?: string;
  /** The next step with its deadline ("Voting closes in 6 days"). */
  next?: React.ReactNode;
  /** Open votes: a `ThresholdBar` of turnout against quorum. */
  participation?: React.ReactNode;
  /** Decided: the result chip and the rule that decided it. */
  result?: { passed: boolean; label: string; rule?: React.ReactNode };
  headingLevel?: 2 | 3 | 4;
}

/**
 * ProposalCard v2 (overhaul D6.2, coop-trust CT-6): title, a one-line excerpt, the author, tags,
 * the next step with its countdown, participation against quorum while voting, and the result
 * once decided. The card is one link (the title's, stretched over it), so it is one tab stop and
 * a pointer can tap anywhere on it.
 */
export function ProposalRow({
  title,
  link,
  excerpt,
  author,
  status,
  statusTone = "info",
  protectedLabel,
  affectsCreatorsLabel,
  canVoteLabel,
  next,
  participation,
  result,
  headingLevel = 3,
  className,
  ...props
}: ProposalRowProps): React.JSX.Element {
  const Heading = `h${headingLevel}` as const;
  return (
    <article
      data-slot="proposal-row"
      className={cn(
        "relative flex min-w-0 flex-col gap-3 bg-card p-4 text-card-foreground ring-1 ring-foreground/10 transition-colors hover:bg-muted/40 motion-reduce:transition-none sm:px-5",
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <Heading className="text-sm font-medium text-balance wrap-anywhere">
            <TargetLink
              target={link}
              className="after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
            >
              {title}
            </TargetLink>
          </Heading>
          <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <ChannelAvatar name={author.name} size="xs" decorative />
            <span className="wrap-anywhere">{author.label}</span>
          </p>
        </div>
        <StatusBadge tone={statusTone} className="shrink-0">
          {status}
        </StatusBadge>
      </div>
      {excerpt ? <p className="line-clamp-2 text-sm text-muted-foreground wrap-anywhere">{excerpt}</p> : null}
      {protectedLabel || affectsCreatorsLabel || canVoteLabel ? (
        <div className="flex flex-wrap items-center gap-2">
          {protectedLabel ? <ProtectedBadge label={protectedLabel} /> : null}
          {affectsCreatorsLabel ? <StatusBadge tone="neutral">{affectsCreatorsLabel}</StatusBadge> : null}
          {canVoteLabel ? <StatusBadge tone="info">{canVoteLabel}</StatusBadge> : null}
        </div>
      ) : null}
      {participation}
      {result ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
          <StatusBadge
            data-slot="proposal-result"
            tone={result.passed ? "success" : "danger"}
            icon={result.passed ? Tick02Icon : Cancel01Icon}
          >
            {result.label}
          </StatusBadge>
          {result.rule ? <span className="text-muted-foreground">{result.rule}</span> : null}
        </div>
      ) : null}
      {next ? <p className="text-xs text-muted-foreground">{next}</p> : null}
    </article>
  );
}
