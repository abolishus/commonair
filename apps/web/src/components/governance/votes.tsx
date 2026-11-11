// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { RelativeTime, formatNumber, useLocale } from "@commonair/ui";
import { ThresholdBar } from "@commonair/ui/blocks/coop";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import type { ProposalDto } from "../../lib/coop.ts";
import { percentText } from "../../lib/coop-settings-format.ts";
import { nextStep, resultBars, turnout, type ResultBar, type VoteRule } from "./model.ts";
import { rich } from "./rich.tsx";

/** "Voting closes in 6 days": the proposal's next step and its deadline, ticking. */
export function NextStepText({
  proposal,
  now,
}: {
  proposal: Pick<ProposalDto, "status" | "timeline">;
  now: number;
}): React.JSX.Element {
  const step = nextStep(proposal, now);
  // The live clock (NowProvider on the server); `now` only decides the step.
  const when = (iso: string) => <RelativeTime date={iso} />;
  switch (step.kind) {
    case "draft":
      return <>{t("d6Governance.next.draft")}</>;
    case "discussionEnds":
      return step.at ? (
        <>{rich((v) => t("d6Governance.next.discussionEnds", v), { when: when(step.at) })}</>
      ) : (
        <>{t("d6Governance.next.discussion")}</>
      );
    case "councilResponds":
      return step.at ? (
        <>{rich((v) => t("d6Governance.next.councilResponds", v), { when: when(step.at) })}</>
      ) : (
        <>{t("d6Governance.next.councilReview")}</>
      );
    case "votingCloses":
      return step.at ? (
        <>{rich((v) => t("d6Governance.next.votingCloses", v), { when: when(step.at) })}</>
      ) : (
        <>{t("d6Governance.next.voting")}</>
      );
    case "counting":
      return <>{t("d6Governance.next.counting")}</>;
    case "applying":
      return <>{t("d6Governance.next.applying")}</>;
    case "applied":
      return step.at ? (
        <>{rich((v) => t("d6Governance.next.applied", v), { when: when(step.at) })}</>
      ) : (
        <>{t("d6Governance.next.appliedNoDate")}</>
      );
    case "rejected":
      return step.at ? (
        <>{rich((v) => t("d6Governance.next.rejected", v), { when: when(step.at) })}</>
      ) : (
        <>{t("d6Governance.next.rejectedNoDate")}</>
      );
    case "withdrawn":
      return <>{t("d6Governance.next.withdrawn")}</>;
  }
}

/** Turnout so far against the quorum (open votes: counts only, never a running tally). */
export function ParticipationBar({
  participation,
  rule,
  ...props
}: {
  participation: NonNullable<ProposalDto["participation"]>;
  rule: VoteRule | null;
} & { [key: `data-${string}`]: string | undefined }): React.JSX.Element {
  const { locale } = useLocale();
  const value = turnout(participation.voted, participation.eligible);
  const reached = rule !== null && participation.eligible > 0 && value >= rule.quorum;
  return (
    <ThresholdBar
      {...props}
      label={t("d6Governance.vote.turnout")}
      value={value}
      threshold={rule?.quorum ?? null}
      valueText={t("d6Governance.vote.turnoutValue", {
        percent: percentText(value, locale),
        voted: formatNumber(participation.voted, locale),
        eligible: formatNumber(participation.eligible, locale),
      })}
      thresholdText={
        rule
          ? reached
            ? t("d6Governance.vote.quorumReached", { percent: percentText(rule.quorum, locale) })
            : t("d6Governance.vote.quorumNeeded", { percent: percentText(rule.quorum, locale) })
          : undefined
      }
    />
  );
}

function barLabel(bar: ResultBar): string {
  switch (bar.rule) {
    case "member_wide_quorum":
      return t("d6Governance.result.turnoutAll");
    case "member_wide_threshold":
      return t("d6Governance.result.yesAll");
    case "streamer_class_quorum":
      return t("d6Governance.result.turnoutStreamers");
    default:
      return t("d6Governance.result.yesStreamers");
  }
}

/** "64% yes of 50% needed": the rule a decided proposal was measured by, in words. */
export function resultRuleText(bar: ResultBar, locale: string): string {
  const value = percentText(bar.value, locale);
  if (bar.threshold === null)
    return bar.measure === "turnout"
      ? t("d6Governance.result.turnoutOnly", { value })
      : t("d6Governance.result.yesOnly", { value });
  const needed = percentText(bar.threshold, locale);
  if (bar.measure === "turnout") return t("d6Governance.result.turnoutRule", { value, needed });
  return bar.strict
    ? t("d6Governance.result.yesRuleStrict", { value, needed })
    : t("d6Governance.result.yesRule", { value, needed });
}

/** The decided result as bars with threshold ticks; each bar says its numbers and whether it was met. */
export function ResultBars({
  tally,
  rule,
}: {
  tally: NonNullable<ProposalDto["tally"]>;
  rule: VoteRule | null;
}): React.JSX.Element | null {
  const { locale } = useLocale();
  const bars = resultBars(tally, rule);
  if (bars.length === 0) return null;
  return (
    <div data-testid="vote-result-bars" className="flex min-w-0 flex-col gap-4">
      {bars.map((bar) => (
        <ThresholdBar
          key={bar.rule}
          data-testid="vote-result-bar"
          data-rule={bar.rule}
          data-passed={String(bar.passed)}
          label={barLabel(bar)}
          value={bar.value}
          threshold={bar.threshold}
          tone={bar.passed ? "success" : "danger"}
          valueText={t("d6Governance.result.value", {
            percent: percentText(bar.value, locale),
            count: formatNumber(bar.numerator, locale),
            of: formatNumber(bar.denominator, locale),
          })}
          thresholdText={
            bar.threshold === null
              ? bar.passed
                ? t("coop.tally.checkPassed")
                : t("coop.tally.checkFailed")
              : t(bar.passed ? "d6Governance.result.met" : "d6Governance.result.notMet", {
                  needed: percentText(bar.threshold, locale),
                })
          }
        />
      ))}
    </div>
  );
}
