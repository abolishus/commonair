// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample data from the Settings board (account settings, profile section). */
import type { Accent } from "@commonair/ui";
import type { SwitchMatrixRow } from "@commonair/ui/blocks/forms";

export const sections = [
  { id: "profile", label: "Profile", href: "#settings/profile", current: true },
  { id: "security", label: "Account & security", href: "#settings/security" },
  { id: "notifications", label: "Notifications", href: "#settings/notifications" },
  { id: "payments", label: "Subscriptions & payments", href: "#settings/payments" },
  { id: "membership", label: "Co-op membership", href: "#settings/membership" },
  { id: "connections", label: "Connections & apps", href: "#settings/connections" },
  { id: "privacy", label: "Privacy & data", href: "#settings/privacy" },
  { id: "blocked", label: "Blocked users", href: "#settings/blocked" },
  { id: "appearance", label: "Appearance & language", href: "#settings/appearance" },
];

export const profile = {
  displayName: "Mira",
  username: "mira",
  bio: "Ceramics, glazes and kiln disasters. Streaming Tue/Thu evenings.",
  accent: "violet" as Accent,
  pictureHint: "PNG or JPEG, at least 256 × 256. Without one, your initial is shown.",
  accentHint: "Used for your avatar fallback, thumbnails and the player scrubber. All accents pass contrast checks.",
};

export const accentLabels: Record<Accent, string> = {
  zinc: "Zinc",
  red: "Red",
  orange: "Orange",
  amber: "Amber",
  lime: "Lime",
  green: "Green",
  teal: "Teal",
  sky: "Sky",
  blue: "Blue",
  indigo: "Indigo",
  violet: "Violet",
  pink: "Pink",
};

export const signInMethods = [
  { id: "password", title: "Password", description: "Changed 3 months ago", action: "Change" },
  { id: "passkeys", title: "Passkeys", description: "2 registered · Laptop, Phone", action: "Manage" },
  {
    id: "totp",
    title: "Authenticator app",
    description: "8 of 10 recovery codes left",
    action: "Recovery codes",
    status: "On",
  },
];

export const notificationColumns = [
  { id: "site", label: "On site" },
  { id: "email", label: "Email" },
  { id: "push", label: "Web push" },
];

export const notificationRows: SwitchMatrixRow[] = [
  { id: "live", label: "A followed channel goes live", values: { site: true, email: false, push: true } },
  { id: "gift", label: "Someone gifts you a subscription", values: { site: true, email: true, push: false } },
  { id: "proposal", label: "New co-op proposal opens for voting", values: { site: true, email: true, push: false } },
  { id: "patronage", label: "Patronage statement ready", values: { site: true, email: true, push: false } },
];
