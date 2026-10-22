// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Creator studio compositions (E6): simulcast targets, alert configuration, the overlay URL and
 * the content (VODs and clips) board. Each renders the test ids of docs/testing/e6-selectors.md
 * itself; select items are `<field test id>-option-<value>`. Strings come in as `labels`.
 */
export {
  SimulcastPanel,
  SIMULCAST_TARGET_LIMIT,
  simulcastStatusTone,
  type SimulcastPanelProps,
  type SimulcastPanelLabels,
  type SimulcastTargetRow,
  type SimulcastAddValues,
} from "./simulcast-panel.tsx";
export {
  AlertConfigCard,
  fillAlertTemplate,
  ALERT_DURATION_MIN_MS,
  ALERT_DURATION_MAX_MS,
  ALERT_MESSAGE_MAX,
  type AlertAnimation,
  type AlertConfigCardProps,
  type AlertConfigDraft,
  type AlertConfigLabels,
  type AlertVariable,
} from "./alert-config.tsx";
export {
  OverlayTokenPanel,
  OVERLAY_EXPIRY_CHOICES,
  isOverlayExpiryChoice,
  resolveOverlayExpiry,
  type OverlayExpiryChoice,
  type OverlayExpiryResult,
  type OverlayTokenPanelProps,
  type OverlayTokenLabels,
  type OverlayTokenStatusView,
} from "./overlay-token.tsx";
export {
  ContentBoard,
  mediaStatusTone,
  type ContentBoardProps,
  type ContentBoardLabels,
  type ContentTab,
  type VodRowData,
  type ClipRowData,
  type VodUpdate,
} from "./content-board.tsx";
