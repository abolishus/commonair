// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The co-op facts the acquisition pages quote (voice guide: "facts the copy reads from config,
 * never from a literal"): the creator share from `platform.cut`, the payout minimum and hold from
 * `payout.rules`, the member share and the streamer class from `membership.classes`, and the
 * protected-vote thresholds from `governance.protections`. Each part is null when its setting is
 * missing or not the shape we know, so a page drops that sentence instead of guessing a number.
 */
import { z } from "zod";

/** The parts of a governance setting this module reads (`coop.settings` rows). */
export interface SettingLike {
  key: string;
  value: unknown;
}

/** The parts of a fee schedule entry this module reads (`coop.feeSchedule` rows). */
export interface FeeEntryLike {
  key: string;
  changedAt: string | null;
}

export interface PayoutFacts {
  minimumCents: number;
  holdDays: number;
  currency: string;
}

export interface MembershipFacts {
  shareCents: number;
  refundableOnExit: boolean;
  /** Null when a subscription does not qualify for membership on this instance. */
  minSubCents: number | null;
  streamerHours: number;
  streamerViewers: number;
  windowDays: number;
}

export interface ProtectionFacts {
  /** Share of all members who must vote yes (0.667). */
  memberWide: number;
  /** Share of streamer members who must vote yes (0.5). */
  streamerClass: number;
}

export interface CoopFacts {
  /** `platform.cut` `streamerShare` (0.9). */
  creatorShare: number | null;
  payout: PayoutFacts | null;
  membership: MembershipFacts | null;
  protections: ProtectionFacts | null;
  /** How many times members changed the cut since the founding value; null without the schedule. */
  cutChanges: number | null;
}

/** The currency shares and payouts are quoted in when `payout.rules` does not say. */
export const FALLBACK_CURRENCY = "usd";

const Share = z.number().min(0).max(1);
const Cents = z.number().int().min(0);
const Count = z.number().int().min(0);

const Cut = z.object({ streamerShare: Share });
const Payout = z.object({ minimumCents: Cents, holdDays: Count, currency: z.string().length(3) });
const Classes = z.object({
  streamer: z.object({ minStreamingHours: z.number().min(0), windowDays: Count, minVerifiedViewers: Count }),
  viewer: z.object({
    shareCents: Cents,
    shareRefundableOnExit: z.boolean(),
    activeSubscriptionQualifies: z.boolean().optional(),
    minSubscriptionCents: Cents.optional(),
  }),
});
const Protections = z.object({ memberWideThreshold: Share, streamerClassThreshold: Share });

function value(settings: readonly SettingLike[] | null, key: string): unknown {
  return settings?.find((s) => s.key === key)?.value;
}

/** Read the facts from `coop.settings` (and, for the change count, `coop.feeSchedule`). */
export function coopFacts(
  settings: readonly SettingLike[] | null,
  feeSchedule: readonly FeeEntryLike[] | null = null,
): CoopFacts {
  const cut = Cut.safeParse(value(settings, "platform.cut"));
  const payout = Payout.safeParse(value(settings, "payout.rules"));
  const classes = Classes.safeParse(value(settings, "membership.classes"));
  const protections = Protections.safeParse(value(settings, "governance.protections"));
  const viewer = classes.success ? classes.data.viewer : null;
  return {
    creatorShare: cut.success ? cut.data.streamerShare : null,
    payout: payout.success
      ? { minimumCents: payout.data.minimumCents, holdDays: payout.data.holdDays, currency: payout.data.currency }
      : null,
    membership:
      classes.success && viewer
        ? {
            shareCents: viewer.shareCents,
            refundableOnExit: viewer.shareRefundableOnExit,
            minSubCents: viewer.activeSubscriptionQualifies === false ? null : (viewer.minSubscriptionCents ?? null),
            streamerHours: classes.data.streamer.minStreamingHours,
            streamerViewers: classes.data.streamer.minVerifiedViewers,
            windowDays: classes.data.streamer.windowDays,
          }
        : null,
    protections: protections.success
      ? {
          memberWide: protections.data.memberWideThreshold,
          streamerClass: protections.data.streamerClassThreshold,
        }
      : null,
    cutChanges: feeSchedule ? feeSchedule.filter((e) => e.key === "platform.cut" && e.changedAt !== null).length : null,
  };
}

/** No facts at all: every sentence that needs one is left out. */
export const NO_FACTS: CoopFacts = {
  creatorShare: null,
  payout: null,
  membership: null,
  protections: null,
  cutChanges: null,
};
