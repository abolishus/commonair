// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample data for the TreasuryCoop board (`/treasury` shares and patronage tabs). Integer cents, USD. */

export const shares = [
  {
    id: "0192d6f4-0000-7000-8000-000000000001",
    user: { id: "0192d6f4-0000-7000-8000-0000000000u1", name: "ohmslaw" },
    status: "refund_pending",
    statusLabel: "Refund due",
    cents: 2_500,
    since: "exited Oct 19",
  },
  {
    id: "0192d6f4-0000-7000-8000-000000000002",
    user: { id: "0192d6f4-0000-7000-8000-0000000000u2", name: "fernpixel" },
    status: "refund_pending",
    statusLabel: "Refund due",
    cents: 2_500,
    since: "exited Oct 20",
  },
  {
    id: "0192d6f4-0000-7000-8000-000000000003",
    user: { id: "0192d6f4-0000-7000-8000-0000000000u3", name: "mira" },
    status: "held",
    statusLabel: "Held",
    cents: 2_500,
    since: "bought Apr 3",
  },
  {
    id: "0192d6f4-0000-7000-8000-000000000004",
    user: { id: "0192d6f4-0000-7000-8000-0000000000u4", name: "quietfox" },
    status: "refunded",
    statusLabel: "Refunded",
    cents: 2_500,
    since: "refunded Sep 30",
  },
];

export const shareFilters = [
  { value: "refund_pending", label: "Refunds due" },
  { value: "pending", label: "Awaiting payment" },
  { value: "held", label: "Held" },
  { value: "refunded", label: "Refunded" },
];

/** The signed-in treasurer (ran the latest period, so cannot approve it). */
export const me = { id: "0192d6f4-0000-7000-8000-0000000000t1", name: "treasurer-ana" };

export const runResult = {
  periodId: "0192d6f3-0000-7000-8000-000000001010",
  members: 1_204,
  totalCents: 3_214_000,
  surplusCents: 3_214_000,
  retainedCents: 0,
};

export const periods = [
  {
    id: "0192d6f3-0000-7000-8000-000000001010",
    period: "Oct 1 – Oct 20, 2026",
    status: "computed",
    statusLabel: "Computed",
    members: 1_204,
    totalCents: 3_214_000,
    computedBy: me,
    approvedBy: null,
  },
  {
    id: "0192d6f3-0000-7000-8000-000000000910",
    period: "Sep 1 – Sep 30, 2026",
    status: "approved",
    statusLabel: "Approved",
    members: 1_180,
    totalCents: 2_980_500,
    computedBy: { id: "0192d6f4-0000-7000-8000-0000000000t2", name: "treasurer-bo" },
    approvedBy: me,
  },
];
