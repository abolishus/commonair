// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Fixture English labels and sample data for the E6 compositions (simulcast, alerts, overlay
 * URL, content, privacy). apps/web passes `t()` strings in the same shapes.
 */
import type * as React from "react";
import type { AlertConfigDraft, AlertConfigLabels, AlertVariable } from "../src/blocks/studio/alert-config.tsx";
import type { ClipRowData, ContentBoardLabels, VodRowData } from "../src/blocks/studio/content-board.tsx";
import type { OverlayTokenLabels } from "../src/blocks/studio/overlay-token.tsx";
import type { SimulcastPanelLabels, SimulcastTargetRow } from "../src/blocks/studio/simulcast-panel.tsx";
import type { DeletionPanelLabels } from "../src/blocks/privacy/deletion-panel.tsx";
import type { ExportPanelLabels, ExportRowData } from "../src/blocks/privacy/export-panel.tsx";
import type { OverlayAlertItem } from "../src/blocks/overlay/alert-queue.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Story dates are relative to load time so "in 6 days" stays true. */
const at = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

export const simulcastLabels: SimulcastPanelLabels = {
  title: "Simulcast",
  description: "Restream to other platforms from our servers, so your upload stays the same.",
  listLabel: "Simulcast targets",
  emptyTitle: "No simulcast targets yet",
  emptyDescription: "Add a target below and it goes live with you.",
  addTitle: "Add a target",
  name: "Name",
  platform: "Platform",
  url: "Server URL",
  urlPlaceholder: "rtmps://",
  urlHint: "An rtmp:// or rtmps:// ingest address from the other platform.",
  key: "Stream key",
  keyHint: "Write-only: it is never shown again.",
  add: "Add target",
  limitReached: "You have 5 targets, the most a channel can have. Remove one to add another.",
  enabled: (name) => `Send to ${name}`,
  lastError: (code) => (
    <>
      Last error: <code>{code}</code>
    </>
  ),
  remove: (name) => `Remove ${name}`,
  removeTitle: (name) => `Remove ${name}?`,
  removeDescription: "The stream key is deleted with it. You can add the target again later.",
  removeConfirm: "Remove target",
};

export const simulcastPlatforms = [
  { value: "twitch", label: "Twitch" },
  { value: "youtube", label: "YouTube" },
  { value: "custom", label: "Custom RTMP" },
];

export const simulcastTargets: SimulcastTargetRow[] = [
  {
    id: "t1",
    name: "PeerTube",
    platform: "custom",
    platformLabel: "Custom RTMP",
    rtmpUrl: "rtmps://tube.example/live",
    enabled: true,
    status: "live",
    statusLabel: "Live",
    lastError: null,
  },
  {
    id: "t2",
    name: "Backup channel",
    platform: "youtube",
    platformLabel: "YouTube",
    rtmpUrl: "rtmp://a.example/live2",
    enabled: false,
    status: "error",
    statusLabel: "Error",
    lastError: "connect_refused",
  },
];

export const alertVariables: Record<string, readonly AlertVariable[]> = {
  tip: ["user", "amount", "message"],
  follow: ["user"],
  subscription: ["user", "tier", "message"],
  raid: ["user", "viewers"],
};

export const alertLabels: AlertConfigLabels = {
  enabled: "Show this alert",
  on: "On",
  off: "Off",
  message: "Message",
  variables: "Insert:",
  messageError: "Write a message of up to 200 characters.",
  showMessage: "Show the supporter's message",
  minAmount: "Minimum amount",
  minAmountHint: "Smaller tips do not trigger the alert.",
  minAmountError: "Enter an amount of zero or more.",
  durationSeconds: "Duration (seconds)",
  durationError: "Between 1 and 30 seconds.",
  animation: "Animation",
  animations: [
    { value: "fade", label: "Fade" },
    { value: "slide", label: "Slide up" },
    { value: "none", label: "None" },
  ],
  save: "Save",
  test: "Send test alert",
};

