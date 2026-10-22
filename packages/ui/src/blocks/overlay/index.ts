// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The OBS overlay (E6): the transparent alert view and its queue. The page owns the token, the
 * state call and the `EventSource`; these only queue and draw what arrives.
 */
export { OverlayAlertsView, type OverlayAlertsViewProps, type OverlayState } from "./overlay-alerts.tsx";
export {
  useAlertQueue,
  useReducedMotion,
  type AlertQueue,
  type AlertQueueOptions,
  type OverlayAlertItem,
} from "./alert-queue.ts";
