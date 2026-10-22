// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Co-op compositions (E5): membership and shares, proposals, votes and tallies, the council,
 * settings, patronage statements and the treasury/admin co-op tools. Every element a spec test id
 * names takes `data-*` from the page (rest props on the root, `itemProps`/`rowProps`/`…Props` on
 * parts); raw values the visible text formats are set as `data-*` by the composition itself.
 */
export type { DataAttributes } from "../../lib/data-attributes.ts";
export {
  proposalStatusTone,
  shareStatusTone,
  membershipStatusTone,
  patronageStatusTone,
  councilStanceTone,
  electionStatusTone,
} from "./tones.ts";
export {
  TallyTable,
  type TallyTableProps,
  type TallyTableRow,
  type TallyTableCheck,
  type TallyTableLabels,
} from "./tally-table.tsx";
export {
  VotePanel,
  VoteParticipation,
  type VotePanelProps,
  type VoteParticipationProps,
  type VoteChoiceOption,
} from "./vote-panel.tsx";
export {
  CouncilResponseCard,
  CouncilRespondForm,
  type CouncilResponseCardProps,
  type CouncilRespondFormProps,
  type CouncilStanceOption,
} from "./council-response.tsx";
export {
  ProposalChangeEditor,
  ProposalChangeSummary,
  ProposalKindBadge,
  SettingValue,
  formatSettingValue,
  type ProposalChangeEditorProps,
  type ProposalChangeEditorLabels,
  type ProposalChangeDraft,
  type ProposalChangeKeyOption,
  type ProposalChangeSummaryProps,
  type ProposalChangeSummaryItem,
  type ProposalKindBadgeProps,
} from "./proposal-changes.tsx";
export {
  MembershipList,
  EligibilityList,
  ShareCard,
  ShareInstructions,
  ConfirmedActionButton,
  type ConfirmedAction,
  type MembershipListProps,
  type MembershipListItem,
  type EligibilityListProps,
  type EligibilityItem,
  type EligibilityProgress,
  type ShareCardProps,
  type ShareInstructionsProps,
} from "./membership.tsx";
export {
  StatementView,
  StatementList,
  type StatementViewProps,
  type StatementLineItem,
  type StatementLabels,
  type StatementListProps,
  type StatementListItem,
} from "./statement.tsx";
export {
  GovernanceSettingsList,
  type GovernanceSettingsListProps,
  type GovernanceSettingItem,
} from "./settings-list.tsx";
export {
  PatronageRunForm,
  PatronageRunResult,
  PatronagePeriodsTable,
  GuardedActionButton,
  type GuardedAction,
  type PatronageRunFormProps,
  type PatronageRunFormValues,
  type PatronageRunResultProps,
  type PatronagePeriodsTableProps,
  type PatronagePeriodRow,
} from "./patronage-admin.tsx";
export {
  ShareRefundsTable,
  AppointWorkerForm,
  type ShareRefundsTableProps,
  type ShareRefundRow,
  type ShareRefundAction,
  type AppointWorkerFormProps,
  type AppointWorkerFormValues,
} from "./treasury.tsx";
export {
  SeatList,
  ElectionCard,
  type SeatListProps,
  type SeatListItem,
  type ElectionCardProps,
  type ElectionCandidate,
} from "./seats.tsx";
export {
  GovernanceOutcomeList,
  type GovernanceOutcomeListProps,
  type GovernanceOutcomeItem,
} from "./governance-outcomes.tsx";