export const alertTitles: Record<string, string> = {
  tip: "Tip alert",
  follow: "Follow alert",
  subscription: "Subscription alert",
  raid: "Raid alert",
};

export const alertConfigs: Record<string, AlertConfigDraft> = {
  tip: {
    enabled: true,
    message: "${user} tipped ${amount}",
    showMessage: true,
    minAmountCents: 100,
    durationMs: 6000,
    animation: "fade",
  },
  follow: {
    enabled: false,
    message: "${user} followed",
    showMessage: false,
    minAmountCents: 0,
    durationMs: 6000,
    animation: "slide",
  },
  subscription: {
    enabled: true,
    message: "${user} subscribed",
    showMessage: true,
    minAmountCents: 0,
    durationMs: 8000,
    animation: "fade",
  },
  raid: {
    enabled: false,
    message: "${user} is raiding with ${viewers}",
    showMessage: false,
    minAmountCents: 0,
    durationMs: 6000,
    animation: "fade",
  },
};

export const alertPreviewValues = {
  user: "Fernsby",
  amount: "$5.00",
  tier: "Tier 1",
  viewers: "42",
  message: "that glaze!!",
};

export const overlayTokenLabels: OverlayTokenLabels = {
  title: "Overlay URL",
  description: "Add it to OBS as a browser source. Anyone with the link sees your alerts.",
  active: "Active",
  inactive: "No URL",
  created: (time) => <>Created {time}</>,
  expires: (time) => <>Expires {time}</>,
  noExpiry: "Never expires",
  expiry: "Expires",
  expiryOptions: {
    none: "Never",
    "1d": "In 1 day",
    "7d": "In 7 days",
    "30d": "In 30 days",
    "90d": "In 90 days",
    "6mo": "In 6 months",
    date: "On a date…",
  },
  expiryDate: "Expiry date and time",
  expiryDateInvalid: "Enter a date and time.",
  expiryDatePast: "Pick a time in the future.",
  create: "Create URL",
  rotate: "Create new URL",
  rotateTitle: "Replace the overlay URL?",
  rotateDescription: "The current URL stops working at once. Paste the new one into OBS.",
  url: "Alerts URL",
  urlHint: "Shown once. Copy it now; you can always create a new one.",
  copy: "Copy",
  copied: "Overlay URL copied",
  copyFailed: "Could not copy the overlay URL",
  revoke: "Revoke",
  revokeTitle: "Revoke the overlay URL?",
  revokeDescription: "Alerts stop showing in OBS until you create a new URL.",
};

export const overlayUrl = "https://example.org/overlay/alerts?token=sample-overlay-token-not-real";

export const overlayStatus = { active: true, createdAt: at(-2 * DAY), expiresAt: at(5 * DAY) };

export const contentLabels: ContentBoardLabels = {
  vods: "Past broadcasts",
  clips: "Clips",
  vodsEmptyTitle: "No past broadcasts",
  vodsEmptyDescription: "Turn on recording and your streams show up here.",
  clipsEmptyTitle: "No clips yet",
  clipsEmptyDescription: "Clips you or your viewers make show up here.",
  vodsListLabel: "Past broadcasts",
  clipsListLabel: "Clips",
  title: "Title",
  titleError: "Write a title.",
  visibility: "Visibility",
  visibilities: [
    { value: "public", label: "Public" },
    { value: "subscribers", label: "Subscribers" },
    { value: "private", label: "Only me" },
  ],
  save: "Save",
  deleteVod: (title) => `Delete ${title}`,
  deleteVodTitle: (title) => `Delete “${title}”?`,
  deleteVodDescription: "The video and every clip of this broadcast are removed for good.",
  deleteClip: (title) => `Delete ${title}`,
  deleteClipTitle: (title) => `Delete “${title}”?`,
  deleteClipDescription: "The clip is removed for good.",
  deleteConfirm: "Delete",
  clippedBy: (name) => `Clipped by ${name}`,
};

