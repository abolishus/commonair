// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample data for the Membership board (`/coop/membership`). Money is integer cents, USD. */
import type { EligibilityItem, MembershipListItem } from "@commonair/ui/blocks/coop";

export const intro =
  "Your classes in the co-op, what each one needs, and your member share. One member, one vote, whichever way you joined.";

export const memberships: Omit<MembershipListItem, "exit">[] = [
  {
    id: "0192d6f0-0000-7000-8000-000000000001",
    memberClass: "streamer",
    classLabel: "Streamer member",
    status: "active",
    statusLabel: "Active",
    basis: "streaming_hours",
    basisLabel: "By streaming hours",
    since: "since Mar 2026",
  },
  {
    id: "0192d6f0-0000-7000-8000-000000000002",
    memberClass: "viewer",
    classLabel: "Viewer member",
    status: "active",
    statusLabel: "Active",
    basis: "share",
    basisLabel: "By member share",
    since: "since Apr 2026",
  },
  {
    id: "0192d6f0-0000-7000-8000-000000000003",
    memberClass: "viewer",
    classLabel: "Viewer member",
    status: "exited",
    statusLabel: "Left",
    basis: "subscription",
    basisLabel: "By subscription",
    since: "Jan – Mar 2026",
  },
];

export const exitCopy: Record<string, { title: string; description: string }> = {
  streamer: {
    title: "Leave the streamer class?",
    description:
      "You stop voting as a streamer from the next proposal. Votes already open keep you in their electorate. Streaming again does not re-join you for 30 days.",
  },
  viewer: {
    title: "Leave the viewer class?",
    description: "Your $25.00 member share will be refunded. The treasury sends it within 30 days.",
  },
};

export const eligibility: EligibilityItem[] = [
  {
    memberClass: "streamer",
    classLabel: "Streamer",
    eligible: true,
    statusLabel: "Eligible",
    basis: "streaming_hours",
    basisLabel: "By streaming hours",
    progress: {
      label: "Streaming hours, last 30 days",
      have: 26.5,
      need: 20,
      unit: "hours",
      valueText: "26.5 of 20 h",
    },
    detail: "Counted from streams with at least one verified viewer.",
  },
  {
    memberClass: "viewer",
    classLabel: "Viewer",
    eligible: true,
    statusLabel: "Eligible",
    basis: "share",
    basisLabel: "By member share",
    progress: { label: "Member share paid", have: 2500, need: 2500, unit: "cents", valueText: "$25.00 of $25.00" },
    detail: "Or keep an active subscription to any channel.",
  },
  {
    memberClass: "worker",
    classLabel: "Worker",
    eligible: false,
    statusLabel: "By appointment",
    basis: null,
    progress: null,
    detail: "Worker members are appointed by a board decision.",
  },
];

export const notEligible: EligibilityItem[] = [
  {
    memberClass: "streamer",
    classLabel: "Streamer",
    eligible: false,
    statusLabel: "Not yet",
    basis: null,
    progress: {
      label: "Streaming hours, last 30 days",
      have: 4.25,
      need: 20,
      unit: "hours",
      valueText: "4.25 of 20 h",
    },
    detail: "Stream 15.75 more hours with a verified viewer to qualify.",
  },
  {
    memberClass: "viewer",
    classLabel: "Viewer",
    eligible: false,
    statusLabel: "Not yet",
    basis: null,
    progress: { label: "Member share paid", have: 0, need: 2500, unit: "cents", valueText: "$0.00 of $25.00" },
    detail: "Buy the refundable member share, or subscribe to any channel.",
  },
  {
    memberClass: "worker",
    classLabel: "Worker",
    eligible: false,
    statusLabel: "By appointment",
    basis: null,
    progress: null,
    detail: "Worker members are appointed by a board decision.",
  },
];

export const share = {
  cents: 2500,
  reference: "CA-7K2M9QXP",
  paymentId: "0192d6f0-0000-7000-8000-0000000000aa",
  instructions:
    "Send a bank transfer to CommonAir Cooperative, IBAN DE00 0000 0000 0000 0000 00. Put the reference in the payment note so the treasury can match it. Unpaid requests expire after 14 days.",
};
