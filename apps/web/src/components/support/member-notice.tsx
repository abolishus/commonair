// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Support dialog's co-op line (overhaul wave 2, D2.6): "a {minSub}+ monthly sub also makes you
 * a co-op member", read from `membership.classes` (never a literal: the co-op votes on it). Shown
 * on the Subscribe tab only (a gift makes nobody a member, a tip neither), never to the channel's
 * owner, and not at all when the co-op does not count subscriptions or its rule did not load. Nor
 * is it shown when the claim is untrue for the caller: already a viewer member, or a viewer member
 * who left (a voluntary exit is respected: no sub re-enrols them, the same rule as `coopOutcome`).
 */
import { formatMoney, useLocale } from "@commonair/ui";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { z } from "zod";
import { t } from "../../i18n/index.ts";
import type { MembershipViewDto, SettingDto } from "../../lib/coop.ts";
import { trackUi } from "../../lib/ui-metrics.ts";

/** The part of `membership.classes` a sub needs (the governance defaults when a field is missing). */
const SubRule = z.object({
  viewer: z.object({
    activeSubscriptionQualifies: z.boolean(),
    minSubscriptionCents: z.number().int().min(0).default(300),
  }),
});

export interface SubMemberRule {
  /** Whether a qualifying subscription makes its payer a viewer member at all. */
  qualifies: boolean;
  minSubscriptionCents: number;
}

/** `membership.classes` → the sub rule; null when it is missing or unreadable (pure). */
export function subMemberRule(settings: readonly Pick<SettingDto, "key" | "value">[] | null): SubMemberRule | null {
  const parsed = SubRule.safeParse(settings?.find((s) => s.key === "membership.classes")?.value);
  if (!parsed.success) return null;
  return {
    qualifies: parsed.data.viewer.activeSubscriptionQualifies,
    minSubscriptionCents: parsed.data.viewer.minSubscriptionCents,
  };
}

/**
 * `rule` for this caller (pure): null when a sub would not make them a member whatever its price,
 * because a viewer membership is active or their latest viewer membership ended in an exit. An
 * unreadable membership (`view` null) is null too: the line is a promise, so it needs the facts.
 */
export function subMemberRuleFor(
  rule: SubMemberRule | null,
  view: Pick<MembershipViewDto, "memberships"> | null,
): SubMemberRule | null {
  if (!rule || !view) return null;
  const viewer = view.memberships
    .filter((m) => m.class === "viewer")
    .toSorted((a, b) => Date.parse(b.joinedAt) - Date.parse(a.joinedAt));
  if (viewer.some((m) => m.status === "active")) return null;
  if (viewer[0]?.status === "exited") return null;
  return rule;
}

/** Whether a self sub at `cents` makes its payer a member under `rule` (pure; gifts never do). */
export function subMakesMember(rule: SubMemberRule | null, cents: number): boolean {
  return rule !== null && rule.qualifies && cents >= rule.minSubscriptionCents;
}

export interface SubMemberNoticeProps {
  rule: SubMemberRule | null;
  currency: string;
  /** The selected tier's price, for `data-qualifies`. */
  cents: number;
  /** Tiers on offer: no tier at or above the minimum, no line. */
  tierCents: readonly number[];
}

export function SubMemberNotice({ rule, currency, cents, tierCents }: SubMemberNoticeProps): React.JSX.Element | null {
  const { locale } = useLocale();
  const shown = rule !== null && rule.qualifies && tierCents.some((c) => c >= rule.minSubscriptionCents);
  React.useEffect(() => {
    if (shown) trackUi("support.subMemberNotice", "view");
  }, [shown]);
  if (!shown) return null;
  return (
    <p
      data-testid="support-member-notice"
      data-qualifies={subMakesMember(rule, cents) ? "true" : "false"}
      className="text-sm text-muted-foreground"
    >
      {t("d2Membership.support.memberNotice", {
        minSub: formatMoney(rule.minSubscriptionCents, currency, locale),
      })}{" "}
      <Link
        to="/coop/membership"
        className="underline underline-offset-4"
        onClick={() => trackUi("support.subMemberNotice", "click")}
      >
        {t("d2Membership.support.memberLink")}
      </Link>
    </p>
  );
}
