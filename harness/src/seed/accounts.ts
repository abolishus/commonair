// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The full seed's fixed logins: one per role a tester needs, same handles at every scale. All are
 * `demo_<handle>@demo-seed.invalid` (both demo anchors) and share one password. seed-social creates
 * them; the other units give each the data its role needs (the `purpose` column is their brief).
 * Generated bulk accounts are `demo_s<n>` (streamers) and `demo_v<n>` (viewers).
 */
import type { PLATFORM_ROLES } from "@commonair/contracts/enums";

export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export interface FixedAccount {
  handle: string;
  displayName: string;
  platformRole: PlatformRole;
  /** Streams and owns a channel. */
  streamer: boolean;
  /** Bot account (owned by `botOwner`). */
  bot?: boolean;
  purpose: string;
}

export const FIXED_ACCOUNTS: readonly FixedAccount[] = [
  {
    handle: "admin",
    displayName: "Ada Admin",
    platformRole: "admin",
    streamer: false,
    purpose: "every /admin queue has items; sees integrity, egress, incidents, legal, apps",
  },
  {
    handle: "treasurer",
    displayName: "Tess Treasurer",
    platformRole: "treasurer",
    streamer: false,
    purpose: "/treasury: pending payouts, held payees, fraud flags to release, costs, reconciliation",
  },
  {
    handle: "legal",
    displayName: "Lex Legal",
    platformRole: "legal",
    streamer: false,
    purpose: "T0 cases and evidence, NCMEC report drafts, legal holds, DMCA",
  },
  {
    handle: "mod",
    displayName: "Moe Moderator",
    platformRole: "moderator",
    streamer: false,
    purpose: "platform moderation queue, appeals to decide",
  },
  {
    handle: "streamer1",
    displayName: "Aurora Pixel",
    platformRole: "user",
    streamer: true,
    purpose: "the full studio: every panel, bot, overlays, relays, revenue, payouts, Discord, developer apps",
  },
  {
    handle: "streamer2",
    displayName: "Lumen Beats",
    platformRole: "user",
    streamer: true,
    purpose: "a mid-size channel: subs and tips, polls, raids received, a held payout",
  },
  {
    handle: "streamer3",
    displayName: "Cedar Codes",
    platformRole: "user",
    streamer: true,
    purpose: "a new channel: first broadcast, few followers, onboarding states",
  },
  {
    handle: "chanmod",
    displayName: "Moss Lantern",
    platformRole: "user",
    streamer: false,
    purpose: "channel moderator and VIP on streamer1, editor on streamer2",
  },
  {
    handle: "viewer1",
    displayName: "Quill & Ink",
    platformRole: "user",
    streamer: false,
    purpose: "a heavy viewer: follows, subs, tips, points, inbox, push, connected apps, data export",
  },
  {
    handle: "viewer2",
    displayName: "Nova Tide",
    platformRole: "user",
    streamer: false,
    purpose: "a viewer with a timeout, a report filed, an appeal pending, a copyright notice",
  },
  {
    handle: "banned",
    displayName: "Rogue Pebble",
    platformRole: "user",
    streamer: false,
    purpose: "platform-suspended account with an enforcement statement and an appeal",
  },
  {
    handle: "member1",
    displayName: "Bramble Fox",
    platformRole: "user",
    streamer: false,
    purpose: "co-op member: shares, votes cast, a proposal drafted, patronage allocation",
  },
  {
    handle: "council1",
    displayName: "Sly Kettle",
    platformRole: "user",
    streamer: true,
    purpose: "creator council member: council responses, an election candidacy",
  },
  {
    handle: "council2",
    displayName: "Fern Ledger",
    platformRole: "user",
    streamer: true,
    purpose: "creator council member (second, for quorum and tallies)",
  },
  {
    handle: "developer",
    displayName: "Dev Null",
    platformRole: "user",
    streamer: false,
    purpose: "OAuth apps, EventSub subscriptions, webhook deliveries, a bot app",
  },
  {
    handle: "newbie",
    displayName: "Pip Newcomer",
    platformRole: "user",
    streamer: false,
    purpose: "a fresh account: every empty state stays visible for comparison",
  },
  {
    handle: "bot1",
    displayName: "Pixel Helper",
    platformRole: "user",
    streamer: false,
    bot: true,
    purpose: "streamer1's chat bot",
  },
];

/** Owner of the bot accounts (by handle). */
export const BOT_OWNER = "streamer1";

export const bulkStreamerHandle = (n: number): string => `s${String(n).padStart(4, "0")}`;
export const bulkViewerHandle = (n: number): string => `v${String(n).padStart(5, "0")}`;
