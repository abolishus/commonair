// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The co-op section tabs shared by the E5 co-op boards (`/coop/*`). */
export type CoopTab = "overview" | "membership" | "proposals" | "council" | "settings" | "patronage" | "transparency";

const TABS: { id: CoopTab; label: string; href: string }[] = [
  { id: "overview", label: "Overview", href: "#coop" },
  { id: "membership", label: "Membership", href: "#coop/membership" },
  { id: "proposals", label: "Proposals", href: "#coop/proposals" },
  { id: "council", label: "Council", href: "#coop/council" },
  { id: "settings", label: "Settings", href: "#coop/settings" },
  { id: "patronage", label: "Patronage", href: "#coop/patronage" },
  { id: "transparency", label: "Transparency", href: "#transparency" },
];

export function coopTabs(current: CoopTab): { id: string; label: string; href: string; current: boolean }[] {
  return TABS.map((tab) => ({ ...tab, current: tab.id === current }));
}
