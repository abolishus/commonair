// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample data for the Statements board (`/coop/patronage`, `/coop/patronage/$periodId`). Integer cents, USD. */

export const statements = [
  {
    periodId: "0192d6f3-0000-7000-8000-000000000910",
    title: "September 2026",
    description: "Sep 1 – Sep 30 · formula patronage-2026.1",
    status: "approved",
    statusLabel: "Approved",
    cents: 9_640,
  },
  {
    periodId: "0192d6f3-0000-7000-8000-000000000908",
    title: "August 2026",
    description: "Aug 1 – Aug 31 · formula patronage-2026.1",
    status: "distributed",
    statusLabel: "Paid out",
    cents: 7_215,
  },
];

export const statement = {
  periodId: "0192d6f3-0000-7000-8000-000000000910",
  title: "September 2026",
  period: "Sep 1 – Sep 30, 2026 (UTC)",
  status: "approved",
  statusLabel: "Approved",
  formulaVersion: "patronage-2026.1",
  formula: "patronage-2026.1",
  surplusCents: 3_214_000,
  totalCents: 9_640,
  lines: [
    {
      component: "revenue",
      label: "Revenue",
      explanation: "Revenue: $310.00 of $41,288.00 (0.75%) × 50% pool of $16,070.00",
      basis: "$310.00 of $41,288.00",
      pool: "pool $16,070.00",
      share: 0.0075,
      cents: 6_030,
      capApplied: false,
    },
    {
      component: "streamingHours",
      label: "Streaming hours",
      explanation: "Streaming hours: 86 of 21,400 counted hours (0.40%) × 20% pool, at most 12 h per day",
      basis: "86 h of 21,400 h",
      pool: "pool $6,428.00",
      share: 0.004,
      cents: 2_571,
      capApplied: true,
    },
    {
      component: "relayBandwidth",
      label: "Relay bandwidth",
      explanation: "Relay bandwidth: no verified relay receipts this period",
      basis: "0 GB of 412,000 GB",
      pool: "pool $3,214.00",
      share: 0,
      cents: 0,
      capApplied: false,
    },
    {
      component: "viewerHours",
      label: "Viewer hours",
      explanation: "Verified viewer-hours on your channel: 1,830 of 1,250,000 (0.15%) × 20% pool",
      basis: "1,830 h of 1,250,000 h",
      pool: "pool $6,428.00",
      share: 0.00146,
      cents: 1_039,
      capApplied: false,
    },
  ],
  inputs: {
    revenueCents: 31_000,
    hours: 86,
    relayBytes: 0,
    viewerHours: 1_830,
  },
};