export const vods: VodRowData[] = [
  {
    id: "v1",
    title: "Throwing a 12-piece dinner set, live",
    visibility: "public",
    status: "ready",
    statusLabel: "Ready",
    durationSeconds: 3 * 3600 + 14 * 60 + 9,
    createdAt: at(-DAY),
  },
  {
    id: "v2",
    title: "Glaze tests and Q&A",
    visibility: "subscribers",
    status: "processing",
    statusLabel: "Processing",
    durationSeconds: 5400,
    createdAt: at(-2 * HOUR),
  },
];

export const clips: ClipRowData[] = [
  {
    id: "c1",
    title: "The handle comes off",
    status: "ready",
    statusLabel: "Ready",
    durationSeconds: 28,
    createdAt: at(-5 * HOUR),
    creatorName: "Fernsby",
    viewsLabel: "1.2K views",
  },
];

export const exportLabels: ExportPanelLabels = {
  title: "Export your data",
  description: "A zip of JSON files with everything we hold about you. The link works for 7 days.",
  request: "Request export",
  cooldown: (time) => <>One export a day: available again {time}</>,
  listLabel: "Your exports",
  emptyTitle: "No exports yet",
  emptyDescription: "We email you a link when an export is ready.",
  requested: (time) => <>Requested {time}</>,
  expires: (time) => <>link expires {time}</>,
  download: "Download",
};

export const exportKinds = (
  cooldownUntil: string | null,
): { kind: string; label: React.ReactNode; description: React.ReactNode; cooldownUntil: string | null }[] => [
  {
    kind: "account",
    label: "Account data",
    description: "Profile, sessions, follows, payments, chat, co-op and safety records.",
    cooldownUntil,
  },
  {
    kind: "channel",
    label: "Channel data",
    description: "Settings, VOD and clip lists, revenue and payouts.",
    cooldownUntil: null,
  },
];

export const exportRows: ExportRowData[] = [
  {
    id: "e1",
    kind: "account",
    kindLabel: "Account data",
    status: "ready",
    statusLabel: "Ready",
    sizeBytes: 1_536_000,
    createdAt: at(-3 * HOUR),
    expiresAt: at(7 * DAY - 3 * HOUR),
    downloadUrl: "#download",
  },
  {
    id: "e2",
    kind: "channel",
    kindLabel: "Channel data",
    status: "running",
    statusLabel: "Preparing",
    sizeBytes: null,
    createdAt: at(-2 * 60 * 1000),
    expiresAt: null,
    downloadUrl: null,
  },
];

export const exportCooldown = at(21 * HOUR);

export const deletionLabels: DeletionPanelLabels = {
  title: "Delete account",
  description: "Your profile, messages and media are removed after a 30-day grace period.",
  request: "Delete my account…",
  confirmTitle: "Delete your account?",
  confirmDescription:
    "Your profile, sign-in methods, chat messages and media are removed. Payments, the ledger, votes and audit history stay, with your name and email removed.",
  confirmLabel: "Schedule deletion",
  scheduled: (date) => <>Your account will be deleted on {date}. Until then you can cancel.</>,
  canceled: "Deletion canceled. Your account stays.",
  cancel: "Cancel deletion",
};

export const deletionScheduled = { status: "scheduled", statusLabel: "Scheduled", scheduledFor: at(30 * DAY) };

export const overlayAlerts: OverlayAlertItem[] = [
  {
    id: "a1",
    type: "tip",
    text: "Fernsby tipped $5.00",
    message: "that glaze!!",
    amountCents: 500,
    durationMs: 6000,
    animation: "slide",
    test: false,
  },
  {
    id: "a2",
    type: "follow",
    text: "Mara followed",
    message: null,
    amountCents: null,
    durationMs: 4000,
    animation: "fade",
    test: false,
  },
];
