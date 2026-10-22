// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample data for the ProposalForm board (`/coop/proposals/new`). */
import type { ProposalChangeDraft, ProposalChangeKeyOption } from "@commonair/ui/blocks/coop";

export const breadcrumbs = [
  { label: "Co-op", href: "#coop" },
  { label: "Proposals", href: "#coop/proposals" },
  { label: "New proposal" },
];

const keys: { key: string; protected: boolean }[] = [
  { key: "discovery.ranking", protected: false },
  { key: "membership.classes", protected: false },
  { key: "council.config", protected: false },
  { key: "governance.ordinary", protected: true },
  { key: "governance.protections", protected: true },
  { key: "platform.cut", protected: true },
  { key: "patronage.weights", protected: true },
];

export const keyOptions: ProposalChangeKeyOption[] = keys.map(({ key, protected: isProtected }) => ({
  value: key,
  label: key,
  protected: isProtected,
  "data-testid": `proposal-change-key-${key}`,
}));

export const draft = {
  title: "Show five spotlight slots on the home page",
  body: "Four spotlight slots leave most small channels out. A fifth slot, reserved for channels under 50 verified viewers, costs nobody a place.\n\nThe change only touches discovery.ranking.",
  affectsCreators: true,
};

export const ordinaryChanges: ProposalChangeDraft[] = [
  { id: "c1", key: "discovery.ranking", value: '{\n  "spotlightSlots": 5\n}' },
];

export const protectedChanges: ProposalChangeDraft[] = [
  ...ordinaryChanges,
  { id: "c2", key: "platform.cut", value: '{\n  "streamerShare": 0.85\n}' },
  { id: "c3", key: "", value: "" },
];
