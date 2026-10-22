// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/settings/privacy` compositions (E6): data export and account deletion. Each renders the test
 * ids of docs/testing/e6-selectors.md itself. Strings come in as `labels`.
 */
export {
  ExportPanel,
  exportCooldownUntil,
  exportStatusTone,
  type ExportPanelProps,
  type ExportPanelLabels,
  type ExportKindOption,
  type ExportRowData,
} from "./export-panel.tsx";
export {
  DeletionPanel,
  deletionStatusTone,
  type DeletionPanelProps,
  type DeletionPanelLabels,
  type DeletionRequestView,
} from "./deletion-panel.tsx";
